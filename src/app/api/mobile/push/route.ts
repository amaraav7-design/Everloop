import { createHash } from 'node:crypto';
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { pushEndpoint, readPushSubscription } from '@/lib/notifications/push-subscription';
import { webPushSettings } from '@/lib/notifications/web-push';

export async function GET() {
  try {
    const { accountId, userId } = await requireRole('agent');
    const config = webPushSettings();
    if (!config) return NextResponse.json({ key: null, devices: [] });
    const { data, error } = await supabaseAdmin().from('everloop_push_subscriptions')
      .select('endpoint').eq('account_id', accountId).eq('user_id', userId).order('updated_at', { ascending: false }).limit(8);
    if (error) throw error;
    const devices = (data ?? []).map(row => createHash('sha256').update(row.endpoint).digest('hex'));
    return NextResponse.json({ key: config.publicKey, devices });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const { userId, accountId } = await requireRole('agent');
    if (!webPushSettings()) return NextResponse.json({ error: 'Push is unavailable' }, { status: 503 });
    const limit = checkRateLimit(`push:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const subscription = readPushSubscription(await request.json().catch(() => null));
    if (!subscription) return NextResponse.json({ error: 'Invalid device subscription' }, { status: 400 });
    const { error } = await supabaseAdmin().from('everloop_push_subscriptions').upsert({
      ...subscription, user_id: userId, account_id: accountId, updated_at: new Date().toISOString(),
    }, { onConflict: 'endpoint' });
    if (error) throw error;
    return NextResponse.json({ registered: true });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const { userId, accountId } = await requireRole('viewer');
    const body = await request.json().catch(() => null);
    const endpoint = pushEndpoint(body?.endpoint);
    if (!endpoint) return NextResponse.json({ error: 'Invalid device subscription' }, { status: 400 });
    const { error } = await supabaseAdmin().from('everloop_push_subscriptions').delete()
      .eq('endpoint', endpoint).eq('user_id', userId).eq('account_id', accountId);
    if (error) throw error;
    return NextResponse.json({ registered: false });
  } catch (error) {
    return toErrorResponse(error);
  }
}
