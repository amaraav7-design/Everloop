import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { getT } from '@/lib/i18n/translate';
import { marketingRecipientKey, readMarketingConsent } from './marketing-consent';
import { sendTemplateMessage, type SendTemplateMessageArgs } from './meta-api';

const t = getT('LibErrors.marketingConsent');

export class TemplateEligibilityError extends Error {
  constructor(readonly code: 'template_unavailable' | 'marketing_opt_out' | 'marketing_consent_required' | 'marketing_consent_unavailable') {
    super(t(code));
    this.name = 'TemplateEligibilityError';
  }
}

export function isMarketingTemplate(template: MessageTemplate | null | undefined, language: string): boolean {
  // Only an exact, synced category can exempt a send. A fallback row for
  // another language may describe a different template at the provider.
  if (template?.language?.toLowerCase() !== language.toLowerCase()) return true;
  return template.category !== 'Utility' && template.category !== 'Authentication';
}

export function assertTemplateAvailable(template: MessageTemplate | null | undefined): void {
  if (template && template.status !== 'APPROVED') {
    throw new TemplateEligibilityError('template_unavailable');
  }
}

/** The final shared guard for all template traffic, including legacy and resumed campaigns. */
export async function sendEligibleTemplate(
  db: SupabaseClient,
  accountId: string,
  args: SendTemplateMessageArgs,
) {
  assertTemplateAvailable(args.template);
  if (isMarketingTemplate(args.template, args.language ?? 'en_US')) {
    const key = marketingRecipientKey(args.to);
    const consent = key ? await readMarketingConsent(db, accountId, key).catch(() => {
      throw new TemplateEligibilityError('marketing_consent_unavailable');
    }) : null;
    if (consent?.state === 'opted_out') throw new TemplateEligibilityError('marketing_opt_out');
    if (consent?.state !== 'opted_in') throw new TemplateEligibilityError('marketing_consent_required');
  }
  return sendTemplateMessage(args);
}
