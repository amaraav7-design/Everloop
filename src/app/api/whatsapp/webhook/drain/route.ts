import { NextResponse } from 'next/server';
import { processWebhook, whatsappWebhookDb } from '@/lib/whatsapp/webhook-processor';
import { processWebhookReceipt, pruneWebhookReceipts } from '@/lib/whatsapp/webhook-queue';
import { whatsappWorkerAuthError } from '@/lib/whatsapp/worker-auth';

export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = whatsappWorkerAuthError(request);
  if (authError) return authError;

  try {
    const db = whatsappWebhookDb();
    const counts = { processed: 0, retry: 0, failed: 0 };
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && counts.processed + counts.retry + counts.failed < 20) {
      const outcome = await processWebhookReceipt(db, processWebhook);
      if (outcome === 'empty') break;
      counts[outcome]++;
    }
    if (process.env.WHATSAPP_PRUNE_WEBHOOK_RECEIPTS === 'true') {
      await pruneWebhookReceipts(db);
    }
    return NextResponse.json(counts);
  } catch {
    console.error('[whatsapp webhook] receipt drain failed');
    return NextResponse.json({ error: 'Could not drain WhatsApp webhook receipts' }, { status: 503 });
  }
}
