import { randomUUID } from 'node:crypto'
import {
  CommandResponseSchema,
  ErrorResponseSchema,
  SseEventSchema,
  type PokerAction,
} from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { getLegalActions } from '../../src/poker/betting.js'
import { applyPokerAction } from '../../src/poker/poker-engine.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  productionSessionMutationRepository,
  type SessionMutationRepository,
} from '../../src/persistence/session-mutation-repository.js'
import {
  createSessionRecoveryRepository,
  productionSessionRecoveryRepository,
  type SessionRecoveryRepository,
} from '../../src/persistence/session-recovery-repository.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  getPrivateEventHandId,
  type PrivateEvent,
} from '../../src/sessions/authoritative-state/private-event.js'
import { currentPrivateEventReader } from '../../src/sessions/authoritative-state/private-event-codec.js'
import {
  currentSnapshotReader,
  decodeCurrentSnapshot,
  encodeSnapshot,
} from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { decodeCurrentCompletedHandResult } from '../../src/sessions/hand-audit/completed-hand-result-codec.js'
import { currentHandStartCheckpointReader } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import { createSessionCommandHandlerMap } from '../../src/sessions/command-execution/command-handler-map.js'
import { createPlayerActionHandlerBinding } from '../../src/sessions/command-execution/player-action-handler.js'
import { createSessionCommandExecutor } from '../../src/sessions/command-execution/session-command-executor.js'
import type { SnapshotProjectionInput } from '../../src/sessions/command-execution/snapshot-projector.js'
import type { SessionCreationIdentityGraph } from '../../src/sessions/session-creation/session-creation-consistency.js'
import {
  clearLocalOwnerSessions,
  createM32Service,
  currentCatalogRequest,
  projectPublicSnapshot,
} from './database-m32-assertions.js'
import { createDatabaseTestSqlForRole } from './database-test-runtime.js'

const COMMAND_AT = '2026-08-10T12:00:00.000Z'
const PREPARATION_AT = '2026-08-10T11:59:00.000Z'

function createDeferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve() {
      resolvePromise?.()
    },
  }
}

export async function createSessionFixture(
  sql: Sql,
  randomValue: number,
): Promise<SessionCreationIdentityGraph> {
  await clearLocalOwnerSessions(sql)
  let identity: SessionCreationIdentityGraph | undefined
  let randomCalls = 0
  const result = await createM32Service(
    sql,
    (created) => {
      identity = created
    },
    {
      randomSource: {
        nextInt: (maximum) => {
          const value = randomCalls === 0 ? randomValue : 0
          randomCalls += 1
          return value % maximum
        },
      },
    },
  ).create(currentCatalogRequest(5))
  expect(result.kind).toBe('created')
  if (identity === undefined) throw new Error('M3.3 缺少创建身份图。')
  return identity
}

export async function readPrivateState(
  sql: Sql | TransactionSql,
  sessionId: string,
) {
  const rows = await sql<
    { readonly payloadVersion: number; readonly payload: unknown }[]
  >`
    SELECT
      private_table_state_payload_version AS "payloadVersion",
      private_table_state_payload AS payload
    FROM app_private.session_snapshots
    WHERE session_id = ${sessionId}::uuid
  `
  const row = rows[0]
  if (row === undefined || rows.length !== 1) {
    throw new Error('M3.3 缺少唯一权威快照。')
  }
  return decodeCurrentSnapshot(row).payload.state
}

function choosePreparationAction(
  state: PrivateTableState,
  contenderCount: number,
): PokerAction {
  const actorSeatNumber = state.poker.hand?.currentActorSeatNumber
  if (actorSeatNumber === null || actorSeatNumber === undefined) {
    throw new Error('M3.3 准备阶段缺少当前行动者。')
  }
  if (actorSeatNumber !== 0 && contenderCount > 2) {
    return { type: 'fold' }
  }
  const passiveAction = getLegalActions(state.poker).find(
    (action) => action.type === 'check' || action.type === 'call',
  )
  if (passiveAction?.type === 'check') return { type: 'check' }
  if (passiveAction?.type === 'call') return { type: 'call' }
  throw new Error('M3.3 固定牌堆准备路径缺少被动合法行动。')
}

