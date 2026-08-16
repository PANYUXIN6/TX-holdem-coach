import {
  AgentPersonaSummarySchema,
  AGENT_PERSONA_IDS,
} from '@tx-holdem-coach/contracts'
import type {
  AgentPersonaId,
  AgentPersonaSummary,
} from '@tx-holdem-coach/contracts'
import { PERSONA_CATALOG_DEFINITIONS } from './catalog-definitions.js'
import {
  ActivePersonaCatalogEntrySchema,
  deepFreeze,
  PERSONA_MODEL_BUNDLE_DEFAULTS,
  PersonaConfigPayloadSchema,
} from './config.js'
import type { DeepReadonly, PersonaConfigPayload } from './config.js'

export class PersonaCatalogValidationError extends Error {
  public constructor() {
    super('人物目录配置无效，服务未启动。')
    this.name = 'PersonaCatalogValidationError'
  }
}

export type PersonaCatalogEntry = DeepReadonly<PersonaConfigPayload>

export interface PersonaCatalog {
  list(): readonly PersonaCatalogEntry[]
  get(personaId: AgentPersonaId): PersonaCatalogEntry | undefined
  listPublicSummaries(): readonly AgentPersonaSummary[]
  getPublicSummary(personaId: AgentPersonaId): AgentPersonaSummary | undefined
}

const PersonaCatalogSourceDefinitionSchema = PersonaConfigPayloadSchema.omit({
  models: true,
})

function cloneDefaultModels() {
  return {
    deepSeek: { ...PERSONA_MODEL_BUNDLE_DEFAULTS.deepSeek },
    kimi: { ...PERSONA_MODEL_BUNDLE_DEFAULTS.kimi },
  }
}

function projectPublicSummary(
  entry: PersonaConfigPayload,
): AgentPersonaSummary {
  return AgentPersonaSummarySchema.parse({
    personaId: entry.personaId,
    personaVersion: entry.personaVersion,
    name: entry.name,
    avatarColor: entry.avatarColor,
    backgroundDescription: entry.backgroundDescription,
    teachingSummary: entry.teachingSummary,
    style: entry.style,
  })
}

export function loadAndValidatePersonaCatalog(
  definitions: readonly unknown[] = PERSONA_CATALOG_DEFINITIONS,
): PersonaCatalog {
  try {
    if (definitions.length !== AGENT_PERSONA_IDS.length) {
      throw new Error('人物数量无效。')
    }

    const parsedEntries = definitions.map((definition) => {
      const source = PersonaCatalogSourceDefinitionSchema.parse(definition)
      return ActivePersonaCatalogEntrySchema.parse({
        ...source,
        models: cloneDefaultModels(),
      })
    })
    const entriesById = new Map(
      parsedEntries.map((entry) => [entry.personaId, entry]),
    )

    if (
      entriesById.size !== AGENT_PERSONA_IDS.length ||
      AGENT_PERSONA_IDS.some((personaId) => !entriesById.has(personaId))
    ) {
      throw new Error('人物标识集合无效。')
    }

    const entries = deepFreeze(
      AGENT_PERSONA_IDS.map((personaId) => {
        const entry = entriesById.get(personaId)
        if (entry === undefined) {
          throw new Error('人物标识缺失。')
        }
        return entry
      }),
    )
    const publicSummaries = deepFreeze(entries.map(projectPublicSummary))
    const catalog = {
      list: () => entries,
      get: (personaId: AgentPersonaId) =>
        entries.find((entry) => entry.personaId === personaId),
      listPublicSummaries: () => publicSummaries,
      getPublicSummary: (personaId: AgentPersonaId) =>
        publicSummaries.find((summary) => summary.personaId === personaId),
    }

    return deepFreeze(catalog)
  } catch (error) {
    if (error instanceof PersonaCatalogValidationError) {
      throw error
    }
    throw new PersonaCatalogValidationError()
  }
}
