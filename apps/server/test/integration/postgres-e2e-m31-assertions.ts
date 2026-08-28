import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { JSONValue, Sql, TransactionSql } from 'postgres'
import { PublicSessionSnapshotSchema } from '@tx-holdem-coach/contracts'
import {
  createHandStartedEventDraft,
  createUncalledBetReturnedEventDraft,
} from '../../src/poker/hand-result.js'
import { getLegalActions } from '../../src/poker/betting.js'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPokerTableState } from '../../src/poker/state.js'
import {
  CommandPayloadConflictError,
  DatabaseOperationError,
} from '../../src/persistence/errors.js'
import {
  completeHandAudit,
  insertInProgressHandAudit,
} from '../../src/persistence/hand-audit-repository.js'
import { productionSessionRecoveryRepository } from '../../src/persistence/session-recovery-repository.js'
import {
  productionSessionMutationRepository,
  type SessionMutationBatch,
} from '../../src/persistence/session-mutation-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  insertSessionRosterSnapshot,
  prepareCurrentCatalogRosterSnapshot,
} from '../helpers/session-roster-fixture.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createSessionCommandHandlerMap } from '../../src/sessions/command-execution/command-handler-map.js'
import { createSessionCommandExecutor } from '../../src/sessions/command-execution/session-command-executor.js'
import type { PreparedMutationCapability } from '../../src/sessions/command-execution/command-handler.js'
import type { SnapshotProjectionInput } from '../../src/sessions/command-execution/snapshot-projector.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'
import { createDatabaseFixtureContext } from './database-fixture-context.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
  runDatabaseTestWithCleanup,
  serializeJsonbFixture,
} from './database-test-runtime.js'

const { lockSessionForMutation, persistSessionMutation } =
  productionSessionMutationRepository
const ownerScope = { ownerId: 'local-user' } as const

async function createRosterInput(query: Sql) {
  const catalog = loadAndValidatePersonaCatalog()
  return prepareCurrentCatalogRosterSnapshot(query, ownerScope, catalog, {
    sessionId: randomUUID(),
    userParticipantId: randomUUID(),
    agents: catalog
      .list()
      .slice(0, 5)
      .map((entry, index) => ({
        personaId: entry.personaId,
        seatNumber: index + 1,
        agentParticipantId: randomUUID(),
      })),
  })
}

