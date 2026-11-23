import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Broadcast, MessageTemplate } from '@/types';
import { fetchAllInChunks } from '@/lib/supabase/paged-query';
import { BroadcastError, type CreateBroadcastParams } from './broadcast-core';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { normalizePhone, isValidE164, parseInternationalPhone } from './phone-utils';
import { resolveTemplateRow } from './template-body';
import { isMarketingTemplate, sendEligibleTemplate, TemplateEligibilityError } from './template-delivery';
import { buildSendComponents, type SendTimeParams } from './template-send-builder';
import { MetaApiError, verifyPhoneNumber } from './meta-api';
import { extractVariableIndices } from './template-validators';
import { decrypt } from './encryption';

export const MAX_CAMPAIGN_RECIPIENTS = 10_000;
export const campaignUuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export function campaignWorkerAccounts(): string[] | null {
  const value = process.env.WHATSAPP_CAMPAIGN_ACCOUNTS;
  return value === '*' ? null : (value ?? '').split(',').map(id => id.trim().toLowerCase()).filter(id => campaignUuid.test(id));
}

export function campaignQueueEnabled(accountId: string): boolean {
  const allowed = campaignWorkerAccounts();
  return Boolean(process.env.WHATSAPP_WORKER_CRON_SECRET && (allowed === null || allowed.includes(accountId.toLowerCase())));
}

export function campaignFingerprint(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map(key => [key, canonical(record[key])]));
    }
    return item;
  }
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function readCampaignKey(key: string | null): string | null {
  if (key === null) return null;
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) {
    throw new BroadcastError('invalid_idempotency_key', 'Provide an Idempotency-Key with 1 to 128 letters, digits, or . _ : - characters.', 400);
  }
  return key;
}

export function readCampaignSchedule(input: unknown): string | null {
  if (input == null || input === '') return null;
  if (typeof input !== 'string' || !/T.*(?:Z|[+-]\d\d:\d\d)$/i.test(input)) {
    throw new BroadcastError('invalid_schedule', 'Provide a scheduled time with its time zone.', 400);
  }
  const instant = Date.parse(input);
  if (!Number.isFinite(instant)) throw new BroadcastError('invalid_schedule', 'Choose a valid scheduled time.', 400);
  return new Date(instant).toISOString();
}

export async function findQueuedCampaign(db: SupabaseClient, accountId: string, key: string | null, fingerprint: string) {
  if (!key) return null;
  const { data, error } = await db.from('broadcasts').select('*').eq('account_id', accountId)
    .eq('launch_key', key).maybeSingle<Broadcast & { launch_fingerprint: string }>();
  if (error) throw new BroadcastError('internal', 'Could not look up the campaign launch.', 500);
  if (data && data.launch_fingerprint !== fingerprint) {
    throw new BroadcastError('campaign_launch_conflict', 'This launch key was already used for another campaign.', 409);
  }
  return data;
}

export async function campaignTemplate(
  db: SupabaseClient, accountId: string, selection: { id: string } | { name: string; language?: string | null },
): Promise<MessageTemplate & { language: string }> {
  let template: MessageTemplate | null;
  if ('id' in selection) {
    const result = await db.from('message_templates').select('*').eq('account_id', accountId)
      .eq('id', selection.id).maybeSingle<MessageTemplate>();
    if (result.error) throw new BroadcastError('internal', 'Could not load the campaign template.', 503);
    template = result.data;
  } else {
    const resolved = await resolveTemplateRow(db, accountId, selection.name, selection.language);
    template = resolved.row?.language?.toLowerCase() === resolved.language.toLowerCase() ? resolved.row : null;
  }
  if (template?.status !== 'APPROVED' || !template.language) {
    throw new BroadcastError('template_unavailable', 'Choose an approved template in its exact language. Sync templates from Meta if needed.', 400);
  }
  return { ...template, language: template.language };
}

export async function readCampaignSender(db: SupabaseClient, accountId: string) {
  const { data, error } = await db.from('whatsapp_config').select('phone_number_id, access_token')
    .eq('account_id', accountId).maybeSingle<{ phone_number_id: string; access_token: string }>();
  if (error) throw new BroadcastError('internal', 'Could not load the WhatsApp connection.', 503);
  if (!data?.phone_number_id || !data.access_token) throw new BroadcastError('whatsapp_not_configured', 'Connect a WhatsApp sender before launching a campaign.', 400);
  return data;
}

