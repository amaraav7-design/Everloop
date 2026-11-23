import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whatsappWebhookDb } from '@/lib/whatsapp/webhook-processor';
import { processWebhookReceipt, pruneWebhookReceipts } from '@/lib/whatsapp/webhook-queue';
import { GET } from './route';

vi.mock('@/lib/whatsapp/webhook-processor', () => ({
  processWebhook: vi.fn(),
  whatsappWebhookDb: vi.fn(),
}));

vi.mock('@/lib/whatsapp/webhook-queue', () => ({
  processWebhookReceipt: vi.fn(),
  pruneWebhookReceipts: vi.fn(),
}));

const workerSecret = 'local-test-worker-secret';

function request(headers?: HeadersInit) {
  return new Request('http://localhost/api/whatsapp/webhook/drain', { headers });
}

describe('WhatsApp webhook recovery worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('WHATSAPP_WORKER_CRON_SECRET', workerSecret);
    vi.stubEnv('WHATSAPP_PRUNE_WEBHOOK_RECEIPTS', undefined);
    vi.mocked(processWebhookReceipt).mockResolvedValue('empty');
  });

  afterEach(() => vi.unstubAllEnvs());

  it('leaves the worker unavailable when its dedicated secret is missing', async () => {
    vi.stubEnv('WHATSAPP_WORKER_CRON_SECRET', undefined);
    expect((await GET(request({ authorization: `Bearer ${workerSecret}` }))).status).toBe(503);
    expect(whatsappWebhookDb).not.toHaveBeenCalled();
  });

  it('rejects an unrelated bearer secret before opening the database', async () => {
    vi.stubEnv('CRON_SECRET', 'other-scheduler-secret');
    expect((await GET(request({ authorization: 'Bearer other-scheduler-secret' }))).status).toBe(401);
    expect(whatsappWebhookDb).not.toHaveBeenCalled();
  });

  it('continues to accept the existing scheduler header and preserves receipts by default', async () => {
    const response = await GET(request({ 'x-cron-secret': workerSecret }));
    expect(response.status).toBe(200);
    expect(processWebhookReceipt).toHaveBeenCalledOnce();
    expect(pruneWebhookReceipts).not.toHaveBeenCalled();
  });

  it('accepts the dedicated key as a bearer token and prunes only when enabled', async () => {
    vi.stubEnv('WHATSAPP_PRUNE_WEBHOOK_RECEIPTS', 'true');
    const response = await GET(request({ authorization: `Bearer ${workerSecret}` }));
    expect(response.status).toBe(200);
    expect(pruneWebhookReceipts).toHaveBeenCalledOnce();
  });
});
