import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { resolveAudienceContacts, type CsvAudienceRow } from '@/lib/broadcast-audience';
import { fetchCustomValueIndex, resolveVariables } from '@/lib/broadcast-personalization';
import { fetchAllInChunks } from '@/lib/supabase/paged-query';
import { BroadcastError } from '@/lib/whatsapp/broadcast-core';
import {
  campaignDestination, campaignFingerprint, campaignPreflight, campaignQueueEnabled, campaignTemplate, campaignUuid,
  enqueueCampaign, findQueuedCampaign, MAX_CAMPAIGN_RECIPIENTS, readCampaignKey, readCampaignSchedule, validateCampaignSender,
} from '@/lib/whatsapp/campaign-queue';
import type { CampaignInput } from '@/lib/whatsapp/campaign-input';
import { isValidE164, parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import type { Contact } from '@/types';

const AUDIENCE_TYPES = ['all', 'tags', 'custom_field', 'csv'];
const VARIABLE_TYPES = ['static', 'field', 'custom_field'];

function readInput(body: Record<string, unknown>): CampaignInput {
  const input = body as unknown as CampaignInput;
  const audience = input.audience;
  const validTagIds = (values?: string[]) => values === undefined || Array.isArray(values) &&
    values.length <= 100 && values.every(id => typeof id === 'string' && campaignUuid.test(id));
  if (typeof input.name !== 'string' || input.name.trim().length > 150 ||
    typeof input.templateId !== 'string' || !campaignUuid.test(input.templateId) ||
    (input.draftId !== undefined && (typeof input.draftId !== 'string' || !campaignUuid.test(input.draftId))) ||
    !audience || !AUDIENCE_TYPES.includes(audience.type) ||
    !validTagIds(audience.tagIds) || !validTagIds(audience.excludeTagIds) ||
    (audience.type === 'tags' && !audience.tagIds?.length) ||
    (audience.type === 'custom_field' && (!audience.customField || typeof audience.customField.fieldId !== 'string' ||
      !campaignUuid.test(audience.customField.fieldId) || typeof audience.customField.value !== 'string' ||
      audience.customField.value.length > 1000 || !['is', 'is_not', 'contains'].includes(audience.customField.operator))) ||
    (audience.type === 'csv' && (!Array.isArray(audience.csvContacts) || audience.csvContacts.length > MAX_CAMPAIGN_RECIPIENTS ||
      audience.csvContacts.some(row => !row || typeof row.phone !== 'string' || row.phone.length > 50 ||
        (row.name !== undefined && (typeof row.name !== 'string' || row.name.length > 200))))) ||
    (input.headerText !== undefined && (typeof input.headerText !== 'string' || input.headerText.length > 60)) ||
    (input.buttonParams !== undefined && (!input.buttonParams || typeof input.buttonParams !== 'object' ||
      Array.isArray(input.buttonParams) || Object.entries(input.buttonParams).length > 10 ||
      Object.entries(input.buttonParams).some(([index, value]) => !/^\d$/.test(index) || typeof value !== 'string' || value.length > 512))) ||
    !input.variables || typeof input.variables !== 'object' || Array.isArray(input.variables) ||
    Object.keys(input.variables).length > 100 || Object.values(input.variables).some(value =>
      !value || !VARIABLE_TYPES.includes(value.type) || typeof value.value !== 'string' || value.value.length > 1024) ||
    (input.headerMediaUrl !== undefined && (typeof input.headerMediaUrl !== 'string' ||
      (input.headerMediaUrl !== '' && (!/^https:\/\/[^\s]+$/i.test(input.headerMediaUrl) || input.headerMediaUrl.length > 2048))))) {
    throw new BroadcastError('bad_request', 'Check the template, audience, and personalization values.', 400);
  }
  return {
    name: input.name.trim(), templateId: input.templateId, audience, variables: input.variables,
    headerMediaUrl: input.headerMediaUrl, headerText: input.headerText, buttonParams: input.buttonParams, scheduledAt: readCampaignSchedule(input.scheduledAt), draftId: input.draftId,
  };
}

async function resolveCsvContacts(
  db: SupabaseClient, accountId: string, userId: string, rows: CsvAudienceRow[], persist: boolean,
): Promise<Contact[]> {
  const byPhone = new Map<string, CsvAudienceRow>();
  for (const row of rows) {
    const phone = campaignDestination(row.phone);
    if (isValidE164(phone) && !byPhone.has(phone)) byPhone.set(phone, row);
  }
  const phones = [...byPhone.keys()];
  async function readContacts(keys: string[]) {
    return fetchAllInChunks<Contact & { phone_normalized: string }, string>(keys, (slice, from, to) =>
      db.from('contacts').select('*').eq('account_id', accountId).in('phone_normalized', slice).order('id').range(from, to));
  }
  const contacts = new Map((await readContacts(phones)).map(contact => [contact.phone_normalized, contact]));
  const missing = phones.filter(phone => !contacts.has(phone));
  if (persist && missing.length) {
    for (let i = 0; i < missing.length; i += 200) {
      const slice = missing.slice(i, i + 200);
      let remaining = slice;
      for (let attempt = 0; remaining.length && attempt < 3; attempt++) {
        const { error } = await db.from('contacts').insert(remaining.map(phone => ({
          user_id: userId, account_id: accountId, phone: '+' + phone, name: byPhone.get(phone)?.name ?? null,
        })));
        if (!error) break;
        if (error.code !== '23505') throw new Error('Could not save the campaign CSV contacts.');
        const present = new Set((await readContacts(remaining)).map(contact => contact.phone_normalized));
        remaining = remaining.filter(phone => !present.has(phone));
      }
    }
    for (const contact of await readContacts(missing)) contacts.set(contact.phone_normalized, contact);
    if (phones.some(phone => !contacts.has(phone))) throw new Error('Could not resolve the campaign CSV contacts.');
  }
  return phones.map(phone => contacts.get(phone) ?? ({
    id: 'csv:' + phone, phone: '+' + phone, name: byPhone.get(phone)?.name,
  } as Contact));
}

export async function POST(request: Request) {
  try {
    const { accountId, userId, supabase } = await requireRole('agent');
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || !['preview', 'launch', 'test'].includes(body.action)) {
      return NextResponse.json({ error: 'Choose preview or launch.' }, { status: 400 });
    }
    const preview = body.action === 'preview';
    const test = body.action === 'test';
    const testPhone = test && typeof body.testTo === 'string' ? parseInternationalPhone(body.testTo) : null;
    if (test && !testPhone) return NextResponse.json({ error: 'Enter a test phone number with its country code.' }, { status: 400 });
    if (!preview) {
      const limit = checkRateLimit(`campaign-launch:${userId}`, RATE_LIMITS.broadcast);
      if (!limit.success) return rateLimitResponse(limit);
    }
    const input = readInput(body);
    const key = readCampaignKey(request.headers.get('idempotency-key'));
    if (!preview && (!input.name || !key)) {
      return NextResponse.json({ error: 'Provide a campaign name and launch key.' }, { status: 400 });
    }
    const admin = supabaseAdmin();
    const fingerprint = campaignFingerprint({ kind: test ? 'dashboard-test' : 'dashboard', input, testPhone });
    if (!preview) {
      const existing = await findQueuedCampaign(admin, accountId, key, fingerprint);
      if (existing) return NextResponse.json({ broadcast_id: existing.id }, { status: 202 });
      if (!campaignQueueEnabled(accountId)) {
        return NextResponse.json({ error: 'Campaign scheduling is unavailable until the background worker is configured.' }, { status: 503 });
      }
    }
    const [template, contacts] = await Promise.all([
      campaignTemplate(admin, accountId, { id: input.templateId }),
      testPhone
        ? resolveCsvContacts(supabase, accountId, userId, [{ phone: '+' + testPhone }], false)
          .then(rows => rows.filter(row => campaignUuid.test(row.id)))
        : resolveAudienceContacts(supabase, input.audience, rows => resolveCsvContacts(supabase, accountId, userId, rows, !preview)),
      ...(preview ? [] : [validateCampaignSender(admin, accountId)]),
    ]);
    if (contacts.length > MAX_CAMPAIGN_RECIPIENTS) {
      throw new BroadcastError('bad_request', 'Split the audience into campaigns of at most 10,000 contacts.', 400);
    }
    const customValues = Object.values(input.variables).some(value => value.type === 'custom_field')
      ? await fetchCustomValueIndex(supabase, contacts.filter(c => campaignUuid.test(c.id)).map(c => c.id))
      : new Map();
    const plan = await campaignPreflight(admin, accountId, template, contacts.map(contact => ({
      contact_id: contact.id, destination: campaignDestination(contact.phone),
      params: { body: resolveVariables(input.variables, contact, customValues.get(contact.id)),
        ...(input.headerMediaUrl ? { headerMediaUrl: input.headerMediaUrl } : {}),
        ...(input.headerText ? { headerText: input.headerText } : {}),
        ...(input.buttonParams ? { buttonParams: input.buttonParams } : {}) },
    })));
    if (preview) return NextResponse.json({ summary: plan.summary }, { headers: { 'Cache-Control': 'no-store' } });
    if (!plan.summary.eligible) {
      return NextResponse.json({ error: test ? 'Use an eligible test contact saved in this workspace.' : 'No eligible recipients. Review audience exclusions and preview the campaign again.', summary: plan.summary }, { status: 409 });
    }
    const campaign = await enqueueCampaign(admin, {
      accountId, userId, name: test ? `Test · ${input.name}` : input.name, template,
      scheduledAt: test ? null : input.scheduledAt ?? null,
      key, fingerprint, draftId: test ? undefined : input.draftId,
      audience: test ? { type: 'test' } : input.audience, variables: input.variables,
      rejected: plan.summary.duplicates, recipients: plan.recipients,
    });
    return NextResponse.json({ broadcast_id: campaign.id, summary: plan.summary }, { status: 202 });
  } catch (error) {
    if (error instanceof BroadcastError) return NextResponse.json({ code: error.code, error: error.message }, { status: error.status });
    return toErrorResponse(error);
  }
}
