import { AGENT_PERSONA_IDS } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import { PERSONA_CATALOG_DEFINITIONS } from '../../src/personas/catalog-definitions.js'
import {
  loadAndValidatePersonaCatalog,
  PersonaCatalogValidationError,
} from '../../src/personas/catalog.js'
import {
  ActiveModelConfigurationSchema,
  canonicalJson,
  createActiveModelConfigurationSchema,
  createConfigSnapshotKey,
  PERSONA_CONFIG_PERSONA_IDS,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../../src/personas/config.js'

function cloneDefinitions(): Record<string, unknown>[] {
  return structuredClone(PERSONA_CATALOG_DEFINITIONS) as unknown as Record<
    string,
    unknown
  >[]
}

describe('private persona configuration', () => {
  test('freezes the current persona id vocabulary locally', () => {
    expect(PERSONA_CONFIG_PERSONA_IDS).toEqual([
      'nit_fish',
      'lag_rec',
      'tag_pro',
      'short_shark',
      'calling_station',
      'deep_maniac',
      'small_ball_reg',
      'trap_specialist',
    ])
    expect(Object.isFrozen(PERSONA_CONFIG_PERSONA_IDS)).toBe(true)
  })

  test('loads complete, deeply frozen and independently expanded entries', () => {
    const catalog = loadAndValidatePersonaCatalog()
    const entries = catalog.list()

    expect(entries.map((entry) => entry.personaId)).toEqual(AGENT_PERSONA_IDS)
    expect(entries).toHaveLength(8)
    for (const entry of entries) {
      expect(PersonaConfigPayloadSchema.safeParse(entry).success).toBe(true)
      expect(entry.models.deepSeek).toEqual({
        modelId: 'deepseek-v4-flash',
        temperature: 0.2,
        maxOutputTokens: 256,
        thinkingMode: 'disabled',
      })
      expect(entry.models.kimi).toEqual({
        modelId: 'kimi-k2.6',
        temperature: 0.6,
        maxOutputTokens: 256,
        thinkingMode: 'disabled',
      })
      expect(Object.isFrozen(entry)).toBe(true)
      expect(Object.isFrozen(entry.style)).toBe(true)
      expect(Object.isFrozen(entry.models)).toBe(true)
      expect(Object.isFrozen(entry.models.deepSeek)).toBe(true)
      expect(Object.isFrozen(entry.models.kimi)).toBe(true)
    }
    expect(entries[0]?.models).not.toBe(entries[1]?.models)
  })

  test.each([
    ['seven entries', (items: Record<string, unknown>[]) => items.slice(0, 7)],
    [
      'nine entries',
      (items: Record<string, unknown>[]) => [...items, { ...items[0] }],
    ],
    [
      'duplicate persona id',
      (items: Record<string, unknown>[]) => {
        items[1] = { ...items[1], personaId: items[0]?.personaId }
        return items
      },
    ],
    [
      'non-current version',
      (items: Record<string, unknown>[]) => {
        items[0] = { ...items[0], personaVersion: 2 }
        return items
      },
    ],
    [
      'invalid avatar color',
      (items: Record<string, unknown>[]) => {
        items[0] = { ...items[0], avatarColor: '#abc123' }
        return items
      },
    ],
    [
      'invalid style',
      (items: Record<string, unknown>[]) => {
        items[0] = {
          ...items[0],
          style: { ...(items[0]?.style as object), aggression: 101 },
        }
        return items
      },
    ],
    [
      'empty strategy',
      (items: Record<string, unknown>[]) => {
        items[0] = { ...items[0], strategyDescription: ' ' }
        return items
      },
    ],
    [
      'extra private field',
      (items: Record<string, unknown>[]) => {
        items[0] = { ...items[0], apiKey: 'secret' }
        return items
      },
    ],
  ])('rejects %s', (_name, mutate) => {
    expect(() =>
      loadAndValidatePersonaCatalog(mutate(cloneDefinitions())),
    ).toThrow(PersonaCatalogValidationError)
  })

  test('does not expose the original catalog validation failure through cause', () => {
    const definitions = cloneDefinitions()
    definitions[0] = { ...definitions[0], apiKey: 'private-catalog-secret' }

    let failure: unknown
    try {
      loadAndValidatePersonaCatalog(definitions)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(PersonaCatalogValidationError)
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  test('rejects provider-compatible but unpublished neighboring bundles', () => {
    const entry = loadAndValidatePersonaCatalog().list()[0]
    expect(
      PersonaConfigPayloadSchema.safeParse({
        ...entry,
        models: {
          ...entry?.models,
          deepSeek: {
            ...entry?.models.deepSeek,
            temperature: 1.7,
            thinkingMode: 'enabled',
          },
        },
      }).success,
    ).toBe(false)
    expect(
      PersonaConfigPayloadSchema.safeParse({
        ...entry,
        models: {
          ...entry?.models,
          kimi: {
            ...entry?.models.kimi,
            temperature: 1,
            thinkingMode: 'enabled',
          },
        },
      }).success,
    ).toBe(false)
  })

  test('keeps permanent parsing valid when a local Active set retires the bundle', () => {
    const entry = loadAndValidatePersonaCatalog().list()[0]
    expect(PersonaConfigPayloadSchema.safeParse(entry).success).toBe(true)
    expect(
      ActiveModelConfigurationSchema.safeParse(entry?.models).success,
    ).toBe(true)
    const retiredSchema = createActiveModelConfigurationSchema(new Set())
    expect(retiredSchema.safeParse(entry?.models).success).toBe(false)
  })

  test('canonicalizes object keys and hashes payload contents plus version', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe(canonicalJson({ a: 1, b: 2 }))
    const payload = PersonaConfigPayloadSchema.parse(
      loadAndValidatePersonaCatalog().list()[0],
    )
    const key = createConfigSnapshotKey(PERSONA_CONFIG_PAYLOAD_VERSION, payload)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(createConfigSnapshotKey(2, payload)).not.toBe(key)
    expect(
      createConfigSnapshotKey(PERSONA_CONFIG_PAYLOAD_VERSION, {
        ...payload,
        strategyDescription: `${payload.strategyDescription}。`,
      }),
    ).not.toBe(key)
  })

  test('definition module import itself does not load or validate the catalog', async () => {
    await expect(
      import('../../src/personas/catalog-definitions.js'),
    ).resolves.toHaveProperty('PERSONA_CATALOG_DEFINITIONS')
  })
})
