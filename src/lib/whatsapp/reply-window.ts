const CUSTOMER_SERVICE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function replyWindowExpiresAt(lastInboundAt: string | null | undefined): number | null {
  const receivedAt = lastInboundAt ? Date.parse(lastInboundAt) : NaN;
  return Number.isFinite(receivedAt) ? receivedAt + CUSTOMER_SERVICE_WINDOW_MS : null;
}

export function isReplyWindowOpen(
  lastInboundAt: string | null | undefined,
  now = Date.now(),
): boolean {
  const expiresAt = replyWindowExpiresAt(lastInboundAt);
  return expiresAt !== null && expiresAt - CUSTOMER_SERVICE_WINDOW_MS <= now && now < expiresAt;
}
