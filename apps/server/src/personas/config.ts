import { createHash } from 'node:crypto'
import { AgentPersonaIdSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { canonicalJson } from '../persisted-json.js'

export const PERSONA_CONFIG_PAYLOAD_VERSION = 1
export const MEMORY_PAYLOAD_VERSION = 1

export const PublishedPersonaModelBundleSchema = z.strictObject({
  deepSeek: z.strictObject({
    modelId: z.literal('deepseek-v4-flash'),
    temperature: z.literal(0.2),
    maxOutputTokens: z.literal(256),
    thinkingMode: z.literal('disabled'),
  }),
  kimi: z.strictObject({
    modelId: z.literal('kimi-k2.6'),
    temperature: z.literal(0.6),
    maxOutputTokens: z.literal(256),
    thinkingMode: z.literal('disabled'),
  }),
})

export type PublishedPersonaModelBundle = z.infer<
  typeof PublishedPersonaModelBundleSchema
>

export const PERSONA_MODEL_BUNDLE_DEFAULTS = {
  deepSeek: {
    modelId: 'deepseek-v4-flash',
    temperature: 0.2,
    maxOutputTokens: 256,
    thinkingMode: 'disabled',
  },
  kimi: {
    modelId: 'kimi-k2.6',
    temperature: 0.6,
    maxOutputTokens: 256,
    thinkingMode: 'disabled',
  },
} as const satisfies PublishedPersonaModelBundle

const PersonaConfigPayloadStyleSchema = z.strictObject({
  tightness: z.number().int().min(0).max(100),
  aggression: z.number().int().min(0).max(100),
  bluffTendency: z.number().int().min(0).max(100),
  pressureCallTendency: z.number().int().min(0).max(100),
  riskPreference: z.number().int().min(0).max(100),
})

export const PersonaConfigPayloadSchema = z.strictObject({
  personaId: AgentPersonaIdSchema,
  personaVersion: z.literal(1),
  name: z.string().trim().min(1),
  avatarColor: z.string().regex(/^#[0-9A-F]{6}$/),
  backgroundDescription: z.string().trim().min(1),
  teachingSummary: z.string().trim().min(1),
  style: PersonaConfigPayloadStyleSchema,
  strategyDescription: z.string().trim().min(1).max(2000),
  models: PublishedPersonaModelBundleSchema,
})

export type PersonaConfigPayload = z.infer<typeof PersonaConfigPayloadSchema>

export const AgentMemoryPayloadSchema = z.strictObject({})
export type AgentMemoryPayload = z.infer<typeof AgentMemoryPayloadSchema>

export function createConfigSnapshotKey(
  configPayloadVersion: number,
  configPayload: PersonaConfigPayload,
): string {
  const canonicalPayload = canonicalJson({
    configPayload,
    configPayloadVersion,
  })
  return createHash('sha256').update(canonicalPayload, 'utf8').digest('hex')
}

export function createActiveModelConfigurationSchema(
  activeKeys: ReadonlySet<string>,
) {
  const allowedKeys = new Set(activeKeys)

  return PublishedPersonaModelBundleSchema.superRefine((models, context) => {
    if (!allowedKeys.has(canonicalJson(models))) {
      context.addIssue({
        code: 'custom',
        message: '该模型配置当前不可用于新场次。',
      })
    }
  })
}

const productionActiveModelConfigurationKey = canonicalJson(
  PERSONA_MODEL_BUNDLE_DEFAULTS,
)

export const ActiveModelConfigurationSchema =
  createActiveModelConfigurationSchema(
    new Set([productionActiveModelConfigurationKey]),
  )

export const ActivePersonaCatalogEntrySchema =
  PersonaConfigPayloadSchema.superRefine((entry, context) => {
    const result = ActiveModelConfigurationSchema.safeParse(entry.models)
    if (!result.success) {
      context.addIssue({
        code: 'custom',
        path: ['models'],
        message: '人物模型配置当前不可用于新场次。',
      })
    }
  })

export type DeepReadonly<T> = T extends (...arguments_: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T

export function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>
  }

  for (const nestedValue of Object.values(value)) {
    deepFreeze(nestedValue)
  }

  return Object.freeze(value) as DeepReadonly<T>
}