export async function prepareTerminalUserTurn(
  sql: Sql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  identity: SessionCreationIdentityGraph,
): Promise<{
  readonly state: PrivateTableState
  readonly eventDrafts: readonly PrivateEvent[]
  readonly firstEventSeq: number
  readonly lastEventSeq: number
}> {
  return sql.begin(async (transaction: TransactionSql) => {
    const locked =
      await productionSessionMutationRepository.lockSessionForMutation(
        transaction,
        owner,
        identity.sessionId,
      )
    const initialState = await readPrivateState(transaction, identity.sessionId)
    if (initialState.stateVersion !== locked.stateVersion) {
      throw new Error('M3.3 准备阶段快照版本不一致。')
    }

    let state = initialState
    const eventDrafts: PrivateEvent[] = []
    for (let actionCount = 0; actionCount < 64; actionCount += 1) {
      const hand = state.poker.hand
      if (hand === null) {
        throw new Error('M3.3 准备阶段意外终止手牌。')
      }
      const actorSeatNumber = hand.currentActorSeatNumber
      if (actorSeatNumber === null) {
        throw new Error('M3.3 准备阶段缺少当前行动者。')
      }
      const participantSeatNumbers = new Set(
        hand.holeCards.map((holeCards) => holeCards.seatNumber),
      )
      const contenders = state.poker.seats.filter(
        (seat) =>
          participantSeatNumbers.has(seat.seatNumber) &&
          (seat.status === 'active' || seat.status === 'allIn'),
      )
      if (actorSeatNumber === 0 && contenders.length === 2) break

      const result = applyPokerAction(state.poker, {
        actorSeatNumber,
        action: choosePreparationAction(state, contenders.length),
      })
      if (result.completedHand !== null) {
        throw new Error('M3.3 准备阶段不得完成手牌。')
      }
      eventDrafts.push(
        ...result.eventDrafts.map((event) =>
          productionSessionMutationRepository.currentPrivateEventProtocol.parseDraft(
            event,
          ),
        ),
      )
      state = createPrivateTableState({ ...state, poker: result.state })
    }

    const terminalHand = state.poker.hand
    const terminalContenders = state.poker.seats.filter(
      (seat) =>
        terminalHand?.holeCards.some(
          (holeCards) => holeCards.seatNumber === seat.seatNumber,
        ) === true &&
        (seat.status === 'active' || seat.status === 'allIn'),
    )
    if (
      terminalHand?.currentActorSeatNumber !== 0 ||
      terminalContenders.length !== 2 ||
      eventDrafts.length === 0
    ) {
      throw new Error('M3.3 未能推进到合法的用户终止行动前。')
    }

    const finalStateVersion = locked.stateVersion + 1
    const preparedState = createPrivateTableState({
      ...state,
      stateVersion: finalStateVersion,
    })
    const firstEventSeq = locked.nextEventSeq
    const lastEventSeq = firstEventSeq + eventDrafts.length - 1
    const projectedSession = {
      ...locked,
      stateVersion: finalStateVersion,
      nextEventSeq: lastEventSeq + 1,
      currentHandId: identity.handId,
      agentRunState: 'idle' as const,
      activePlayerRunId: null,
      activeDecisionRequestId: null,
    }
    const finalSnapshot = projectPublicSnapshot(
      preparedState,
      projectedSession,
      lastEventSeq,
    )
    await productionSessionMutationRepository.persistSessionMutation(
      transaction,
      locked,
      {
        finalStateVersion,
        lifecycleStatus: 'active',
        currentHandId: identity.handId,
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        snapshot: encodeSnapshot(preparedState),
        events: eventDrafts.map((event, index) => {
          const eventSeq = firstEventSeq + index
          const eventId = randomUUID()
          const publicEvent = SseEventSchema.parse({
            eventId,
            sessionId: identity.sessionId,
            eventSeq,
            stateVersion: finalStateVersion,
            type: event.type,
            payload: { snapshot: { ...finalSnapshot, eventSeq } },
          })
          return {
            eventId,
            eventSeq,
            handId: getPrivateEventHandId(event),
            commandLedgerId: null,
            stateVersionBefore: locked.stateVersion,
            stateVersionAfter: finalStateVersion,
            privateEvent:
              productionSessionMutationRepository.currentPrivateEventProtocol.encodeCurrent(
                event,
              ),
            publicEvent,
            createdAt: PREPARATION_AT,
          }
        }),
        mutationAt: PREPARATION_AT,
      },
    )
    return Object.freeze({
      state: preparedState,
      eventDrafts: Object.freeze(eventDrafts),
      firstEventSeq,
      lastEventSeq,
    })
  })
}

