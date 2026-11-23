import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { campaignUuid } from '@/lib/whatsapp/campaign-queue';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { accountId } = await requireRole('agent');
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || !['pause', 'resume', 'cancel'].includes(body.action) || !campaignUuid.test(id)) {
      return NextResponse.json({ error: 'Invalid campaign action.' }, { status: 400 });
    }
    const { data, error } = await supabaseAdmin().rpc('control_campaign', {
      p_account: accountId, p_id: id, p_action: body.action,
    });
    if (error) throw error;
    if (!data) return NextResponse.json({ error: 'This action is unavailable for the campaign.' }, { status: 409 });
    return NextResponse.json({ status: data });
  } catch (error) {
    return toErrorResponse(error);
  }
}
