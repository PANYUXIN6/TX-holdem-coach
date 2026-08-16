import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import {
  completeCommand,
  failCommand,
  readExistingCommandResult,
  registerCommand,
  type LedgerCommand,
} from '../../src/persistence/command-ledger-repository.js'
import { readHandAudit } from '../../src/persistence/hand-audit-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  productionSessionMutationRepository,
  type SessionMutationRepository,
} from '../../src/persistence/session-mutation-repository.js'
import {
  createSessionRecoveryRepository,
  productionSessionRecoveryRepository,
} from '../../src/persistence/session-recovery-repository.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { currentPrivateEventReader } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  currentSnapshotReader,
  decodeCurrentSnapshot,
  encodeSnapshot,
} from '../../src/sessions/authoritative-state/snapshot-codec.js'
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from '../../src/sessions/command-execution/command-handler.js'
import { createSessionCommandHandlerMap } from '../../src/sessions/command-execution/command-handler-map.js'
import { createEndSessionHandlerBinding } from '../../src/sessions/command-execution/end-session-handler.js'
import { createRebuyHandlerBinding } from '../../src/sessions/command-execution/rebuy-handler.js'
import { createSessionCommandExecutor } from '../../src/sessions/command-execution/session-command-executor.js'
import type { SnapshotProjectionInput } from '../../src/sessions/command-execution/snapshot-projector.js'
import { createStartNextHandHandlerBinding } from '../../src/sessions/command-execution/start-next-hand-handler.js'
import {
  clearLocalOwnerSessions,
  projectPublicSnapshot,
} from './database-m32-assertions.js'
import {
  createM33Executor,
  createSessionFixture,
  prepareTerminalUserTurn,
  readPrivateState,
} from './database-m33-assertions.js'
import { createM27PlayerRunInput } from './database-repository-assertions.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
  serializeJsonbFixture,
} from './database-test-runtime.js'

const REBUY_AT = '2026-08-11T04:00:00.000Z'
const NEXT_HAND_AT = '2026-08-11T04:01:00.000Z'
const ABORT_AT = '2026-08-11T04:02:00.000Z'
const NORMAL_END_AT = '2026-08-11T04:03:00.000Z'
const POSTGRES_TEXT_OID = 25

type CommandLedgerRepositoryOverride = NonNullable<
  Parameters<typeof createSessionCommandExecutor>[0]['commandLedgerRepository']
>

function createDeferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolvePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return Object.freeze({
    promise,
    resolve(value: Value) {
      resolvePromise?.(value)
    },
  })
}

const LateRetryFixtureBinding = defineSessionCommandHandlerBinding<
  Extract<LedgerCommand, { readonly type: 'retryAgent' }>,
  Readonly<Record<string, never>>,
  Readonly<Record<string, never>>,
  Readonly<Record<string, never>>
>({
  commandType: 'retryAgent',
  handler: {
    async prepare() {
      throw new Error('M3.4 迟到 retry 不得进入 active Handler。')
    },
    async applyRelations() {
      throw new Error('M3.4 迟到 retry 不得写入关系。')
    },
  },
  bindReadPort: () => Object.freeze({}),
  bindWritePort: () => Object.freeze({}),
})

async function executeM34Stage<Result>(
  stage: string,
  operation: Promise<Result>,
): Promise<Result> {
  try {
    return await operation
  } catch (error) {
    throw new Error(`M3.4 ${stage} 失败。`, { cause: error })
  }
}

