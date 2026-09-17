import { encodeRunConfigurationAudit } from '../../../src/agents/audit/run-configuration-audit-codec.js'
import {
  COACH_POLICY_DEPENDENCY_IDS,
  writeCoachPolicyDependencies,
  type CoachPolicyVersions,
} from '../../../src/agents/coach/policy-versions.js'
import { createRunReadAuthenticator } from '../../../src/agents/foundation/run-read-authentication.js'
import { issueRuntimeCommitAuthority } from '../../../src/agents/foundation/runtime-ports.js'
import { createRunConfigurationSnapshot } from '../../../src/agents/foundation/agent-run-coordinator.js'
import { coachRuntimeDefinition } from '../../../src/agents/coach/foundation-definition.js'
import type { PersistedAgentRun } from '../../../src/agents/foundation/agent-run-types.js'
import type { Sql } from 'postgres'
import { loadAndValidatePersonaCatalog } from '../../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PersonaConfigPayloadSchema,
} from '../../../src/personas/config.js'
import { resolveOwnerScope } from '../../../src/persistence/owner-scope.js'
import { encodeCompletedHandResult } from '../../../src/sessions/hand-audit/completed-hand-result-codec.js'
import { encodeCurrentHandStartCheckpoint } from '../../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import { encodeCurrentPrivateEvent } from '../../../src/sessions/authoritative-state/private-event-codec.js'
import { createShowdownCompletedHandHistoryFacts } from '../completed-hand-history-fixture.js'

export function reviewOwner() {
  return resolveOwnerScope(
    (() =>
      Promise.resolve([
        { databaseOwnerId: '11111111-1111-4111-8111-111111111111' },
      ])) as unknown as Sql,
    { ownerId: 'local-user' },
  )
}
export function completedReviewRow(
  allIn = false,
  tableSize = 6,
  reverseFutureDeck = false,
  scenario: 'default' | 'reopen' | 'zeroHero' = 'default',
) {
  const facts = createShowdownCompletedHandHistoryFacts(
    allIn,
    tableSize,
    reverseFutureDeck,
    scenario,
  )
  const checkpoint = encodeCurrentHandStartCheckpoint(facts.checkpoint)
  const result = encodeCompletedHandResult(facts.result)
  const catalog = loadAndValidatePersonaCatalog().list()
  const personas = facts.roster
    .filter((seat) => !seat.isUser)
    .map((seat, index) => {
      const payload = PersonaConfigPayloadSchema.parse({
        ...catalog[index],
        personaVersion: 1,
      })
      return {
        hasAgent: true,
        participantId: seat.playerId,
        seatNumber: seat.seatNumber,
        displayName: payload.name,
        avatarColor: payload.avatarColor,
        personaId: payload.personaId,
        personaVersion: payload.personaVersion,
        configSnapshotKey: createConfigSnapshotKey(1, payload),
        configPayloadVersion: 1,
        configPayload: payload,
      }
    })
  let version = 1
  let command = 0
  const events = [
    { type: 'handStarted' as const, startedHand: facts.checkpoint.startedHand },
    ...facts.events.map((fact) => fact.event),
  ]
  return {
    status: 'completed' as const,
    personas,
    facts: {
      handId: facts.handId,
      sessionId: facts.sessionId,
      handNumber: facts.handNumber,
      startedAt: '2026-09-03T12:00:00.000000Z',
      completedAt: '2026-09-03T12:01:00.000000Z',
      checkpointPayloadVersion: checkpoint.payloadVersion,
      checkpointPayload: checkpoint.payload,
      completedResultPayloadVersion: result.payloadVersion,
      completedResultPayload: result.payload,
      roster: facts.roster.map((seat) => {
        const persona = personas.find((p) => p.participantId === seat.playerId)
        return {
          seatNumber: seat.seatNumber,
          playerId: seat.playerId,
          participantType: seat.isUser ? 'user' : 'agent',
          displayName: persona?.displayName ?? null,
          avatarColor: persona?.avatarColor ?? null,
        }
      }),
      events: events.map((event, index) => {
        if (event.type === 'handStarted' || event.type === 'actionCommitted') {
          version++
          command++
        }
        const encoded = encodeCurrentPrivateEvent(event)
        return {
          eventSeq: 19 + index,
          commandLedgerId: `55555555-5555-4555-8555-${String(command).padStart(12, '0')}`,
          stateVersionBefore: version - 1,
          stateVersionAfter: version,
          privateEventPayloadVersion: encoded.payloadVersion,
          privateEventPayload: encoded.payload,
        }
      }),
    },
  }
}

// Explicit offline producer versions; these do not claim M8.3–M8.5 are installed.
export const fixtureCoachVersions = Object.fromEntries(
  Object.entries(COACH_POLICY_DEPENDENCY_IDS).map(([role, id]) => [
    role,
    { id, version: 1 },
  ]),
) as CoachPolicyVersions
export async function reviewExecution(sessionId: string, handId: string) {
  const authority = issueRuntimeCommitAuthority({
    runtimeType: 'coach',
    runId: '66666666-6666-4666-8666-666666666666',
    leaseOwner: 'fixture',
    fencingToken: 1,
  })
  const run: PersistedAgentRun<'coach'> = {
    ownerId: 'local-user',
    runId: authority.runId,
    runtimeType: 'coach',
    sessionId,
    handId,
    triggerType: 'hand_completed',
    lifecycle: 'running',
    idempotencyKey: 'fixture',
    participantId: null,
    sourceStateVersion: null,
    decisionRequestId: null,
    parentRunId: null,
    replacementRunId: null,
    leaseOwner: authority.leaseOwner,
    fencingToken: authority.fencingToken,
    leaseExpiresAt: '2099-01-01T00:00:00.000Z',
    deadlineAt: '2099-01-01T00:00:00.000Z',
    runtimeDefinitionVersion: 1,
    terminationReason: null,
    runConfiguration: encodeRunConfigurationAudit(
      createRunConfigurationSnapshot(
        coachRuntimeDefinition,
        writeCoachPolicyDependencies(fixtureCoachVersions),
      ),
    ).payload.configuration,
    budget: coachRuntimeDefinition.budgetPolicy.createSnapshot({
      runtimeType: 'coach',
    }),
    createdAt: '2026-09-17T00:00:00.000Z',
    startedAt: '2026-09-17T00:00:00.000Z',
    completedAt: null,
    updatedAt: '2026-09-17T00:00:00.000Z',
  }
  return createRunReadAuthenticator(async () => run)(
    authority,
    sessionId,
    handId,
    undefined,
  )
}
