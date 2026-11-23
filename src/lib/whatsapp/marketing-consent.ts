import type { SupabaseClient } from '@supabase/supabase-js';
import { isValidE164, normalizePhone } from './phone-utils';
import { isBusinessScopedUserId } from './wa-identity';

export const MANUAL_CONSENT_SOURCES = ['website', 'checkout', 'whatsapp', 'in_person', 'other'] as const;
export type ManualConsentSource = (typeof MANUAL_CONSENT_SOURCES)[number];
export type MarketingConsentState = 'opted_in' | 'opted_out';

export interface MarketingConsent {
  state: MarketingConsentState;
  source: ManualConsentSource | 'csv';
  occurred_at: string;
  evidence: string;
}

export function parseMarketingConsentEvidence(occurredAt: unknown, evidence: unknown, now = Date.now()) {
  if (typeof evidence !== 'string' || !evidence.trim() || evidence.trim().length > 500) return null;
  if (typeof occurredAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(occurredAt)) return null;
  const date = Date.parse(occurredAt);
  if (!Number.isFinite(date) || date > now) return null;
  return { occurred_at: new Date(date).toISOString(), evidence: evidence.trim() };
}

export function marketingRecipientKey(destination: string | null | undefined): string | null {
  if (!destination) return null;
  if (isBusinessScopedUserId(destination)) {
    const id = destination.trim();
    return id.length <= 71 ? `wa:${id}` : null;
  }
  const phone = normalizePhone(destination);
  return isValidE164(phone) ? `phone:${phone}` : null;
}

export async function readMarketingConsent(
  db: SupabaseClient,
  accountId: string,
  recipientKey: string,
): Promise<MarketingConsent | null> {
  const { data, error } = await db
    .from('whatsapp_marketing_consent_events')
    .select('state, source, occurred_at, evidence')
    .eq('account_id', accountId)
    .eq('recipient_key', recipientKey)
    .order('occurred_at', { ascending: false })
    // When events share a timestamp, opting out takes precedence.
    .order('state', { ascending: false })
    .order('recorded_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
    .maybeSingle<MarketingConsent>();
  if (error) throw new Error('Could not verify WhatsApp marketing permission');
  return data;
}

export async function recordMarketingConsent(
  db: SupabaseClient,
  accountId: string,
  recipientKeys: string[],
  consent: MarketingConsent,
  audit: { userId?: string; messageId?: string },
): Promise<void> {
  const rows = [...new Set(recipientKeys)].map(recipient_key => ({
    ...consent,
    account_id: accountId,
    recipient_key,
    recorded_by: audit.userId ?? null,
    whatsapp_message_id: audit.messageId ?? null,
  }));
  if (!rows.length) return;

  const table = db.from('whatsapp_marketing_consent_events');
  const { error } = audit.messageId
    ? await table.upsert(rows, { onConflict: 'account_id,recipient_key,whatsapp_message_id', ignoreDuplicates: true })
    : await table.insert(rows);
  if (error) throw new Error('Could not save WhatsApp marketing permission');
}

const OPT_OUT_COMMANDS = new Set([
  'stop', 'unsubscribe', 'stop promotions', 'stop marketing', 'opt out',
  'cancelar inscrição', 'parar promoções', 'cancelar suscripción', 'dejar de recibir promociones',
  '수신 거부', '구독 취소',
]);

export function isMarketingOptOut(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const command = value.normalize('NFKC').trim().toLowerCase()
    .replace(/[.!?]+$/, '').trim().replace(/[\s_-]+/g, ' ');
  return OPT_OUT_COMMANDS.has(command);
}
