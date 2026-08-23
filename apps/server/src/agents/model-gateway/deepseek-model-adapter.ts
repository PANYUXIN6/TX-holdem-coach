import { createDeepSeek } from '@ai-sdk/deepseek'
import type { SensitiveValueScanner } from '../foundation/context-envelope.js'
import type { ModelProviderAdapter } from '../foundation/model-gateway-protocol.js'
import { createAiSdkModelAdapter } from './ai-sdk-model-adapter.js'

export function createDeepSeekModelAdapter(input: {
  readonly apiKey: string
  readonly scanner: SensitiveValueScanner
}): ModelProviderAdapter {
  if (input.apiKey.trim().length === 0) {
    throw new TypeError('DeepSeek API Key 未配置。')
  }
  const provider = createDeepSeek({ apiKey: input.apiKey })
  return createAiSdkModelAdapter({
    provider: 'deepseek',
    createModel: (modelId) => provider(modelId),
    scanner: input.scanner,
  })
}
