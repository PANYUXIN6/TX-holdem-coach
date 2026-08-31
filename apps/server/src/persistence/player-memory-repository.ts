import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../persisted-json.js'
import { CompletedHandResultSchema } from '../poker/hand-result.js'
import { currentPrivateEventReader } from '../sessions/authoritative-state/private-event-codec.js'
import type { PlayerVisibleState } from '../sessions/authoritative-state/player-visible-state.js'
import {
  decodePlayerSessionMemoryV1,
  foldPlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
  PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
  PlayerMemoryLifecycleFactSchema,
  PLAYER_EMPTY_SESSION_MEMORY_V1,
  type AgentMemoryPayloadV1,
  type PlayerMemoryLifecycleFact,
} from '../agents/player/player-session-memory.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const UuidSchema = z.string().uuid()
const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const HexDigestSchema = z.string().regex(/^[0-9a-f]{64}$/)

const LockedRunSchema = z.strictObject({
  runId: UuidSchema,
  sessionId: UuidSchema,
  handId: UuidSchema,
  participantId: UuidSchema,
  sourceStateVersion: SafeIntegerSchema,
  decisionRequestId: UuidSchema,
})
const MemoryRowSchema = z.strictObject({
  participantId: UuidSchema,
  sessionId: UuidSchema,
  ownerId: UuidSchema,
  revision: SafeIntegerSchema,
  payloadVersion: z.literal(1),
  payload: z.unknown(),
  sourceAgentRunId: UuidSchema.nullable(),
  sourceHandId: UuidSchema.nullable(),
  sourceStateVersion: SafeIntegerSchema.nullable(),
  decisionRequestId: UuidSchema.nullable(),
  asOfEventSeq: SafeIntegerSchema.nullable(),
  memorySha256: HexDigestSchema,
})
const SourceHandRowSchema = z.strictObject({
  handId: UuidSchema,
  handNumber: SafeIntegerSchema.positive(),
  status: z.enum(['completed', 'aborted', 'inProgress']),
  buttonSeatNumber: z.number().int().min(0).max(8),
  participantSeats: z.array(z.number().int().min(0).max(8)).min(6).max(9),
  completedPayloadVersion: z.unknown().nullable(),
  completedPayload: z.unknown().nullable(),
  terminalEventSeq: SafeIntegerSchema.nullable(),
})
const ParticipantRowSchema = z.strictObject({
  participantId: UuidSchema,
  seatNumber: z.number().int().min(0).max(8),
})
const EventRowSchema = z.strictObject({
  handId: UuidSchema,
  eventSeq: SafeIntegerSchema,
  payloadVersion: z.unknown(),
  payload: z.unknown(),
})

export class PlayerMemoryRepositoryError extends Error {
  public constructor(
    public readonly code:
      | 'authorityLost'
      | 'invalidMemory'
      | 'invalidSource'
      | 'integrityViolation',
  ) {
    super(`Player Memory Repository 错误：${code}`)
    this.name = 'PlayerMemoryRepositoryError'
  }
}

export interface CertifiedPlayerMemoryRevisionV1 {
  readonly revision: number
  readonly payloadVersion: 1
  readonly payload: AgentMemoryPayloadV1
  readonly sha256: string
  readonly sourceAgentRunId: string | null
  readonly sourceHandId: string | null
  readonly sourceStateVersion: number | null
  readonly decisionRequestId: string | null
  readonly asOfEventSeq: number | null
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

async function queryRows(
  query: Promise<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await query
  } catch {
    throw new DatabaseOperationError()
  }
}

function one<T>(rows: readonly unknown[], schema: z.ZodType<T>): T {
  const parsed = z.array(schema).safeParse(rows)
  if (!parsed.success || parsed.data.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }
  return parsed.data[0]!
}

