import { AiError } from './types'

export type ManagedAiProvider = 'openrouter' | 'google_ai_studio'

export const MANAGED_PROVIDER_LABEL = {
  openrouter: 'OpenRouter',
  google_ai_studio: 'Google AI Studio',
} as const

export const MANAGED_PROVIDER_URL = {
  openrouter: 'https://openrouter.ai/api/v1',
  google_ai_studio: 'https://generativelanguage.googleapis.com/v1beta/openai',
} as const

// Google publishes free-tier availability by model, but the Gemini API
// does not report the caller project's billing tier.
export const GOOGLE_FREE_TEXT_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'] as const

export function isManagedProvider(value: unknown): value is ManagedAiProvider {
  return value === 'openrouter' || value === 'google_ai_studio'
}

export function isOpenRouterFreeModel(model: string) {
  return model === 'openrouter/free' || /^[a-z0-9_.-]+\/[a-z0-9_.-]+:free$/i.test(model)
}

export function validateManagedModel(provider: ManagedAiProvider, model: string, freeOnly: boolean) {
  if (
    (provider === 'google_ai_studio' && !GOOGLE_FREE_TEXT_MODELS.some(choice => choice === model)) ||
    (provider === 'openrouter' && freeOnly && !isOpenRouterFreeModel(model))
  ) {
    throw new AiError('Choose an available free text model for this provider.', { code: 'free_model_required', status: 400 })
  }
  if (model.length > 160 || !/^[a-z0-9][a-z0-9_.:/-]*$/i.test(model)) {
    throw new AiError('Enter a valid model ID.', { code: 'invalid_model', status: 400 })
  }
}

export function managedAutoReplyEnabled(accountId: string) {
  return (process.env.EVERLOOP_AI_AUTO_REPLY_ACCOUNTS ?? '').split(',').some(id => id.trim() === accountId)
}

export function redactAiText(value: string) {
  return value
    .replace(/https?:\/\/[^\s<>"']+/gi, '[link]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/(?:\+?\d[\s().-]*){8,15}(?!\d)/g, '[number]')
}
