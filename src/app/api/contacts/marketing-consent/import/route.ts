import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { parseMarketingConsentEvidence } from '@/lib/whatsapp/marketing-consent';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';

export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const rate = checkRateLimit(`marketing-consent-import:${userId}`, RATE_LIMITS.adminAction);
    if (!rate.success) return rateLimitResponse(rate);

    const data = await request.json().catch(() => null);
    if (!Array.isArray(data) || data.length < 1 || data.length > 100) {
      return NextResponse.json({ error: 'Submit between 1 and 100 contact consent records' }, { status: 400 });
    }

    const byContact = new Map<string, { phone: string; occurred_at: string; evidence: string }>();
    for (const row of data) {
      const id = row?.contact_id;
      const phone = typeof row?.phone === 'string' ? parseInternationalPhone(row.phone) : null;
      const proof = parseMarketingConsentEvidence(row?.occurred_at, row?.evidence);
      if (typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id) && phone && proof && !byContact.has(id)) {
        byContact.set(id, { phone, ...proof });
      }
    }
    if (!byContact.size) return NextResponse.json({ recorded: 0 });

    const { data: contacts, error } = await supabase.from('contacts').select('id, phone_normalized')
      .eq('account_id', accountId).in('id', [...byContact.keys()]);
    if (error) throw new Error('Could not verify imported contacts');

    const events = (contacts ?? []).flatMap((contact) => {
      const proof = byContact.get(contact.id);
      if (!proof || contact.phone_normalized !== proof.phone) return [];
      return [{
        account_id: accountId,
        recipient_key: `phone:${proof.phone}`,
        occurred_at: proof.occurred_at,
        evidence: proof.evidence,
        recorded_by: userId,
        source: 'csv',
        state: 'opted_in',
      }];
    });

    if (events.length) {
      const { error: insertError } = await supabaseAdmin().from('whatsapp_marketing_consent_events').insert(events);
      if (insertError) throw new Error('Could not record imported marketing consent');
    }
    return NextResponse.json({ recorded: events.length });
  } catch (error) {
    return toErrorResponse(error);
  }
}
