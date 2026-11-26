import type { VoiceInfo } from '../../../types'

import { errorMessageFrom } from '@moeru/std'
import { createOpenAI } from '@xsai-ext/providers/create'
import { z } from 'zod'

import { defineProvider } from '../../registry'

const DEFAULT_BASE_URL = 'https://api.boson.ai/v1/'

/**
 * The synthesis model used when the caller names none. The settings page and
 * the Speech module both name a model, so this covers a bare provider call.
 */
const DEFAULT_SPEECH_MODEL = 'higgs-tts-3'

const configSchema = z.object({
  apiKey: z.string(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
})

type Config = z.input<typeof configSchema>

/** The body of a failed request. It has the OpenAI error shape. */
interface ErrorBody {
  error?: { message?: string }
}

/**
 * The body of `GET audio/voices`. It lists the preset voices and the voices
 * that the account cloned. A preset voice has `is_public: true`.
 */
interface VoiceList {
  data?: Array<{ voice_id?: string, title?: string | null, is_public?: boolean }>
}

/**
 * How the account answered a voice catalog request. A refusal and an
 * unreachable API stay apart, because only a refusal says anything about the
 * credentials.
 */
type VoiceCatalogOutcome
  = | { kind: 'ok', voices: VoiceInfo[] }
    | { kind: 'rejected', reason: string }
    | { kind: 'unreachable', reason: string }

/**
 * Normalizes the base URL so that a relative path resolves below it.
 *
 * @example
 * normalizeBaseUrl('https://api.boson.ai/v1')
 * // => 'https://api.boson.ai/v1/'
 */
function normalizeBaseUrl(baseUrl: string | undefined) {
  const value = baseUrl?.trim() || DEFAULT_BASE_URL
  return value.endsWith('/') ? value : `${value}/`
}

/** The API message from a failed response, or the HTTP status when the body has none. */
async function readRefusal(response: Response): Promise<string> {
  const status = `Boson AI request failed: ${response.status} ${response.statusText}`.trim()

  try {
    const body = await response.json() as ErrorBody
    return body.error?.message || status
  }
  catch {
    return status
  }
}

/**
 * Reads the voices that the key can use from `GET audio/voices`. The voices of
 * the account come first, and the preset voices follow them.
 */
async function requestVoices(config: Config, signal?: AbortSignal): Promise<VoiceCatalogOutcome> {
  const apiKey = config.apiKey?.trim()
  if (!apiKey)
    return { kind: 'rejected', reason: 'API key is required.' }

  let response: Response
  try {
    response = await fetch(new URL('audio/voices', normalizeBaseUrl(config.baseUrl)), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal,
    })
  }
  catch (error) {
    // An aborted request has no answer. The caller must not read it as an
    // unreachable API.
    if (signal?.aborted)
      throw error

    return { kind: 'unreachable', reason: `Cannot reach Boson AI: ${errorMessageFrom(error) ?? 'Unknown error'}` }
  }

  // A server error says nothing about the credentials.
  if (response.status >= 500)
    return { kind: 'unreachable', reason: await readRefusal(response) }

  if (!response.ok)
    return { kind: 'rejected', reason: await readRefusal(response) }

  let payload: VoiceList
  try {
    payload = await response.json() as VoiceList
  }
  catch {
    return { kind: 'unreachable', reason: 'Boson AI sent a voice list that is not JSON.' }
  }

  const entries = (payload.data ?? []).filter(entry => !!entry.voice_id)

  return {
    kind: 'ok',
    voices: [...entries.filter(entry => !entry.is_public), ...entries.filter(entry => entry.is_public)]
      .map(entry => ({
        id: entry.voice_id as string,
        name: entry.title || entry.voice_id as string,
        provider: 'boson-ai-speech',
        languages: [],
      })),
  }
}

/**
 * Higgs TTS 3 of Boson AI. The API accepts the OpenAI `audio/speech` request,
 * so the OpenAI client sends the synthesis call.
 */
export const providerBosonAISpeech = defineProvider<Config, 'boson-ai-speech'>({
  id: 'boson-ai-speech',
  name: 'Boson AI',
  nameLocalize: ({ t }) => t('settings.pages.providers.provider.boson-ai-speech.title'),
  description: 'boson.ai',
  descriptionLocalize: ({ t }) => t('settings.pages.providers.provider.boson-ai-speech.description'),
  tasks: ['text-to-speech'],
  icon: 'i-solar:soundwave-bold-duotone',
  createProviderConfig: () => configSchema,
  createProvider(config) {
    const provider = createOpenAI(config.apiKey.trim(), normalizeBaseUrl(config.baseUrl))

    return {
      speech: (model: string) => ({
        ...provider.speech(model || DEFAULT_SPEECH_MODEL),
        // The shared generator reports a failed request with the raw JSON
        // body. The API message names the cause, for example an unknown voice
        // or an account with no credit, so the user reads that message.
        fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
          const response = await fetch(input, init)
          if (!response.ok)
            throw new Error(await readRefusal(response))

          return response
        },
      }),
    }
  },
  validationRequiredWhen: config => Boolean(config.apiKey?.trim()),
  validators: {
    validateConfig: [
      ({ t }) => ({
        id: 'boson-ai-speech:check-config',
        name: t('settings.pages.providers.catalog.edit.validators.openai-compatible.check-config.title'),
        validator: async (config) => {
          const errors: Array<{ error: unknown }> = []

          if (!config.apiKey?.trim()) {
            errors.push({ error: new Error('API key is required.') })
          }
          else {
            // A nonempty key is a supplied key, not an authenticated one.
            const outcome = await requestVoices(config)
            if (outcome.kind === 'rejected')
              errors.push({ error: new Error(outcome.reason) })
          }

          return {
            errors,
            reason: errors.map(item => (item.error as Error).message).join(', '),
            reasonKey: '',
            valid: errors.length === 0,
          }
        },
      }),
    ],
  },
  extraMethods: {
    listModels: async () => [
      { id: DEFAULT_SPEECH_MODEL, name: 'Higgs TTS 3', provider: 'boson-ai-speech', description: 'Expressive multilingual speech with inline emotion and style tags', contextLength: 0, deprecated: false },
    ],
    // The voice list belongs to the account, so the key is a discovery input.
    voiceCatalogConfig: ({ apiKey, baseUrl }) => ({ apiKey, baseUrl }),
    listVoices: async (config, _provider, _model, signal) => {
      const outcome = await requestVoices(config, signal)

      // The API owns the voice list. A failed request must reach the user as
      // an error, because an empty selector does not name the cause.
      if (outcome.kind !== 'ok')
        throw new Error(outcome.reason)

      return outcome.voices
    },
  },
})
