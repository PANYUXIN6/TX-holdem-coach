import { z } from 'zod'
import { deepFreezeDecisionValue } from '../poker/decision-analysis-types.js'
import { projectAuthoritativeCompletedHandHistory } from '../sessions/hand-history/completed-hand-history-projector.js'
import type {
  CompletedHandReviewFacts,
  CompletedHandReviewSourceReader,
  ReviewReadBudget,
} from '../sessions/hand-history/completed-hand-review-source.js'
import { decodeCompletedHandHistoryFacts } from './completed-hand-history-repository.js'
import { parseSessionAgentSnapshot } from './session-repository.js'
import {
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'
import type { CoachReadResource } from './coach-read-resource.js'

const sequence = z.number().int().nonnegative().safe()
const EventIdentity = z.strictObject({
  eventSeq: sequence,
  commandLedgerId: z.uuid().nullable(),
  stateVersionBefore: sequence,
  stateVersionAfter: sequence,
  privateEventPayloadVersion: z.unknown(),
  privateEventPayload: z.unknown(),
})
const PersonaRow = z.strictObject({
  hasAgent: z.boolean(),
  participantId: z.uuid(),
  seatNumber: z.number().int().min(1).max(8),
  displayName: z.string().nullable(),
  avatarColor: z.string().nullable(),
  personaId: z.string().nullable(),
  personaVersion: z.number().nullable(),
  configSnapshotKey: z.string().nullable(),
  configPayloadVersion: z.number().nullable(),
  configPayload: z.unknown(),
})
const RowSchema = z.strictObject({
  status: z.enum(['inProgress', 'completed', 'aborted']),
  facts: z.unknown().nullable(),
  personas: z.array(PersonaRow).nullable(),
})
function corrupt(): never {
  throw new PersistenceDataCorruptionError('invalidCompletedHandHistory')
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function decodeCompletedHandReviewRow(
  raw: unknown,
  owner: ResolvedOwnerScope,
) {
  const row = RowSchema.parse(raw)
  if (row.status !== 'completed') {
    if (row.facts !== null || row.personas !== null) corrupt()
    return { kind: 'notCompleted' as const }
  }
  if (
    !row.facts ||
    typeof row.facts !== 'object' ||
    !('events' in row.facts) ||
    !row.personas
  )
    return corrupt()
  const identities = z
    .array(EventIdentity)
    .parse(row.facts.events)
    .sort((a, b) => a.eventSeq - b.eventSeq)
  const history = decodeCompletedHandHistoryFacts(
    {
      ...row.facts,
      events: identities.map((event) => ({
        eventSeq: event.eventSeq,
        privateEventPayloadVersion: event.privateEventPayloadVersion,
        privateEventPayload: event.privateEventPayload,
      })),
    },
    owner,
  )
  projectAuthoritativeCompletedHandHistory(history)
  const events = history.events
  if (
    events[0]?.event.type !== 'handStarted' ||
    events.at(-1)?.event.type !== 'handCompleted' ||
    !same(events[0].event.startedHand, history.checkpoint.startedHand)
  )
    return corrupt()
  let segment: (typeof identities)[number] | undefined
  const usedCommands = new Set<string>()
  for (const [index, fact] of events.entries()) {
    const identity = identities[index]!
    if (index && identity.eventSeq !== identities[index - 1]!.eventSeq + 1)
      corrupt()
    const type = fact.event.type
    if (type === 'handStarted' || type === 'actionCommitted') {
      if (
        (type === 'handStarted' && index !== 0) ||
        (type !== 'handStarted' && identity.commandLedgerId === null) ||
        (identity.commandLedgerId !== null &&
          usedCommands.has(identity.commandLedgerId)) ||
        identity.stateVersionAfter !== identity.stateVersionBefore + 1 ||
        (segment &&
          identity.stateVersionBefore !== segment.stateVersionAfter) ||
        (!segment &&
          identity.stateVersionBefore !==
            history.checkpoint.stateBeforeStartCommand.stateVersion)
      )
        corrupt()
      if (identity.commandLedgerId !== null)
        usedCommands.add(identity.commandLedgerId)
      segment = identity
    } else if (type === 'uncalledBetReturned' || type === 'handCompleted') {
      if (
        !segment ||
        identity.commandLedgerId !== segment.commandLedgerId ||
        identity.stateVersionBefore !== segment.stateVersionBefore ||
        identity.stateVersionAfter !== segment.stateVersionAfter
      )
        corrupt()
    } else if (
      type === 'agentStarted' ||
      type === 'agentRepairAttempted' ||
      type === 'agentPaused'
    ) {
      if (
        !segment ||
        identity.stateVersionBefore !== segment.stateVersionAfter ||
        identity.stateVersionAfter !== identity.stateVersionBefore
      )
        corrupt()
    } else corrupt()
    if (type === 'actionCommitted') {
      const action = fact.event
      if (
        !same(
          action.before.board,
          history.result.board.slice(0, action.before.board.length),
        ) ||
        !same(
          action.after.board,
          history.result.board.slice(0, action.after.board.length),
        )
      )
        corrupt()
    }
  }
  const agents = row.personas.map(parseSessionAgentSnapshot)
  const expectedAgents = history.roster.filter((seat) => !seat.isUser)
  if (
    agents.length !== expectedAgents.length ||
    new Set(agents.map((agent) => agent.participantId)).size !==
      agents.length ||
    agents.some(
      (agent) =>
        !expectedAgents.some(
          (seat) =>
            seat.playerId === agent.participantId &&
            seat.seatNumber === agent.seatNumber &&
            seat.displayName === agent.displayName &&
            seat.avatarColor === agent.avatarColor,
        ),
    )
  )
    corrupt()
  const hero = history.roster.filter((seat) => seat.isUser)
  if (hero.length !== 1 || hero[0]!.seatNumber !== 0) corrupt()
  const facts: CompletedHandReviewFacts = {
    ownerId: history.ownerId,
    sessionId: history.sessionId,
    handId: history.handId,
    pokerRuleSetVersion: history.checkpoint.pokerRuleSetVersion,
    startedHand: history.checkpoint.startedHand,
    completedEventSeq: events.at(-1)!.eventSeq,
    heroSeatNumber: 0,
    personas: agents.map((agent) => ({
      seatNumber: agent.seatNumber,
      participantId: agent.participantId,
      personaId: agent.personaId,
      personaVersion: agent.personaVersion,
      configSnapshotKey: agent.configSnapshotKey,
    })),
    result: history.result.summary,
    events: events.map((fact, index) => {
      const identity = identities[index]!
      const base = {
        eventSeq: identity.eventSeq,
        commandLedgerId: identity.commandLedgerId,
        stateVersionBefore: identity.stateVersionBefore,
        stateVersionAfter: identity.stateVersionAfter,
      }
      const event = fact.event
      switch (event.type) {
        case 'handStarted':
        case 'handCompleted':
        case 'uncalledBetReturned':
          return { ...base, type: event.type }
        case 'actionCommitted':
          return {
            ...base,
            type: event.type,
            action: {
              actorSeatNumber: event.actorSeatNumber,
              command: event.command,
              before: event.before,
              after: event.after,
              legalActionsBefore: event.legalActionsBefore,
              progression: {
                streetTransitions: event.progression.streetTransitions,
                boardCardsAdded: event.progression.boardCardsAdded,
                terminationReason: event.progression.terminationReason,
              },
            },
          }
        default:
          return { ...base, type: 'coordination' as const }
      }
    }),
  }
  return {
    kind: 'completed' as const,
    facts: deepFreezeDecisionValue(structuredClone(facts)),
  }
}

export function createCompletedHandReviewSourceRepository(input: {
  readonly resource: CoachReadResource
  readonly owner: ResolvedOwnerScope
}): CompletedHandReviewSourceReader {
  if (!isResolvedOwnerScope(input.owner))
    throw new RepositoryInputValidationError()
  return Object.freeze({
    async readCompletedSource(handId: string, budget: ReviewReadBudget) {
      if (!z.uuid().safeParse(handId).success)
        throw new RepositoryInputValidationError()
      const rows = await input.resource.read(
        (sql) => sql`
        SELECT h.status,
          CASE WHEN h.status = 'completed' THEN jsonb_build_object(
            'handId', h.id::text, 'sessionId', h.session_id::text, 'handNumber', h.hand_number,
            'startedAt', to_char(h.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'completedAt', to_char(h.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
            'checkpointPayloadVersion', h.hand_start_checkpoint_payload_version, 'checkpointPayload', h.hand_start_checkpoint_payload,
            'completedResultPayloadVersion', h.completed_result_payload_version, 'completedResultPayload', h.completed_result_payload,
            'roster', (SELECT jsonb_agg(jsonb_build_object('seatNumber', p.seat_number, 'playerId', p.id::text, 'participantType', p.participant_type, 'displayName', a.display_name, 'avatarColor', a.avatar_color) ORDER BY p.seat_number)
              FROM app_private.session_participants p LEFT JOIN app_private.session_agents a ON a.participant_id=p.id AND a.session_id=p.session_id AND a.owner_id=p.owner_id WHERE p.session_id=h.session_id AND p.owner_id=h.owner_id),
            'events', (SELECT jsonb_agg(jsonb_build_object('eventSeq', e.event_seq, 'commandLedgerId', e.command_ledger_id::text, 'stateVersionBefore', e.state_version_before, 'stateVersionAfter', e.state_version_after, 'privateEventPayloadVersion', e.private_event_payload_version, 'privateEventPayload', e.private_event_payload) ORDER BY e.event_seq)
              FROM app_private.session_events e WHERE e.hand_id=h.id AND e.session_id=h.session_id AND e.owner_id=h.owner_id)
          ) ELSE NULL END AS facts,
          CASE WHEN h.status = 'completed' THEN (SELECT jsonb_agg(jsonb_build_object(
            'hasAgent', a.participant_id IS NOT NULL, 'participantId', p.id::text, 'seatNumber', p.seat_number,
            'displayName', a.display_name, 'avatarColor', a.avatar_color, 'personaId', a.persona_id, 'personaVersion', a.persona_version,
            'configSnapshotKey', a.config_snapshot_key, 'configPayloadVersion', a.config_payload_version, 'configPayload', a.config_payload
          ) ORDER BY p.seat_number) FROM app_private.session_participants p LEFT JOIN app_private.session_agents a ON a.participant_id=p.id AND a.session_id=p.session_id AND a.owner_id=p.owner_id WHERE p.session_id=h.session_id AND p.owner_id=h.owner_id AND p.participant_type='agent') ELSE NULL END AS personas
        FROM app_private.hands h WHERE h.id=${handId}::uuid AND h.owner_id=${input.owner.databaseOwnerId}::uuid
      `,
        budget,
      )
      budget.signal.throwIfAborted()
      if (rows.length === 0) return { kind: 'notFound' as const }
      if (rows.length !== 1) return corrupt()
      try {
        return decodeCompletedHandReviewRow(rows[0], input.owner)
      } catch (error) {
        if (error instanceof z.ZodError) return corrupt()
        throw error
      }
    },
  })
}
