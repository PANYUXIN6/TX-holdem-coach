import type { AgentPersonaId } from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import { z } from 'zod'
import type { PersonaCatalog } from '../personas/catalog.js'
import {
  ActiveModelConfigurationV1Schema,
  createConfigSnapshotKey,
  deepFreeze,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadV1Schema,
} from '../personas/config.js'
import {
  ActiveModelConfigurationError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
} from '../persistence/errors.js'
import {
  resolveOwnerScope,
  type OwnerScope,
} from '../persistence/owner-scope.js'
import {
  findLatestEndedSessionForRosterReuse,
  INITIAL_AGENT_MEMORY,
  readSessionAgentSnapshots,
  type InsertSessionRosterSnapshotInput,
  type SessionAgentSnapshot,
  type SessionRosterAgentInput,
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

function createAgentInput(
  snapshot: SessionAgentSnapshot,
  agentParticipantId: string,
): SessionRosterAgentInput {
  return deepFreeze({
    seatNumber: snapshot.seatNumber,
    agentParticipantId,
    displayName: snapshot.displayName,
    avatarColor: snapshot.avatarColor,
    personaId: snapshot.personaId,
    personaVersion: snapshot.personaVersion,
    configSnapshotKey: snapshot.configSnapshotKey,
    configPayloadVersion: snapshot.configPayloadVersion,
    configPayload: snapshot.configPayload,
    initialMemory: INITIAL_AGENT_MEMORY,
  })
}

type ActiveModelConfigurationSchema = Pick<
  typeof ActiveModelConfigurationV1Schema,
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

export async function prepareCurrentCatalogRoster(
  sql: Sql,
  ownerScope: OwnerScope,
  catalog: PersonaCatalog,
  identityGraph: CurrentCatalogRosterIdentityGraph,
): Promise<InsertSessionRosterSnapshotInput> {
  const owner = await resolveOwnerScope(sql, ownerScope)
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
    const payload = PersonaConfigPayloadV1Schema.safeParse(catalogEntry)
    if (!payload.success) {
      throw new RepositoryInputValidationError()
    }
    const active = ActiveModelConfigurationV1Schema.safeParse(
      payload.data.models,
    )
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

  return deepFreeze({
    owner,
    sessionId: graph.sessionId,
    userParticipantId: graph.userParticipantId,
    agents,
  })
}

export async function prepareLatestEndedRosterForReuse(
  sql: Sql,
  ownerScope: OwnerScope,
  identityGraph: StableIdentityGraph,
): Promise<InsertSessionRosterSnapshotInput> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  const graph = assertIdentityGraph(identityGraph)
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
  if (snapshots.length !== graph.agentParticipants.length) {
    throw new RepositoryInputValidationError()
  }
  assertRosterSnapshotsUseActiveModels(
    snapshots,
    ActiveModelConfigurationV1Schema,
  )

  const participantsBySeat = new Map(
    graph.agentParticipants.map((participant) => [
      participant.seatNumber,
      participant.agentParticipantId,
    ]),
  )
  const agents = snapshots.map((snapshot) => {
    const participantId = participantsBySeat.get(snapshot.seatNumber)
    if (participantId === undefined) {
      throw new RepositoryInputValidationError()
    }
    return createAgentInput(snapshot, participantId)
  })

  return deepFreeze({
    owner,
    sessionId: graph.sessionId,
    userParticipantId: graph.userParticipantId,
    agents,
  })
}
