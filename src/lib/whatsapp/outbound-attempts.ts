import { createHash, randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { isUniqueViolation } from '@/lib/contacts/dedupe';

interface SendResult { messageId: string; whatsappMessageId: string }
export type AttemptState = 'rejected' | 'uncertain' | 'accepted' | 'saved';
const TABLE = 'whatsapp_outbound_attempts';

export function isValidSendRequestKey(value: string) {
  return /^[A-Za-z0-9._:-]{1,128}$/.test(value);
}

export async function reserveSendAttempt(db: SupabaseClient, conversationId: string, payload: object, requestKey?: string) {
  const key = requestKey ?? randomUUID();
  const callbackId = randomUUID();
  const hash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const { error } = await db.from(TABLE).insert({
    conversation_id: conversationId, request_key: key, payload_hash: hash, state: 'sending', callback_id: callbackId,
  });
  if (!error) return { key, previous: null, callbackId };
  if (!isUniqueViolation(error)) throw new Error('Could not reserve outbound WhatsApp attempt');

  const { data: attempt, error: readError } = await db.from(TABLE)
    .select('payload_hash,state,provider_message_id,message_id')
    .eq('conversation_id', conversationId).eq('request_key', key).single();
  if (readError || !attempt) throw new Error('Could not load outbound WhatsApp attempt');
  if (attempt.payload_hash !== hash) return { key, previous: 'conflict' as const };
  if (attempt.state === 'saved' && attempt.message_id && attempt.provider_message_id) {
    const previous: SendResult = { messageId: attempt.message_id, whatsappMessageId: attempt.provider_message_id };
    return { key, previous };
  }
  if (attempt.state === 'accepted' && attempt.provider_message_id) return { key, previous: 'confirmed' as const };
  return { key, previous: attempt.state === 'rejected' ? 'rejected' as const : 'uncertain' as const };
}

export async function settleSendAttempt(
  db: SupabaseClient, conversationId: string, key: string, state: AttemptState,
  ids: { providerMessageId?: string; messageId?: string } = {},
) {
  let query = db.from(TABLE).update({
    state,
    updated_at: new Date().toISOString(),
    ...(ids.providerMessageId ? { provider_message_id: ids.providerMessageId } : {}),
    ...(ids.messageId ? { message_id: ids.messageId } : {}),
  }).eq('conversation_id', conversationId).eq('request_key', key);
  if (state === 'rejected' || state === 'uncertain') query = query.eq('state', 'sending');
  if (state === 'accepted') query = query.neq('state', 'saved');
  const { error } = await query;
  if (error) console.error('[whatsapp send] could not save attempt state', conversationId, state);
}
