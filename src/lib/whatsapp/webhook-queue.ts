import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const MAX_ATTEMPTS = 8;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

interface Receipt<T> {
  delivery_key: string;
  lease_id: string;
  attempts: number;
  payload: T;
}

export async function enqueueWebhookReceipt(db: SupabaseClient, rawBody: string, payload: object) {
  const key = createHash('sha256').update(rawBody).digest('hex');
  const { error } = await db.from('whatsapp_webhook_receipts').upsert(
    { delivery_key: key, payload },
    { onConflict: 'delivery_key', ignoreDuplicates: true },
  );
  if (error) throw new Error('Could not persist WhatsApp webhook receipt');
  return key;
}

export async function processWebhookReceipt<T>(
  db: SupabaseClient,
  process: (payload: T) => Promise<void>,
  key?: string,
): Promise<'processed' | 'retry' | 'failed' | 'empty'> {
  const { data, error } = await db.rpc('claim_whatsapp_webhook_receipt', { p_delivery_key: key ?? null });
  if (error) throw new Error('Could not claim WhatsApp webhook receipt');
  const receipt = (data as Receipt<T>[] | null)?.[0];
  if (!receipt) return 'empty';

  let outcome: 'processed' | 'retry' | 'failed' = 'processed';
  try {
    await process(receipt.payload);
  } catch {
    outcome = receipt.attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
    // The payload and provider error can contain customer content.
    console.error('[whatsapp webhook] delivery processing failed', receipt.delivery_key, receipt.attempts);
  }

  const now = new Date();
  const update = outcome === 'processed'
    ? { payload: null, completed_at: now.toISOString() }
    : outcome === 'failed'
      ? { failed_at: now.toISOString() }
      : { retry_at: new Date(now.getTime() + Math.min(3600, 30 * 2 ** receipt.attempts) * 1000).toISOString() };
  const { error: saveError } = await db.from('whatsapp_webhook_receipts')
    .update({ ...update, lease_id: null, lease_until: null })
    .eq('delivery_key', receipt.delivery_key).eq('lease_id', receipt.lease_id);
  if (saveError) throw new Error('Could not settle WhatsApp webhook receipt');
  return outcome;
}

export async function pruneWebhookReceipts(db: SupabaseClient) {
  const cutoff = new Date(Date.now() - RETENTION_MS).toISOString();
  const results = await Promise.all([
    db.from('whatsapp_webhook_receipts').delete().lt('completed_at', cutoff),
    db.from('whatsapp_webhook_receipts').delete().lt('failed_at', cutoff),
  ]);
  if (results.some(({ error }) => error)) throw new Error('Could not prune WhatsApp webhook receipts');
}