function decodeMemoryRow(
  row: z.infer<typeof MemoryRowSchema>,
): CertifiedPlayerMemoryRevisionV1 {
  let payload: AgentMemoryPayloadV1
  try {
    payload = decodePlayerSessionMemoryV1(row.payload)
  } catch {
    throw new PlayerMemoryRepositoryError('invalidMemory')
  }
  if (hashPlayerSessionMemoryV1(payload) !== row.memorySha256) {
    throw new PlayerMemoryRepositoryError('integrityViolation')
  }
  const sources = [
    row.sourceAgentRunId,
    row.sourceHandId,
    row.sourceStateVersion,
    row.decisionRequestId,
    row.asOfEventSeq,
  ]
  if (
    (row.revision === 0 && sources.some((value) => value !== null)) ||
    (row.revision > 0 && sources.some((value) => value === null))
  ) {
    throw new PlayerMemoryRepositoryError('integrityViolation')
  }
  if (
    row.revision === 0 &&
    canonicalJson(payload as unknown as JsonValue) !==
      canonicalJson(PLAYER_EMPTY_SESSION_MEMORY_V1 as unknown as JsonValue)
  ) {
    throw new PlayerMemoryRepositoryError('integrityViolation')
  }
  return deepFreeze({
    revision: row.revision,
    payloadVersion: PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
    payload,
    sha256: row.memorySha256,
    sourceAgentRunId: row.sourceAgentRunId,
    sourceHandId: row.sourceHandId,
    sourceStateVersion: row.sourceStateVersion,
    decisionRequestId: row.decisionRequestId,
    asOfEventSeq: row.asOfEventSeq,
  })
}

async function lockLiveRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  authority: RuntimeCommitAuthority<'player'>,
) {
  const rows = await queryRows(transaction`
    SELECT id::text AS "runId", session_id::text AS "sessionId",
           hand_id::text AS "handId", participant_id::text AS "participantId",
           source_state_version::float8 AS "sourceStateVersion",
           decision_request_id::text AS "decisionRequestId"
    FROM app_private.agent_runs
    WHERE id = ${authority.runId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND runtime = 'player'
      AND execution_mode = 'live'
      AND lifecycle = 'running'
      AND lease_owner = ${authority.leaseOwner}
      AND fencing_token = ${authority.fencingToken}::bigint
      AND lease_expires_at > clock_timestamp()
      AND deadline_at > clock_timestamp()
    FOR UPDATE
  `)
  if (rows.length === 0) throw new PlayerMemoryRepositoryError('authorityLost')
  return one(rows, LockedRunSchema)
}

async function lockSessionForLiveRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  authority: RuntimeCommitAuthority<'player'>,
): Promise<string> {
  const rows = await queryRows(transaction`
    SELECT session.id::text AS "sessionId"
    FROM app_private.sessions AS session
    JOIN app_private.agent_runs AS run
      ON run.session_id = session.id AND run.owner_id = session.owner_id
    WHERE run.id = ${authority.runId}::uuid
      AND run.owner_id = ${owner.databaseOwnerId}::uuid
      AND run.runtime = 'player'
      AND run.execution_mode = 'live'
    FOR SHARE OF session
  `)
  return one(rows, z.strictObject({ sessionId: UuidSchema })).sessionId
}

function toLifecycleFacts(input: {
  readonly sourceHands: readonly z.infer<typeof SourceHandRowSchema>[]
  readonly participantBySeat: ReadonlyMap<number, string>
  readonly eventsByHand: ReadonlyMap<
    string,
    readonly z.infer<typeof EventRowSchema>[]
  >
}): readonly PlayerMemoryLifecycleFact[] {
  return input.sourceHands.map((hand) => {
    if (hand.status === 'inProgress' || hand.terminalEventSeq === null) {
      throw new PlayerMemoryRepositoryError('invalidSource')
    }
    if (hand.status === 'aborted') {
      return PlayerMemoryLifecycleFactSchema.parse({
        handNumber: hand.handNumber,
        terminalEventSeq: hand.terminalEventSeq,
        status: 'aborted',
      })
    }
    if (hand.completedPayloadVersion !== 1 || hand.completedPayload === null) {
      throw new PlayerMemoryRepositoryError('invalidSource')
    }
    const result = CompletedHandResultSchema.safeParse(hand.completedPayload)
    if (!result.success || result.data.handId !== hand.handId) {
      throw new PlayerMemoryRepositoryError('invalidSource')
    }
    const participants = hand.participantSeats.map((seatNumber) => {
      const participantId = input.participantBySeat.get(seatNumber)
      if (participantId === undefined)
        throw new PlayerMemoryRepositoryError('invalidSource')
      return { participantId, seatNumber }
    })
    const events = input.eventsByHand.get(hand.handId) ?? []
    const actions = events.flatMap((row) => {
      const decoded = currentPrivateEventReader.read(
        row.payloadVersion,
        row.payload,
      )
      if (decoded.kind !== 'decoded') {
        throw new PlayerMemoryRepositoryError('invalidSource')
      }
      if (decoded.value.type !== 'actionCommitted') return []
      const action = decoded.value
      return [
        {
          eventSeq: row.eventSeq,
          actorSeatNumber: action.actorSeatNumber,
          actionType: action.command.action.type,
          contributionDelta:
            action.statistics === undefined
              ? 0
              : Math.max(0, action.after.pot - action.before.pot),
          isVoluntaryPreflopContribution:
            action.statistics.isVoluntaryPreflopContribution,
          isFullRaise: action.statistics.isVoluntaryPreflopFullRaise,
          facedAggression: isPlayerMemoryFacingAggressionV1(
            action.legalActionsBefore,
          ),
        },
      ]
    })
    const eligibleSeats = new Set(
      result.data.summary.pots.flatMap((pot) => pot.eligibleSeatNumbers),
    )
    const revealedHands =
      result.data.terminationReason === 'showdown'
        ? result.data.summary.participantHands
            .filter(
              (entry) =>
                eligibleSeats.has(entry.seatNumber) &&
                entry.handEvaluation !== null,
            )
            .map(({ seatNumber, holeCards }) => ({ seatNumber, holeCards }))
        : []
    const board = result.data.summary.board
    if (result.data.terminationReason === 'showdown' && board.length !== 5) {
      throw new PlayerMemoryRepositoryError('invalidSource')
    }
    return PlayerMemoryLifecycleFactSchema.parse({
      handNumber: hand.handNumber,
      terminalEventSeq: hand.terminalEventSeq,
      status: 'completed',
      buttonSeatNumber: hand.buttonSeatNumber,
      participants,
      actions,
      showdown:
        result.data.terminationReason === 'showdown'
          ? {
              board: [board[0]!, board[1]!, board[2]!, board[3]!, board[4]!],
              revealedHands,
            }
          : null,
    })
  })
}

