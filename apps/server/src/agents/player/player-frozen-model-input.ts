import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import {
  restorePreparedModelRequest,
  type PreparedModelRequest,
} from '../foundation/prompt-module.js'

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/)
const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const MessageSchema = z.strictObject({
  role: z.enum(['system', 'user']),
  content: z.string().min(1),
})

export const FrozenPlayerModelInputV1Schema = z.strictObject({
  frozenModelInputSchemaVersion: z.literal(1),
  contextSha256: Sha256Schema,
  messages: z.array(MessageSchema).min(1),
  requestSha256: Sha256Schema,
  maximumRequestBytes: SafeIntegerSchema.positive(),
  estimatedInputTokens: SafeIntegerSchema,
  routePolicy: z.strictObject({
    policy: z.strictObject({
      id: z.literal('player.route-policy'),
      version: z.literal(1),
    }),
    pricingPolicy: z.strictObject({
      id: z.literal('foundation.deepseek-pricing-cny'),
      version: z.literal(1),
    }),
    provider: z.literal('deepseek'),
    maximumContentCorrections: z.literal(2),
  }),
  modelSelection: z.strictObject({
    modelId: z.literal('deepseek-v4-flash'),
    temperature: z.literal(0.2),
    maxOutputTokens: z.literal(256),
    thinkingMode: z.literal('disabled'),
  }),
  outputSchema: z.strictObject({
    id: z.literal('player.output.decision'),
    version: z.literal(1),
  }),
  validator: z.strictObject({
    id: z.literal('player.validator.decision'),
    version: z.literal(1),
  }),
})

export type FrozenPlayerModelInputV1 = Readonly<
  z.infer<typeof FrozenPlayerModelInputV1Schema>
>

export interface CreateFrozenPlayerModelInputV1Input {
  readonly contextSha256: string
  readonly messages: readonly {
    readonly role: 'system' | 'user'
    readonly content: string
  }[]
  readonly maximumRequestBytes: number
  readonly estimatedInputTokens: number
  readonly routePolicy: {
    readonly policy: { readonly id: string; readonly version: number }
    readonly pricingPolicy: { readonly id: string; readonly version: number }
    readonly provider: string
    readonly maximumContentCorrections: number
  }
  readonly modelSelection: {
    readonly modelId: string
    readonly temperature: number
    readonly maxOutputTokens: number
    readonly thinkingMode: string
  }
  readonly outputSchema: { readonly id: string; readonly version: number }
  readonly validator: { readonly id: string; readonly version: number }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function hashRequestMessages(
  messages: readonly z.infer<typeof MessageSchema>[],
) {
  return createHash('sha256')
    .update(canonicalJson({ messages } as JsonValue), 'utf8')
    .digest('hex')
}

export function decodeFrozenPlayerModelInputV1(
  value: unknown,
): FrozenPlayerModelInputV1 {
  const parsed = FrozenPlayerModelInputV1Schema.parse(value)
  if (hashRequestMessages(parsed.messages) !== parsed.requestSha256) {
    throw new RangeError('冻结模型输入的 request 摘要不一致。')
  }
  return deepFreeze(parsed)
}

export function hashFrozenPlayerModelInputV1(value: unknown): string {
  return createHash('sha256')
    .update(
      canonicalJson(
        decodeFrozenPlayerModelInputV1(value) as unknown as JsonValue,
      ),
      'utf8',
    )
    .digest('hex')
}

export function restoreFrozenPlayerModelRequestV1(
  value: unknown,
): PreparedModelRequest<'player'> {
  const frozen = decodeFrozenPlayerModelInputV1(value)
  return restorePreparedModelRequest({
    runtimeType: 'player',
    messages: frozen.messages,
    maximumRequestBytes: frozen.maximumRequestBytes,
    sha256: frozen.requestSha256,
    estimatedInputTokens: frozen.estimatedInputTokens,
  })
}

export function createFrozenPlayerModelInputV1(
  input: CreateFrozenPlayerModelInputV1Input,
): FrozenPlayerModelInputV1 {
  return decodeFrozenPlayerModelInputV1({
    ...input,
    frozenModelInputSchemaVersion: 1,
    requestSha256: hashRequestMessages(input.messages),
  })
}
