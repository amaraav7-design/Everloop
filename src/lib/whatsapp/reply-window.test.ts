import { describe, expect, it } from 'vitest';
import { isReplyWindowOpen, replyWindowExpiresAt } from './reply-window';

describe('WhatsApp customer service window', () => {
  const inbound = '2026-11-21T06:00:00.000Z';
  const expiresAt = Date.parse('2026-11-22T06:00:00.000Z');

  it('expires on the exact 24-hour boundary', () => {
    expect(replyWindowExpiresAt(inbound)).toBe(expiresAt);
    expect(isReplyWindowOpen(inbound, expiresAt - 1)).toBe(true);
    expect(isReplyWindowOpen(inbound, expiresAt)).toBe(false);
  });

  it('requires a valid customer timestamp that has already occurred', () => {
    expect(isReplyWindowOpen(null, expiresAt)).toBe(false);
    expect(isReplyWindowOpen('invalid', expiresAt)).toBe(false);
    expect(isReplyWindowOpen(inbound, Date.parse(inbound) - 1)).toBe(false);
  });
});