async function waitForTransactionBlock(
  transaction: TransactionSql,
  firstBackendPid: number,
  secondBackendPid: number,
  requireAgentRunParentLockQuery = false,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await transaction<
      {
        readonly waitsForTransactionId: boolean
        readonly blockedByFirst: boolean
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_locks AS waiting
          JOIN pg_locks AS held
            ON held.locktype = 'transactionid'
            AND held.transactionid = waiting.transactionid
            AND held.granted
            AND held.pid = ${firstBackendPid}::int
          WHERE waiting.pid = ${secondBackendPid}::int
            AND waiting.locktype = 'transactionid'
            AND NOT waiting.granted
        ) AS "waitsForTransactionId",
        ${firstBackendPid}::int = ANY(
          pg_blocking_pids(${secondBackendPid}::int)
        ) AS "blockedByFirst"
    `
    if (rows[0]?.waitsForTransactionId && rows[0].blockedByFirst) {
      if (!requireAgentRunParentLockQuery) {
        return
      }
      const activityRows = await transaction<
        { readonly waitsOnAgentRunParentLockQuery: boolean }[]
      >`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity AS activity
          WHERE activity.pid = ${secondBackendPid}::int
            AND activity.state = 'active'
            AND activity.query LIKE '%FROM app_private.agent_runs%'
            AND activity.query LIKE '%FOR UPDATE%'
        ) AS "waitsOnAgentRunParentLockQuery"
      `
      if (activityRows[0]?.waitsOnAgentRunParentLockQuery) {
        return
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('未观察到第二事务等待第一事务。')
}

type MutationLifecycleStatus = 'active' | 'ended'

interface MutationBatchFixtureInput {
  readonly sessionId: string
  readonly handId: string
  readonly eventIds: readonly string[]
  readonly lockedStateVersion: number
  readonly nextEventSeq: number
  readonly mutationAt: string
  readonly lifecycleStatus?: MutationLifecycleStatus
  readonly writeSnapshot?: boolean
  readonly commandLedgerId?: string | null
  readonly userStack?: number
}

function createMutationPublicSnapshot(
  sessionId: string,
  stateVersion: number,
  eventSeq: number,
  lifecycleStatus: MutationLifecycleStatus,
  userStack = 2_000,
) {
  return {
    sessionId,
    stateVersion,
    eventSeq,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `77777777-7777-4777-8777-${(seatNumber + 1)
        .toString()
        .padStart(12, '0')}`,
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seatNumber === 0,
      stack: seatNumber === 0 ? userStack : 2_000,
      status: 'active' as const,
    })),
    hand: null,
    lastCompletedHandSummary: null,
  }
}

function createMutationBatch(
  input: MutationBatchFixtureInput,
): SessionMutationBatch {
  const lifecycleStatus = input.lifecycleStatus ?? 'active'
  const writeSnapshot = input.writeSnapshot ?? true
  const finalStateVersion = writeSnapshot
    ? input.lockedStateVersion + 1
    : input.lockedStateVersion
  const poker = createTestPokerState({
    seats: createTestPokerState().seats.map((seat) =>
      seat.seatNumber === 0
        ? { ...seat, stack: input.userStack ?? seat.stack }
        : seat,
    ),
  })
  const privateState = createPrivateTableState({
    stateVersion: finalStateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn:
        seat.seatNumber === 0 ? (input.userStack ?? 2_000) : 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const privateEvent = encodeCurrentPrivateEvent(
    createHandStartedEventDraft({
      handId: input.handId,
      handNumber: 1,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
      buttonSeatNumber: 0,
      smallBlindSeatNumber: 1,
      bigBlindSeatNumber: 2,
      positions: [
        { seatNumber: 0, position: 'BTN' },
        { seatNumber: 1, position: 'SB' },
        { seatNumber: 2, position: 'BB' },
        { seatNumber: 3, position: 'UTG' },
        { seatNumber: 4, position: 'HJ' },
        { seatNumber: 5, position: 'CO' },
      ],
      startingStacks: [0, 1, 2, 3, 4, 5].map((seatNumber) => ({
        seatNumber,
        stack: seatNumber === 0 ? (input.userStack ?? 2_000) : 2_000,
      })),
    }),
  )

  return {
    finalStateVersion,
    lifecycleStatus,
    currentHandId: null,
    agentRunState: 'idle',
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    snapshot: writeSnapshot ? encodeSnapshot(privateState) : null,
    events: input.eventIds.map((eventId, index) => {
      const eventSeq = input.nextEventSeq + index
      const publicSnapshot = createMutationPublicSnapshot(
        input.sessionId,
        finalStateVersion,
        eventSeq,
        lifecycleStatus,
        input.userStack,
      )
      return {
        eventId,
        eventSeq,
        handId: input.handId,
        commandLedgerId: input.commandLedgerId ?? null,
        stateVersionBefore: input.lockedStateVersion,
        stateVersionAfter: finalStateVersion,
        privateEvent,
        publicEvent: {
          eventId,
          sessionId: input.sessionId,
          eventSeq,
          stateVersion: finalStateVersion,
          type: 'handStarted',
          payload: { snapshot: publicSnapshot },
        },
        createdAt: input.mutationAt,
      }
    }),
    mutationAt: input.mutationAt,
  }
}

async function insertMutationHand(
  query: Sql,
  ownerId: string,
  sessionId: string,
  handId: string,
): Promise<void> {
  await query`
    INSERT INTO app_private.hands (
      id,
      session_id,
      owner_id,
      hand_number,
      status,
      hand_start_checkpoint_payload_version,
      hand_start_checkpoint_payload,
      button_seat,
      participant_seats,
      started_at
    ) VALUES (
      ${handId}::uuid,
      ${sessionId}::uuid,
      ${ownerId}::uuid,
      1,
      'inProgress',
      1,
      '{}'::jsonb,
      0,
      ARRAY[0, 1, 2, 3, 4, 5]::integer[],
      '2026-08-03T10:00:00.000Z'::timestamptz
    )
  `
}

async function insertCommittedActiveSession(
  sql: Sql,
  sessionId: string,
  handId?: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const query = transaction as unknown as Sql
    const roster = await createRosterInput(query)
    await insertSessionRosterSnapshot(transaction, { ...roster, sessionId })
    if (handId !== undefined) {
      await insertMutationHand(
        query,
        roster.owner.databaseOwnerId,
        sessionId,
        handId,
      )
    }
  })
}

async function insertRecoverableSession(
  sql: Sql,
  sessionId: string,
  handId: string,
  eventId: string,
  fixtureOptions: { readonly userStack?: number } = {},
): Promise<void> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  await insertCommittedActiveSession(sql, sessionId, handId)
  await sql.begin(async (transaction) => {
    const locked = await lockSessionForMutation(transaction, owner, sessionId)
    await persistSessionMutation(
      transaction,
      locked,
      createMutationBatch({
        sessionId,
        handId,
        eventIds: [eventId],
        lockedStateVersion: 0,
        nextEventSeq: 0,
        mutationAt: '2026-08-04T10:00:00.000Z',
        ...(fixtureOptions.userStack === undefined
          ? {}
          : { userStack: fixtureOptions.userStack }),
      }),
    )
    await transaction`
      UPDATE app_private.hands
      SET status = 'aborted',
          abort_reason = 'M2.6 recovery fixture',
          aborted_at = '2026-08-04T10:00:00.000Z'::timestamptz,
          updated_at = '2026-08-04T10:00:00.000Z'::timestamptz
      WHERE id = ${handId}::uuid
        AND session_id = ${sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
  })
}

const M27_RANDOM_SOURCE = Object.freeze({
  nextInt: (maximum: number) => 0 % maximum,
})

