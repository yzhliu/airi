import type { SpeechProvider } from '@xsai-ext/providers/utils'

import { generateSpeech } from '@xsai/generate-speech'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { providerBosonAISpeech } from './index'

const listVoices = providerBosonAISpeech.extraMethods!.listVoices!

const config = { apiKey: 'bai-test', baseUrl: 'https://api.boson.ai/v1' }

/**
 * The shape of `GET audio/voices`. The API lists the preset voices first and
 * marks them with `is_public`. The names and IDs are fixtures.
 */
const VOICE_LIST_BODY = {
  object: 'list',
  data: [
    { voice_id: 'chloe', title: 'Chloe', is_public: true, created_at: '2026-01-01T00:00:00+00:00' },
    { voice_id: 'jake', title: 'Jake', is_public: true, created_at: '2026-01-01T00:00:00+00:00' },
    { voice_id: 'voice_abc123', title: 'Example cloned voice', is_public: false, created_at: '2026-01-02T00:00:00+00:00' },
  ],
}

/** The API answers a rejected key with this shape and HTTP 401. The message is shortened. */
const INVALID_KEY_BODY = {
  error: { message: 'You didn\'t provide a valid API key.', type: 'authentication_error', code: 'invalid_api_key' },
}

/**
 * The documented shape for an account with no credit, sent with HTTP 429.
 * The message text is a fixture.
 */
const NO_CREDIT_BODY = {
  error: { message: 'You exceeded your current quota.', type: 'insufficient_quota' },
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function audioResponse() {
  return new Response(new Uint8Array([0x49, 0x44, 0x33]), {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg' },
  })
}

/** Runs the adapter the way the provider store does, with a real instance. */
async function readVoices(signal?: AbortSignal) {
  const provider = await providerBosonAISpeech.createProvider(config)

  return await listVoices(config, provider, undefined, signal)
}

/** Sends a synthesis request through the shared generator, as the Speech module does. */
async function synthesize(model: string) {
  const provider = await providerBosonAISpeech.createProvider(config) as SpeechProvider

  return await generateSpeech({
    ...provider.speech(model),
    input: 'Hello',
    voice: 'chloe',
  })
}

async function validateConfig(providerConfig: { apiKey: string, baseUrl?: string }) {
  const context = { t: (key: string) => key }
  const validator = await providerBosonAISpeech.validators!.validateConfig![0](context)

  return await validator.validator(providerConfig, context)
}

describe('providerBosonAISpeech voice catalog', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reads the voice list with the configured key', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse(VOICE_LIST_BODY))
    vi.stubGlobal('fetch', fetchMock)

    await readVoices()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://api.boson.ai/v1/audio/voices')
    expect(fetchMock.mock.calls[0]![1]?.headers).toEqual({ Authorization: 'Bearer bai-test' })
  })

  it('lists the voices of the account before the preset voices', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(VOICE_LIST_BODY)))

    const voices = await readVoices()

    expect(voices.map(voice => ({ id: voice.id, name: voice.name }))).toEqual([
      { id: 'voice_abc123', name: 'Example cloned voice' },
      { id: 'chloe', name: 'Chloe' },
      { id: 'jake', name: 'Jake' },
    ])
  })

  it('names an untitled voice by its ID', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({
      data: [{ voice_id: 'voice_abc123', title: null, is_public: false }],
    })))

    const voices = await readVoices()

    expect(voices.map(voice => voice.name)).toEqual(['voice_abc123'])
  })

  it('lists no voices when the API returns none', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({ object: 'list', data: [] })))

    await expect(readVoices()).resolves.toEqual([])
  })

  // An empty selector does not name the cause. Each failed request must
  // reach the user as an error.
  it('reports the API message when the account rejects the key', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(INVALID_KEY_BODY, 401)))

    await expect(readVoices()).rejects.toHaveProperty('message', 'You didn\'t provide a valid API key.')
  })

  it('reports the network error when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch')
    }))

    await expect(readVoices()).rejects.toHaveProperty('message', 'Cannot reach Boson AI: Failed to fetch')
  })

  it('reports the API message of a server error', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({ error: { message: 'Internal error' } }, 503)))

    await expect(readVoices()).rejects.toHaveProperty('message', 'Internal error')
  })

  it('rejects when the request owner aborts the request', async () => {
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (_input, init) => {
      controller.abort()
      init?.signal?.throwIfAborted()
      return jsonResponse({ data: [] })
    }))

    await expect(readVoices(controller.signal)).rejects.toThrow()
  })
})

describe('providerBosonAISpeech synthesis', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends an OpenAI speech request to the configured endpoint', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => audioResponse())
    vi.stubGlobal('fetch', fetchMock)

    const audio = await synthesize('higgs-tts-3')

    const [url, init] = fetchMock.mock.calls[0]!
    expect(String(url)).toBe('https://api.boson.ai/v1/audio/speech')
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer bai-test')
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'higgs-tts-3', input: 'Hello', voice: 'chloe' })
    expect(audio.byteLength).toBe(3)
  })

  it('falls back to the default model when the caller names none', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => audioResponse())
    vi.stubGlobal('fetch', fetchMock)

    await synthesize('')

    const sent = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as { model: string }
    expect(sent.model).toBe('higgs-tts-3')
  })

  // A new account has no credit until the user claims the trial credit. The
  // API message is the only text that tells the user this cause.
  it('reports the API message of a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(NO_CREDIT_BODY, 429)))

    await expect(synthesize('higgs-tts-3')).rejects.toHaveProperty('message', 'You exceeded your current quota.')
  })

  it('reports the HTTP status when a failed request has no API message', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response('Bad Gateway', { status: 502, statusText: 'Bad Gateway' })))

    await expect(synthesize('higgs-tts-3')).rejects.toHaveProperty('message', 'Boson AI request failed: 502 Bad Gateway')
  })
})

describe('providerBosonAISpeech credential validation', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('rejects an empty key without a request', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    vi.stubGlobal('fetch', fetchMock)

    const result = await validateConfig({ apiKey: ' ' })

    expect(result.valid).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects a key that the account refuses', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse(INVALID_KEY_BODY, 401)))

    const result = await validateConfig(config)

    expect(result.valid).toBe(false)
    expect(result.reason).toBe('You didn\'t provide a valid API key.')
  })

  it('accepts a key that the account accepts', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => jsonResponse({ data: [] })))

    const result = await validateConfig(config)

    expect(result.valid).toBe(true)
  })

  // An unreachable API says nothing about the key, so the settings page must
  // not mark a correct key as wrong while the user is offline.
  it('accepts a key when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch')
    }))

    const result = await validateConfig(config)

    expect(result.valid).toBe(true)
  })
})
