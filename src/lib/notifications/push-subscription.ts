const PUSH_HOSTS = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);

export function pushEndpoint(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.pathname === '/') return null;
    if (!(PUSH_HOSTS.has(url.hostname) || url.hostname.endsWith('.notify.windows.com') || url.hostname.endsWith('.push.apple.com'))) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function readPushSubscription(input: unknown) {
  if (!input || typeof input !== 'object') return null;
  const { endpoint, keys } = input as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  const url = pushEndpoint(endpoint);
  if (!url || typeof keys?.p256dh !== 'string' || typeof keys.auth !== 'string') return null;
  if (!/^[A-Za-z0-9_-]{87}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]{22}$/.test(keys.auth)) return null;
  const point = Buffer.from(keys.p256dh, 'base64url');
  if (point.length !== 65 || point[0] !== 4 || Buffer.from(keys.auth, 'base64url').length !== 16) return null;
  return { endpoint: url, p256dh: keys.p256dh, auth_secret: keys.auth };
}
