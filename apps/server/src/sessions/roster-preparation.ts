import type {
  LatestEndedRosterPreviewBinding,
  AgentPersonaId,
} from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import { z } from 'zod'
import type { PersonaCatalog } from '../personas/catalog.js'
import {
  PLAYER_EMPTY_SESSION_MEMORY_V1,
  PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
  type AgentMemoryPayloadV1,
} from '../agents/player/player-session-memory.js'
import {
  ActiveModelConfigurationSchema,
  createConfigSnapshotKey,
  deepFreeze,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
  type DeepReadonly,
  type PersonaConfigPayload,
} from '../personas/config.js'
import {
  ActiveModelConfigurationError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  RosterSourceChangedError,
} from '../persistence/errors.js'
import { type ResolvedOwnerScope } from '../persistence/owner-scope.js'
import {
  findLatestEndedSessionForRosterReuse,
  readSessionAgentSnapshots,
  type SessionAgentSnapshot,
} from '../persistence/session-repository.js'

const StableIdentityGraphSchema = z.strictObject({
  sessionId: z.string().uuid(),
  userParticipantId: z.string().uuid(),
  agentParticipants: z
    .array(
      z.strictObject({
        seatNumber: z.number().int().min(1).max(8),
        agentParticipantId: z.string().uuid(),
      }),
    )
    .min(5)
    .max(8),
})

export type StableIdentityGraph = z.infer<typeof StableIdentityGraphSchema>

export interface InitialAgentMemoryInput {
  readonly currentRevision: number
  readonly currentPayloadVersion: number
  readonly currentPayload: DeepReadonly<AgentMemoryPayloadV1>
  readonly revision: number
  readonly revisionPayloadVersion: number
  readonly revisionPayload: DeepReadonly<AgentMemoryPayloadV1>
}

export interface SessionRosterAgentInput {
  readonly seatNumber: number
  readonly agentParticipantId: string
  readonly displayName: string
  readonly avatarColor: string
  readonly personaId: string
  readonly personaVersion: number
  readonly configSnapshotKey: string
  readonly configPayloadVersion: number
  readonly configPayload: PersonaConfigPayload
  readonly initialMemory: InitialAgentMemoryInput
}

export const INITIAL_AGENT_MEMORY: InitialAgentMemoryInput = deepFreeze({
  currentRevision: 0,
  currentPayloadVersion: PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
  currentPayload: PLAYER_EMPTY_SESSION_MEMORY_V1,
  revision: 0,
  revisionPayloadVersion: PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
  revisionPayload: PLAYER_EMPTY_SESSION_MEMORY_V1,
})

export interface CurrentCatalogRosterSelection {
  readonly seatNumber: number
  readonly agentParticipantId: string
  readonly personaId: AgentPersonaId
}

export interface CurrentCatalogRosterIdentityGraph {
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agents: readonly CurrentCatalogRosterSelection[]
}

declare const preparedCurrentCatalogRosterBrand: unique symbol

export interface PreparedCurrentCatalogRoster {
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agents: readonly SessionRosterAgentInput[]
  readonly [preparedCurrentCatalogRosterBrand]: never
}

const preparedCurrentCatalogRosters = new WeakSet<object>()

export function isPreparedCurrentCatalogRoster(
  value: unknown,
): value is PreparedCurrentCatalogRoster {
  return (
    typeof value === 'object' &&
    value !== null &&
    preparedCurrentCatalogRosters.has(value)
  )
}

export interface LatestEndedRosterPreflight {
  readonly sourceSessionId: string
  readonly preview?: DeepReadonly<LatestEndedRosterPreviewBinding>
  readonly aiSeatNumbers: readonly number[]
}

function assertIdentityGraph(
  graph: StableIdentityGraph,
): z.infer<typeof StableIdentityGraphSchema> {
  const result = StableIdentityGraphSchema.safeParse(graph)
  if (!result.success) {
    throw new RepositoryInputValidationError()
  }
  const ids = [
    result.data.sessionId,
    result.data.userParticipantId,
    ...result.data.agentParticipants.map(
      (participant) => participant.agentParticipantId,
    ),
  ]
  const seats = result.data.agentParticipants.map(
    (participant) => participant.seatNumber,
  )
  if (
    new Set(ids).size !== ids.length ||
    new Set(seats).size !== seats.length
  ) {
    throw new RepositoryInputValidationError()
  }
  return result.data
}

type ActiveModelConfigurationSchema = Pick<
  typeof ActiveModelConfigurationSchema,
  'safeParse'
>

