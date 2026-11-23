import { after } from 'next/server';

import { campaignQueueEnabled, queuePublicCampaign, readCampaignKey, readCampaignSchedule } from '@/lib/whatsapp/campaign-queue';
import { requireApiKey } from '@/lib/auth/api-context';

export const maxDuration = 60;

import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  createBroadcast,
  deliverBroadcast,
  BroadcastError,
} from '@/lib/whatsapp/broadcast-core';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const templateName =
      typeof body.template_name === 'string' ? body.template_name : '';
    const recipients = Array.isArray(body.recipients) ? body.recipients : [];

    const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const input = {
      name: typeof body.name === 'string' ? body.name : null,
      templateName,
      templateLanguage:
        typeof body.template_language === 'string'
          ? body.template_language
          : null,
      recipients: recipients.map((r) => ({
        to: typeof r?.to === 'string' ? r.to : '',
        params: Array.isArray(r?.params) ? r.params : undefined,
      })),
    };
    const key = readCampaignKey(request.headers.get('idempotency-key'));
    const scheduledAt = readCampaignSchedule(body.scheduled_at);
    if (campaignQueueEnabled(ctx.accountId)) {
      const campaign = await queuePublicCampaign(ctx.supabase, ctx.accountId, auditUserId, input, key, scheduledAt);
      return ok({
        broadcast_id: campaign.id,
        status: campaign.status,
        total_recipients: campaign.total_recipients,
        accepted: campaign.total_recipients - (campaign.excluded_count ?? 0),
        excluded: campaign.excluded_count ?? 0,
        rejected: campaign.rejected_count ?? 0,
      }, 202);
    }
    if (key || scheduledAt) {
      return fail('campaign_queue_unavailable', 'Scheduled and idempotent launches require the campaign worker.', 503);
    }
    const plan = await createBroadcast(ctx.supabase, ctx.accountId, auditUserId, input);

    // Fan out after the response is sent. Uses the same service-role
    // client — no request-scoped auth needed for the Meta calls or
    // the account-scoped row updates.
    after(() => deliverBroadcast(ctx.supabase, plan));

    return ok(
      {
        broadcast_id: plan.broadcastId,
        status: 'sending',
        total_recipients: plan.planned.length,
        accepted: plan.planned.length,
        rejected: plan.rejected,
      },
      202
    );
  } catch (err) {
    if (err instanceof BroadcastError) {
      return fail(err.code, err.message, err.status);
    }
    if (err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
