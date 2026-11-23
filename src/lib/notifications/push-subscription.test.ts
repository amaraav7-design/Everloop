import { describe, expect, it } from 'vitest';
import { pushEndpoint, readPushSubscription } from './push-subscription';

describe('web push subscription destinations', () => {
  it('recognizes browser push services with HTTPS', () => {
    expect(pushEndpoint('https://web.push.apple.com/Qpush')).toBe('https://web.push.apple.com/Qpush');
    expect(pushEndpoint('https://fcm.googleapis.com/fcm/send/example')).toBe('https://fcm.googleapis.com/fcm/send/example');
    expect(pushEndpoint('https://updates.push.services.mozilla.com/wpush/example')).not.toBeNull();
  });

  it('rejects arbitrary endpoints, credentials, ports, and fragments', () => {
    for (const url of [
      'https://127.0.0.1/private', 'http://fcm.googleapis.com/example', 'https://web.push.apple.com.example.com/path',
      'https://agent@web.push.apple.com/path', 'https://fcm.googleapis.com:8080/path', 'https://fcm.googleapis.com/path#fragment',
    ]) expect(pushEndpoint(url)).toBeNull();
  });

  it('recognizes a subscription only with correctly shaped keys', () => {
    const endpoint = 'https://fcm.googleapis.com/example';
    const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url');
    const auth = Buffer.alloc(16).toString('base64url');
    expect(readPushSubscription({ endpoint, keys: { p256dh, auth } })).toEqual({ endpoint, p256dh, auth_secret: auth });
    expect(readPushSubscription({ endpoint, keys: { p256dh, auth: 'invalid' } })).toBeNull();
  });
});
