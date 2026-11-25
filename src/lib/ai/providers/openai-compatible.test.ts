import { describe, expect, it, vi } from 'vitest'
import { generateOpenAiCompatible, normalizeOpenAiCompatibleBaseUrl } from './openai-compatible'
import { AiError } from '../types'

vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '1.1.1.1', family: 4 }]),
}))

describe('normalizeOpenAiCompatibleBaseUrl', () => {
  it('appends /chat/completions to a base URL', () => {
    expect(normalizeOpenAiCompatibleBaseUrl('https://8.8.8.8/v1')).toBe(
      'https://8.8.8.8/v1/chat/completions',
    )
  })

  it('does not duplicate an existing endpoint path', () => {
    expect(
      normalizeOpenAiCompatibleBaseUrl('https://8.8.8.8/v1/chat/completions'),
    ).toBe('https://8.8.8.8/v1/chat/completions')
  })

  it('accepts http for explicitly allow-listed self-hosted servers', () => {
    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = '127.0.0.1'
    try {
      expect(normalizeOpenAiCompatibleBaseUrl('http://127.0.0.1:11434/v1')).toBe(
        'http://127.0.0.1:11434/v1/chat/completions',
      )
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('rejects plain http for a host that is not allow-listed', () => {
    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = '127.0.0.1'
    try {
      expect(() => normalizeOpenAiCompatibleBaseUrl('http://8.8.8.8/v1')).toThrow(
        /must use https:\/\//,
      )
      expect(() => normalizeOpenAiCompatibleBaseUrl('http://api.groq.com/openai/v1')).toThrow(
        /must use https:\/\//,
      )
      expect(() => normalizeOpenAiCompatibleBaseUrl('http://127.0.0.2:11434/v1')).toThrow(
        /must use https:\/\//,
      )
      expect(normalizeOpenAiCompatibleBaseUrl('https://api.groq.com/openai/v1')).toBe(
        'https://api.groq.com/openai/v1/chat/completions',
      )
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('rejects plain http when no allow-list is configured', () => {
    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    try {
      expect(() => normalizeOpenAiCompatibleBaseUrl('http://127.0.0.1:11434/v1')).toThrow(
        /must use https:\/\//,
      )
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('rejects credentials, query strings, fragments, and unsupported protocols', () => {
    expect(() => normalizeOpenAiCompatibleBaseUrl('https://user:pass@8.8.8.8/v1')).toThrow(
      /embedded credentials/,
    )
    expect(() => normalizeOpenAiCompatibleBaseUrl('https://8.8.8.8/v1?x=1')).toThrow(
      /query string or fragment/,
    )
    expect(() => normalizeOpenAiCompatibleBaseUrl('https://8.8.8.8/v1#x')).toThrow(
      /query string or fragment/,
    )
    expect(() => normalizeOpenAiCompatibleBaseUrl('ftp://8.8.8.8/v1')).toThrow(
      /http:\/\/ or https:\/\//,
    )
  })
})

describe('DeepSeek chat configuration', () => {
  const args = {
    apiKey: 'fictional-key',
    model: 'deepseek-flash',
    systemPrompt: 'Fictional test',
    messages: [{ role: 'user' as const, content: 'ping' }],
    timeoutMs: 1000,
    baseUrl: 'https://api.deepseek.com',
  }

  it('rejects the key-management dashboard before transmitting a credential', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(generateOpenAiCompatible({ ...args, baseUrl: 'https://platform.deepseek.com/api_keys' }))
        .rejects.toMatchObject({ code: 'invalid_base_url', message: expect.stringContaining('https://api.deepseek.com') })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('normalizes the official DeepSeek API URL and its legacy aliases to the same endpoint', () => {
    for (const baseUrl of [args.baseUrl, args.baseUrl + '/v1/', args.baseUrl + '/v1/chat/completions']) {
      expect(normalizeOpenAiCompatibleBaseUrl(baseUrl)).toBe(args.baseUrl + '/chat/completions')
    }
    expect(() => normalizeOpenAiCompatibleBaseUrl(args.baseUrl + '/anthropic')).toThrow(/DeepSeek chat/)
  })

  it('uses non-thinking mode for a short WhatsApp reply on the official endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ choices: [{ message: { content: 'OK' } }] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(generateOpenAiCompatible({ ...args, baseUrl: args.baseUrl + '/v1' }))
        .resolves.toMatchObject({ text: 'OK' })
      expect(fetchMock).toHaveBeenCalledOnce()
      expect(fetchMock.mock.calls[0][0]).toBe(args.baseUrl + '/chat/completions')
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
        model: 'deepseek-flash', max_tokens: 1024, thinking: { type: 'disabled' },
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it.each([[402, 'provider_budget'], [404, 'provider_model_unavailable']] as const)(
    'reports DeepSeek HTTP %s without exposing upstream error text',
    async (status, code) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
        error: { message: 'Fictional upstream private diagnostic' },
      }, { status })))
      try {
        await expect(generateOpenAiCompatible(args)).rejects.toMatchObject({ code, status })
      } finally {
        vi.unstubAllGlobals()
      }
    },
  )

  it('reports an output limit as incomplete rather than a connection failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({
      choices: [{ finish_reason: 'length', message: { content: null } }],
    })))
    try {
      await expect(generateOpenAiCompatible(args)).rejects.toMatchObject({ code: 'incomplete_response' })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('generateOpenAiCompatible', () => {
  it.each([404, 200])('maps a managed provider route error without exposing the upstream payload (HTTP %s)', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({
      error: { code: 404, message: 'private provider diagnostic' },
    }, { status }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await expect(generateOpenAiCompatible({
        apiKey: 'test-key',
        model: 'openrouter/free',
        systemPrompt: 'Fictional test',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 1000,
        baseUrl: 'https://8.8.8.8/v1',
      }, {
        label: 'OpenRouter',
        errorForStatus: status => status === 404
          ? new AiError('No eligible model route', { code: 'provider_route_unavailable', status: 503 })
          : undefined,
      })).rejects.toMatchObject({
        message: 'No eligible model route',
        code: 'provider_route_unavailable',
        status: 503,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('blocks private addresses by default', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    try {
      await expect(
        generateOpenAiCompatible({
          apiKey: 'test-key',
          model: 'llama3.2',
          systemPrompt: 'sys',
          messages: [{ role: 'user', content: 'Hi' }],
          timeoutMs: 1000,
          baseUrl: 'https://127.0.0.1:11434/v1',
        }),
      ).rejects.toMatchObject({ code: 'blocked_url', status: 400 })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('allows a private address only when the operator explicitly allow-lists it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Local reply' } }],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const previous = process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
    process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = '127.0.0.1'
    try {
      const result = await generateOpenAiCompatible({
        apiKey: 'test-key',
        model: 'llama3.2',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 1000,
        baseUrl: 'http://127.0.0.1:11434/v1',
      })
      expect(result).toEqual({
        text: 'Local reply',
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      })
      expect(fetchMock).toHaveBeenCalledOnce()
    } finally {
      if (previous === undefined) delete process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS
      else process.env.AI_PROVIDER_ALLOWED_PRIVATE_HOSTS = previous
    }
  })

  it('uses manual redirects', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 302 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      generateOpenAiCompatible({
        apiKey: 'test-key',
        model: 'llama3.2',
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
        timeoutMs: 1000,
        baseUrl: 'https://8.8.8.8/v1',
      }),
    ).rejects.toMatchObject({ code: 'provider_error' })

    expect(fetchMock.mock.calls[0][1].redirect).toBe('manual')
  })
})