export function createM33Executor(input: {
  readonly sql: Sql
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly mutationRepository?: SessionMutationRepository
  readonly recoveryRepository?: SessionRecoveryRepository
}) {
  const mutationRepository =
    input.mutationRepository ?? productionSessionMutationRepository
  const recoveryRepository =
    input.recoveryRepository ?? productionSessionRecoveryRepository
  return createSessionCommandExecutor({
    sql: input.sql,
    owner: input.owner,
    handlers: createSessionCommandHandlerMap({
      enabledCommandTypes: ['playerAction'],
      bindings: [createPlayerActionHandlerBinding({ owner: input.owner })],
    }),
    mutationRepository,
    recoveryRepository,
    recoveryRegistries: {
      snapshot: currentSnapshotReader,
      privateEvent: currentPrivateEventReader,
    },
    snapshotProjectorBinding: {
      bindReadPort: () => Object.freeze({}),
      projector: {
        async project({ state, session, eventSeq }: SnapshotProjectionInput) {
          return projectPublicSnapshot(state, session, eventSeq)
        },
      },
    },
    now: () => COMMAND_AT,
    nextEventId: randomUUID,
  })
}

async function readPersistenceMirror(
  sql: Sql,
  input: {
    readonly sessionId: string
    readonly handId: string
    readonly commandId?: string
  },
) {
  const sessionRows = await sql<
    {
      readonly lifecycleStatus: string
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly currentHandId: string | null
      readonly agentRunState: string
      readonly activePlayerRunId: string | null
      readonly activeDecisionRequestId: string | null
      readonly handStatus: string
      readonly completedAt: string | null
      readonly checkpointPayloadVersion: number
      readonly checkpointPayload: unknown
      readonly completedResultPayloadVersion: number | null
      readonly completedResultPayload: unknown | null
      readonly snapshotPayloadVersion: number
      readonly snapshotPayload: unknown
    }[]
  >`
    SELECT
      session.lifecycle_status AS "lifecycleStatus",
      session.state_version::float8 AS "stateVersion",
      session.next_event_seq::float8 AS "nextEventSeq",
      session.current_hand_id::text AS "currentHandId",
      session.agent_run_state AS "agentRunState",
      session.active_player_run_id::text AS "activePlayerRunId",
      session.active_decision_request_id::text AS "activeDecisionRequestId",
      hand.status AS "handStatus",
      CASE WHEN hand.completed_at IS NULL THEN NULL ELSE
        to_char(
          hand.completed_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        )
      END AS "completedAt",
      hand.hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
      hand.hand_start_checkpoint_payload AS "checkpointPayload",
      hand.completed_result_payload_version AS "completedResultPayloadVersion",
      hand.completed_result_payload AS "completedResultPayload",
      snapshot.private_table_state_payload_version AS "snapshotPayloadVersion",
      snapshot.private_table_state_payload AS "snapshotPayload"
    FROM app_private.sessions AS session
    JOIN app_private.hands AS hand
      ON hand.id = ${input.handId}::uuid
      AND hand.session_id = session.id
    JOIN app_private.session_snapshots AS snapshot
      ON snapshot.session_id = session.id
      AND snapshot.owner_id = session.owner_id
    WHERE session.id = ${input.sessionId}::uuid
  `
  const row = sessionRows[0]
  if (row === undefined || sessionRows.length !== 1) {
    throw new Error('M3.3 持久化镜像缺失。')
  }
  const eventRows = await sql<
    {
      readonly eventSeq: number
      readonly commandLedgerId: string | null
      readonly stateVersionBefore: number
      readonly stateVersionAfter: number
      readonly privateEventPayloadVersion: number
      readonly privateEventPayload: unknown
      readonly publicEventPayload: unknown
      readonly createdAt: string
    }[]
  >`
    SELECT
      event.event_seq::float8 AS "eventSeq",
      event.command_ledger_id::text AS "commandLedgerId",
      event.state_version_before::float8 AS "stateVersionBefore",
      event.state_version_after::float8 AS "stateVersionAfter",
      event.private_event_payload_version AS "privateEventPayloadVersion",
      event.private_event_payload AS "privateEventPayload",
      event.public_event_payload AS "publicEventPayload",
      to_char(
        event.created_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ) AS "createdAt"
    FROM app_private.session_events AS event
    WHERE event.session_id = ${input.sessionId}::uuid
    ORDER BY event.event_seq
  `
  const events = eventRows.map((eventRow) => {
    const privateEvent = currentPrivateEventReader.read(
      eventRow.privateEventPayloadVersion,
      eventRow.privateEventPayload,
    )
    if (privateEvent.kind !== 'decoded') {
      throw new Error('M3.3 私有事件无法解码。')
    }
    return Object.freeze({
      ...eventRow,
      privateEvent: privateEvent.value,
      publicEvent: SseEventSchema.parse(eventRow.publicEventPayload),
    })
  })

  const ledgerRows =
    input.commandId === undefined
      ? []
      : await sql<
          {
            readonly ledgerStatus: string
            readonly finalStateVersion: number | null
            readonly firstEventSeq: number | null
            readonly lastEventSeq: number | null
            readonly responsePayload: unknown | null
          }[]
        >`
          SELECT
            ledger.processing_status AS "ledgerStatus",
            ledger.final_state_version::float8 AS "finalStateVersion",
            ledger.first_event_seq::float8 AS "firstEventSeq",
            ledger.last_event_seq::float8 AS "lastEventSeq",
            ledger.response_payload AS "responsePayload"
          FROM app_private.command_ledger AS ledger
          WHERE ledger.session_id = ${input.sessionId}::uuid
            AND ledger.command_id = ${input.commandId}::uuid
        `
  if (ledgerRows.length > 1) throw new Error('M3.3 命令账本不唯一。')
  const ledgerRow = ledgerRows[0]
  const completedResult =
    row.completedResultPayloadVersion === null &&
    row.completedResultPayload === null
      ? null
      : decodeCurrentCompletedHandResult({
          payloadVersion: row.completedResultPayloadVersion,
          payload: row.completedResultPayload,
        }).payload.result
  const ledgerResponse =
    ledgerRow?.responsePayload === null || ledgerRow === undefined
      ? null
      : ledgerRow.ledgerStatus === 'completed'
        ? CommandResponseSchema.parse(ledgerRow.responsePayload)
        : ErrorResponseSchema.parse(ledgerRow.responsePayload)
  const checkpoint = currentHandStartCheckpointReader.read(
    row.checkpointPayloadVersion,
    row.checkpointPayload,
  )
  if (checkpoint.kind !== 'decoded') {
    throw new Error('M3.3 Hand checkpoint 无法解码。')
  }
  return Object.freeze({
    ...row,
    eventCount: events.length,
    completedResultPresent: completedResult !== null,
    completedResult,
    checkpoint: checkpoint.value,
    snapshot: decodeCurrentSnapshot({
      payloadVersion: row.snapshotPayloadVersion,
      payload: row.snapshotPayload,
    }).payload.state,
    events: Object.freeze(events),
    ledgerStatus: ledgerRow?.ledgerStatus ?? null,
    ledgerFinalStateVersion: ledgerRow?.finalStateVersion ?? null,
    ledgerFirstEventSeq: ledgerRow?.firstEventSeq ?? null,
    ledgerLastEventSeq: ledgerRow?.lastEventSeq ?? null,
    ledgerResponse,
  })
}

