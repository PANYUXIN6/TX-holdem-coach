import type { ProviderId } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { ProviderCheckFailure } from './provider-error-classifier.js'
import { PERSONA_MODEL_BUNDLE_DEFAULTS } from '../personas/config.js'

const MODEL_ENDPOINTS = {
  deepseek: {
    url: 'https://api.deepseek.com/models',
    targetModelId: PERSONA_MODEL_BUNDLE_DEFAULTS.deepSeek.modelId,
  },
  kimi: {
    url: 'https://api.moonshot.ai/v1/models',
    targetModelId: PERSONA_MODEL_BUNDLE_DEFAULTS.kimi.modelId,
  },
} as const

const ProviderModelsResponseSchema = z.strictObject({
  data: z
    .array(z.object({ id: z.string().trim().min(1).max(200) }).passthrough())
    .max(1_000),
})
const KimiErrorResponseSchema = z.object({
  error: z.object({ type: z.string() }).passthrough(),
})
const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1_024

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // Cancellation diagnostics cannot change the sanitized public failure.
  }
}

async function readLimitedResponseBytes(
  response: Response,
): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new ProviderCheckFailure('unknown')
  const chunks: Uint8Array[] = []
  let byteLength = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      byteLength += chunk.value.byteLength
      if (byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // The public result remains a sanitized invalid-response failure.
        }
        throw new ProviderCheckFailure('unknown')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }

  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export interface ProviderCheckTransport {
  check(provider: ProviderId, apiKey: string): Promise<void>
}

function classifyStatus(status: number): ProviderCheckFailure {
  if (status === 401 || status === 403) return new ProviderCheckFailure('auth')
  if (status === 402) return new ProviderCheckFailure('billing')
  if (status === 429) return new ProviderCheckFailure('rateLimited')
  if (status === 502 || status === 503 || status === 504) {
    return new ProviderCheckFailure('serviceUnavailable')
  }
  return new ProviderCheckFailure('unknown')
}

async function classifyKimiRateLimit(
  response: Response,
): Promise<ProviderCheckFailure> {
  const declaredLength = Number(response.headers.get('content-length'))
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > MAX_PROVIDER_RESPONSE_BYTES
  ) {
    await cancelResponseBody(response)
    return new ProviderCheckFailure('rateLimited')
  }

  try {
    const bytes = await readLimitedResponseBytes(response)
    const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
    const parsed = KimiErrorResponseSchema.safeParse(payload)
    return new ProviderCheckFailure(
      parsed.success &&
        parsed.data.error.type === 'exceeded_current_quota_error'
        ? 'billing'
        : 'rateLimited',
    )
  } catch {
    return new ProviderCheckFailure('rateLimited')
  }
}

export function createProviderCheckTransport(
  input: {
    readonly fetch?: typeof fetch
    readonly timeoutMs?: number
  } = {},
): ProviderCheckTransport {
  const fetchImplementation = input.fetch ?? fetch
  const timeoutMs = input.timeoutMs ?? 10_000

  return Object.freeze({
    async check(provider: ProviderId, apiKey: string): Promise<void> {
      const target = MODEL_ENDPOINTS[provider]
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const response = await fetchImplementation(target.url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        })

        if (!response.ok) {
          if (provider === 'kimi' && response.status === 429) {
            throw await classifyKimiRateLimit(response)
          }
          await cancelResponseBody(response)
          throw classifyStatus(response.status)
        }

        const declaredLength = Number(response.headers.get('content-length'))
        if (
          Number.isFinite(declaredLength) &&
          declaredLength > MAX_PROVIDER_RESPONSE_BYTES
        ) {
          await cancelResponseBody(response)
          throw new ProviderCheckFailure('unknown')
        }
        const bytes = await readLimitedResponseBytes(response)
        const payload: unknown = JSON.parse(new TextDecoder().decode(bytes))
        const parsed = ProviderModelsResponseSchema.safeParse(payload)
        if (!parsed.success) throw new ProviderCheckFailure('unknown')
        if (
          !parsed.data.data.some((model) => model.id === target.targetModelId)
        ) {
          throw new ProviderCheckFailure('serviceUnavailable')
        }
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ProviderCheckFailure('timeout')
        }
        if (error instanceof ProviderCheckFailure) throw error
        if (error instanceof TypeError) {
          throw new ProviderCheckFailure('network')
        }
        throw new ProviderCheckFailure('unknown')
      } finally {
        clearTimeout(timeout)
      }
    },
  })
}
