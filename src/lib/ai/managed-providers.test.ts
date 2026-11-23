import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiConfig } from './types';
import { generateReply } from './generate';

const adapter = vi.hoisted(() => vi.fn());
vi.mock('./providers/openai-compatible', () => ({ generateOpenAiCompatible: adapter }));

const config: AiConfig = {
  provider: 'openrouter', model: 'openrouter/free', baseUrl: null, apiKey: 'synthetic-key',
  systemPrompt: null, isActive: true, autoReplyEnabled: false, autoReplyMaxPerConversation: 3,
  handoffAgentId: null, embeddingsApiKey: null, freeOnly: true,
};
const input = { config, systemPrompt: 'Answer briefly.', messages: [{ role: 'user' as const, content: 'Email example@example.com.' }] };

describe('managed AI providers', () => {
  beforeEach(() => { adapter.mockReset(); });

  it('blocks paid model IDs before a free-only provider request', async () => {
    await expect(generateReply({ ...input, config: { ...config, model: 'provider/paid-model' } })).rejects.toMatchObject({
      code: 'free_model_required',
    });
    expect(adapter).not.toHaveBeenCalled();
  });

  it('fixes the endpoint, enforces privacy and pricing options, and records the resolved model', async () => {
    adapter.mockResolvedValue({ text: 'Hello', usage: null, resolvedModel: 'provider/actual-free-model' });
    const result = await generateReply({ ...input, config: { ...config, baseUrl: 'https://example.invalid' } });
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://openrouter.ai/api/v1', messages: [{ role: 'user', content: 'Email [email].' }],
    }), expect.objectContaining({
      body: { provider: { data_collection: 'deny', zdr: true, max_price: { prompt: 0, completion: 0, request: 0 } } },
    }));
    expect(result.resolvedModel).toBe('provider/actual-free-model');
  });

  it('allows Google for a synthetic sample and blocks customer context', async () => {
    const google = { ...config, provider: 'google_ai_studio' as const, model: 'gemini-3.5-flash-lite' };
    await expect(generateReply({ ...input, config: google })).rejects.toMatchObject({ code: 'synthetic_only' });
    expect(adapter).not.toHaveBeenCalled();
    adapter.mockResolvedValue({ text: 'OK', usage: null });
    await generateReply({ ...input, config: google, synthetic: true, messages: [{ role: 'user', content: 'Fictional sample' }] });
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    }), expect.objectContaining({ label: 'Google AI Studio' }));
  });
});