async function assertNormalActionAndStableFailures(
  sql: Sql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
): Promise<void> {
  const identity = await createSessionFixture(sql, 3)
  const initial = await readPrivateState(sql, identity.sessionId)
  expect(initial.poker.hand?.currentActorSeatNumber).toBe(0)
  const commandId = randomUUID()
  const executor = createM33Executor({ sql, owner })
  await expect(
    executor.execute({
      sessionId: identity.sessionId,
      commandId,
      expectedStateVersion: 1,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    }),
  ).resolves.toMatchObject({
    kind: 'completed',
    origin: 'newCommit',
    response: { snapshot: { stateVersion: 2, eventSeq: 2 } },
  })
  await expect(
    executor.execute({
      sessionId: identity.sessionId,
      commandId: randomUUID(),
      expectedStateVersion: 1,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    }),
  ).resolves.toMatchObject({
    kind: 'rejected',
    response: { code: 'STATE_VERSION_CONFLICT' },
  })
  expect(
    await readPersistenceMirror(sql, {
      sessionId: identity.sessionId,
      handId: identity.handId,
      commandId,
    }),
  ).toMatchObject({
    stateVersion: 2,
    nextEventSeq: 3,
    currentHandId: identity.handId,
    eventCount: 3,
    handStatus: 'inProgress',
    completedResultPresent: false,
    ledgerStatus: 'completed',
  })

  const illegalIdentity = await createSessionFixture(sql, 3)
  const illegalCommandId = randomUUID()
  await expect(
    executor.execute({
      sessionId: illegalIdentity.sessionId,
      commandId: illegalCommandId,
      expectedStateVersion: 1,
      type: 'playerAction',
      payload: { action: { type: 'check' } },
    }),
  ).resolves.toMatchObject({
    kind: 'rejected',
    origin: 'ledgerCommit',
    response: { code: 'POKER_ACTION_NOT_LEGAL' },
  })
  expect(
    await readPersistenceMirror(sql, {
      sessionId: illegalIdentity.sessionId,
      handId: illegalIdentity.handId,
      commandId: illegalCommandId,
    }),
  ).toMatchObject({
    stateVersion: 1,
    nextEventSeq: 2,
    eventCount: 2,
    handStatus: 'inProgress',
    ledgerStatus: 'failed',
  })

  const targetIdentity = await createSessionFixture(sql, 3)
  const targetBefore = await readPersistenceMirror(sql, {
    sessionId: targetIdentity.sessionId,
    handId: targetIdentity.handId,
  })
  const targetCommandId = randomUUID()
  const targetResult = await executor.execute({
    sessionId: targetIdentity.sessionId,
    commandId: targetCommandId,
    expectedStateVersion: 1,
    type: 'playerAction',
    payload: {
      action: { type: 'raise', targetStreetCommitment: 1 },
    },
  })
  expect(targetResult).toMatchObject({
    kind: 'rejected',
    origin: 'ledgerCommit',
    response: { code: 'POKER_ACTION_TARGET_OUT_OF_RANGE' },
  })
  const targetAfter = await readPersistenceMirror(sql, {
    sessionId: targetIdentity.sessionId,
    handId: targetIdentity.handId,
    commandId: targetCommandId,
  })
  expect(targetAfter).toMatchObject({
    stateVersion: targetBefore.stateVersion,
    nextEventSeq: targetBefore.nextEventSeq,
    currentHandId: targetBefore.currentHandId,
    handStatus: targetBefore.handStatus,
    completedResultPresent: false,
    ledgerStatus: 'failed',
    ledgerFinalStateVersion: targetBefore.stateVersion,
    ledgerFirstEventSeq: null,
    ledgerLastEventSeq: null,
  })
  expect(targetAfter.snapshot).toEqual(targetBefore.snapshot)
  expect(targetAfter.events).toEqual(targetBefore.events)
  expect(targetAfter.ledgerResponse).toEqual(
    targetResult.kind === 'rejected' ? targetResult.response : null,
  )

  const actorIdentity = await createSessionFixture(sql, 0)
  await expect(
    executor.execute({
      sessionId: actorIdentity.sessionId,
      commandId: randomUUID(),
      expectedStateVersion: 1,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    }),
  ).resolves.toMatchObject({
    kind: 'rejected',
    response: { code: 'PLAYER_NOT_CURRENT_ACTOR' },
  })
}