function createM27PokerSeats(rebuySeatNumber?: number) {
  return Array.from({ length: 6 }, (_, seatNumber) => ({
    seatNumber,
    playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
      .toString()
      .padStart(12, '0')}`,
    isUser: seatNumber === 0,
    stack: seatNumber === rebuySeatNumber ? 1_250 : 1_000,
    status: 'active' as const,
    streetContribution: 0,
    totalContribution: 0,
  }))
}

function createM27HandAuditFixture(
  handId: string,
  options: { readonly rebuySeatNumber?: number } = {},
) {
  const stateBeforeStartPoker = initializePokerTable(
    createM27PokerSeats(),
    M27_RANDOM_SOURCE,
  )
  const pokerForStart = initializePokerTable(
    createM27PokerSeats(options.rebuySeatNumber),
    M27_RANDOM_SOURCE,
  )
  const started = startPokerHand(pokerForStart, {
    handId,
    completedHandCountBeforeStart: 0,
    randomSource: M27_RANDOM_SOURCE,
  })
  const terminalState = createPokerTableState({
    ...started.state,
    seats: started.state.seats.map((seat) => ({
      ...seat,
      status:
        seat.seatNumber === 2 || seat.seatNumber === 3
          ? ('active' as const)
          : ('folded' as const),
    })),
  })
  const completed = applyPokerAction(terminalState, {
    actorSeatNumber: 3,
    action: { type: 'fold' },
  }).completedHand
  if (completed === null) {
    throw new Error('M2.7 Hand fixture 未产生完成结果。')
  }

  return Object.freeze({
    checkpoint: {
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      stateBeforeStartCommand: createPrivateTableState({
        stateVersion: 7,
        poker: stateBeforeStartPoker,
        completedHandCount: 0,
        seatAccounting: stateBeforeStartPoker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: 1_000,
        })),
        lastCompletedHandSummary: null,
      }),
      startedHand: started.startedHand,
    },
    completed,
  })
}

function createM31SnapshotProjectorBinding(sessionId: string) {
  return {
    projector: {
      project: async ({
        state,
        session,
        eventSeq,
      }: SnapshotProjectionInput) => {
        const hand = state.poker.hand
        return PublicSessionSnapshotSchema.parse({
          sessionId,
          stateVersion: state.stateVersion,
          eventSeq,
          pokerPhase: state.poker.pokerPhase,
          lifecycleStatus: session.lifecycleStatus,
          agentRunState: session.agentRunState,
          activeDecision: null,
          seats: state.poker.seats.map((seat) => ({
            seatNumber: seat.seatNumber,
            playerId: seat.playerId,
            displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
            avatarColor: '#0f766e',
            isUser: seat.isUser,
            stack: seat.stack,
            status: seat.status,
          })),
          hand:
            hand === null
              ? null
              : {
                  handId: hand.handId,
                  street: hand.street,
                  board: hand.board,
                  pot: hand.pot,
                  currentActorSeatNumber: hand.currentActorSeatNumber,
                  heroHoleCards:
                    hand.holeCards.find((cards) => cards.seatNumber === 0)
                      ?.cards ?? null,
                  legalActions: getLegalActions(state.poker),
                  actionTimeline: [],
                },
          lastCompletedHandSummary: null,
        })
      },
    },
    bindReadPort: () => Object.freeze({}),
  }
}

function createM31Executor(input: {
  readonly sql: Sql
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly sessionId: string
  readonly commandType: 'rebuy' | 'endSession'
  readonly handler: object
  readonly eventId: string
  readonly commandAt: string
}) {
  return createSessionCommandExecutor({
    sql: input.sql,
    owner: input.owner,
    handlers: createSessionCommandHandlerMap({
      bindings: [
        {
          commandType: input.commandType,
          handler: input.handler,
          bindReadPort: () => Object.freeze({}),
          bindWritePort: (transaction: TransactionSql) =>
            Object.freeze({
              insertProtocolRelation: async (plan: {
                readonly checkpoint: Parameters<
                  typeof insertInProgressHandAudit
                >[2]['checkpoint']
                readonly completed: Parameters<
                  typeof completeHandAudit
                >[2]['result']
              }) => {
                await insertInProgressHandAudit(transaction, input.owner, {
                  sessionId: input.sessionId,
                  checkpoint: plan.checkpoint,
                  startedAt: '2026-08-05T10:00:00.000Z',
                })
                await completeHandAudit(transaction, input.owner, {
                  sessionId: input.sessionId,
                  handId: plan.checkpoint.startedHand.handId,
                  result: plan.completed,
                  completedAt: '2026-08-05T10:00:01.000Z',
                })
              },
            }),
        } as never,
      ],
    }),
    mutationRepository: productionSessionMutationRepository,
    recoveryRepository: productionSessionRecoveryRepository,
    snapshotProjectorBinding: createM31SnapshotProjectorBinding(
      input.sessionId,
    ),
    now: () => input.commandAt,
    nextEventId: () => input.eventId,
    committedEventPublisher: { publish: () => undefined },
  })
}

function createM31RebuyHandler(
  relationHandId: string,
  beforePrepare: () => Promise<void> = async () => {},
) {
  const relationFixture = createM27HandAuditFixture(relationHandId)
  type RelationPlan = {
    readonly kind: 'rebuy'
  }
  type WritePort = {
    readonly insertProtocolRelation: (plan: RelationPlan) => Promise<unknown>
  }
  return {
    prepare: async ({ state }: { readonly state: PrivateTableState }) => {
      await beforePrepare()
      const userSeat = state.poker.seats.find((seat) => seat.seatNumber === 0)
      const userAccounting = state.seatAccounting.find(
        (seat) => seat.seatNumber === 0,
      )
      if (userSeat === undefined || userAccounting === undefined) {
        throw new Error('M3.1 rebuy fixture 缺少用户座位。')
      }
      const amount = 500
      const stackAfter = userSeat.stack + amount
      const cumulativeBuyInAfter = userAccounting.cumulativeBuyIn + amount
      return {
        kind: 'prepared' as const,
        mutation: {
          stateEffect: {
            kind: 'stateChanged' as const,
            stateContent: {
              poker: {
                ...state.poker,
                seats: state.poker.seats.map((seat) =>
                  seat.seatNumber === 0
                    ? { ...seat, stack: stackAfter, status: 'active' as const }
                    : seat,
                ),
              },
              completedHandCount: state.completedHandCount,
              seatAccounting: state.seatAccounting.map((seat) =>
                seat.seatNumber === 0
                  ? { ...seat, cumulativeBuyIn: cumulativeBuyInAfter }
                  : seat,
              ),
              lastCompletedHandSummary: state.lastCompletedHandSummary,
            },
          },
          lifecycleAfter: 'active' as const,
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle' as const,
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            {
              type: 'userRebuy' as const,
              seatNumber: 0 as const,
              amount,
              stackBefore: userSeat.stack,
              stackAfter,
              cumulativeBuyInBefore: userAccounting.cumulativeBuyIn,
              cumulativeBuyInAfter,
            },
          ],
          relationPlan: Object.freeze({
            kind: 'rebuy' as const,
          }),
        },
      }
    },
    applyRelations: async (
      { writes }: { readonly writes: WritePort },
      capability: PreparedMutationCapability<RelationPlan>,
    ) => {
      await writes.insertProtocolRelation({
        ...capability.relationPlan,
        checkpoint: relationFixture.checkpoint,
        completed: relationFixture.completed,
      } as never)
    },
  }
}

function reportM31ContentionTransactionPid(
  sql: Sql,
  report: (pid: number) => void,
): Sql {
  return {
    begin: async (callback: (transaction: TransactionSql) => unknown) =>
      sql.begin(async (transaction) => {
        await transaction`SET LOCAL statement_timeout = '240s'`
        await transaction`SET LOCAL idle_in_transaction_session_timeout = '240s'`
        report(await readTransactionBackendPid(transaction))
        return callback(transaction)
      }),
  } as unknown as Sql
}

function isPostgresLockTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '55P03'
  )
}

async function deleteM31FixtureSessions(
  sql: Sql,
  sessionIds: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL lock_timeout = '2s'`
        for (const sessionId of sessionIds) {
          await transaction`
            DELETE FROM app_private.sessions
            WHERE id = ${sessionId}::uuid
          `
        }
      })
      return
    } catch (error) {
      if (!isPostgresLockTimeout(error) || Date.now() >= deadline) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function cleanupM31ConcurrentFixture(input: {
  readonly runtimeUrl: string
  readonly role: string
  readonly release: () => void
  readonly clients: readonly Sql[]
  readonly operations: readonly (Promise<unknown> | undefined)[]
  readonly sessionIds: readonly string[]
}): Promise<void> {
  input.release()
  const cleanupFailures: unknown[] = []
  const closeResults = await Promise.allSettled(
    input.clients.map((client) => client.end({ timeout: 0 })),
  )
  cleanupFailures.push(
    ...closeResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  )
  await Promise.allSettled(
    input.operations.filter(
      (operation): operation is Promise<unknown> => operation !== undefined,
    ),
  )

  const cleanupSql = createDatabaseTestSqlForRole(input.runtimeUrl, input.role)
  try {
    await deleteM31FixtureSessions(cleanupSql, input.sessionIds)
  } catch (error) {
    cleanupFailures.push(error)
  } finally {
    const cleanupClose = await Promise.allSettled([
      cleanupSql.end({ timeout: 0 }),
    ])
    if (cleanupClose[0]?.status === 'rejected') {
      cleanupFailures.push(cleanupClose[0].reason)
    }
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'M3.1 并发夹具清理失败。')
  }
}

