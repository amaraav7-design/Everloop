import { sendNotification, WebPushError } from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { pushEndpoint } from './push-subscription';

export function webPushSettings() {
  const { EVERLOOP_VAPID_PUBLIC_KEY: publicKey, EVERLOOP_VAPID_PRIVATE_KEY: privateKey, EVERLOOP_VAPID_SUBJECT: subject } = process.env;
  if (!publicKey || !privateKey || !subject) return null;
  return { publicKey, privateKey, subject };
}

export async function notifyAssignedDevice(db: SupabaseClient, accountId: string, conversationId: string, userId: string) {
  const settings = webPushSettings();
  if (!settings) return;
  // Recheck membership right before delivery. A conversation can retain
  // its assignee for a short interval after that person leaves the team.
  const { data: membership } = await db.from('profiles').select('user_id')
    .eq('account_id', accountId).eq('user_id', userId).neq('account_role', 'viewer').maybeSingle();
  if (!membership) return;
  const { data, error } = await db.from('everloop_push_subscriptions')
    .select('endpoint, p256dh, auth_secret').eq('account_id', accountId).eq('user_id', userId)
    .order('updated_at', { ascending: false }).limit(8);
  if (error || !data) return;

  await Promise.allSettled(data.map(async row => {
    const endpoint = pushEndpoint(row.endpoint);
    if (!endpoint) return;
    try {
      await sendNotification(
        { endpoint, keys: { p256dh: row.p256dh, auth: row.auth_secret } },
        JSON.stringify({ conversation: conversationId }),
        { vapidDetails: settings, TTL: 60, timeout: 3000, topic: 'everloop-inbox' },
      );
    } catch (error) {
      if (error instanceof WebPushError && [404, 410].includes(error.statusCode)) {
        await db.from('everloop_push_subscriptions').delete().eq('endpoint', endpoint)
          .eq('account_id', accountId).eq('user_id', userId);
      }
    }
  }));
}