async function assertTerminalAtomicityAndReplay(
  sql: Sql,
  runtimeUrl: string,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
): Promise<void> {
  const identity = await createSessionFixture(sql, 3)
  const prepared = await prepareTerminalUserTurn(sql, owner, identity)
  const expectedEngineResult = applyPokerAction(prepared.state.poker, {
    actorSeatNumber: 0,
    action: { type: 'fold' },
  })
  if (expectedEngineResult.completedHand === null) {
    throw new Error('M3.3 最终用户行动未完成手牌。')
  }
  const expectedFinalState = createPrivateTableState({
    ...prepared.state,
    stateVersion: prepared.state.stateVersion + 1,
    poker: expectedEngineResult.state,
    completedHandCount: prepared.state.completedHandCount + 1,
    lastCompletedHandSummary: expectedEngineResult.completedHand.summary,
  })
  const reachedPersist = createDeferred()
  const releasePersist = createDeferred()
  const mutationRepository: SessionMutationRepository = Object.freeze({
    ...productionSessionMutationRepository,
    async persistSessionMutation(
      ...arguments_: Parameters<
        SessionMutationRepository['persistSessionMutation']
      >
    ) {
      reachedPersist.resolve()
      await releasePersist.promise
      return productionSessionMutationRepository.persistSessionMutation(
        ...arguments_,
      )
    },
  })
  const recoveryRepository = createSessionRecoveryRepository({
    sessionMutationRepository: mutationRepository,
  })
  const executor = createM33Executor({
    sql,
    owner,
    mutationRepository,
    recoveryRepository,
  })
  const commandId = randomUUID()
  const execution = executor.execute({
    sessionId: identity.sessionId,
    commandId,
    expectedStateVersion: prepared.state.stateVersion,
    type: 'playerAction',
    payload: { action: { type: 'fold' } },
  })
  await Promise.race([
    reachedPersist.promise,
    execution.then(
      () => {
        throw new Error('M3.3 命令在持久化暂停点前提前完成。')
      },
      (error: unknown) => {
        throw error
      },
    ),
  ])

  const observerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm33-observer')
  try {
    const uncommitted = await readPersistenceMirror(observerSql, {
      sessionId: identity.sessionId,
      handId: identity.handId,
      commandId,
    })
    expect(uncommitted).toMatchObject({
      stateVersion: prepared.state.stateVersion,
      nextEventSeq: prepared.lastEventSeq + 1,
      eventCount: prepared.lastEventSeq + 1,
      handStatus: 'inProgress',
      completedResultPresent: false,
      ledgerStatus: null,
    })
    expect(uncommitted.snapshot).toEqual(prepared.state)
    expect(
      uncommitted.events
        .filter(
          (event) =>
            event.eventSeq >= prepared.firstEventSeq &&
            event.eventSeq <= prepared.lastEventSeq,
        )
        .map((event) => event.privateEvent),
    ).toEqual(prepared.eventDrafts)
  } finally {
    releasePersist.resolve()
    await observerSql.end({ timeout: 0 })
  }

  const result = await execution
  expect(result).toMatchObject({
    kind: 'completed',
    origin: 'newCommit',
    response: {
      snapshot: {
        stateVersion: expectedFinalState.stateVersion,
        pokerPhase: 'betweenHands',
        lastCompletedHandSummary: { handId: identity.handId },
      },
    },
  })
  if (result.kind !== 'completed' || result.origin !== 'newCommit') {
    throw new Error('M3.3 最终用户行动未产生新提交。')
  }
  const committed = await readPersistenceMirror(sql, {
    sessionId: identity.sessionId,
    handId: identity.handId,
    commandId,
  })
  const firstCommandEventSeq = prepared.lastEventSeq + 1
  const lastCommandEventSeq =
    firstCommandEventSeq + expectedEngineResult.eventDrafts.length - 1
  expect(committed).toMatchObject({
    lifecycleStatus: 'active',
    stateVersion: expectedFinalState.stateVersion,
    nextEventSeq: lastCommandEventSeq + 1,
    currentHandId: null,
    agentRunState: 'idle',
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    handStatus: 'completed',
    completedAt: COMMAND_AT,
    completedResultPresent: true,
    ledgerStatus: 'completed',
    ledgerFinalStateVersion: expectedFinalState.stateVersion,
    ledgerFirstEventSeq: firstCommandEventSeq,
    ledgerLastEventSeq: lastCommandEventSeq,
  })
  expect(committed.checkpoint.startedHand.handId).toBe(identity.handId)
  expect(committed.completedResult).toEqual(expectedEngineResult.completedHand)
  expect(committed.snapshot).toEqual(expectedFinalState)
  expect(committed.ledgerResponse).toEqual(result.response)
  const commandEvents = committed.events.filter(
    (event) =>
      event.eventSeq >= firstCommandEventSeq &&
      event.eventSeq <= lastCommandEventSeq,
  )
  expect(commandEvents.map((event) => event.privateEvent)).toEqual(
    expectedEngineResult.eventDrafts,
  )
  expect(commandEvents.map((event) => event.publicEvent)).toEqual(
    result.newlyPersistedEvents,
  )
  expect(
    commandEvents.every(
      (event) =>
        event.createdAt === COMMAND_AT &&
        event.stateVersionBefore === prepared.state.stateVersion &&
        event.stateVersionAfter === expectedFinalState.stateVersion,
    ),
  ).toBe(true)
  const eventCount = committed.eventCount
  await expect(
    executor.execute({
      sessionId: identity.sessionId,
      commandId,
      expectedStateVersion: prepared.state.stateVersion,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    }),
  ).resolves.toMatchObject({ kind: 'completed', origin: 'replay' })
  const replayed = await readPersistenceMirror(sql, {
    sessionId: identity.sessionId,
    handId: identity.handId,
    commandId,
  })
  expect(replayed).toMatchObject({
    eventCount,
    stateVersion: expectedFinalState.stateVersion,
    handStatus: 'completed',
  })
  expect(replayed).toEqual(committed)
}