async function storeInitialM31EventAsCurrent(
  sql: Sql,
  sessionId: string,
  handId: string,
): Promise<void> {
  const stored = encodeCurrentPrivateEvent(
    createUncalledBetReturnedEventDraft(handId, [
      { seatNumber: 1, amount: 10 },
    ]),
  )
  await sql`
    UPDATE app_private.session_events
    SET private_event_payload_version = ${stored.payloadVersion},
        private_event_payload = ${serializeJsonbFixture(stored.payload as unknown as JSONValue)}::text::jsonb,
        public_event_payload = jsonb_set(
          public_event_payload,
          '{type}',
          to_jsonb('uncalledBetReturned'::text)
        )
    WHERE session_id = ${sessionId}::uuid
      AND event_seq = 0
  `
}

async function insertM31RebuyableSession(
  sql: Sql,
  sessionId: string,
  previousHandId: string,
  eventId: string,
): Promise<void> {
  await insertRecoverableSession(sql, sessionId, previousHandId, eventId, {
    userStack: 1_000,
  })
  await sql`
    UPDATE app_private.hands
    SET hand_number = 2
    WHERE id = ${previousHandId}::uuid
      AND session_id = ${sessionId}::uuid
  `
  const stored = encodeCurrentPrivateEvent(
    createUncalledBetReturnedEventDraft(previousHandId, [
      { seatNumber: 1, amount: 10 },
    ]),
  )
  await sql`
    UPDATE app_private.session_events
    SET private_event_payload_version = ${stored.payloadVersion},
        private_event_payload = ${serializeJsonbFixture(stored.payload as unknown as JSONValue)}::text::jsonb,
        public_event_payload = jsonb_set(
          public_event_payload,
          '{type}',
          to_jsonb('uncalledBetReturned'::text)
        )
    WHERE session_id = ${sessionId}::uuid
      AND event_seq = 0
  `
}

