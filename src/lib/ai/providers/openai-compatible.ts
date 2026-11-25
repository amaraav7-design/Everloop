import { AiError, type ProviderResult } from '../types'
import { DEEPSEEK_API_BASE_URL, DEEPSEEK_DEFAULT_MODEL, MAX_OUTPUT_TOKENS } from '../defaults'
import {
  mergeConsecutive,
  normalizeUsage,
  providerHttpError,
  toNetworkError,
  type ProviderArgs,
} from './shared'
import { isDeliverableUrl } from '@/lib/webhooks/ssrf'
import { getT } from '@/lib/i18n/translate'

const t = getT('LibErrors')

const PRIVATE_HOST_ALLOWLIST_ENV = 'AI_PROVIDER_ALLOWED_PRIVATE_HOSTS'

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
}

function allowedPrivateHosts(): Set<string> {
  return new Set(
    (process.env[PRIVATE_HOST_ALLOWLIST_ENV] ?? '')
      .split(',')
      .map(normalizeHost)
      .filter(Boolean),
  )
}

export function normalizeOpenAiCompatibleBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, '')
  if (!value) {
    throw new AiError(t('ai.compatBaseUrlRequired'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new AiError(t('ai.compatBaseUrlInvalid'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new AiError(t('ai.compatBaseUrlProtocol'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.protocol === 'http:' && !allowedPrivateHosts().has(normalizeHost(parsed.hostname))) {
    throw new AiError(t('ai.compatBaseUrlHttpsRequired', { envVar: PRIVATE_HOST_ALLOWLIST_ENV }), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.username || parsed.password) {
    throw new AiError(t('ai.compatBaseUrlCredentials'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.search || parsed.hash) {
    throw new AiError(t('ai.compatBaseUrlQuery'), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (normalizeHost(parsed.hostname) === 'platform.deepseek.com') {
    throw new AiError(t('ai.deepSeekDashboardUrl', { endpoint: DEEPSEEK_API_BASE_URL }), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  if (parsed.origin === DEEPSEEK_API_BASE_URL) {
    const pathname = parsed.pathname.replace(/\/+$/, '')
    if (pathname === '' || pathname === '/v1' || pathname === '/chat/completions' || pathname === '/v1/chat/completions') {
      return `${DEEPSEEK_API_BASE_URL}/chat/completions`
    }
    throw new AiError(t('ai.deepSeekChatUrl', { endpoint: DEEPSEEK_API_BASE_URL }), {
      code: 'invalid_base_url',
      status: 400,
    })
  }

  const normalized = parsed.toString().replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

interface OpenAiCompatibleResponse {
  model?: string
  error?: { code?: number }
  choices?: { finish_reason?: string; message?: { content?: string | null } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

function deepSeekHttpError(status: number): AiError | undefined {
  if (status === 402) {
    return new AiError(t('ai.deepSeekBalance'), { code: 'provider_budget', status: 402 })
  }
  if (status === 404) {
    return new AiError(t('ai.deepSeekModel', { model: DEEPSEEK_DEFAULT_MODEL }), { code: 'provider_model_unavailable', status: 404 })
  }
  if (status === 405) {
    return new AiError(t('ai.deepSeekChatUrl', { endpoint: DEEPSEEK_API_BASE_URL }), { code: 'invalid_base_url', status: 400 })
  }
}

export async function generateOpenAiCompatible(
  args: ProviderArgs,
  options?: {
    label: string
    body?: Record<string, unknown>
    errorForStatus?: (status: number) => AiError | undefined
  },
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args
  const endpoint = normalizeOpenAiCompatibleBaseUrl(baseUrl ?? '')
  const deepSeek = endpoint === `${DEEPSEEK_API_BASE_URL}/chat/completions`
  const label = deepSeek ? 'DeepSeek' : options?.label ?? 'OpenAI-compatible provider'
  const errorForStatus = deepSeek ? deepSeekHttpError : options?.errorForStatus
  if (deepSeek && ['deepseek-chat', 'deepseek-reasoner', 'deepseek flash'].includes(model.toLowerCase())) {
    throw new AiError(t('ai.deepSeekModel', { model: DEEPSEEK_DEFAULT_MODEL }), { code: 'invalid_model', status: 400 })
  }

  let deliverable = false
  try {
    deliverable = await isDeliverableUrl(endpoint, {
      allowPrivateHosts: allowedPrivateHosts(),
    })
  } catch {
    deliverable = false
  }

  if (!deliverable) {
    throw new AiError(t('ai.compatBlockedUrl', { envVar: PRIVATE_HOST_ALLOWLIST_ENV }), {
      code: 'blocked_url',
      status: 400,
    })
  }

  let res: Response
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: systemPrompt }, ...mergeConsecutive(messages)],
        max_tokens: MAX_OUTPUT_TOKENS,
        ...options?.body,
        ...(deepSeek ? { thinking: { type: 'disabled' } } : {}),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  if (!res.ok) {
    const error = errorForStatus?.(res.status)
    if (error) throw error
    // Keep provider error bodies out of the UI because they may echo inputs.
    throw await providerHttpError(label, new Response(null, { status: res.status }))
  }

  const data = (await res.json().catch(() => null)) as OpenAiCompatibleResponse | null
  const choice = data?.choices?.[0]
  const text = choice?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    const status = data?.error?.code
    if (typeof status === 'number' && Number.isInteger(status) && status >= 400 && status < 600) {
      throw errorForStatus?.(status) ?? await providerHttpError(label, new Response(null, { status }))
    }
    if (choice?.finish_reason === 'length') {
      throw new AiError(t('ai.incompleteProviderReply', { provider: label }), { code: 'incomplete_response' })
    }
    throw new AiError(t('ai.emptyResponse', { provider: label }), {
      code: 'empty_response',
    })
  }

  return {
    text,
    ...(options && data?.model ? { resolvedModel: data.model } : {}),
    usage: normalizeUsage({
      prompt: data?.usage?.prompt_tokens,
      completion: data?.usage?.completion_tokens,
      total: data?.usage?.total_tokens,
    }),
  }
}