// Cache only verified health, scoped to the sender and credential version.
// A hosted drain can reuse it within one run without adding a Meta GET per
// recipient. Expired or unavailable verification is never treated as healthy.
const healthySenders = new Map<string, number>();

async function verifySenderHealth(sender: Awaited<ReturnType<typeof readCampaignSender>>, token: string) {
  const key = campaignFingerprint([sender.phone_number_id, sender.access_token]);
  if ((healthySenders.get(key) ?? 0) > Date.now()) return;
  try {
    const info = await verifyPhoneNumber({ phoneNumberId: sender.phone_number_id, accessToken: token });
    if (info.id !== sender.phone_number_id || info.quality_rating === 'RED') {
      throw new BroadcastError('whatsapp_sender_unhealthy', 'Review the sender’s WhatsApp quality rating before launching.', 409);
    }
    if (healthySenders.size >= 200) healthySenders.clear();
    healthySenders.set(key, Date.now() + 60_000);
  } catch (error) {
    if (error instanceof BroadcastError) throw error;
    throw new BroadcastError('whatsapp_sender_unavailable', 'Could not verify the WhatsApp sender with Meta. Check the connection and try again.', 503);
  }
}

export async function validateCampaignSender(db: SupabaseClient, accountId: string) {
  const sender = await readCampaignSender(db, accountId);
  await verifySenderHealth(sender, decrypt(sender.access_token));
  return sender;
}

function deliveryTemplateFingerprint(template: MessageTemplate) {
  return campaignFingerprint({
    name: template.name, language: template.language, body: template.body_text, category: template.category,
    headerType: template.header_type, headerText: template.header_content, headerUrl: template.header_media_url,
    buttons: template.buttons ?? [], metaId: template.meta_template_id,
  });
}

type Exclusion = 'invalid_phone' | 'marketing_opt_out' | 'marketing_consent_required' | 'invalid_template_parameters';

export interface CampaignRecipientInput {
  contact_id: string;
  destination: string;
  params: SendTimeParams;
}

export type CampaignRecipient = CampaignRecipientInput & { exclusion: Exclusion | null };

export async function campaignPreflight(
  db: SupabaseClient, accountId: string, template: MessageTemplate & { language: string },
  input: CampaignRecipientInput[],
) {
  const ids = new Set<string>();
  const phones = new Set<string>();
  const unique = input.filter(({ contact_id, destination }) => {
    if (ids.has(contact_id) || (destination && phones.has(destination))) return false;
    ids.add(contact_id);
    if (destination) phones.add(destination);
    return true;
  });
  const destinations = unique.filter(r => isValidE164(r.destination)).map(r => 'phone:' + r.destination);
  const needsConsent = isMarketingTemplate(template, template.language);
  const consent = new Map<string, string>();
  if (needsConsent) {
    const states = await fetchAllInChunks<{ recipient_key: string; state: string }, string>(
      destinations, (slice, from, to) => db.rpc('campaign_consent_states', {
        p_account: accountId, p_keys: slice,
      }).order('recipient_key').range(from, to),
    );
    for (const row of states) consent.set(row.recipient_key, row.state);
  }
  const counts = { invalid_phone: 0, marketing_opt_out: 0, marketing_consent_required: 0, invalid_template_parameters: 0 };
  const bodyKeys = extractVariableIndices(template.body_text).map(String);
  const mediaHeader = template.header_type && ['image', 'document', 'video'].includes(template.header_type);
  const recipients: CampaignRecipient[] = unique.map((r) => {
    let exclusion: Exclusion | null = null;
    if (!isValidE164(r.destination)) {
      exclusion = 'invalid_phone';
    } else if (needsConsent && consent.get('phone:' + r.destination) !== 'opted_in') {
      exclusion = consent.get('phone:' + r.destination) === 'opted_out' ? 'marketing_opt_out' : 'marketing_consent_required';
    } else if ((r.params.body ?? []).length !== bodyKeys.length || (r.params.body ?? []).some(p => !p.trim()) ||
      (mediaHeader && !r.params.headerMediaUrl && !template.header_media_url)) {
      exclusion = 'invalid_template_parameters';
    } else {
      try {
        buildSendComponents(template, r.params);
      } catch {
        exclusion = 'invalid_template_parameters';
      }
    }
    if (exclusion) counts[exclusion]++;
    return { ...r, exclusion };
  });
  const eligible = recipients.filter(r => !r.exclusion);
  const sample = eligible[0];
  return {
    recipients,
    summary: {
      total: input.length,
      eligible: eligible.length,
      duplicates: input.length - unique.length,
      exclusions: counts,
      example: sample ? template.body_text.replace(/{{\s*([^{}]+?)\s*}}/g, (match, key: string) =>
        sample.params.body?.[bodyKeys.indexOf(key)] ?? match) : null,
    },
  };
}

