import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CampaignSummary } from '@/lib/whatsapp/campaign-input';

const accountId = '20000000-0000-4000-8000-000000000001';
const summary: CampaignSummary = {
  total: 1,
  eligible: 1,
  duplicates: 0,
  exclusions: {
    invalid_phone: 0,
    marketing_opt_out: 0,
    marketing_consent_required: 0,
    invalid_template_parameters: 0,
  },
  example: 'Fictional campaign preview',
};
const enqueueCampaign = vi.fn();

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId, userId: 'fixture-user', supabase: {} }),
  toErrorResponse: (error: unknown) => { throw error; },
}));
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }));
vi.mock('@/lib/broadcast-audience', () => ({
  resolveAudienceContacts: async () => [{
    id: '40000000-0000-4000-8000-000000000001',
    phone: '+14155550101',
  }],
}));
vi.mock('@/lib/whatsapp/campaign-queue', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/whatsapp/campaign-queue')>(),
  findQueuedCampaign: async () => null,
  campaignTemplate: async () => ({}),
  campaignPreflight: async () => ({ summary, recipients: [] }),
  enqueueCampaign: (...args: unknown[]) => enqueueCampaign(...args),
}));

import { POST } from './route';

function campaignRequest(action: 'preview' | 'launch' | 'test'): Request {
  return new Request('http://localhost/api/whatsapp/campaigns', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `fixture-${action}` },
    body: JSON.stringify({
      action,
      name: 'Fictional campaign',
      templateId: '80000000-0000-4000-8000-000000000001',
      audience: { type: 'all' },
      variables: {},
      ...(action === 'test' ? { testTo: '+14155550101' } : {}),
    }),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  enqueueCampaign.mockClear();
});

describe('campaign sending readiness', () => {
  it.each([
    { secret: undefined, allowlist: accountId, sendingConfigured: false },
    { secret: 'fictional-worker-secret', allowlist: '', sendingConfigured: false },
    { secret: 'fictional-worker-secret', allowlist: accountId, sendingConfigured: true },
  ])('returns the audience preview with sendingConfigured=$sendingConfigured', async ({ secret, allowlist, sendingConfigured }) => {
    vi.stubEnv('WHATSAPP_WORKER_CRON_SECRET', secret);
    vi.stubEnv('WHATSAPP_CAMPAIGN_ACCOUNTS', allowlist);

    const response = await POST(campaignRequest('preview'));
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({ summary, sendingConfigured });
    expect(enqueueCampaign).not.toHaveBeenCalled();
  });

  it.each(['launch', 'test'] as const)('rejects %s while the worker is unconfigured', async (action) => {
    vi.stubEnv('WHATSAPP_WORKER_CRON_SECRET', undefined);
    vi.stubEnv('WHATSAPP_CAMPAIGN_ACCOUNTS', accountId);

    const response = await POST(campaignRequest(action));
    expect(response.status).toBe(503);
    expect(enqueueCampaign).not.toHaveBeenCalled();
  });
});
