import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import {
  MANUAL_CONSENT_SOURCES,
  marketingRecipientKey,
  parseMarketingConsentEvidence,
  readMarketingConsent,
  recordMarketingConsent,
  type ManualConsentSource,
  type MarketingConsent,
} from '@/lib/whatsapp/marketing-consent';
import { resolveContactSendTarget } from '@/lib/whatsapp/wa-identity';

type Context = { params: Promise<{ id: string }> };
const t = getT('Contacts.marketingConsent');

async function loadContact(ctx: Context) {
  const auth = await requireRole('agent');
  const { id } = await ctx.params;
  const { data: contact, error } = await auth.supabase.from('contacts')
    .select('phone, wa_user_id').eq('id', id).eq('account_id', auth.accountId).maybeSingle();
  if (error) throw new Error('Consent contact lookup failed');
  return { ...auth, contact };
}

export async function GET(_request: Request, ctx: Context) {
  try {
    const { supabase, accountId, contact } = await loadContact(ctx);
    if (!contact) return NextResponse.json({ error: t('contactUnavailable') }, { status: 404 });
    const key = marketingRecipientKey(resolveContactSendTarget(contact)?.target);
    const consent = key ? await readMarketingConsent(supabase, accountId, key) : null;
    return NextResponse.json({ consent, addressable: !!key });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request, ctx: Context) {
  try {
    const { supabase, accountId, userId, contact } = await loadContact(ctx);
    const rate = checkRateLimit(`marketing-consent:${userId}`, RATE_LIMITS.adminAction);
    if (!rate.success) return rateLimitResponse(rate);
    if (!contact) return NextResponse.json({ error: t('contactUnavailable') }, { status: 404 });

    const key = marketingRecipientKey(resolveContactSendTarget(contact)?.target);
    if (!key) return NextResponse.json({ error: t('addressUnavailable') }, { status: 409 });

    const body = await request.json().catch(() => null);
    const now = new Date();
    let consent: MarketingConsent;
    if (body?.state === 'opted_out') {
      consent = { state: 'opted_out', source: 'other', occurred_at: now.toISOString(), evidence: 'Recorded by an operator' };
    } else if (body?.state === 'opted_in') {
      const source = body.source as ManualConsentSource;
      const evidence = parseMarketingConsentEvidence(body.occurred_at, body.evidence, now.getTime());
      if (!MANUAL_CONSENT_SOURCES.includes(source) || !evidence) {
        return NextResponse.json({ error: t('invalidEvidence') }, { status: 400 });
      }
      consent = { state: 'opted_in', source, ...evidence };
    } else {
      return NextResponse.json({ error: t('invalidEvidence') }, { status: 400 });
    }

    const keys = consent.state === 'opted_out'
      ? [key, marketingRecipientKey(contact.wa_user_id)].filter((value): value is string => value !== null)
      : [key];
    await recordMarketingConsent(supabaseAdmin(), accountId, keys, consent, { userId });
    return NextResponse.json({ consent: await readMarketingConsent(supabase, accountId, key), addressable: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}