/**
 * 当前投注投影只会在 amountToCallBefore 为零时给行动者 check。因此不能因
 * raise/allIn 在合法列表中出现就认为面对攻击；没有 check 与 amountToCallBefore
 * 为正等价，也覆盖短码只能 all-in 跟注的合法行动集。
 */
export function isPlayerMemoryFacingAggressionV1(
  legalActions: readonly { readonly type: string }[],
): boolean {
  return !legalActions.some(({ type }) => type === 'check')
}

export interface PlayerMemoryRepository {
  materializeForRun(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    authority: RuntimeCommitAuthority<'player'>,
    observation: PlayerVisibleState,
  ): Promise<CertifiedPlayerMemoryRevisionV1>
  readForRun(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: { readonly runId: string; readonly participantId: string },
  ): Promise<CertifiedPlayerMemoryRevisionV1>
}

export function createPlayerMemoryRepository(): PlayerMemoryRepository {
  const repository: PlayerMemoryRepository = {
    async materializeForRun(transaction, owner, authority, observation) {
      if (
        !isResolvedOwnerScope(owner) ||
        !isRuntimeCommitAuthority(authority, 'player')
      ) {
        throw new RepositoryInputValidationError()
      }
      const sessionId = await lockSessionForLiveRun(
        transaction,
        owner,
        authority,
      )
      const run = await lockLiveRun(transaction, owner, authority)
      if (
        sessionId !== run.sessionId ||
        observation.identity.sessionId !== run.sessionId ||
        observation.identity.handId !== run.handId ||
        observation.identity.actorParticipantId !== run.participantId ||
        observation.identity.stateVersion !== run.sourceStateVersion ||
        observation.identity.decisionRequestId !== run.decisionRequestId
      ) {
        throw new PlayerMemoryRepositoryError('authorityLost')
      }
      const currentRows = await queryRows(transaction`
        SELECT memory.revision::float8 AS "revision",
               memory.memory_payload_version AS "payloadVersion",
               memory.memory_payload AS "payload",
               memory.participant_id::text AS "participantId",
               memory.session_id::text AS "sessionId",
               memory.owner_id::text AS "ownerId",
               memory.source_agent_run_id::text AS "sourceAgentRunId",
               memory.source_hand_id::text AS "sourceHandId",
               memory.source_state_version::float8 AS "sourceStateVersion",
               memory.decision_request_id::text AS "decisionRequestId",
               memory.as_of_event_seq::float8 AS "asOfEventSeq",
               memory.memory_sha256 AS "memorySha256"
        FROM app_private.session_agents AS agent
        JOIN app_private.agent_memory_revisions AS memory
          ON memory.participant_id = agent.participant_id
          AND memory.session_id = agent.session_id
          AND memory.owner_id = agent.owner_id
          AND memory.revision = agent.current_memory_revision
        WHERE agent.participant_id = ${run.participantId}::uuid
          AND agent.session_id = ${run.sessionId}::uuid
          AND agent.owner_id = ${owner.databaseOwnerId}::uuid
        FOR UPDATE OF agent
      `)
      const current = decodeMemoryRow(one(currentRows, MemoryRowSchema))
      const existingRows = await queryRows(transaction`
        SELECT participant_id::text AS "participantId", session_id::text AS "sessionId",
               owner_id::text AS "ownerId", revision::float8 AS "revision",
               memory_payload_version AS "payloadVersion", memory_payload AS "payload",
               source_agent_run_id::text AS "sourceAgentRunId", source_hand_id::text AS "sourceHandId",
               source_state_version::float8 AS "sourceStateVersion", decision_request_id::text AS "decisionRequestId",
               as_of_event_seq::float8 AS "asOfEventSeq", memory_sha256 AS "memorySha256"
        FROM app_private.agent_memory_revisions
        WHERE source_agent_run_id = ${run.runId}::uuid
        FOR SHARE
      `)
      if (existingRows.length > 1)
        throw new PlayerMemoryRepositoryError('integrityViolation')
      if (existingRows.length === 1)
        return decodeMemoryRow(one(existingRows, MemoryRowSchema))
      const sourceHandsRows = await queryRows(transaction`
        SELECT hand.id::text AS "handId", hand.hand_number::float8 AS "handNumber",
               hand.status, hand.button_seat AS "buttonSeatNumber",
               hand.participant_seats AS "participantSeats",
               hand.completed_result_payload_version AS "completedPayloadVersion",
               hand.completed_result_payload AS "completedPayload",
               max(event.event_seq)::float8 AS "terminalEventSeq"
        FROM app_private.hands AS hand
        LEFT JOIN app_private.session_events AS event
          ON event.hand_id = hand.id AND event.session_id = hand.session_id
        WHERE hand.session_id = ${run.sessionId}::uuid
          AND hand.owner_id = ${owner.databaseOwnerId}::uuid
          AND hand.hand_number > ${current.payload.scannedThrough?.handNumber ?? 0}::bigint
          AND hand.hand_number < ${observation.hand.handNumber}::bigint
        GROUP BY hand.id
        ORDER BY hand.hand_number ASC
      `)
      const sourceHands = z
        .array(SourceHandRowSchema)
        .safeParse(sourceHandsRows)
      if (!sourceHands.success)
        throw new PlayerMemoryRepositoryError('invalidSource')
      const participantRows = await queryRows(transaction`
        SELECT id::text AS "participantId", seat_number AS "seatNumber"
        FROM app_private.session_participants
        WHERE session_id = ${run.sessionId}::uuid AND owner_id = ${owner.databaseOwnerId}::uuid
        ORDER BY seat_number ASC
      `)
      const participants = z
        .array(ParticipantRowSchema)
        .safeParse(participantRows)
      if (!participants.success)
        throw new PlayerMemoryRepositoryError('invalidSource')
      const sourceHandIds = sourceHands.data.map(({ handId }) => handId)
      // fold 只会读取还未折叠的连续 Hand；不重复扫描早已写入 Memory 的事件。
      const eventRows =
        sourceHandIds.length === 0
          ? []
          : await queryRows(transaction`
              SELECT hand_id::text AS "handId", event_seq::float8 AS "eventSeq",
                     private_event_payload_version AS "payloadVersion", private_event_payload AS "payload"
              FROM app_private.session_events
              WHERE session_id = ${run.sessionId}::uuid
                AND owner_id = ${owner.databaseOwnerId}::uuid
                AND hand_id = ANY(${transaction.array(sourceHandIds)}::uuid[])
                AND event_seq <= ${observation.identity.asOfEventSeq}::bigint
              ORDER BY hand_id, event_seq
            `)
      const events = z.array(EventRowSchema).safeParse(eventRows)
      if (!events.success)
        throw new PlayerMemoryRepositoryError('invalidSource')
      const eventsByHand = new Map<string, z.infer<typeof EventRowSchema>[]>()
      for (const event of events.data) {
        const currentEvents = eventsByHand.get(event.handId) ?? []
        currentEvents.push(event)
        eventsByHand.set(event.handId, currentEvents)
      }
      const nextPayload = foldPlayerSessionMemoryV1({
        memory: current.payload,
        actorParticipantId: run.participantId,
        cutoff: {
          handNumber: observation.hand.handNumber,
          eventSeq: observation.identity.asOfEventSeq,
        },
        hands: toLifecycleFacts({
          sourceHands: sourceHands.data,
          participantBySeat: new Map(
            participants.data.map((row) => [row.seatNumber, row.participantId]),
          ),
          eventsByHand,
        }),
      })
      const nextRevision = current.revision + 1
      const nextSha256 = hashPlayerSessionMemoryV1(nextPayload)
      const insertedRows = await queryRows(transaction`
        INSERT INTO app_private.agent_memory_revisions (
          participant_id, session_id, owner_id, revision, memory_payload_version,
          memory_payload, source_agent_run_id, source_hand_id, source_state_version,
          decision_request_id, as_of_event_seq, memory_sha256
        ) VALUES (
          ${run.participantId}::uuid, ${run.sessionId}::uuid, ${owner.databaseOwnerId}::uuid,
          ${nextRevision}::bigint, 1, ${transaction.json(nextPayload)},
          ${run.runId}::uuid, ${run.handId}::uuid, ${run.sourceStateVersion}::bigint,
          ${run.decisionRequestId}::uuid, ${observation.identity.asOfEventSeq}::bigint, ${nextSha256}
        )
        RETURNING participant_id::text AS "participantId", session_id::text AS "sessionId",
                  owner_id::text AS "ownerId", revision::float8 AS "revision",
                  memory_payload_version AS "payloadVersion", memory_payload AS "payload",
                  source_agent_run_id::text AS "sourceAgentRunId", source_hand_id::text AS "sourceHandId",
                  source_state_version::float8 AS "sourceStateVersion", decision_request_id::text AS "decisionRequestId",
                  as_of_event_seq::float8 AS "asOfEventSeq", memory_sha256 AS "memorySha256"
      `)
      const inserted = decodeMemoryRow(one(insertedRows, MemoryRowSchema))
      const updated = await queryRows(transaction`
        UPDATE app_private.session_agents
        SET current_memory_revision = ${inserted.revision}::bigint,
            memory_payload_version = 1,
            memory_payload = ${transaction.json(inserted.payload)},
            updated_at = clock_timestamp()
        WHERE participant_id = ${run.participantId}::uuid
          AND session_id = ${run.sessionId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
          AND current_memory_revision = ${current.revision}::bigint
        RETURNING current_memory_revision::float8 AS revision, memory_payload AS payload
      `)
      const updatedRow = one(
        updated,
        z.strictObject({ revision: SafeIntegerSchema, payload: z.unknown() }),
      )
      if (
        updatedRow.revision !== inserted.revision ||
        hashPlayerSessionMemoryV1(updatedRow.payload) !== inserted.sha256
      ) {
        throw new PlayerMemoryRepositoryError('integrityViolation')
      }
      return inserted
    },

    async readForRun(transaction, owner, input) {
      const parsed = z
        .strictObject({ runId: UuidSchema, participantId: UuidSchema })
        .safeParse(input)
      if (!isResolvedOwnerScope(owner) || !parsed.success)
        throw new RepositoryInputValidationError()
      const rows = await queryRows(transaction`
        SELECT memory.participant_id::text AS "participantId", memory.session_id::text AS "sessionId",
               memory.owner_id::text AS "ownerId", memory.revision::float8 AS "revision",
               memory.memory_payload_version AS "payloadVersion", memory.memory_payload AS "payload",
               memory.source_agent_run_id::text AS "sourceAgentRunId", memory.source_hand_id::text AS "sourceHandId",
               memory.source_state_version::float8 AS "sourceStateVersion", memory.decision_request_id::text AS "decisionRequestId",
               memory.as_of_event_seq::float8 AS "asOfEventSeq", memory.memory_sha256 AS "memorySha256"
        FROM app_private.agent_memory_revisions AS memory
        JOIN app_private.agent_runs AS run ON run.id = memory.source_agent_run_id
          AND run.session_id = memory.session_id AND run.owner_id = memory.owner_id
        WHERE memory.source_agent_run_id = ${parsed.data.runId}::uuid
          AND memory.participant_id = ${parsed.data.participantId}::uuid
          AND memory.owner_id = ${owner.databaseOwnerId}::uuid
          AND run.runtime = 'player' AND run.execution_mode = 'live'
      `)
      if (rows.length === 0) throw new ResourceNotFoundError()
      return decodeMemoryRow(one(rows, MemoryRowSchema))
    },
  }
  return Object.freeze(repository)
}
