import { AiError, type ProviderResult } from '../types'
import { MAX_OUTPUT_TOKENS } from '../defaults'
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

  const normalized = parsed.toString().replace(/\/+$/, '')
  return normalized.endsWith('/chat/completions')
    ? normalized
    : `${normalized}/chat/completions`
}

interface OpenAiCompatibleResponse {
  model?: string
  error?: { code?: number }
  choices?: { message?: { content?: string } }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
}

export async function generateOpenAiCompatible(
  args: ProviderArgs,
  options?: {
    label: string
    body?: Record<string, unknown>
    suppressUpstreamError?: boolean
    errorForStatus?: (status: number) => AiError | undefined
  },
): Promise<ProviderResult> {
  const { apiKey, model, systemPrompt, messages, timeoutMs, baseUrl } = args
  const endpoint = normalizeOpenAiCompatibleBaseUrl(baseUrl ?? '')

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
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }

  const label = options?.label ?? 'OpenAI-compatible provider'
  if (!res.ok) {
    const error = options?.errorForStatus?.(res.status)
    if (error) throw error
    // A BYO provider can echo inputs in its error. Avoid returning those
    // payloads through the managed provider settings or chat routes.
    if (options?.suppressUpstreamError) throw await providerHttpError(label, new Response(null, { status: res.status }))
    throw await providerHttpError(label, res)
  }

  const data = (await res.json().catch(() => null)) as OpenAiCompatibleResponse | null
  const text = data?.choices?.[0]?.message?.content
  if (!text || typeof text !== 'string' || !text.trim()) {
    if (options?.errorForStatus && typeof data?.error?.code === 'number' &&
        data.error.code >= 400 && data.error.code < 600) {
      throw options.errorForStatus(data.error.code) ??
        await providerHttpError(label, new Response(null, { status: data.error.code }))
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
