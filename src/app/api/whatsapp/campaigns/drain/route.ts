import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { deliverNextCampaignJob } from '@/lib/whatsapp/campaign-queue';
import { whatsappWorkerAuthError } from '@/lib/whatsapp/worker-auth';

export const maxDuration = 60;

export async function GET(request: Request) {
  const authError = whatsappWorkerAuthError(request);
  if (authError) return authError;
  try {
    const counts = { sent: 0, failed: 0, skipped: 0, excluded: 0, uncertain: 0, retry: 0 };
    const db = supabaseAdmin();
    const deadline = Date.now() + 28_000;
    for (let i = 0; i < 120 && Date.now() < deadline; i++) {
      const result = await deliverNextCampaignJob(db);
      if (result === 'empty') break;
      counts[result]++;
    }
    return NextResponse.json(counts, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.error('[campaign] worker drain failed');
    return NextResponse.json({ error: 'Could not drain campaigns' }, { status: 503 });
  }
}