export function createM34Executor(input: {
  readonly sql: Sql
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly nextHandId: string
  readonly commandAt: string
  readonly mutationRepository?: SessionMutationRepository
  readonly commandLedgerRepository?: CommandLedgerRepositoryOverride
  readonly startNextHandBinding?: ReturnType<
    typeof createStartNextHandHandlerBinding
  >
  readonly includeLateRetryFixture?: boolean
}) {
  const mutationRepository =
    input.mutationRepository ?? productionSessionMutationRepository
  const recoveryRepository =
    mutationRepository === productionSessionMutationRepository
      ? productionSessionRecoveryRepository
      : createSessionRecoveryRepository({
          sessionMutationRepository: mutationRepository,
        })
  const bindings: SessionCommandHandlerBinding[] = [
    createRebuyHandlerBinding(),
    input.startNextHandBinding ??
      createStartNextHandHandlerBinding({
        owner: input.owner,
        nextHandId: () => input.nextHandId,
        randomSource: { nextInt: () => 0 },
      }),
    createEndSessionHandlerBinding({ owner: input.owner }),
  ]
  if (input.includeLateRetryFixture) bindings.push(LateRetryFixtureBinding)
  return createSessionCommandExecutor({
    sql: input.sql,
    owner: input.owner,
    handlers: createSessionCommandHandlerMap({
      enabledCommandTypes: [
        'rebuy',
        'startNextHand',
        'endSession',
        ...(input.includeLateRetryFixture ? (['retryAgent'] as const) : []),
      ],
      bindings,
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
    now: () => input.commandAt,
    nextEventId: randomUUID,
    ...(input.commandLedgerRepository === undefined
      ? {}
      : { commandLedgerRepository: input.commandLedgerRepository }),
  })
}

async function readM34AtomicCounts(sql: Sql, sessionId: string) {
  const rows = await sql<
    {
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly currentHandId: string | null
      readonly eventCount: number
      readonly ledgerCount: number
      readonly handCount: number
    }[]
  >`
    SELECT
      session.state_version::int AS "stateVersion",
      session.next_event_seq::int AS "nextEventSeq",
      session.current_hand_id::text AS "currentHandId",
      (SELECT count(*)::int FROM app_private.session_events AS event
       WHERE event.session_id = session.id) AS "eventCount",
      (SELECT count(*)::int FROM app_private.command_ledger AS ledger
       WHERE ledger.session_id = session.id) AS "ledgerCount",
      (SELECT count(*)::int FROM app_private.hands AS hand
       WHERE hand.session_id = session.id) AS "handCount"
    FROM app_private.sessions AS session
    WHERE session.id = ${sessionId}::uuid
  `
  const row = rows[0]
  if (row === undefined || rows.length !== 1) {
    throw new Error('M3.4 原子计数镜像缺失。')
  }
  return row
}

async function readM34CommandFacts(
  sql: Sql,
  sessionId: string,
  commandId: string,
) {
  const ledgerRows = await sql<
    {
      readonly ledgerId: string
      readonly ledgerStatus: string
      readonly finalStateVersion: number
      readonly firstEventSeq: number | null
      readonly lastEventSeq: number | null
    }[]
  >`
    SELECT
      id::text AS "ledgerId",
      processing_status AS "ledgerStatus",
      final_state_version::int AS "finalStateVersion",
      first_event_seq::int AS "firstEventSeq",
      last_event_seq::int AS "lastEventSeq"
    FROM app_private.command_ledger
    WHERE session_id = ${sessionId}::uuid
      AND command_id = ${commandId}::uuid
  `
  const ledger = ledgerRows[0]
  if (ledger === undefined || ledgerRows.length !== 1) {
    throw new Error('M3.4 命令账本镜像缺失。')
  }
  const eventRows = await sql<
    {
      readonly eventSeq: number
      readonly handId: string | null
      readonly stateVersionBefore: number
      readonly stateVersionAfter: number
      readonly payloadVersion: number
      readonly payload: unknown
    }[]
  >`
    SELECT
      event_seq::int AS "eventSeq",
      hand_id::text AS "handId",
      state_version_before::int AS "stateVersionBefore",
      state_version_after::int AS "stateVersionAfter",
      private_event_payload_version AS "payloadVersion",
      private_event_payload AS "payload"
    FROM app_private.session_events
    WHERE session_id = ${sessionId}::uuid
      AND command_ledger_id = ${ledger.ledgerId}::uuid
    ORDER BY event_seq
  `
  const events = eventRows.map((row) => {
    const decoded = currentPrivateEventReader.read(
      row.payloadVersion,
      row.payload,
    )
    if (decoded.kind !== 'decoded') {
      throw new Error('M3.4 命令事件无法解码。')
    }
    const { payloadVersion: _, payload: _payload, ...eventMirror } = row
    return Object.freeze({ ...eventMirror, event: decoded.value })
  })
  return Object.freeze({ ledger, events: Object.freeze(events) })
}

async function completeFirstHand(sql: Sql, randomValue: number) {
  const identity = await createSessionFixture(sql, randomValue)
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const terminal = await prepareTerminalUserTurn(sql, owner, identity)
  const result = await createM33Executor({ sql, owner }).execute({
    sessionId: identity.sessionId,
    commandId: randomUUID(),
    expectedStateVersion: terminal.state.stateVersion,
    type: 'playerAction',
    payload: { action: { type: 'fold' } },
  })
  expect(result).toMatchObject({ kind: 'completed', origin: 'newCommit' })
  return {
    identity,
    owner,
    state: await readPrivateState(sql, identity.sessionId),
  }
}

async function writePrivateStateFixture(
  sql: Sql,
  sessionId: string,
  state: ReturnType<typeof createPrivateTableState>,
): Promise<void> {
  const encoded = encodeSnapshot(state)
  const payload = sql.typed(
    serializeJsonbFixture(encoded.payload),
    POSTGRES_TEXT_OID,
  )
  const rows = await sql<{ readonly sessionId: string }[]>`
    UPDATE app_private.session_snapshots
    SET private_table_state_payload_version = ${encoded.payloadVersion},
        private_table_state_payload = ${payload}::jsonb,
        updated_at = clock_timestamp()
    WHERE session_id = ${sessionId}::uuid
    RETURNING session_id::text AS "sessionId"
  `
  if (rows.length !== 1 || rows[0]?.sessionId !== sessionId) {
    throw new Error('M3.4 未能写入权威快照夹具。')
  }
}

async function prepareZeroStackAiState(
  sql: Sql,
  sessionId: string,
  zeroSeatNumbers: readonly number[],
) {
  const state = await readPrivateState(sql, sessionId)
  const zeroSeats = new Set(zeroSeatNumbers)
  const selectedSeats = state.poker.seats.filter((seat) =>
    zeroSeats.has(seat.seatNumber),
  )
  if (
    state.poker.pokerPhase !== 'betweenHands' ||
    state.poker.hand !== null ||
    zeroSeats.size !== zeroSeatNumbers.length ||
    selectedSeats.length !== zeroSeats.size ||
    selectedSeats.some((seat) => seat.isUser || seat.stack === 0)
  ) {
    throw new Error('M3.4 归零 AI 夹具无效。')
  }
  const donor = state.poker.seats.find(
    (seat) => !seat.isUser && !zeroSeats.has(seat.seatNumber),
  )
  if (donor === undefined)
    throw new Error('M3.4 归零 AI 夹具缺少筹码接收座位。')
  const transferredChips = selectedSeats.reduce(
    (total, seat) => total + seat.stack,
    0,
  )
  const poker = createPokerTableState({
    ...state.poker,
    seats: state.poker.seats.map((seat) =>
      zeroSeats.has(seat.seatNumber)
        ? { ...seat, stack: 0, status: 'out' as const }
        : seat.seatNumber === donor.seatNumber
          ? {
              ...seat,
              stack: seat.stack + transferredChips,
              status: 'active' as const,
            }
          : seat,
    ),
  })
  const prepared = createPrivateTableState({ ...state, poker })
  await writePrivateStateFixture(sql, sessionId, prepared)
  return prepared
}

async function prepareUserStackState(
  sql: Sql,
  sessionId: string,
  targetStack: number,
) {
  const state = await readPrivateState(sql, sessionId)
  const userSeat = state.poker.seats.find(
    (seat) => seat.seatNumber === 0 && seat.isUser,
  )
  const donor = state.poker.seats.find((seat) => !seat.isUser)
  if (
    state.poker.pokerPhase !== 'betweenHands' ||
    state.poker.hand !== null ||
    userSeat === undefined ||
    donor === undefined ||
    !Number.isSafeInteger(targetStack) ||
    targetStack < 0 ||
    targetStack > userSeat.stack
  ) {
    throw new Error('M3.4 用户余额夹具无效。')
  }
  const transferredChips = userSeat.stack - targetStack
  const poker = createPokerTableState({
    ...state.poker,
    seats: state.poker.seats.map((seat) =>
      seat.seatNumber === userSeat.seatNumber
        ? {
            ...seat,
            stack: targetStack,
            status: targetStack === 0 ? ('out' as const) : ('active' as const),
          }
        : seat.seatNumber === donor.seatNumber
          ? {
              ...seat,
              stack: seat.stack + transferredChips,
              status: 'active' as const,
            }
          : seat,
    ),
  })
  const prepared = createPrivateTableState({ ...state, poker })
  await writePrivateStateFixture(sql, sessionId, prepared)
  return prepared
}

async function assertUserRebuySuccessBranches(sql: Sql): Promise<void> {
  const fixture = await completeFirstHand(sql, 5)
  const completedUserSeat = fixture.state.poker.seats.find(
    (seat) => seat.seatNumber === 0,
  )
  if (completedUserSeat === undefined || completedUserSeat.stack <= 0) {
    throw new Error('M3.4 用户补码夹具缺少正余额。')
  }

  const partialStackBefore = Math.min(completedUserSeat.stack, 1_000)
  const partialSource = await prepareUserStackState(
    sql,
    fixture.identity.sessionId,
    partialStackBefore,
  )
  const partialAccountingBefore = partialSource.seatAccounting.find(
    (seat) => seat.seatNumber === 0,
  )?.cumulativeBuyIn
  if (partialAccountingBefore === undefined) {
    throw new Error('M3.4 用户部分补码夹具缺少记账。')
  }
  const partialAmount = Math.min(500, 1_999 - partialStackBefore)
  const partialCommandId = randomUUID()
  const partialBefore = await readM34AtomicCounts(
    sql,
    fixture.identity.sessionId,
  )
  await expect(
    createM34Executor({
      sql,
      owner: fixture.owner,
      nextHandId: randomUUID(),
      commandAt: REBUY_AT,
    }).execute({
      sessionId: fixture.identity.sessionId,
      commandId: partialCommandId,
      expectedStateVersion: partialSource.stateVersion,
      type: 'rebuy',
      payload: { amount: partialAmount },
    }),
  ).resolves.toMatchObject({ kind: 'completed', origin: 'newCommit' })
  const partialStackAfter = partialStackBefore + partialAmount
  expect(partialStackAfter).toBeLessThan(2_000)
  expect(
    await readM34CommandFacts(
      sql,
      fixture.identity.sessionId,
      partialCommandId,
    ),
  ).toMatchObject({
    ledger: {
      ledgerStatus: 'completed',
      finalStateVersion: partialSource.stateVersion + 1,
    },
    events: [
      {
        handId: null,
        stateVersionBefore: partialSource.stateVersion,
        stateVersionAfter: partialSource.stateVersion + 1,
        event: {
          type: 'userRebuy',
          seatNumber: 0,
          amount: partialAmount,
          stackBefore: partialStackBefore,
          stackAfter: partialStackAfter,
          cumulativeBuyInBefore: partialAccountingBefore,
          cumulativeBuyInAfter: partialAccountingBefore + partialAmount,
        },
      },
    ],
  })
  expect(await readM34AtomicCounts(sql, fixture.identity.sessionId)).toEqual({
    ...partialBefore,
    stateVersion: partialBefore.stateVersion + 1,
    nextEventSeq: partialBefore.nextEventSeq + 1,
    eventCount: partialBefore.eventCount + 1,
    ledgerCount: partialBefore.ledgerCount + 1,
  })
  const partialPersistedState = await readPrivateState(
    sql,
    fixture.identity.sessionId,
  )
  expect(
    partialPersistedState.poker.seats.find((seat) => seat.seatNumber === 0),
  ).toMatchObject({ stack: partialStackAfter, status: 'active' })
  expect(
    partialPersistedState.seatAccounting.find((seat) => seat.seatNumber === 0),
  ).toMatchObject({ cumulativeBuyIn: partialAccountingBefore + partialAmount })

  const zeroSource = await prepareUserStackState(
    sql,
    fixture.identity.sessionId,
    0,
  )
  const zeroAccountingBefore = zeroSource.seatAccounting.find(
    (seat) => seat.seatNumber === 0,
  )?.cumulativeBuyIn
  if (zeroAccountingBefore === undefined) {
    throw new Error('M3.4 用户归零补满夹具缺少记账。')
  }
  const fullCommandId = randomUUID()
  const fullBefore = await readM34AtomicCounts(sql, fixture.identity.sessionId)
  await expect(
    createM34Executor({
      sql,
      owner: fixture.owner,
      nextHandId: randomUUID(),
      commandAt: REBUY_AT,
    }).execute({
      sessionId: fixture.identity.sessionId,
      commandId: fullCommandId,
      expectedStateVersion: zeroSource.stateVersion,
      type: 'rebuy',
      payload: { amount: 2_000 },
    }),
  ).resolves.toMatchObject({ kind: 'completed', origin: 'newCommit' })
  expect(
    await readM34CommandFacts(sql, fixture.identity.sessionId, fullCommandId),
  ).toMatchObject({
    ledger: {
      ledgerStatus: 'completed',
      finalStateVersion: zeroSource.stateVersion + 1,
    },
    events: [
      {
        handId: null,
        stateVersionBefore: zeroSource.stateVersion,
        stateVersionAfter: zeroSource.stateVersion + 1,
        event: {
          type: 'userRebuy',
          seatNumber: 0,
          amount: 2_000,
          stackBefore: 0,
          stackAfter: 2_000,
          cumulativeBuyInBefore: zeroAccountingBefore,
          cumulativeBuyInAfter: zeroAccountingBefore + 2_000,
        },
      },
    ],
  })
  const finalState = await readPrivateState(sql, fixture.identity.sessionId)
  expect(
    finalState.poker.seats.find((seat) => seat.seatNumber === 0),
  ).toMatchObject({ stack: 2_000, status: 'active' })
  expect(
    finalState.seatAccounting.find((seat) => seat.seatNumber === 0),
  ).toMatchObject({ cumulativeBuyIn: zeroAccountingBefore + 2_000 })
  expect(await readM34AtomicCounts(sql, fixture.identity.sessionId)).toEqual({
    ...fullBefore,
    stateVersion: fullBefore.stateVersion + 1,
    nextEventSeq: fullBefore.nextEventSeq + 1,
    eventCount: fullBefore.eventCount + 1,
    ledgerCount: fullBefore.ledgerCount + 1,
  })
}

async function assertSingleAiAutoRebuy(sql: Sql): Promise<void> {
  const fixture = await completeFirstHand(sql, 1)
  const sourceState = await prepareZeroStackAiState(
    sql,
    fixture.identity.sessionId,
    [1],
  )
  const before = await readM34AtomicCounts(sql, fixture.identity.sessionId)
  const nextHandId = randomUUID()
  const commandId = randomUUID()
  await expect(
    createM34Executor({
      sql,
      owner: fixture.owner,
      nextHandId,
      commandAt: NEXT_HAND_AT,
    }).execute({
      sessionId: fixture.identity.sessionId,
      commandId,
      expectedStateVersion: sourceState.stateVersion,
      type: 'startNextHand',
      payload: {},
    }),
  ).resolves.toMatchObject({ kind: 'completed', origin: 'newCommit' })

  const facts = await readM34CommandFacts(
    sql,
    fixture.identity.sessionId,
    commandId,
  )
  expect(facts.events.map((event) => event.event.type)).toEqual([
    'aiAutoRebuy',
    'handStarted',
  ])
  expect(facts.events.map((event) => event.handId)).toEqual([null, nextHandId])
  expect(facts.events.map((event) => event.eventSeq)).toEqual([
    before.nextEventSeq,
    before.nextEventSeq + 1,
  ])
  expect(
    facts.events.map((event) => [
      event.stateVersionBefore,
      event.stateVersionAfter,
    ]),
  ).toEqual([
    [sourceState.stateVersion, sourceState.stateVersion + 1],
    [sourceState.stateVersion, sourceState.stateVersion + 1],
  ])
  expect(facts.events[0]?.event).toMatchObject({
    type: 'aiAutoRebuy',
    seatNumber: 1,
    stackBefore: 0,
    stackAfter: 2_000,
  })
  expect(facts.ledger).toMatchObject({
    firstEventSeq: before.nextEventSeq,
    lastEventSeq: before.nextEventSeq + 1,
    finalStateVersion: sourceState.stateVersion + 1,
  })
  expect(await readM34AtomicCounts(sql, fixture.identity.sessionId)).toEqual({
    ...before,
    stateVersion: before.stateVersion + 1,
    nextEventSeq: before.nextEventSeq + 2,
    currentHandId: nextHandId,
    eventCount: before.eventCount + 2,
    ledgerCount: before.ledgerCount + 1,
    handCount: before.handCount + 1,
  })

  const audit = await sql.begin((transaction) =>
    readHandAudit(
      transaction,
      fixture.owner,
      fixture.identity.sessionId,
      nextHandId,
    ),
  )
  if (audit.status !== 'inProgress') {
    throw new Error('M3.4 单 AI 自动买入缺少进行中 Hand 审计。')
  }
  expect(audit.checkpoint.stateBeforeStartCommand).toEqual(sourceState)
  expect(
    audit.checkpoint.startedHand.startingStacks.find(
      (seat) => seat.seatNumber === 1,
    )?.stack,
  ).toBe(2_000)
  const blindAmount =
    audit.checkpoint.startedHand.smallBlindSeatNumber === 1
      ? 10
      : audit.checkpoint.startedHand.bigBlindSeatNumber === 1
        ? 20
        : 0
  expect(
    (await readPrivateState(sql, fixture.identity.sessionId)).poker.seats.find(
      (seat) => seat.seatNumber === 1,
    )?.stack,
  ).toBe(2_000 - blindAmount)
}

async function readM34Mirror(sql: Sql, sessionId: string, handId: string) {
  const sessionRows = await sql<
    {
      readonly lifecycleStatus: string
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly currentHandId: string | null
      readonly agentRunState: string
      readonly handStatus: string
      readonly abortReason: string | null
      readonly abortedByRunId: string | null
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
      hand.status AS "handStatus",
      hand.abort_reason AS "abortReason",
      hand.aborted_by_agent_run_id::text AS "abortedByRunId",
      snapshot.private_table_state_payload_version AS "snapshotPayloadVersion",
      snapshot.private_table_state_payload AS "snapshotPayload"
    FROM app_private.sessions AS session
    JOIN app_private.hands AS hand
      ON hand.id = ${handId}::uuid
      AND hand.session_id = session.id
    JOIN app_private.session_snapshots AS snapshot
      ON snapshot.session_id = session.id
    WHERE session.id = ${sessionId}::uuid
  `
  const eventRows = await sql<
    {
      readonly eventSeq: number
      readonly stateVersionBefore: number
      readonly stateVersionAfter: number
      readonly eventType: string
    }[]
  >`
    SELECT
      event_seq::float8 AS "eventSeq",
      state_version_before::float8 AS "stateVersionBefore",
      state_version_after::float8 AS "stateVersionAfter",
      public_event_payload->>'type' AS "eventType"
    FROM app_private.session_events
    WHERE session_id = ${sessionId}::uuid
    ORDER BY event_seq DESC
    LIMIT 2
  `
  const session = sessionRows[0]
  if (session === undefined || sessionRows.length !== 1) {
    throw new Error('M3.4 持久化镜像缺失。')
  }
  const snapshot = decodeCurrentSnapshot({
    payloadVersion: session.snapshotPayloadVersion,
    payload: session.snapshotPayload,
  }).payload.state
  const {
    snapshotPayloadVersion: _,
    snapshotPayload: _payload,
    ...mirror
  } = session
  return {
    session: { ...mirror, snapshotStateVersion: snapshot.stateVersion },
    events: [...eventRows].reverse(),
  }
}

function createFailingStartNextHandBinding(input: {
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly nextHandId: string
  readonly message: string
}) {
  const base = createStartNextHandHandlerBinding({
    owner: input.owner,
    nextHandId: () => input.nextHandId,
    randomSource: { nextInt: () => 0 },
  })
  return defineSessionCommandHandlerBinding({
    commandType: base.commandType,
    handler: {
      prepare: base.handler.prepare,
      async applyRelations(context, capability) {
        await base.handler.applyRelations(context, capability)
        throw new Error(input.message)
      },
    },
    bindReadPort: base.bindReadPort,
    bindWritePort: base.bindWritePort,
  })
}

function createFailingMutationRepository(message: string) {
  const base = productionSessionMutationRepository
  return Object.freeze({
    ...base,
    async persistSessionMutation(
      ...parameters: Parameters<typeof base.persistSessionMutation>
    ) {
      await base.persistSessionMutation(...parameters)
      throw new Error(message)
    },
  }) satisfies SessionMutationRepository
}

function createFailingCommandLedgerRepository(
  message: string,
): CommandLedgerRepositoryOverride {
  return Object.freeze({
    registerCommand,
    readExistingCommandResult,
    failCommand,
    async completeCommand(...parameters: Parameters<typeof completeCommand>) {
      await completeCommand(...parameters)
      throw new Error(message)
    },
  })
}

async function assertStartNextHandCompetitionAndRollback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const competing = await completeFirstHand(sql, 4)
  const beforeCompetition = await readM34AtomicCounts(
    sql,
    competing.identity.sessionId,
  )
  const firstHandId = randomUUID()
  const secondHandId = randomUUID()
  const firstCommandId = randomUUID()
  const secondCommandId = randomUUID()
  const competingSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm34-competing-start',
  )
  let competitionResults: Awaited<
    ReturnType<ReturnType<typeof createM34Executor>['execute']>
  >[]
  try {
    competitionResults = await Promise.all([
      createM34Executor({
        sql,
        owner: competing.owner,
        nextHandId: firstHandId,
        commandAt: NEXT_HAND_AT,
      }).execute({
        sessionId: competing.identity.sessionId,
        commandId: firstCommandId,
        expectedStateVersion: competing.state.stateVersion,
        type: 'startNextHand',
        payload: {},
      }),
      createM34Executor({
        sql: competingSql,
        owner: competing.owner,
        nextHandId: secondHandId,
        commandAt: NEXT_HAND_AT,
      }).execute({
        sessionId: competing.identity.sessionId,
        commandId: secondCommandId,
        expectedStateVersion: competing.state.stateVersion,
        type: 'startNextHand',
        payload: {},
      }),
    ])
  } finally {
    await competingSql.end({ timeout: 0 })
  }
  expect(
    competitionResults.filter(
      (result) => result.kind === 'completed' && result.origin === 'newCommit',
    ),
  ).toHaveLength(1)
  expect(
    competitionResults.filter(
      (result) =>
        result.kind === 'rejected' &&
        result.response.code === 'STATE_VERSION_CONFLICT',
    ),
  ).toHaveLength(1)
  const afterCompetition = await readM34AtomicCounts(
    sql,
    competing.identity.sessionId,
  )
  expect(afterCompetition).toMatchObject({
    stateVersion: beforeCompetition.stateVersion + 1,
    nextEventSeq: beforeCompetition.nextEventSeq + 1,
    eventCount: beforeCompetition.eventCount + 1,
    ledgerCount: beforeCompetition.ledgerCount + 2,
    handCount: beforeCompetition.handCount + 1,
  })
  expect([firstHandId, secondHandId]).toContain(afterCompetition.currentHandId)
  const winningCommandId =
    afterCompetition.currentHandId === firstHandId
      ? firstCommandId
      : secondCommandId
  const winningFacts = await readM34CommandFacts(
    sql,
    competing.identity.sessionId,
    winningCommandId,
  )
  expect(winningFacts.events).toMatchObject([
    { handId: afterCompetition.currentHandId, event: { type: 'handStarted' } },
  ])

  const rollback = await completeFirstHand(sql, 2)
  const beforeRollback = await readM34AtomicCounts(
    sql,
    rollback.identity.sessionId,
  )
  for (const stage of [
    'after hand insert',
    'after session mutation',
    'after ledger complete',
  ] as const) {
    const message = `injected M3.4 ${stage}`
    const nextHandId = randomUUID()
    const mutationRepository =
      stage === 'after session mutation'
        ? createFailingMutationRepository(message)
        : undefined
    const commandLedgerRepository =
      stage === 'after ledger complete'
        ? createFailingCommandLedgerRepository(message)
        : undefined
    const startNextHandBinding =
      stage === 'after hand insert'
        ? createFailingStartNextHandBinding({
            owner: rollback.owner,
            nextHandId,
            message,
          })
        : undefined
    await expect(
      createM34Executor({
        sql,
        owner: rollback.owner,
        nextHandId,
        commandAt: NEXT_HAND_AT,
        ...(mutationRepository === undefined ? {} : { mutationRepository }),
        ...(commandLedgerRepository === undefined
          ? {}
          : { commandLedgerRepository }),
        ...(startNextHandBinding === undefined ? {} : { startNextHandBinding }),
      }).execute({
        sessionId: rollback.identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: rollback.state.stateVersion,
        type: 'startNextHand',
        payload: {},
      }),
    ).rejects.toThrow(message)
    expect(await readM34AtomicCounts(sql, rollback.identity.sessionId)).toEqual(
      beforeRollback,
    )
  }
}

async function waitForTransactionBlock(
  observer: Sql,
  blockingBackendPid: number,
  waitingBackendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await observer<
      {
        readonly waitsForTransactionId: boolean
        readonly blockedByAbort: boolean
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
            AND held.pid = ${blockingBackendPid}::int
          WHERE waiting.pid = ${waitingBackendPid}::int
            AND waiting.locktype = 'transactionid'
            AND NOT waiting.granted
        ) AS "waitsForTransactionId",
        ${blockingBackendPid}::int = ANY(
          pg_blocking_pids(${waitingBackendPid}::int)
        ) AS "blockedByAbort"
    `
    if (rows[0]?.waitsForTransactionId && rows[0].blockedByAbort) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('M3.4 未观察到中止命令持有的真实 PostgreSQL 锁等待。')
}

async function assertAbortBlocksLateRetry(input: {
  readonly observerSql: Sql
  readonly runtimeUrl: string
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly sessionId: string
  readonly stateVersion: number
}): Promise<string> {
  const before = await readM34AtomicCounts(input.observerSql, input.sessionId)
  const abortLocked = createDeferred<number>()
  const retryStarted = createDeferred<number>()
  const releaseAbort = createDeferred<void>()
  const blockingMutationRepository: SessionMutationRepository = Object.freeze({
    ...productionSessionMutationRepository,
    async lockSessionForMutation(
      ...parameters: Parameters<
        SessionMutationRepository['lockSessionForMutation']
      >
    ) {
      const [transaction] = parameters
      const locked =
        await productionSessionMutationRepository.lockSessionForMutation(
          ...parameters,
        )
      abortLocked.resolve(await readTransactionBackendPid(transaction))
      await releaseAbort.promise
      return locked
    },
  })
  const waitingMutationRepository: SessionMutationRepository = Object.freeze({
    ...productionSessionMutationRepository,
    async lockSessionForMutation(
      ...parameters: Parameters<
        SessionMutationRepository['lockSessionForMutation']
      >
    ) {
      const [transaction] = parameters
      retryStarted.resolve(await readTransactionBackendPid(transaction))
      return productionSessionMutationRepository.lockSessionForMutation(
        ...parameters,
      )
    },
  })
  const abortSql = createDatabaseTestSqlForRole(
    input.runtimeUrl,
    'm34-abort-lock',
  )
  const retrySql = createDatabaseTestSqlForRole(
    input.runtimeUrl,
    'm34-late-retry',
  )
  const abortCommandId = randomUUID()
  type ExecutionResult = Awaited<
    ReturnType<ReturnType<typeof createM34Executor>['execute']>
  >
  let abortResult: ExecutionResult | undefined
  let retryResult: ExecutionResult | undefined
  let abortPromise: Promise<ExecutionResult> | undefined
  let retryPromise: Promise<ExecutionResult> | undefined
  try {
    abortPromise = createM34Executor({
      sql: abortSql,
      owner: input.owner,
      nextHandId: randomUUID(),
      commandAt: ABORT_AT,
      mutationRepository: blockingMutationRepository,
    }).execute({
      sessionId: input.sessionId,
      commandId: abortCommandId,
      expectedStateVersion: input.stateVersion,
      type: 'endSession',
      payload: {},
    })
    const blockingBackendPid = await abortLocked.promise
    retryPromise = createM34Executor({
      sql: retrySql,
      owner: input.owner,
      nextHandId: randomUUID(),
      commandAt: ABORT_AT,
      mutationRepository: waitingMutationRepository,
      includeLateRetryFixture: true,
    }).execute({
      sessionId: input.sessionId,
      commandId: randomUUID(),
      expectedStateVersion: input.stateVersion,
      type: 'retryAgent',
      payload: {},
    })
    const waitingBackendPid = await retryStarted.promise
    await waitForTransactionBlock(
      input.observerSql,
      blockingBackendPid,
      waitingBackendPid,
    )
    releaseAbort.resolve(undefined)
    ;[abortResult, retryResult] = await Promise.all([
      abortPromise,
      retryPromise,
    ])
  } finally {
    releaseAbort.resolve(undefined)
    await Promise.allSettled(
      [abortPromise, retryPromise].filter(
        (operation): operation is Promise<ExecutionResult> =>
          operation !== undefined,
      ),
    )
    await Promise.all([
      abortSql.end({ timeout: 0 }),
      retrySql.end({ timeout: 0 }),
    ])
  }
  expect(abortResult).toMatchObject({
    kind: 'completed',
    origin: 'newCommit',
    response: {
      snapshot: {
        lifecycleStatus: 'ended',
        pokerPhase: 'betweenHands',
        stateVersion: input.stateVersion + 1,
      },
    },
  })
  expect(retryResult).toMatchObject({
    kind: 'rejected',
    origin: 'unregistered',
    response: { code: 'SESSION_ENDED' },
  })
  expect(await readM34AtomicCounts(input.observerSql, input.sessionId)).toEqual(
    {
      ...before,
      stateVersion: before.stateVersion + 1,
      nextEventSeq: before.nextEventSeq + 2,
      currentHandId: null,
      eventCount: before.eventCount + 2,
      ledgerCount: before.ledgerCount + 1,
    },
  )
  return abortCommandId
}

export async function assertM34RebuyNextHandSessionEnd(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  try {
    const {
      identity,
      owner,
      state: completedState,
    } = await completeFirstHand(sql, 5)
    const userSeat = completedState.poker.seats.find(
      (seat) => seat.seatNumber === 0,
    )
    if (
      userSeat === undefined ||
      userSeat.stack <= 0 ||
      userSeat.stack >= 2_000
    ) {
      throw new Error('M3.4 未得到可补码用户余额。')
    }
    const rebuyAmount = 2_000 - userSeat.stack
    const rebuyCommand = {
      sessionId: identity.sessionId,
      commandId: randomUUID(),
      expectedStateVersion: completedState.stateVersion,
      type: 'rebuy' as const,
      payload: { amount: rebuyAmount },
    }
    const nextHandId = randomUUID()
    const rebuyExecutor = createM34Executor({
      sql,
      owner,
      nextHandId,
      commandAt: REBUY_AT,
    })
    const beforeInvalidRebuy = await readM34AtomicCounts(
      sql,
      identity.sessionId,
    )
    const invalidRebuyCommandId = randomUUID()
    await expect(
      rebuyExecutor.execute({
        ...rebuyCommand,
        commandId: invalidRebuyCommandId,
        payload: { amount: rebuyAmount + 1 },
      }),
    ).resolves.toMatchObject({
      kind: 'rejected',
      origin: 'ledgerCommit',
      response: { code: 'REBUY_AMOUNT_NOT_ALLOWED' },
    })
    const invalidRebuyFacts = await readM34CommandFacts(
      sql,
      identity.sessionId,
      invalidRebuyCommandId,
    )
    expect(invalidRebuyFacts).toMatchObject({
      ledger: {
        ledgerStatus: 'failed',
        finalStateVersion: completedState.stateVersion,
        firstEventSeq: null,
        lastEventSeq: null,
      },
      events: [],
    })
    expect(await readM34AtomicCounts(sql, identity.sessionId)).toEqual({
      ...beforeInvalidRebuy,
      ledgerCount: beforeInvalidRebuy.ledgerCount + 1,
    })
    const rebuy = await executeM34Stage(
      'rebuy',
      rebuyExecutor.execute(rebuyCommand),
    )
    expect(rebuy).toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: {
        snapshot: {
          stateVersion: completedState.stateVersion + 1,
          pokerPhase: 'betweenHands',
        },
      },
    })
    await expect(rebuyExecutor.execute(rebuyCommand)).resolves.toMatchObject({
      kind: 'completed',
      origin: 'replay',
    })

    const autoRebuySourceState = await prepareZeroStackAiState(
      sql,
      identity.sessionId,
      [1, 3],
    )
    expect(
      autoRebuySourceState.poker.seats.find((seat) => seat.seatNumber === 0)
        ?.stack,
    ).toBe(2_000)
    const startNextHandCommandId = randomUUID()
    const startNextHandCommand = {
      sessionId: identity.sessionId,
      commandId: startNextHandCommandId,
      expectedStateVersion: autoRebuySourceState.stateVersion,
      type: 'startNextHand' as const,
      payload: {},
    }
    const replaySql = createDatabaseTestSqlForRole(runtimeUrl, 'm34-replay')
    let nextHandResults: Awaited<
      ReturnType<ReturnType<typeof createM34Executor>['execute']>
    >[]
    try {
      nextHandResults = await executeM34Stage(
        'concurrent startNextHand replay',
        Promise.all([
          createM34Executor({
            sql,
            owner,
            nextHandId,
            commandAt: NEXT_HAND_AT,
          }).execute(startNextHandCommand),
          createM34Executor({
            sql: replaySql,
            owner,
            nextHandId,
            commandAt: NEXT_HAND_AT,
          }).execute(startNextHandCommand),
        ]),
      )
    } finally {
      await replaySql.end({ timeout: 0 })
    }
    expect(
      nextHandResults
        .filter((result) => result.kind === 'completed')
        .map((result) => result.origin)
        .sort(),
    ).toEqual(['newCommit', 'replay'])
    const nextHand = nextHandResults.find(
      (result) => result.kind === 'completed' && result.origin === 'newCommit',
    )
    if (nextHand === undefined || nextHand.kind !== 'completed') {
      throw new Error('M3.4 下一手缺少唯一新提交结果。')
    }
    expect(nextHand).toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: {
        snapshot: {
          stateVersion: autoRebuySourceState.stateVersion + 1,
          pokerPhase: 'inHand',
        },
      },
    })
    const nextHandFacts = await readM34CommandFacts(
      sql,
      identity.sessionId,
      startNextHandCommandId,
    )
    expect(nextHandFacts).toMatchObject({
      ledger: {
        ledgerStatus: 'completed',
        finalStateVersion: autoRebuySourceState.stateVersion + 1,
      },
      events: [
        {
          handId: null,
          stateVersionBefore: autoRebuySourceState.stateVersion,
          stateVersionAfter: autoRebuySourceState.stateVersion + 1,
          event: { type: 'aiAutoRebuy', seatNumber: 1 },
        },
        {
          handId: null,
          stateVersionBefore: autoRebuySourceState.stateVersion,
          stateVersionAfter: autoRebuySourceState.stateVersion + 1,
          event: { type: 'aiAutoRebuy', seatNumber: 3 },
        },
        {
          handId: nextHandId,
          stateVersionBefore: autoRebuySourceState.stateVersion,
          stateVersionAfter: autoRebuySourceState.stateVersion + 1,
          event: { type: 'handStarted' },
        },
      ],
    })
    const firstNextHandEventSeq = nextHandFacts.events[0]?.eventSeq
    if (firstNextHandEventSeq === undefined) {
      throw new Error('M3.4 多 AI 自动买入缺少首事件序号。')
    }
    expect(nextHandFacts.events.map((event) => event.eventSeq)).toEqual([
      firstNextHandEventSeq,
      firstNextHandEventSeq + 1,
      firstNextHandEventSeq + 2,
    ])
    expect(nextHandFacts.ledger.firstEventSeq).toBe(firstNextHandEventSeq)
    expect(nextHandFacts.ledger.lastEventSeq).toBe(firstNextHandEventSeq + 2)
    const startedHandAudit = await sql.begin((transaction) =>
      readHandAudit(transaction, owner, identity.sessionId, nextHandId),
    )
    expect(startedHandAudit).toMatchObject({
      status: 'inProgress',
      checkpoint: { stateBeforeStartCommand: autoRebuySourceState },
    })
    if (startedHandAudit.status !== 'inProgress') {
      throw new Error('M3.4 多 AI 自动买入缺少进行中 Hand 审计。')
    }
    expect(
      startedHandAudit.checkpoint.startedHand.startingStacks
        .filter((seat) => seat.seatNumber === 1 || seat.seatNumber === 3)
        .map((seat) => [seat.seatNumber, seat.stack]),
    ).toEqual([
      [1, 2_000],
      [3, 2_000],
    ])
    const startedState = await readPrivateState(sql, identity.sessionId)
    const actorSeat = startedState.poker.seats.find(
      (seat) =>
        seat.seatNumber === startedState.poker.hand?.currentActorSeatNumber,
    )
    if (actorSeat === undefined || actorSeat.isUser) {
      throw new Error('M3.4 暂停夹具当前行动者必须是 AI。')
    }

    const supersededFailedPlayerRunId = randomUUID()
    const failedPlayerRunId = randomUUID()
    const supersededDecisionRequestId = randomUUID()
    const decisionRequestId = randomUUID()
    const auditRepository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    await sql.begin(async (transaction: TransactionSql) => {
      await auditRepository.insertAgentRunAudit(transaction, owner, {
        ...createM27PlayerRunInput(
          identity.sessionId,
          nextHandId,
          supersededFailedPlayerRunId,
          actorSeat.playerId,
          supersededDecisionRequestId,
        ),
        sourceStateVersion: startedState.stateVersion,
      })
      await transaction`
        UPDATE app_private.agent_runs
        SET lifecycle = 'failed',
            termination_reason = 'provider_timeout',
            completed_at = ${ABORT_AT}::timestamptz,
            updated_at = ${ABORT_AT}::timestamptz
        WHERE id = ${supersededFailedPlayerRunId}::uuid
      `
      await auditRepository.insertAgentRunAudit(transaction, owner, {
        ...createM27PlayerRunInput(
          identity.sessionId,
          nextHandId,
          failedPlayerRunId,
          actorSeat.playerId,
          decisionRequestId,
        ),
        sourceStateVersion: startedState.stateVersion,
        parentRunId: supersededFailedPlayerRunId,
      })
      await transaction`
        UPDATE app_private.agent_runs
        SET lifecycle = 'failed',
            termination_reason = 'provider_timeout',
            completed_at = ${ABORT_AT}::timestamptz,
            updated_at = ${ABORT_AT}::timestamptz
        WHERE id = ${failedPlayerRunId}::uuid
      `
      await transaction`
        UPDATE app_private.agent_runs
        SET replacement_run_id = ${failedPlayerRunId}::uuid,
            updated_at = ${ABORT_AT}::timestamptz
        WHERE id = ${supersededFailedPlayerRunId}::uuid
      `
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'paused',
            active_player_run_id = NULL,
            active_decision_request_id = NULL,
            updated_at = ${ABORT_AT}::timestamptz
        WHERE id = ${identity.sessionId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
      `
    })

    const abortCommandId = await assertAbortBlocksLateRetry({
      observerSql: sql,
      runtimeUrl,
      owner,
      sessionId: identity.sessionId,
      stateVersion: startedState.stateVersion,
    })
    const mirror = await readM34Mirror(sql, identity.sessionId, nextHandId)
    expect(mirror.session).toMatchObject({
      lifecycleStatus: 'ended',
      stateVersion: startedState.stateVersion + 1,
      currentHandId: null,
      agentRunState: 'idle',
      handStatus: 'aborted',
      abortReason: 'provider_timeout',
      abortedByRunId: failedPlayerRunId,
      snapshotStateVersion: startedState.stateVersion + 1,
    })
    expect(mirror.events).toMatchObject([
      {
        stateVersionBefore: startedState.stateVersion,
        stateVersionAfter: startedState.stateVersion + 1,
        eventType: 'handAborted',
      },
      {
        stateVersionBefore: startedState.stateVersion,
        stateVersionAfter: startedState.stateVersion + 1,
        eventType: 'sessionEnded',
      },
    ])

    const abortFacts = await readM34CommandFacts(
      sql,
      identity.sessionId,
      abortCommandId,
    )
    expect(abortFacts.events.map((event) => event.event.type)).toEqual([
      'handAborted',
      'sessionEnded',
    ])
    expect(abortFacts.events.map((event) => event.eventSeq)).toEqual([
      abortFacts.ledger.firstEventSeq,
      abortFacts.ledger.lastEventSeq,
    ])
    const handAbortedEvent = abortFacts.events[0]?.event
    if (handAbortedEvent?.type !== 'handAborted') {
      throw new Error('M3.4 中止命令缺少 handAborted 私有事件。')
    }
    expect(
      handAbortedEvent.restored.seats
        .filter((seat) => seat.seatNumber === 1 || seat.seatNumber === 3)
        .map((seat) => [seat.seatNumber, seat.stack, seat.cumulativeBuyIn]),
    ).toEqual(
      autoRebuySourceState.poker.seats
        .filter((seat) => seat.seatNumber === 1 || seat.seatNumber === 3)
        .map((seat) => [
          seat.seatNumber,
          seat.stack,
          autoRebuySourceState.seatAccounting.find(
            (accounting) => accounting.seatNumber === seat.seatNumber,
          )?.cumulativeBuyIn,
        ]),
    )
    const restoredState = await readPrivateState(sql, identity.sessionId)
    expect(restoredState).toMatchObject({
      poker: autoRebuySourceState.poker,
      completedHandCount: autoRebuySourceState.completedHandCount,
      seatAccounting: autoRebuySourceState.seatAccounting,
      lastCompletedHandSummary: autoRebuySourceState.lastCompletedHandSummary,
    })
    const runRows = await sql<
      {
        readonly runId: string
        readonly lifecycle: string
        readonly replacementRunId: string | null
      }[]
    >`
      SELECT
        id::text AS "runId",
        lifecycle,
        replacement_run_id::text AS "replacementRunId"
      FROM app_private.agent_runs
      WHERE id IN (
        ${supersededFailedPlayerRunId}::uuid,
        ${failedPlayerRunId}::uuid
      )
      ORDER BY id
    `
    expect(runRows).toEqual(
      expect.arrayContaining([
        {
          runId: supersededFailedPlayerRunId,
          lifecycle: 'failed',
          replacementRunId: failedPlayerRunId,
        },
        {
          runId: failedPlayerRunId,
          lifecycle: 'failed',
          replacementRunId: null,
        },
      ]),
    )

    await assertSingleAiAutoRebuy(sql)

    const normal = await completeFirstHand(sql, 0)
    const snapshotVersionBefore = normal.state.stateVersion
    const normalEnded = await executeM34Stage(
      'normal endSession',
      createM34Executor({
        sql,
        owner: normal.owner,
        nextHandId: randomUUID(),
        commandAt: NORMAL_END_AT,
      }).execute({
        sessionId: normal.identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: snapshotVersionBefore,
        type: 'endSession',
        payload: {},
      }),
    )
    expect(normalEnded).toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: {
        snapshot: {
          lifecycleStatus: 'ended',
          stateVersion: snapshotVersionBefore,
        },
      },
    })
    const normalRows = await sql<
      {
        readonly sessionVersion: number
        readonly snapshotPayloadVersion: number
        readonly snapshotPayload: unknown
      }[]
    >`
      SELECT
        session.state_version::float8 AS "sessionVersion",
        snapshot.private_table_state_payload_version AS "snapshotPayloadVersion",
        snapshot.private_table_state_payload AS "snapshotPayload"
      FROM app_private.sessions AS session
      JOIN app_private.session_snapshots AS snapshot
        ON snapshot.session_id = session.id
      WHERE session.id = ${normal.identity.sessionId}::uuid
    `
    const normalRow = normalRows[0]
    if (normalRow === undefined || normalRows.length !== 1) {
      throw new Error('M3.4 正常结束快照镜像缺失。')
    }
    expect(normalRow.sessionVersion).toBe(snapshotVersionBefore)
    expect(
      decodeCurrentSnapshot({
        payloadVersion: normalRow.snapshotPayloadVersion,
        payload: normalRow.snapshotPayload,
      }).payload.state.stateVersion,
    ).toBe(snapshotVersionBefore)

    await assertUserRebuySuccessBranches(sql)
    await assertStartNextHandCompetitionAndRollback(sql, runtimeUrl)
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