async function assertCheckpointMismatchRollsBack(
  sql: Sql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
): Promise<void> {
  const identity = await createSessionFixture(sql, 3)
  const prepared = await prepareTerminalUserTurn(sql, owner, identity)
  await sql`
    UPDATE app_private.hands
    SET hand_start_checkpoint_payload = jsonb_set(
      hand_start_checkpoint_payload,
      '{checkpoint,startedHand,startingStacks,0,stack}',
      to_jsonb((hand_start_checkpoint_payload #>>
        '{checkpoint,startedHand,startingStacks,0,stack}')::int + 1)
    )
    WHERE id = ${identity.handId}::uuid
  `
  const beforeCommand = await readPersistenceMirror(sql, {
    sessionId: identity.sessionId,
    handId: identity.handId,
  })
  const commandId = randomUUID()
  await expect(
    createM33Executor({ sql, owner }).execute({
      sessionId: identity.sessionId,
      commandId,
      expectedStateVersion: prepared.state.stateVersion,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    }),
  ).rejects.toThrow()
  const afterCommand = await readPersistenceMirror(sql, {
    sessionId: identity.sessionId,
    handId: identity.handId,
    commandId,
  })
  expect(afterCommand).toMatchObject({
    stateVersion: prepared.state.stateVersion,
    nextEventSeq: prepared.lastEventSeq + 1,
    currentHandId: identity.handId,
    eventCount: prepared.lastEventSeq + 1,
    handStatus: 'inProgress',
    completedResultPresent: false,
    ledgerStatus: null,
  })
  expect(afterCommand.snapshot).toEqual(beforeCommand.snapshot)
  expect(afterCommand.events).toEqual(beforeCommand.events)
  expect(afterCommand.checkpoint).toEqual(beforeCommand.checkpoint)
}

export async function assertM33PlayerActionHandCompletion(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  try {
    await assertNormalActionAndStableFailures(sql, owner)
    await assertTerminalAtomicityAndReplay(sql, runtimeUrl, owner)
    await assertCheckpointMismatchRollsBack(sql, owner)
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
