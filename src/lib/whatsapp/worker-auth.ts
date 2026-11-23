import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

export function whatsappWorkerAuthError(request: Request): NextResponse | null {
  const secret = process.env.WHATSAPP_WORKER_CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'WhatsApp worker is not configured' }, { status: 503 });
  const authorization = request.headers.get('authorization') ?? '';
  const supplied = request.headers.get('x-cron-secret') ?? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] ?? '';
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
