<script setup lang="ts">
import type { VoiceInfo } from '@proj-airi/stage-ui/stores/providers/provider'
import type { SpeechProviderWithExtraOptions } from '@xsai-ext/providers/utils'

import {
  SpeechPlayground,
  SpeechProviderSettings,
} from '@proj-airi/stage-ui/components'
import { useSpeechStore } from '@proj-airi/stage-ui/stores/modules/speech'
import { useProviderConfigStore } from '@proj-airi/stage-ui/stores/providers/config'
import { useProviderStore } from '@proj-airi/stage-ui/stores/providers/provider'
import { watchDebounced } from '@vueuse/core'
import { cloneDeep } from 'es-toolkit'
import { storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()

const providerId = 'boson-ai-speech'
const defaultModel = 'higgs-tts-3'

const speechStore = useSpeechStore()
const providersStore = useProviderStore()
const providerStore = useProviderConfigStore()
const { configs: providers } = storeToRefs(providerStore)

const apiKeyConfigured = computed(() => !!providers.value[providerId]?.apiKey)

// The picked voice lives in the provider config, and the playground binds to
// it. That binding is what makes a choice survive reopening the page, which a
// preview-local selection cannot do.
const voice = computed({
  get: () => providers.value[providerId]?.voice as string | undefined || '',
  set: (value: string) => {
    if (!providers.value[providerId])
      return
    providers.value[providerId].voice = value
  },
})

// A stable empty list keeps the computed value stable when the provider has no
// voice catalog yet. A new array on each read causes extra UI updates.
const emptyVoices: VoiceInfo[] = []
Object.freeze(emptyVoices)

const availableVoices = computed(() => {
  return speechStore.availableVoices[providerId] ?? emptyVoices
})

async function handleGenerateSpeech(input: string, voiceId: string, _useSSML: boolean) {
  const provider = await providersStore.getProviderInstance(providerId) as SpeechProviderWithExtraOptions<string>
  if (!provider) {
    throw new Error(t('settings.pages.providers.provider.boson-ai-speech.errors.provider-initialization-failed'))
  }

  return await speechStore.speech(
    provider,
    defaultModel,
    input,
    voiceId,
    providerStore.getProviderConfig(providerId),
  )
}

/**
 * Commits the picked voice to the provider config, and mirrors it into the
 * Speech module when that module already uses this provider. The module owns
 * the active selection, so a page for another provider must not take it over.
 */
async function selectVoice(value: string) {
  voice.value = value
  if (speechStore.activeSpeechProvider !== providerId)
    return

  // An unchanged model keeps the leader from clearing the voice it then sets.
  await speechStore.selectProviderModel(providerId, speechStore.activeSpeechModel, value)
}

async function loadVoicesWhenConfigured() {
  const providerConfig = providerStore.getProviderConfig(providerId)
  // Clone nested reactive values before the synchronized action sends its arguments.
  const configSnapshot = cloneDeep(providerConfig)
  if ((await providersStore.validateProviderConfig(providerId, configSnapshot)).valid) {
    await speechStore.loadVoicesForProvider(providerId)
  }
  else {
    console.error('Failed to validate provider config', providerConfig)
  }
}

// The API lists the voices that the key can use, so the catalog depends on the
// key. The page must also load it on mount, because a saved key does not
// change after a reload.
watchDebounced([
  () => providers.value[providerId]?.apiKey,
  () => providers.value[providerId]?.baseUrl,
], loadVoicesWhenConfigured, {
  debounce: 500,
  immediate: true,
})
</script>

<template>
  <SpeechProviderSettings
    :provider-id="providerId"
    :default-model="defaultModel"
  >
    <template #playground>
      <SpeechPlayground
        :available-voices="availableVoices"
        :voice="voice"
        :generate-speech="handleGenerateSpeech"
        :api-key-configured="apiKeyConfigured"
        :default-text="t('settings.pages.providers.provider.boson-ai-speech.playground.default-text')"
        @update:voice="selectVoice"
      />
    </template>
  </SpeechProviderSettings>
</template>

<route lang="yaml">
  meta:
    layout: settings
    stageTransition:
      name: slide
  </route>
