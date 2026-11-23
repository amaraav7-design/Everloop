import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { reserveSendAttempt } from './outbound-attempts';

function attemptsDb() {
  const state = { row: null as Record<string, unknown> | null };
  const query = {
    insert: vi.fn(async (row: Record<string, unknown>) => {
      if (state.row) return { error: { code: '23505' } };
      state.row = row;
      return { error: null };
    }),
    select: () => query,
    eq: () => query,
    single: async () => ({ data: state.row, error: null }),
  };
  return { db: { from: () => query } as unknown as SupabaseClient, state };
}

describe('outbound send attempts', () => {
  const payload = { type: 'text', text: 'hello' };

  it('reserves a key before dispatch and refuses a concurrent or uncertain replay', async () => {
    const { db } = attemptsDb();
    await expect(reserveSendAttempt(db, 'thread', payload, 'request-1'))
      .resolves.toMatchObject({ key: 'request-1', previous: null, callbackId: expect.any(String) });
    await expect(reserveSendAttempt(db, 'thread', payload, 'request-1'))
      .resolves.toEqual({ key: 'request-1', previous: 'uncertain' });
    await expect(reserveSendAttempt(db, 'thread', { ...payload, text: 'changed' }, 'request-1'))
      .resolves.toEqual({ key: 'request-1', previous: 'conflict' });
  });

  it('returns already-saved identifiers without another Meta call', async () => {
    const { db, state } = attemptsDb();
    await reserveSendAttempt(db, 'thread', payload, 'request-1');
    Object.assign(state.row!, { state: 'saved', message_id: 'message-1', provider_message_id: 'wamid.1' });
    await expect(reserveSendAttempt(db, 'thread', payload, 'request-1')).resolves.toEqual({
      key: 'request-1', previous: { messageId: 'message-1', whatsappMessageId: 'wamid.1' },
    });
  });
});
