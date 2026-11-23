import { supabaseAdmin } from './admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { AiError } from './types'
import type { ManagedAiProvider } from './managed-providers'

export async function readAiConnection(accountId: string, provider: ManagedAiProvider) {
  const { data, error } = await supabaseAdmin().from('ai_provider_connections')
    .select('api_key, model, free_only').eq('account_id', accountId).eq('provider', provider)
    .maybeSingle<{ api_key: string; model: string; free_only: boolean }>()
  if (error) throw new AiError('Could not read the saved AI connection.', { code: 'connection_unavailable', status: 503 })
  return data
}

export function decryptAiConnection(secret: string) {
  try {
    return decrypt(secret)
  } catch {
    throw new AiError('The saved API key could not be opened. Enter the key again.', { code: 'key_decrypt_failed', status: 400 })
  }
}