async function assertM31ConcurrentVersionConflict(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_200)
  const previousHandId = fixture.id(31_201)
  const relationHandId = fixture.id(31_207)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-first')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-second')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let signalFirstEntered!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    signalFirstEntered = resolve
  })
  let signalFirstPid!: (pid: number) => void
  const firstPid = new Promise<number>((resolve) => {
    signalFirstPid = resolve
  })
  let signalSecondPid!: (pid: number) => void
  const secondPid = new Promise<number>((resolve) => {
    signalSecondPid = resolve
  })
  let firstResult: Promise<unknown> | undefined
  let secondResult: Promise<unknown> | undefined

  await runDatabaseTestWithCleanup(
    async () => {
      await insertM31RebuyableSession(
        sql,
        sessionId,
        previousHandId,
        fixture.id(31_202),
      )
      await storeInitialM31EventAsCurrent(sql, sessionId, previousHandId)
      const firstExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(firstSql, signalFirstPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(relationHandId, async () => {
          signalFirstEntered()
          await firstGate
        }),
        eventId: fixture.id(31_205),
        commandAt: '2026-08-05T10:01:00.000Z',
      })
      const secondExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(secondSql, signalSecondPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(relationHandId),
        eventId: fixture.id(31_206),
        commandAt: '2026-08-05T10:01:01.000Z',
      })
      const firstCommand = {
        sessionId,
        commandId: fixture.id(31_203),
        expectedStateVersion: 1,
        type: 'rebuy' as const,
        payload: { amount: 500 },
      }
      const secondCommand = {
        ...firstCommand,
        commandId: fixture.id(31_204),
      }

      firstResult = firstExecutor.execute(firstCommand)
      await firstEntered
      secondResult = secondExecutor.execute(secondCommand)
      try {
        await waitForTransactionBlock(
          sql as unknown as TransactionSql,
          await firstPid,
          await secondPid,
        )
      } finally {
        releaseFirst()
      }

      await Promise.all([
        expect(firstResult).resolves.toMatchObject({
          kind: 'completed',
          origin: 'newCommit',
          response: { snapshot: { stateVersion: 2, eventSeq: 1 } },
        }),
        expect(secondResult).resolves.toMatchObject({
          kind: 'rejected',
          origin: 'ledgerCommit',
          response: {
            code: 'STATE_VERSION_CONFLICT',
            latestSnapshot: { stateVersion: 2, eventSeq: 1 },
          },
        }),
      ])
      await expect(firstExecutor.execute(firstCommand)).resolves.toMatchObject({
        kind: 'completed',
        origin: 'replay',
      })
      await expect(
        secondExecutor.execute({ ...firstCommand, expectedStateVersion: 2 }),
      ).rejects.toBeInstanceOf(CommandPayloadConflictError)

      const rows = await sql<
        {
          readonly stateVersion: number
          readonly nextEventSeq: number
          readonly eventVersions: number[]
          readonly completedLedgers: number
          readonly failedLedgers: number
        }[]
      >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (SELECT array_agg(event.private_event_payload_version ORDER BY event.event_seq)
         FROM app_private.session_events AS event
         WHERE event.session_id = session.id) AS "eventVersions",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id
           AND ledger.processing_status = 'completed') AS "completedLedgers",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id
           AND ledger.processing_status = 'failed') AS "failedLedgers"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
      expect(rows[0]).toEqual({
        stateVersion: 2,
        nextEventSeq: 2,
        eventVersions: [2, 2],
        completedLedgers: 1,
        failedLedgers: 1,
      })
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-conflict-cleanup',
        release: releaseFirst,
        clients: [firstSql, secondSql],
        operations: [firstResult, secondResult],
        sessionIds: [sessionId],
      }),
  )
}