interface EnqueueParams {
  accountId: string;
  userId: string;
  name: string;
  template: MessageTemplate;
  scheduledAt: string | null;
  key: string | null;
  fingerprint: string;
  draftId?: string;
  audience?: unknown;
  variables?: unknown;
  rejected: number;
  recipients: CampaignRecipient[];
}

export async function enqueueCampaign(db: SupabaseClient, params: EnqueueParams): Promise<Broadcast> {
  if (params.scheduledAt && Date.parse(params.scheduledAt) <= Date.now()) {
    throw new BroadcastError('invalid_schedule', 'Choose a time in the future.', 400);
  }
  const { data, error } = await db.rpc('enqueue_campaign', {
    p_account: params.accountId, p_user: params.userId, p_name: params.name, p_template: params.template.id, p_template_fingerprint: deliveryTemplateFingerprint(params.template),
    p_when: params.scheduledAt, p_key: params.key, p_fingerprint: params.fingerprint,
    p_draft: params.draftId ?? null, p_audience: params.audience ?? null, p_variables: params.variables ?? null,
    p_rejected: params.rejected, p_recipients: params.recipients,
  }).single<Broadcast>();
  if (error?.code === '23505') throw new BroadcastError('campaign_launch_conflict', 'This campaign or draft was already launched.', 409);
  if (error?.code === '22023') throw new BroadcastError('campaign_inputs_changed', 'The template, sender, or audience changed. Review the campaign and try again.', 409);
  if (error || !data) {
    console.error('[campaign] queue insert failed', error?.code);
    throw new BroadcastError('internal', 'Could not queue the campaign.', 500);
  }
  return data;
}

export async function queuePublicCampaign(
  db: SupabaseClient, accountId: string, userId: string, input: CreateBroadcastParams,
  key: string | null, scheduledAt: string | null,
) {
  const fingerprint = campaignFingerprint({ kind: 'api', input, scheduledAt });
  const existing = await findQueuedCampaign(db, accountId, key, fingerprint);
  if (existing) return existing;
  if (!input.templateName || input.recipients.length < 1 || input.recipients.length > 1000) {
    throw new BroadcastError('bad_request', 'Provide an approved template and between 1 and 1,000 recipients.', 400);
  }
  const [template] = await Promise.all([
    campaignTemplate(db, accountId, { name: input.templateName, language: input.templateLanguage }),
    validateCampaignSender(db, accountId),
  ]);
  const recipients: CampaignRecipientInput[] = [];
  const destinations = new Set<string>();
  let rejected = 0;
  for (const { to, params } of input.recipients) {
    const destination = parseInternationalPhone(to);
    if (!destination || destinations.has(destination)) {
      rejected++;
      continue;
    }
    destinations.add(destination);
    const contact = await findOrCreateContact(db, accountId, userId, { phone: to });
    recipients.push({
      contact_id: contact.id, destination, params: { body: params?.filter(p => typeof p === 'string') ?? [] },
    });
  }
  if (!recipients.length) throw new BroadcastError('bad_request', 'No recipients have valid international phone numbers.', 400);
  const plan = await campaignPreflight(db, accountId, template, recipients);
  return enqueueCampaign(db, {
    accountId, userId, name: input.name?.trim().slice(0, 150) || `API campaign (${template.name})`,
    template, key, fingerprint, scheduledAt,
    rejected: rejected + plan.summary.duplicates, recipients: plan.recipients,
  });
}

export function campaignDestination(phone: string | null | undefined): string {
  return phone ? normalizePhone(phone) : '';
}

interface CampaignJob {
  broadcast_id: string;
  recipient_id: string;
  account_id: string;
  sender_phone_id: string;
  template_id: string | null;
  template_name: string;
  template_language: string;
  template_fingerprint: string;
  destination: string;
  send_params: SendTimeParams;
  lease_id: string;
  attempts: number;
}

