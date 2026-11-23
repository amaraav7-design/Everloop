import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ProviderResult,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateOpenAiCompatible } from './providers/openai-compatible'
import { generateAnthropic } from './providers/anthropic'
import { MANAGED_PROVIDER_LABEL, MANAGED_PROVIDER_URL, redactAiText, validateManagedModel } from './managed-providers'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
  synthetic?: boolean
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
    baseUrl: config.baseUrl,
  }

  let result: ProviderResult
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'openai_compatible':
      result = await generateOpenAiCompatible(providerArgs)
      break
    case 'openrouter':
    case 'google_ai_studio': {
      const provider = config.provider
      const freeOnly = config.freeOnly !== false
      validateManagedModel(provider, config.model, freeOnly)
      if (provider === 'google_ai_studio' && !args.synthetic) {
        throw new AiError('Google AI Studio is available for synthetic testing. Choose another connection for customer drafts.', {
          code: 'synthetic_only', status: 403,
        })
      }
      const openRouterRouting = provider === 'openrouter' ? {
        provider: {
          ...(!args.synthetic ? { data_collection: 'deny', zdr: true } : {}),
          ...(freeOnly ? { max_price: { prompt: 0, completion: 0, request: 0 } } : {}),
        },
      } : undefined
      const scopedArgs = args.synthetic ? providerArgs : {
        ...providerArgs,
        systemPrompt: redactAiText(systemPrompt.slice(0, 12_000)),
        messages: messages.slice(-10).map(message => ({ ...message, content: redactAiText(message.content.slice(0, 2000)) })),
      }
      result = await generateOpenAiCompatible({ ...scopedArgs, baseUrl: MANAGED_PROVIDER_URL[provider] }, {
        body: openRouterRouting, label: MANAGED_PROVIDER_LABEL[provider], suppressUpstreamError: true,
      })
      break
    }
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  const generation = parseGeneration(result.text, result.usage)
  return result.resolvedModel ? { ...generation, resolvedModel: result.resolvedModel } : generation
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const handoff = raw.includes(HANDOFF_SENTINEL)
  const text = raw.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage }
}