export function assertRosterSnapshotsUseActiveModels(
  snapshots: readonly SessionAgentSnapshot[],
  activeModelConfigurationSchema: ActiveModelConfigurationSchema,
): void {
  for (const snapshot of snapshots) {
    const active = activeModelConfigurationSchema.safeParse(
      snapshot.configPayload.models,
    )
    if (!active.success) {
      throw new ActiveModelConfigurationError(
        snapshot.seatNumber,
        snapshot.personaId,
      )
    }
  }
}

export function prepareCurrentCatalogRoster(
  catalog: PersonaCatalog,
  identityGraph: CurrentCatalogRosterIdentityGraph,
): PreparedCurrentCatalogRoster {
  const graph = assertIdentityGraph({
    sessionId: identityGraph.sessionId,
    userParticipantId: identityGraph.userParticipantId,
    agentParticipants: identityGraph.agents.map((agent) => ({
      seatNumber: agent.seatNumber,
      agentParticipantId: agent.agentParticipantId,
    })),
  })
  const personaIds = identityGraph.agents.map((agent) => agent.personaId)
  if (new Set(personaIds).size !== personaIds.length) {
    throw new RepositoryInputValidationError()
  }

  const agents = identityGraph.agents.map((selection, index) => {
    const catalogEntry = catalog.get(selection.personaId)
    if (catalogEntry === undefined) {
      throw new RepositoryInputValidationError()
    }
    const payload = PersonaConfigPayloadSchema.safeParse(catalogEntry)
    if (!payload.success) {
      throw new RepositoryInputValidationError()
    }
    const active = ActiveModelConfigurationSchema.safeParse(payload.data.models)
    if (!active.success) {
      throw new ActiveModelConfigurationError(
        selection.seatNumber,
        selection.personaId,
      )
    }

    const participant = graph.agentParticipants[index]
    if (
      participant === undefined ||
      participant.seatNumber !== selection.seatNumber
    ) {
      throw new RepositoryInputValidationError()
    }

    return deepFreeze({
      seatNumber: selection.seatNumber,
      agentParticipantId: participant.agentParticipantId,
      displayName: payload.data.name,
      avatarColor: payload.data.avatarColor,
      personaId: payload.data.personaId,
      personaVersion: payload.data.personaVersion,
      configSnapshotKey: createConfigSnapshotKey(
        PERSONA_CONFIG_PAYLOAD_VERSION,
        payload.data,
      ),
      configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
      configPayload: payload.data,
      initialMemory: INITIAL_AGENT_MEMORY,
    })
  })

  const prepared = deepFreeze({
    sessionId: graph.sessionId,
    userParticipantId: graph.userParticipantId,
    agents,
  }) as PreparedCurrentCatalogRoster
  preparedCurrentCatalogRosters.add(prepared)
  return prepared
}

export async function prepareLatestEndedRosterPreflight(
  sql: Sql,
  owner: ResolvedOwnerScope,
  preview?: LatestEndedRosterPreviewBinding,
): Promise<LatestEndedRosterPreflight> {
  const latestEndedSession = await findLatestEndedSessionForRosterReuse(
    sql,
    owner,
  )
  if (latestEndedSession === null) {
    throw new ResourceNotFoundError()
  }
  const snapshots = await readSessionAgentSnapshots(
    sql,
    owner,
    latestEndedSession.id,
  )
  assertRosterSnapshotsUseActiveModels(
    snapshots,
    ActiveModelConfigurationSchema,
  )
  if (preview !== undefined)
    assertRosterPreviewBinding(latestEndedSession.id, snapshots, preview)
  return deepFreeze({
    ...(preview === undefined ? {} : { preview }),
    sourceSessionId: latestEndedSession.id,
    aiSeatNumbers: snapshots.map((snapshot) => snapshot.seatNumber),
  })
}

export function assertRosterPreviewBinding(
  sourceSessionId: string,
  snapshots: readonly Pick<
    SessionAgentSnapshot,
    'seatNumber' | 'configSnapshotKey'
  >[],
  preview: LatestEndedRosterPreviewBinding,
): void {
  const seats = new Set(snapshots.map((snapshot) => snapshot.seatNumber))
  if (
    preview.sourceSessionId !== sourceSessionId ||
    preview.assignments.length !== snapshots.length ||
    new Set(preview.assignments.map((a) => a.sourceSeatNumber)).size !==
      snapshots.length ||
    new Set(preview.assignments.map((a) => a.seatNumber)).size !==
      snapshots.length ||
    preview.assignments.some(
      (a) =>
        !seats.has(a.seatNumber) ||
        !snapshots.some(
          (s) =>
            s.seatNumber === a.sourceSeatNumber &&
            s.configSnapshotKey === a.configSnapshotKey,
        ),
    )
  ) {
    throw new RosterSourceChangedError()
  }
}