async function assertM31FailureCleanupDoesNotPollute(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_250)
  const workerSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm31-failure-worker',
  )
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseWorker!: () => void
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve
  })
  let signalWorkerEntered!: () => void
  const workerEntered = new Promise<void>((resolve) => {
    signalWorkerEntered = resolve
  })
  let workerResult: Promise<unknown> | undefined
  const expectedFailure = new Error('expected M3.1 fixture failure')

  try {
    await runDatabaseTestWithCleanup(
      async () => {
        await insertM31RebuyableSession(
          sql,
          sessionId,
          fixture.id(31_251),
          fixture.id(31_252),
        )
        const executor = createM31Executor({
          sql: reportM31ContentionTransactionPid(workerSql, () => {}),
          owner,
          sessionId,
          commandType: 'rebuy',
          handler: createM31RebuyHandler(fixture.id(31_256), async () => {
            signalWorkerEntered()
            await workerGate
          }),
          eventId: fixture.id(31_254),
          commandAt: '2026-08-05T10:01:30.000Z',
        })
        workerResult = executor.execute({
          sessionId,
          commandId: fixture.id(31_253),
          expectedStateVersion: 1,
          type: 'rebuy',
          payload: { amount: 500 },
        })
        await workerEntered
        throw expectedFailure
      },
      async () =>
        cleanupM31ConcurrentFixture({
          runtimeUrl,
          role: 'm31-failure-clean',
          release: releaseWorker,
          clients: [workerSql],
          operations: [workerResult],
          sessionIds: [sessionId],
        }),
    )
  } catch (error) {
    expect(error).toBe(expectedFailure)
  }

  const rows = await sql<{ readonly sessionCount: number }[]>`
    SELECT count(*)::int AS "sessionCount"
    FROM app_private.sessions
    WHERE id = ${sessionId}::uuid
  `
  expect(rows[0]?.sessionCount).toBe(0)
}

async function assertM31WaiterAcquiresAfterRollback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_300)
  const previousHandId = fixture.id(31_301)
  const relationHandId = fixture.id(31_306)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-rollback')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-waiter')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let signalFirstEntered!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    signalFirstEntered = resolve
  })
  let signalFirstPid!: (pid: number) => void
  const firstPid = new Promise<number>((resolve) => {
    signalFirstPid = resolve
  })
  let signalSecondPid!: (pid: number) => void
  const secondPid = new Promise<number>((resolve) => {
    signalSecondPid = resolve
  })
  let firstResult: Promise<unknown> | undefined
  let secondResult: Promise<unknown> | undefined

  await runDatabaseTestWithCleanup(
    async () => {
      await insertM31RebuyableSession(
        sql,
        sessionId,
        previousHandId,
        fixture.id(31_302),
      )
      const failingHandler = {
        prepare: async () => {
          signalFirstEntered()
          await firstGate
          throw new Error('injected M3.1 rollback')
        },
        applyRelations: async () => {},
      }
      const firstExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(firstSql, signalFirstPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: failingHandler,
        eventId: fixture.id(31_304),
        commandAt: '2026-08-05T10:02:00.000Z',
      })
      const secondExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(secondSql, signalSecondPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(relationHandId),
        eventId: fixture.id(31_305),
        commandAt: '2026-08-05T10:02:01.000Z',
      })
      const command = {
        sessionId,
        commandId: fixture.id(31_303),
        expectedStateVersion: 1,
        type: 'rebuy' as const,
        payload: { amount: 500 },
      }

      firstResult = firstExecutor.execute(command)
      await firstEntered
      secondResult = secondExecutor.execute(command)
      try {
        await waitForTransactionBlock(
          sql as unknown as TransactionSql,
          await firstPid,
          await secondPid,
        )
      } finally {
        releaseFirst()
      }

      await Promise.all([
        expect(firstResult).rejects.toThrow('injected M3.1 rollback'),
        expect(secondResult).resolves.toMatchObject({
          kind: 'completed',
          origin: 'newCommit',
          response: { snapshot: { stateVersion: 2, eventSeq: 1 } },
        }),
      ])
      const rows = await sql<
        {
          readonly stateVersion: number
          readonly nextEventSeq: number
          readonly eventCount: number
          readonly ledgerCount: number
        }[]
      >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (SELECT count(*)::int FROM app_private.session_events AS event
         WHERE event.session_id = session.id) AS "eventCount",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id) AS "ledgerCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
      expect(rows[0]).toEqual({
        stateVersion: 2,
        nextEventSeq: 2,
        eventCount: 2,
        ledgerCount: 1,
      })
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-rollback-cleanup',
        release: releaseFirst,
        clients: [firstSql, secondSql],
        operations: [firstResult, secondResult],
        sessionIds: [sessionId],
      }),
  )
}

function holdM31TransactionBeforeCommit(
  sql: Sql,
  signalReady: () => void,
  waitForRelease: Promise<void>,
): Sql {
  return {
    begin: async (callback: (transaction: TransactionSql) => unknown) =>
      sql.begin(async (transaction) => {
        const result = await callback(transaction)
        signalReady()
        await waitForRelease
        return result
      }),
  } as unknown as Sql
}

function rollbackM31TransactionAfterWrites(sql: Sql): Sql {
  return {
    begin: async (callback: (transaction: TransactionSql) => unknown) =>
      sql.begin(async (transaction) => {
        await callback(transaction)
        throw new Error('injected transaction rollback after writes')
      }),
  } as unknown as Sql
}

