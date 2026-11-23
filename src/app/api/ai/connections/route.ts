import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/ai/admin-client'
import { managedAutoReplyEnabled } from '@/lib/ai/managed-providers'

export async function GET() {
  try {
    const { accountId } = await requireRole('admin')
    const { data, error } = await supabaseAdmin().from('ai_provider_connections')
      .select('provider, model, free_only').eq('account_id', accountId)
    if (error) throw error
    return NextResponse.json({
      connections: data,
      auto_reply_pilot: managedAutoReplyEnabled(accountId),
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return toErrorResponse(error)
  }
}