interface JobResult {
  state: 'sent' | 'failed' | 'retry' | 'uncertain' | 'excluded';
  reason?: string;
  messageId?: string;
  retrySeconds?: number;
}

export function campaignSendFailure(error: unknown, previousAttempts: number): JobResult {
  if (error instanceof TemplateEligibilityError) {
    if (error.code === 'marketing_consent_unavailable' && previousAttempts < 4) {
      return { state: 'retry', reason: error.code, retrySeconds: 30 * 2 ** previousAttempts };
    }
    return { state: 'excluded', reason: error.code };
  }
  if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500 && error.httpStatus !== 408) {
    if ((error.httpStatus === 429 || [4, 130429, 131056].includes(error.code ?? 0)) && previousAttempts < 4) {
      return { state: 'retry', reason: 'provider_rate_limited', retrySeconds: 60 * 2 ** previousAttempts };
    }
    return { state: 'failed', reason: error.code ? `Meta [${error.code}]` : `Meta HTTP ${error.httpStatus}` };
  }
  return { state: 'uncertain', reason: 'delivery_uncertain' };
}

export async function deliverNextCampaignJob(db: SupabaseClient): Promise<'empty' | 'skipped' | JobResult['state']> {
  const { data, error } = await db.rpc('claim_campaign_job', { p_accounts: campaignWorkerAccounts() }).maybeSingle<CampaignJob>();
  if (error) throw new Error('Could not claim a campaign job');
  if (!data) return 'empty';
  const job = data;

  async function finish(result: JobResult) {
    const { error } = await db.rpc('finish_campaign_job', {
      p_recipient: job.recipient_id, p_lease: job.lease_id,
      p_result: result.state, p_reason: result.reason ?? null,
      p_wamid: result.messageId ?? null, p_retry_seconds: result.retrySeconds ?? null,
    });
    if (error) throw new Error('Could not finalize campaign delivery');
    return result.state;
  }

  let template: Awaited<ReturnType<typeof campaignTemplate>>;
  let sender: Awaited<ReturnType<typeof readCampaignSender>>;
  let accessToken: string;
  try {
    if (!job.template_id) return finish({ state: 'excluded', reason: 'template_unavailable' });
    [template, sender] = await Promise.all([
      campaignTemplate(db, job.account_id, { id: job.template_id }),
      readCampaignSender(db, job.account_id),
    ]);
    if (template.name !== job.template_name || template.language !== job.template_language ||
      deliveryTemplateFingerprint(template) !== job.template_fingerprint) {
      return finish({ state: 'excluded', reason: 'template_unavailable' });
    }
    if (sender.phone_number_id !== job.sender_phone_id) {
      return finish({ state: 'excluded', reason: 'whatsapp_sender_changed' });
    }
    accessToken = decrypt(sender.access_token);
    await verifySenderHealth(sender, accessToken);
  } catch (error) {
    if (error instanceof BroadcastError && error.code === 'whatsapp_sender_unhealthy') {
      const { error: pauseError } = await db.rpc('control_campaign', {
        p_account: job.account_id, p_id: job.broadcast_id, p_action: 'pause',
      });
      if (pauseError) throw new Error('Could not pause campaign with an unhealthy sender');
      return finish({ state: 'retry', reason: error.code, retrySeconds: 60 });
    }
    if (error instanceof BroadcastError && error.status === 400) return finish({ state: 'excluded', reason: error.code });
    throw new Error('Could not prepare campaign delivery');
  }

  const { data: authorized, error: dispatchError } = await db.rpc('begin_campaign_dispatch', {
    p_recipient: job.recipient_id, p_lease: job.lease_id,
  });
  if (dispatchError) throw new Error('Could not begin campaign dispatch');
  if (!authorized) return 'skipped';

  let result: JobResult;
  try {
    const sent = await sendEligibleTemplate(db, job.account_id, {
      phoneNumberId: sender.phone_number_id, accessToken, to: job.destination,
      templateName: template.name, language: template.language, template,
      messageParams: job.send_params, callbackData: `everloop-campaign:${job.recipient_id}`,
    });
    result = sent.messageId
      ? { state: 'sent', messageId: sent.messageId }
      : { state: 'uncertain', reason: 'delivery_uncertain' };
  } catch (error) {
    result = campaignSendFailure(error, job.attempts);
  }
  return finish(result);
}