async function readM31AtomicCounts(sql: Sql, sessionId: string) {
  const rows = await sql<
    {
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly snapshotStateVersion: number
      readonly eventCount: number
      readonly ledgerCount: number
      readonly handCount: number
    }[]
  >`
    SELECT
      session.state_version::int AS "stateVersion",
      session.next_event_seq::int AS "nextEventSeq",
      (SELECT (snapshot.private_table_state_payload #>> '{state,stateVersion}')::int
       FROM app_private.session_snapshots AS snapshot
       WHERE snapshot.session_id = session.id) AS "snapshotStateVersion",
      (SELECT count(*)::int FROM app_private.session_events AS event
       WHERE event.session_id = session.id) AS "eventCount",
      (SELECT count(*)::int FROM app_private.command_ledger AS ledger
       WHERE ledger.session_id = session.id) AS "ledgerCount",
      (SELECT count(*)::int FROM app_private.hands AS hand
       WHERE hand.session_id = session.id) AS "handCount"
    FROM app_private.sessions AS session
    WHERE session.id = ${sessionId}::uuid
  `
  return rows[0]
}

async function assertM31AtomicCommitRollbackAndVisibility(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const commitSessionId = fixture.id(31_400)
  const commitPreviousHandId = fixture.id(31_401)
  const commitRelationHandId = fixture.id(31_402)
  const rollbackSessionId = fixture.id(31_410)
  const rollbackPreviousHandId = fixture.id(31_411)
  const rollbackRelationHandId = fixture.id(31_412)
  const observerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-observer')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseCommit!: () => void
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  let signalWritesReady!: () => void
  const writesReady = new Promise<void>((resolve) => {
    signalWritesReady = resolve
  })
  let commitResult: Promise<unknown> | undefined
  let rollbackResult: Promise<unknown> | undefined
  await runDatabaseTestWithCleanup(
    async () => {
      await insertM31RebuyableSession(
        sql,
        commitSessionId,
        commitPreviousHandId,
        fixture.id(31_403),
      )
      const executor = createM31Executor({
        sql: holdM31TransactionBeforeCommit(
          observerSql,
          signalWritesReady,
          commitGate,
        ),
        owner,
        sessionId: commitSessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(commitRelationHandId),
        eventId: fixture.id(31_404),
        commandAt: '2026-08-05T10:04:00.000Z',
      })
      commitResult = executor.execute({
        sessionId: commitSessionId,
        commandId: fixture.id(31_405),
        expectedStateVersion: 1,
        type: 'rebuy',
        payload: { amount: 500 },
      })
      await writesReady
      expect(await readM31AtomicCounts(sql, commitSessionId)).toEqual({
        stateVersion: 1,
        nextEventSeq: 1,
        snapshotStateVersion: 1,
        eventCount: 1,
        ledgerCount: 0,
        handCount: 1,
      })
      releaseCommit()
      await expect(commitResult).resolves.toMatchObject({
        kind: 'completed',
        origin: 'newCommit',
      })
      expect(await readM31AtomicCounts(sql, commitSessionId)).toEqual({
        stateVersion: 2,
        nextEventSeq: 2,
        snapshotStateVersion: 2,
        eventCount: 2,
        ledgerCount: 1,
        handCount: 2,
      })
      await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${commitSessionId}::uuid
    `

      await insertM31RebuyableSession(
        sql,
        rollbackSessionId,
        rollbackPreviousHandId,
        fixture.id(31_413),
      )
      const rollbackExecutor = createM31Executor({
        sql: rollbackM31TransactionAfterWrites(observerSql),
        owner,
        sessionId: rollbackSessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(rollbackRelationHandId),
        eventId: fixture.id(31_414),
        commandAt: '2026-08-05T10:04:10.000Z',
      })
      rollbackResult = rollbackExecutor.execute({
        sessionId: rollbackSessionId,
        commandId: fixture.id(31_415),
        expectedStateVersion: 1,
        type: 'rebuy',
        payload: { amount: 500 },
      })
      await expect(rollbackResult).rejects.toBeInstanceOf(
        DatabaseOperationError,
      )
      expect(await readM31AtomicCounts(sql, rollbackSessionId)).toEqual({
        stateVersion: 1,
        nextEventSeq: 1,
        snapshotStateVersion: 1,
        eventCount: 1,
        ledgerCount: 0,
        handCount: 1,
      })
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-atomic-cleanup',
        release: releaseCommit,
        clients: [observerSql],
        operations: [commitResult, rollbackResult],
        sessionIds: [commitSessionId, rollbackSessionId],
      }),
  )
}

async function assertM31DifferentSessionsRunInParallel(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const firstSessionId = fixture.id(31_500)
  const secondSessionId = fixture.id(31_510)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-parallel-1')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-parallel-2')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalFirst!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    signalFirst = resolve
  })
  let signalSecond!: () => void
  const secondEntered = new Promise<void>((resolve) => {
    signalSecond = resolve
  })
  let first: Promise<unknown> | undefined
  let second: Promise<unknown> | undefined
  await runDatabaseTestWithCleanup(
    async () => {
      await insertRecoverableSession(
        sql,
        firstSessionId,
        fixture.id(31_501),
        fixture.id(31_502),
      )
      const endingHandler = {
        prepare: async () => ({
          kind: 'prepared' as const,
          mutation: {
            stateEffect: { kind: 'stateUnchanged' as const },
            lifecycleAfter: 'ended' as const,
            currentHandIdAfter: null,
            playerCoordinationAfter: {
              agentRunState: 'idle' as const,
              activePlayerRunId: null,
              activeDecisionRequestId: null,
            },
            privateEventDrafts: [
              {
                type: 'sessionEnded' as const,
                reason: 'userRequested' as const,
              },
            ] as const,
            relationPlan: Object.freeze({ kind: 'normalEnd' }),
          },
        }),
        applyRelations: async () => {},
      }
      const endedCommand = {
        sessionId: firstSessionId,
        commandId: fixture.id(31_505),
        expectedStateVersion: 1,
        type: 'endSession' as const,
        payload: {},
      }
      await expect(
        createM31Executor({
          sql: firstSql,
          owner,
          sessionId: firstSessionId,
          commandType: 'endSession',
          handler: endingHandler,
          eventId: fixture.id(31_504),
          commandAt: '2026-08-05T10:05:00.000Z',
        }).execute(endedCommand),
      ).resolves.toMatchObject({ kind: 'completed', origin: 'newCommit' })
      await insertM31RebuyableSession(
        sql,
        secondSessionId,
        fixture.id(31_511),
        fixture.id(31_512),
      )
      const firstExecutor = createM31Executor({
        sql: holdM31TransactionBeforeCommit(firstSql, signalFirst, gate),
        owner,
        sessionId: firstSessionId,
        commandType: 'endSession',
        handler: endingHandler,
        eventId: fixture.id(31_504),
        commandAt: '2026-08-05T10:05:00.000Z',
      })
      const secondExecutor = createM31Executor({
        sql: secondSql,
        owner,
        sessionId: secondSessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(fixture.id(31_513), async () => {
          signalSecond()
          await gate
        }),
        eventId: fixture.id(31_514),
        commandAt: '2026-08-05T10:05:01.000Z',
      })
      first = firstExecutor.execute(endedCommand)
      second = secondExecutor.execute({
        sessionId: secondSessionId,
        commandId: fixture.id(31_515),
        expectedStateVersion: 1,
        type: 'rebuy',
        payload: { amount: 500 },
      })
      await Promise.all([firstEntered, secondEntered])
      release()
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { kind: 'completed', origin: 'replay' },
        { kind: 'completed', origin: 'newCommit' },
      ])
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-parallel-cleanup',
        release,
        clients: [firstSql, secondSql],
        operations: [first, second],
        sessionIds: [firstSessionId, secondSessionId],
      }),
  )
}

export async function assertM31SessionCommandExecutor(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_100)
  const handId = fixture.id(31_101)
  const initialEventId = fixture.id(31_102)
  const commandId = fixture.id(31_103)
  const terminalEventId = fixture.id(31_104)
  const owner = await resolveOwnerScope(sql, ownerScope)
  try {
    await insertRecoverableSession(sql, sessionId, handId, initialEventId)
    const handler = {
      prepare: async () => ({
        kind: 'prepared' as const,
        mutation: {
          stateEffect: { kind: 'stateUnchanged' as const },
          lifecycleAfter: 'ended' as const,
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle' as const,
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            { type: 'sessionEnded' as const, reason: 'userRequested' as const },
          ] as const,
          relationPlan: Object.freeze({ kind: 'normalEnd' }),
        },
      }),
      applyRelations: async () => {},
    }
    const executor = createM31Executor({
      sql,
      owner,
      sessionId,
      commandType: 'endSession',
      handler,
      eventId: terminalEventId,
      commandAt: '2026-08-05T10:00:00.000Z',
    })
    const command = {
      sessionId,
      commandId,
      expectedStateVersion: 1,
      type: 'endSession' as const,
      payload: {},
    }

    const committed = await executor.execute(command)
    expect(committed).toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: {
        snapshot: {
          lifecycleStatus: 'ended',
          stateVersion: 1,
          eventSeq: 1,
        },
      },
    })
    const replay = await executor.execute(command)
    expect(replay).toEqual({
      kind: 'completed',
      origin: 'replay',
      response: committed.kind === 'completed' ? committed.response : null,
    })

    const rows = await sql<
      {
        readonly lifecycleStatus: string
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly eventCount: number
        readonly ledgerCount: number
      }[]
    >`
      SELECT
        session.lifecycle_status AS "lifecycleStatus",
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (SELECT count(*)::int FROM app_private.session_events AS event
         WHERE event.session_id = session.id) AS "eventCount",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id) AS "ledgerCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      lifecycleStatus: 'ended',
      stateVersion: 1,
      nextEventSeq: 2,
      eventCount: 2,
      ledgerCount: 1,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
  await assertM31ConcurrentVersionConflict(sql, runtimeUrl)
  await assertM31FailureCleanupDoesNotPollute(sql, runtimeUrl)
  await assertM31WaiterAcquiresAfterRollback(sql, runtimeUrl)
  await assertM31AtomicCommitRollbackAndVisibility(sql, runtimeUrl)
  await assertM31DifferentSessionsRunInParallel(sql, runtimeUrl)
}
