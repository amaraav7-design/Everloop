import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { MessageTemplate } from '@/types';
import { readMarketingConsent } from './marketing-consent';
import { sendTemplateMessage } from './meta-api';
import { sendEligibleTemplate } from './template-delivery';

vi.mock('./marketing-consent', async (original) => ({
  ...(await original<typeof import('./marketing-consent')>()),
  readMarketingConsent: vi.fn(),
}));
vi.mock('./meta-api', () => ({ sendTemplateMessage: vi.fn() }));

const db = {} as SupabaseClient;
const template: MessageTemplate = {
  id: 'template-1', user_id: 'user-1', name: 'summer_offer', category: 'Marketing',
  language: 'en_US', status: 'APPROVED', body_text: 'Summer offer', created_at: '2026-01-01',
};
const args = {
  phoneNumberId: 'sender-1', accessToken: 'fake-token', to: '15551234567',
  templateName: template.name, language: 'en_US', template,
};

describe('template delivery eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(readMarketingConsent).mockResolvedValue(null);
    vi.mocked(sendTemplateMessage).mockResolvedValue({ messageId: 'wamid.accepted' });
  });

  it('looks up permission for the account and exact destination before contacting Meta', async () => {
    vi.mocked(readMarketingConsent).mockResolvedValue({
      state: 'opted_in', source: 'website', occurred_at: '2026-11-20T01:00:00Z', evidence: 'form-12',
    });
    await expect(sendEligibleTemplate(db, 'account-1', args)).resolves.toEqual({ messageId: 'wamid.accepted' });
    expect(readMarketingConsent).toHaveBeenCalledWith(db, 'account-1', 'phone:15551234567');
    expect(readMarketingConsent).toHaveBeenCalledBefore(vi.mocked(sendTemplateMessage));
  });

  it('blocks a contact whose most recent permission is an opt-out', async () => {
    vi.mocked(readMarketingConsent).mockResolvedValue({
      state: 'opted_out', source: 'whatsapp', occurred_at: '2026-11-20T02:00:00Z', evidence: 'STOP',
    });
    await expect(sendEligibleTemplate(db, 'account-1', args)).rejects.toMatchObject({ code: 'marketing_opt_out' });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('does not exempt an unsynced or different language based on a utility template', async () => {
    await expect(sendEligibleTemplate(db, 'account-1', {
      ...args, template: { ...template, category: 'Utility', language: 'en' },
    })).rejects.toMatchObject({ code: 'marketing_consent_required' });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });

  it('allows a synced, approved utility template without a marketing opt-in', async () => {
    await sendEligibleTemplate(db, 'account-1', { ...args, template: { ...template, category: 'Utility' } });
    expect(sendTemplateMessage).toHaveBeenCalledOnce();
    expect(readMarketingConsent).not.toHaveBeenCalled();
  });

  it('fails closed on a consent lookup failure or paused template', async () => {
    vi.mocked(readMarketingConsent).mockRejectedValueOnce(new Error('database unavailable'));
    await expect(sendEligibleTemplate(db, 'account-1', args)).rejects.toMatchObject({ code: 'marketing_consent_unavailable' });
    await expect(sendEligibleTemplate(db, 'account-1', {
      ...args, template: { ...template, status: 'PAUSED' },
    })).rejects.toMatchObject({ code: 'template_unavailable' });
    expect(sendTemplateMessage).not.toHaveBeenCalled();
  });
});
