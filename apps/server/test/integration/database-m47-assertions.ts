import { randomUUID } from 'node:crypto'
import { SseEventSchema, type PokerAction } from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import {
  issueRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../../src/agents/foundation/runtime-ports.js'
import { encodeExecutionBudgetAudit } from '../../src/agents/audit/execution-budget-audit-codec.js'
import { encodeRunConfigurationAudit } from '../../src/agents/audit/run-configuration-audit-codec.js'
import {
  completeCommand,
  preparePrivateAiActionCommandRegistration,
  registerCommand,
} from '../../src/persistence/command-ledger-repository.js'
import { createAgentRunLifecycleRepository } from '../../src/persistence/agent-run-lifecycle-repository.js'
import {
  createPlayerCommitGateRepository,
  type PlayerCommitClaim,
} from '../../src/persistence/player-commit-gate-repository.js'
import { ResourceNotFoundError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { productionSessionMutationRepository } from '../../src/persistence/session-mutation-repository.js'
import { productionSessionRecoveryRepository } from '../../src/persistence/session-recovery-repository.js'
import { clearOwnerSessionData } from '../../src/persistence/session-deletion-repository.js'
import { completeHandAudit } from '../../src/persistence/hand-audit-repository.js'
import type { JsonValue } from '../../src/persisted-json.js'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { getLegalActions } from '../../src/poker/betting.js'
import {
  getPrivateEventHandId,
  type PrivateEvent,
} from '../../src/sessions/authoritative-state/private-event.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { encodeCurrentHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
  runDatabaseTestWithCleanup,
} from './database-test-runtime.js'
import { projectPublicSnapshot } from './database-m32-assertions.js'

const SESSION_ID = '20000000-0000-4000-8000-000000000047'
const HAND_ID = '30000000-0000-4000-8000-000000000047'
const PARTICIPANT_ID = '40000000-0000-4000-8000-000000000049'
const DECISION_REQUEST_ID = '50000000-0000-4000-8000-000000000047'
const ROSTER_IDS = [
  '40000000-0000-4000-8000-000000000040',
  '40000000-0000-4000-8000-000000000047',
  '40000000-0000-4000-8000-000000000048',
  PARTICIPANT_ID,
  '40000000-0000-4000-8000-000000000050',
  '40000000-0000-4000-8000-000000000051',
] as const

interface M47CommitSurface {
  readonly stateVersion: number
  readonly handStatus: string
  readonly decisionStatus: string
  readonly runLifecycle: string
  readonly ledgerCount: number
}

interface M47DeletedCommitSurface {
  readonly sessionCount: number
  readonly handCount: number
  readonly runCount: number
  readonly decisionCount: number
  readonly ledgerCount: number
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolvePromise: ((value: Value) => void) | undefined
  return {
    promise: new Promise<Value>((resolve) => {
      resolvePromise = resolve
    }),
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

async function waitForTransactionBlock(
  observer: Sql,
  blockingBackendPid: number,
  waitingBackendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await observer<
      readonly {
        readonly waitsForTransactionId: boolean
        readonly blocked: boolean
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
        ) AS "blocked"
    `
    if (rows[0]?.waitsForTransactionId && rows[0].blocked) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('M4.7 未观察到预期的 PostgreSQL 锁等待。')
}

async function readDatabaseTimestamp(
  transaction: TransactionSql,
): Promise<string> {
  const rows = await transaction<readonly { readonly timestamp: string }[]>`
    SELECT to_char(
      clock_timestamp() AT TIME ZONE 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) AS "timestamp"
  `
  const timestamp = rows[0]?.timestamp
  if (typeof timestamp !== 'string') {
    throw new Error('M4.7 未读取到数据库当前时间。')
  }
  return timestamp
}

function pauseAfterGateLock(input: {
  readonly transaction: TransactionSql
  readonly handLocked: ReturnType<typeof createDeferred<void>>
  readonly releaseHand: ReturnType<typeof createDeferred<void>>
  readonly runLocked: ReturnType<typeof createDeferred<void>>
  readonly releaseRun: ReturnType<typeof createDeferred<void>>
}): TransactionSql {
  let handPaused = false
  let runPaused = false
  return new Proxy(input.transaction, {
    apply(target, thisArgument, argumentsList) {
      const template = argumentsList[0]
      const statement =
        Array.isArray(template) || 'raw' in (template as object)
          ? (template as TemplateStringsArray).join(' ')
          : ''
      const query = Reflect.apply(target, thisArgument, argumentsList)
      if (
        !handPaused &&
        statement.includes('FROM app_private.hands') &&
        statement.includes('FOR UPDATE')
      ) {
        handPaused = true
        return Promise.resolve(query).then(async (rows) => {
          input.handLocked.resolve()
          await input.releaseHand.promise
          return rows
        })
      }
      if (
        !runPaused &&
        statement.includes('FROM app_private.agent_runs') &&
        statement.includes('FOR UPDATE')
      ) {
        runPaused = true
        return Promise.resolve(query).then(async (rows) => {
          input.runLocked.resolve()
          await input.releaseRun.promise
          return rows
        })
      }
      return query
    },
  }) as TransactionSql
}

async function clearFixtures(sql: Sql): Promise<void> {
  await sql`DELETE FROM app_private.sessions WHERE id = ${SESSION_ID}::uuid`
}

async function readM47CommitSurface(
  sql: Sql,
  fixture: Pick<M47LiveFixture, 'decisionId' | 'runId'>,
): Promise<M47CommitSurface> {
  const rows = await sql<readonly M47CommitSurface[]>`
    SELECT
      (SELECT state_version::float8 FROM app_private.sessions
       WHERE id = ${SESSION_ID}::uuid) AS "stateVersion",
      (SELECT status FROM app_private.hands
       WHERE session_id = ${SESSION_ID}::uuid) AS "handStatus",
      (SELECT status FROM app_private.player_decisions
       WHERE id = ${fixture.decisionId}::uuid) AS "decisionStatus",
      (SELECT lifecycle FROM app_private.agent_runs
       WHERE id = ${fixture.runId}::uuid) AS "runLifecycle",
      (SELECT count(*)::int FROM app_private.command_ledger
       WHERE session_id = ${SESSION_ID}::uuid) AS "ledgerCount"
  `
  const surface = rows[0]
  if (surface === undefined) {
    throw new Error('M4.7 未读取到 Commit Gate 成功面。')
  }
  return surface
}

async function readM47DeletedCommitSurface(
  sql: Sql,
  fixture: Pick<M47LiveFixture, 'decisionId' | 'runId'>,
): Promise<M47DeletedCommitSurface> {
  const rows = await sql<readonly M47DeletedCommitSurface[]>`
    SELECT
      (SELECT count(*)::int FROM app_private.sessions
       WHERE id = ${SESSION_ID}::uuid) AS "sessionCount",
      (SELECT count(*)::int FROM app_private.hands
       WHERE id = ${HAND_ID}::uuid) AS "handCount",
      (SELECT count(*)::int FROM app_private.agent_runs
       WHERE id = ${fixture.runId}::uuid) AS "runCount",
      (SELECT count(*)::int FROM app_private.player_decisions
       WHERE id = ${fixture.decisionId}::uuid) AS "decisionCount",
      (SELECT count(*)::int FROM app_private.command_ledger
       WHERE command_id = ${fixture.decisionId}::uuid) AS "ledgerCount"
  `
  const surface = rows[0]
  if (surface === undefined) {
    throw new Error('M4.7 未读取到删除后的 Commit Gate 成功面。')
  }
  return surface
}

interface M47LiveFixture {
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly runId: string
  readonly decisionId: string
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly claim: PlayerCommitClaim
}

function createM47SessionState() {
  const randomSource = Object.freeze({ nextInt: () => 0 })
  const pokerBeforeStart = initializePokerTable(
    ROSTER_IDS.map((participantId, seatNumber) => ({
      seatNumber,
      playerId: participantId,
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    randomSource,
  )
  const stateBeforeStart = createPrivateTableState({
    stateVersion: 0,
    poker: pokerBeforeStart,
    completedHandCount: 0,
    seatAccounting: pokerBeforeStart.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const started = startPokerHand(pokerBeforeStart, {
    handId: HAND_ID,
    completedHandCountBeforeStart: 0,
    randomSource,
  })
  const state = createPrivateTableState({
    stateVersion: 1,
    poker: started.state,
    completedHandCount: 0,
    seatAccounting: started.state.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const checkpoint = encodeCurrentHandStartCheckpoint({
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    stateBeforeStartCommand: stateBeforeStart,
    startedHand: started.startedHand,
  })
  const handStarted = started.eventDrafts[0]
  if (handStarted?.type !== 'handStarted') {
    throw new Error('M4.7 fixture 未生成开手事件。')
  }
  return {
    state,
    checkpoint,
    snapshot: encodeSnapshot(state),
    initialEvents: [
      encodeCurrentPrivateEvent({
        type: 'sessionCreated',
        initialBuyIns: stateBeforeStart.poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          amount: 2_000,
        })),
      }),
      encodeCurrentPrivateEvent(handStarted),
    ] as const,
  }
}

function chooseM47TerminalPreparationAction(
  state: PrivateTableState,
  contenderCount: number,
): PokerAction {
  const actorSeatNumber = state.poker.hand?.currentActorSeatNumber
  if (actorSeatNumber === null || actorSeatNumber === undefined) {
    throw new Error('M4.7 complete-hand fixture 缺少当前行动者。')
  }
  if (actorSeatNumber !== 0 && contenderCount > 2) return { type: 'fold' }
  const passiveAction = getLegalActions(state.poker).find(
    (action) => action.type === 'check' || action.type === 'call',
  )
  if (passiveAction?.type === 'check') return { type: 'check' }
  if (passiveAction?.type === 'call') return { type: 'call' }
  throw new Error('M4.7 complete-hand fixture 缺少被动合法行动。')
}

/**
 * database milestone 只依赖 persistence 和纯扑克内核，不能复用 M3.3 的
 * command-execution 夹具。这里将终局前动作作为一个普通 mutation 批次持久化，
 * 为随后真实 Hand writer 的完整成功面回滚提供当前 AI turn。
 */
async function prepareM47TerminalAgentTurn(
  sql: Sql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
): Promise<PrivateTableState> {
  return sql.begin(async (transaction) => {
    const recovery =
      await productionSessionRecoveryRepository.recoverSessionForMutation(
        transaction,
        owner,
        SESSION_ID,
        await readDatabaseTimestamp(transaction),
      )
    if (recovery.kind !== 'ready') {
      throw new Error('M4.7 complete-hand fixture 未恢复 active Session。')
    }
    let state = recovery.state
    const eventDrafts: PrivateEvent[] = []
    for (let actionCount = 0; actionCount < 64; actionCount += 1) {
      const hand = state.poker.hand
      if (hand === null || hand.currentActorSeatNumber === null) {
        throw new Error('M4.7 complete-hand fixture 缺少进行中的手牌。')
      }
      const participantSeatNumbers = new Set(
        hand.holeCards.map((holeCards) => holeCards.seatNumber),
      )
      const contenders = state.poker.seats.filter(
        (seat) =>
          participantSeatNumbers.has(seat.seatNumber) &&
          (seat.status === 'active' || seat.status === 'allIn'),
      )
      const legalActions = getLegalActions(state.poker)
      if (
        hand.currentActorSeatNumber !== 0 &&
        contenders.length === 2 &&
        legalActions.some((action) => action.type === 'fold')
      ) {
        break
      }
      const forcedAllIn =
        contenders.length === 2 && hand.currentActorSeatNumber === 0
          ? legalActions.find((action) => action.type === 'allIn')
          : undefined
      const transition = applyPokerAction(state.poker, {
        actorSeatNumber: hand.currentActorSeatNumber,
        action:
          forcedAllIn ??
          chooseM47TerminalPreparationAction(state, contenders.length),
      })
      if (
        transition.completedHand !== null ||
        transition.eventDrafts.length === 0
      ) {
        throw new Error('M4.7 complete-hand fixture 提前完成手牌。')
      }
      eventDrafts.push(
        ...transition.eventDrafts.map((event) =>
          productionSessionMutationRepository.currentPrivateEventProtocol.parseDraft(
            event,
          ),
        ),
      )
      state = createPrivateTableState({ ...state, poker: transition.state })
    }
    const terminalHand = state.poker.hand
    if (
      terminalHand === null ||
      terminalHand.currentActorSeatNumber === null ||
      terminalHand.currentActorSeatNumber === 0 ||
      !getLegalActions(state.poker).some((action) => action.type === 'fold') ||
      eventDrafts.length === 0
    ) {
      throw new Error('M4.7 complete-hand fixture 未生成终局前 AI 行动。')
    }
    const finalStateVersion = recovery.locked.stateVersion + 1
    const finalState = createPrivateTableState({
      ...state,
      stateVersion: finalStateVersion,
    })
    const firstEventSeq = recovery.locked.nextEventSeq
    const lastEventSeq = firstEventSeq + eventDrafts.length - 1
    const projectedSession = {
      ...recovery.session,
      stateVersion: finalStateVersion,
      nextEventSeq: lastEventSeq + 1,
      currentHandId: HAND_ID,
      agentRunState: 'idle' as const,
      activePlayerRunId: null,
      activeDecisionRequestId: null,
    }
    const mutationAt = await readDatabaseTimestamp(transaction)
    await productionSessionMutationRepository.persistSessionMutation(
      transaction,
      recovery.locked,
      {
        finalStateVersion,
        lifecycleStatus: 'active',
        currentHandId: HAND_ID,
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        snapshot: encodeSnapshot(finalState),
        events: eventDrafts.map((event, index) => {
          const eventSeq = firstEventSeq + index
          const eventId = randomUUID()
          const publicEvent = SseEventSchema.parse({
            eventId,
            sessionId: SESSION_ID,
            eventSeq,
            stateVersion: finalStateVersion,
            type: event.type,
            payload: {
              snapshot: {
                ...projectPublicSnapshot(
                  finalState,
                  projectedSession,
                  lastEventSeq,
                ),
                eventSeq,
              },
            },
          })
          return {
            eventId,
            eventSeq,
            handId: getPrivateEventHandId(event),
            commandLedgerId: null,
            stateVersionBefore: recovery.locked.stateVersion,
            stateVersionAfter: finalStateVersion,
            privateEvent:
              productionSessionMutationRepository.currentPrivateEventProtocol.encodeCurrent(
                event,
              ),
            publicEvent,
            createdAt: mutationAt,
          }
        }),
        mutationAt,
      },
    )
    return finalState
  })
}

function playerRunConfiguration() {
  return {
    runtime: 'player',
    runtimeDefinitionVersion: 1,
    contextSchemaVersion: 1,
    promptModules: [],
    capabilityManifest: { id: 'player.capabilities', version: 1 },
    capabilities: [],
    routePolicy: { id: 'player.route-policy', version: 1 },
    outputSchema: { id: 'player.output.decision', version: 1 },
    validator: { id: 'player.validator.decision', version: 1 },
    commitGate: { id: 'player.commit-poker-decision', version: 1 },
    recoveryPolicy: { id: 'player.recovery-policy', version: 1 },
    dataDependencies: [],
  }
}

function playerExecutionBudget() {
  return {
    budgetSchemaVersion: 1 as const,
    maxAttempts: 4,
    maxInputTokens: 20_000,
    maxOutputTokens: 1_000,
    maxWallClockMs: 45_000,
    maxCapabilityInvocations: 4,
    maxCostMicrounits: 2_000,
    maxOwnerConcurrentRuns: 2,
    maxSystemConcurrentRuns: 4,
    minimumAttemptStartRemainingMs: 5_000,
    attemptTimeoutMs: 15_000,
  }
}

async function insertSelectedDecisionFixture(
  sql: Sql,
  options: { readonly completeHand?: boolean } = {},
): Promise<M47LiveFixture> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const runId = randomUUID()
  const decisionId = randomUUID()
  const attemptId = randomUUID()
  const authority = issueRuntimeCommitAuthority({
    runtimeType: 'player',
    runId,
    leaseOwner: 'm47-database:player:0',
    fencingToken: 1,
  })
  let claim: PlayerCommitClaim = {
    decisionRecordId: decisionId,
    agentRunId: runId,
    commandId: decisionId,
    acceptedAttemptId: attemptId,
    binding: {
      sessionId: SESSION_ID,
      handId: HAND_ID,
      stateVersion: 1,
      decisionRequestId: DECISION_REQUEST_ID,
      actorParticipantId: PARTICIPANT_ID,
      actorSeat: 3,
      pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    },
  }
  const { checkpoint, snapshot, initialEvents } = createM47SessionState()
  const runConfiguration = encodeRunConfigurationAudit(playerRunConfiguration())
  const budget = encodeExecutionBudgetAudit(playerExecutionBudget())
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO app_private.sessions (id, owner_id)
      VALUES (${SESSION_ID}::uuid, ${owner.databaseOwnerId}::uuid)
    `
    for (const [seatNumber, participantId] of ROSTER_IDS.entries()) {
      await transaction`
        INSERT INTO app_private.session_participants (
          id, session_id, owner_id, participant_type, seat_number
        ) VALUES (
          ${participantId}::uuid, ${SESSION_ID}::uuid,
          ${owner.databaseOwnerId}::uuid,
          ${seatNumber === 0 ? 'user' : 'agent'}, ${seatNumber}
        )
      `
      if (seatNumber > 0) {
        await transaction`
          INSERT INTO app_private.session_agents (
            participant_id, session_id, owner_id, display_name,
            avatar_color, persona_id, persona_version,
            config_snapshot_key, config_payload_version, config_payload,
            memory_payload_version, memory_payload
          ) VALUES (
            ${participantId}::uuid, ${SESSION_ID}::uuid,
            ${owner.databaseOwnerId}::uuid, ${`M47 Agent ${seatNumber}`},
            '#000000', ${`m47-persona-${seatNumber}`}, 1,
            ${'0'.repeat(64)}, 1, ${transaction.json({})},
            1, ${transaction.json({})}
          )
        `
        await transaction`
          INSERT INTO app_private.agent_memory_revisions (
            participant_id, session_id, owner_id, revision,
            memory_payload_version, memory_payload
          ) VALUES (
            ${participantId}::uuid, ${SESSION_ID}::uuid,
            ${owner.databaseOwnerId}::uuid, 0, 1, ${transaction.json({})}
          )
        `
      }
    }
    await transaction`
      INSERT INTO app_private.hands (
        id, session_id, owner_id, hand_number, status,
        hand_start_checkpoint_payload_version,
        hand_start_checkpoint_payload, button_seat, participant_seats,
        started_at
      ) VALUES (
        ${HAND_ID}::uuid, ${SESSION_ID}::uuid,
        ${owner.databaseOwnerId}::uuid, 1, 'inProgress',
        ${checkpoint.payloadVersion}, ${transaction.json(
          checkpoint.payload as unknown as JsonValue,
        )},
        ${checkpoint.payload.checkpoint.startedHand.buttonSeatNumber},
        ${checkpoint.payload.checkpoint.startedHand.participantSeatNumbers}::integer[],
        clock_timestamp()
      )
    `
    await transaction`
      INSERT INTO app_private.session_events (
        id, session_id, owner_id, hand_id, command_ledger_id, event_seq,
        state_version_before, state_version_after,
        private_event_payload_version, private_event_payload,
        public_event_payload, created_at
      ) VALUES
        (
          ${randomUUID()}::uuid, ${SESSION_ID}::uuid,
          ${owner.databaseOwnerId}::uuid, NULL, NULL, 0, 0, 1,
          ${initialEvents[0].payloadVersion},
          ${transaction.json(initialEvents[0].payload as JsonValue)},
          ${transaction.json({})}, clock_timestamp()
        ),
        (
          ${randomUUID()}::uuid, ${SESSION_ID}::uuid,
          ${owner.databaseOwnerId}::uuid, ${HAND_ID}::uuid, NULL, 1, 0, 1,
          ${initialEvents[1].payloadVersion},
          ${transaction.json(initialEvents[1].payload as JsonValue)},
          ${transaction.json({})}, clock_timestamp()
        )
    `
    await transaction`
      INSERT INTO app_private.session_snapshots (
        session_id, owner_id, private_table_state_payload_version,
        private_table_state_payload
      ) VALUES (
        ${SESSION_ID}::uuid, ${owner.databaseOwnerId}::uuid,
        ${snapshot.payloadVersion}, ${transaction.json(
          snapshot.payload as unknown as JsonValue,
        )}
      )
    `
    await transaction`
      UPDATE app_private.sessions
      SET state_version = 1,
          next_event_seq = 2,
          current_hand_id = ${HAND_ID}::uuid
      WHERE id = ${SESSION_ID}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
  })

  if (options.completeHand === true) {
    const terminalState = await prepareM47TerminalAgentTurn(sql, owner)
    const terminalActorSeat = terminalState.poker.hand?.currentActorSeatNumber
    const terminalActorParticipantId =
      terminalActorSeat === null || terminalActorSeat === undefined
        ? undefined
        : ROSTER_IDS[terminalActorSeat]
    if (
      terminalActorSeat === null ||
      terminalActorSeat === undefined ||
      terminalActorSeat === 0 ||
      terminalActorParticipantId === undefined
    ) {
      throw new Error('M4.7 complete-hand fixture 未生成 AI 当前行动者。')
    }
    claim = {
      ...claim,
      binding: {
        ...claim.binding,
        actorParticipantId: terminalActorParticipantId,
        actorSeat: terminalActorSeat,
        stateVersion: terminalState.stateVersion,
      },
    }
  }

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO app_private.agent_runs (
        id, owner_id, session_id, runtime, trigger_type, lifecycle,
        idempotency_key, hand_id, participant_id, source_state_version,
        decision_request_id, lease_owner, lease_expires_at, fencing_token,
        deadline_at, runtime_definition_version,
        run_config_payload_version, run_config_payload,
        budget_payload_version, budget_payload, created_at, started_at
      ) VALUES (
        ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
        ${SESSION_ID}::uuid, 'player', 'action_required', 'running',
        ${`m47/database/${runId}`}, ${HAND_ID}::uuid,
        ${claim.binding.actorParticipantId}::uuid,
        ${claim.binding.stateVersion}, ${DECISION_REQUEST_ID}::uuid,
        'm47-database:player:0', clock_timestamp() + interval '5 minutes', 1,
        clock_timestamp() + interval '5 minutes', 1,
        ${runConfiguration.payloadVersion},
        ${transaction.json(runConfiguration.payload)},
        ${budget.payloadVersion}, ${transaction.json(budget.payload)},
        clock_timestamp(), clock_timestamp()
      )
    `
    await transaction`
      UPDATE app_private.sessions
      SET agent_run_state = 'thinking',
          active_player_run_id = ${runId}::uuid,
          active_decision_request_id = ${DECISION_REQUEST_ID}::uuid,
          updated_at = clock_timestamp()
      WHERE id = ${SESSION_ID}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
    await transaction`
      INSERT INTO app_private.agent_attempts (
        id, agent_run_id, owner_id, session_id, fencing_token,
        attempt_number, attempt_type, stage, provider, model, lifecycle,
        accepted, stale, interrupted, input_tokens, output_tokens,
        cost_microunits, duration_ms, error_category,
        attempt_payload_version, attempt_payload, started_at, completed_at
      ) VALUES (
        ${attemptId}::uuid, ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
        ${SESSION_ID}::uuid, 1, 1, 'initial', 'player.bounded-choice',
        'deepseek', 'deepseek-v4-flash', 'completed', true, false, false,
        100, 10, 120, 10, NULL, 1,
        ${transaction.json({
          actualTimeoutMs: 1,
          remainingDeadlineMsAtStart: 0,
          requestProjectionHash: 'a'.repeat(64),
          reservedInputTokens: 0,
          reservedOutputTokens: 0,
          reservedCostMicrounits: 0,
          responseProjectionHash: 'a'.repeat(64),
          validationStatus: 'valid',
          usageAccounting: 'providerReported',
          costAccounting: 'providerReportedSplit',
        })},
        clock_timestamp(), clock_timestamp()
      )
    `
    await transaction`
      INSERT INTO app_private.player_decisions (
        id, agent_run_id, owner_id, session_id, hand_id, participant_id,
        source_state_version, decision_request_id, runtime, record_version,
        status, decision_audit_snapshot_payload_version,
        decision_audit_snapshot_payload, candidate_set_payload_version,
        candidate_set_payload, model_projection_payload_version,
        model_projection_payload, model_choice_payload_version,
        model_choice_payload, validator_result_payload_version,
        validator_result_payload, accepted_attempt_id, model_prepared_at,
        selected_at
      ) VALUES (
        ${decisionId}::uuid, ${runId}::uuid, ${owner.databaseOwnerId}::uuid,
        ${SESSION_ID}::uuid, ${HAND_ID}::uuid,
        ${claim.binding.actorParticipantId}::uuid,
        ${claim.binding.stateVersion}, ${DECISION_REQUEST_ID}::uuid,
        'player', 1, 'selected',
        1, ${transaction.json({ audit: 1 })},
        1, ${transaction.json({ candidates: 1 })},
        1, ${transaction.json({ projection: 1 })},
        1, ${transaction.json({ candidateActionId: 'fold' })},
        1, ${transaction.json({ valid: true })}, ${attemptId}::uuid,
        clock_timestamp(), clock_timestamp()
      )
    `
  })
  return { owner, runId, decisionId, authority, claim }
}

function createTrackedTransaction(
  transaction: TransactionSql,
  counter: {
    calls: number
  },
): TransactionSql {
  return new Proxy(transaction, {
    apply(target, thisArgument, argumentsList) {
      counter.calls += 1
      return Reflect.apply(target, thisArgument, argumentsList)
    },
  }) as TransactionSql
}

async function createLiveCommitAttemptInput(input: {
  readonly transaction: TransactionSql
  readonly fixture: M47LiveFixture
  readonly claim?: PlayerCommitClaim
}) {
  const claim = input.claim ?? input.fixture.claim
  const recovery =
    await productionSessionRecoveryRepository.recoverSessionForMutation(
      input.transaction,
      input.fixture.owner,
      SESSION_ID,
      new Date().toISOString(),
    )
  if (recovery.kind !== 'ready') {
    throw new Error('M4.7 Repository fixture 未恢复到 active Session。')
  }
  const prepared = preparePrivateAiActionCommandRegistration({
    sessionId: claim.binding.sessionId,
    commandId: claim.commandId,
    expectedStateVersion: claim.binding.stateVersion,
    type: 'aiAction',
    payload: {
      decisionRequestId: claim.binding.decisionRequestId,
      handId: claim.binding.handId,
      actorSeatNumber: claim.binding.actorSeat,
      candidateActionId: 'fold',
      action: { type: 'fold' },
    },
  })
  const registration = await registerCommand(
    input.transaction,
    input.fixture.owner,
    prepared,
  )
  if (registration.status !== 'acquired') {
    throw new Error('M4.7 Repository fixture 未获得 command ledger。')
  }
  const commits = createPlayerCommitGateRepository()
  return { claim, commits, recovery, prepared, registration }
}

async function prepareLiveCommitAttempt(input: {
  readonly transaction: TransactionSql
  readonly fixture: M47LiveFixture
}) {
  const { claim, commits, recovery, prepared, registration } =
    await createLiveCommitAttemptInput(input)
  const liveFacts = await commits.lockForCommit({
    transaction: input.transaction,
    owner: input.fixture.owner,
    authority: input.fixture.authority,
    claim,
    recovery,
    prepared,
    registration,
  })
  return { commits, recovery, registration, liveFacts }
}

async function completeLiveCommitSurface(input: {
  readonly transaction: TransactionSql
  readonly fixture: M47LiveFixture
  readonly commits: ReturnType<typeof createPlayerCommitGateRepository>
  readonly capability: Parameters<
    ReturnType<typeof createPlayerCommitGateRepository>['markCommitted']
  >[0]['capability']
  readonly registration: Awaited<ReturnType<typeof registerCommand>>
  readonly recovery: Awaited<
    ReturnType<
      typeof productionSessionRecoveryRepository.recoverSessionForMutation
    >
  >
}): Promise<void> {
  if (
    input.registration.status !== 'acquired' ||
    input.recovery.kind !== 'ready'
  ) {
    throw new Error(
      'M4.7 Repository fixture 缺少 acquired ledger 或 ready recovery。',
    )
  }
  const registration = input.registration
  const recovery = input.recovery
  const actionResult = applyPokerAction(recovery.state.poker, {
    actorSeatNumber: input.fixture.claim.binding.actorSeat,
    action: { type: 'fold' },
  })
  const completedHandResult = actionResult.completedHand
  if (completedHandResult === null || actionResult.eventDrafts.length === 0) {
    throw new Error('M4.7 Repository fixture 未生成完成手的 AI 行动。')
  }
  const completedHandCount = Number(
    BigInt(recovery.state.completedHandCount) + 1n,
  )
  if (!Number.isSafeInteger(completedHandCount)) {
    throw new Error('M4.7 Repository fixture 完成手计数溢出。')
  }
  const finalStateVersion = recovery.locked.stateVersion + 1
  const finalState = createPrivateTableState({
    ...recovery.state,
    stateVersion: finalStateVersion,
    poker: actionResult.state,
    completedHandCount,
    lastCompletedHandSummary: completedHandResult.summary,
  })
  const firstEventSeq = recovery.locked.nextEventSeq
  const lastEventSeq = firstEventSeq + actionResult.eventDrafts.length - 1
  const projectedSession = {
    ...recovery.session,
    stateVersion: finalStateVersion,
    nextEventSeq: lastEventSeq + 1,
    currentHandId: null,
    agentRunState: 'idle' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
  }
  const response = {
    snapshot: projectPublicSnapshot(finalState, projectedSession, lastEventSeq),
  }
  await completeHandAudit(input.transaction, input.fixture.owner, {
    sessionId: input.fixture.claim.binding.sessionId,
    handId: input.fixture.claim.binding.handId,
    result: completedHandResult,
    completedAt: await readDatabaseTimestamp(input.transaction),
  })
  const handRows = await input.transaction<
    readonly { readonly status: string; readonly completedAt: string | null }[]
  >`
    SELECT status,
           completed_at::text AS "completedAt"
    FROM app_private.hands
    WHERE id = ${input.fixture.claim.binding.handId}::uuid
  `
  if (
    handRows.length !== 1 ||
    handRows[0]?.status !== 'completed' ||
    handRows[0].completedAt === null
  ) {
    throw new Error('M4.7 Repository fixture 未写入完成 Hand。')
  }
  const persisted =
    await productionSessionMutationRepository.persistSessionMutation(
      input.transaction,
      recovery.locked,
      {
        finalStateVersion,
        lifecycleStatus: 'active',
        currentHandId: null,
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        snapshot: encodeSnapshot(finalState),
        events: actionResult.eventDrafts.map((event, index) => {
          const eventSeq = firstEventSeq + index
          const publicEvent = SseEventSchema.parse({
            eventId: randomUUID(),
            sessionId: input.fixture.claim.binding.sessionId,
            eventSeq,
            stateVersion: finalStateVersion,
            type: event.type,
            payload: {
              snapshot: { ...response.snapshot, eventSeq },
            },
          })
          return {
            eventId: publicEvent.eventId,
            eventSeq,
            handId: getPrivateEventHandId(event),
            commandLedgerId: registration.ledgerId,
            stateVersionBefore: recovery.locked.stateVersion,
            stateVersionAfter: finalStateVersion,
            privateEvent:
              productionSessionMutationRepository.currentPrivateEventProtocol.encodeCurrent(
                event,
              ),
            publicEvent,
            createdAt: '2026-08-26T12:00:00.000Z',
          }
        }),
        mutationAt: '2026-08-26T12:00:00.000Z',
      },
    )
  await completeCommand(input.transaction, registration, response, {
    firstEventSeq: persisted.firstEventSeq,
    lastEventSeq: persisted.lastEventSeq,
  })
  const committed = await input.commits.markCommitted({
    transaction: input.transaction,
    owner: input.fixture.owner,
    capability: input.capability,
  })
  const finalized = await createAgentRunLifecycleRepository().finalize(
    input.transaction,
    input.fixture.owner,
    {
      runId: input.fixture.runId,
      authority: input.fixture.authority,
      lifecycle: 'completed',
      terminationReason: null,
      completedAt: committed.committedAt,
    },
  )
  if (!finalized.changed || finalized.run.lifecycle !== 'completed') {
    throw new Error('M4.7 Repository fixture 未完成 Player Run。')
  }
}

async function assertM47ProductionGateRepository(sql: Sql): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      await clearFixtures(sql)
      const fixture = await insertSelectedDecisionFixture(sql, {
        completeHand: true,
      })
      let crossTransactionCapability: unknown
      await expect(
        sql.begin(async (originalTransaction) => {
          const transaction = createTrackedTransaction(originalTransaction, {
            calls: 0,
          })
          const attempt = await prepareLiveCommitAttempt({
            transaction,
            fixture,
          })
          crossTransactionCapability = attempt.commits.issueCommitCapability({
            transaction,
            owner: fixture.owner,
            liveFacts: attempt.liveFacts,
          })
          throw new Error('M4.7 capability 跨事务 fixture rollback')
        }),
      ).rejects.toThrow('M4.7 capability 跨事务 fixture rollback')

      await sql.begin(async (originalTransaction) => {
        const counter = { calls: 0 }
        const transaction = createTrackedTransaction(
          originalTransaction,
          counter,
        )
        await expect(
          createPlayerCommitGateRepository().markCommitted({
            transaction,
            owner: fixture.owner,
            capability: crossTransactionCapability as never,
          }),
        ).rejects.toMatchObject({ code: 'player_commit_input_rejected' })
        expect(counter.calls).toBe(0)
      })

      const beforeRollback = await sql<readonly M47CommitSurface[]>`
        SELECT
          (SELECT state_version::float8 FROM app_private.sessions
           WHERE id = ${SESSION_ID}::uuid) AS "stateVersion",
          (SELECT status FROM app_private.hands
           WHERE session_id = ${SESSION_ID}::uuid) AS "handStatus",
          (SELECT status FROM app_private.player_decisions
           WHERE id = ${fixture.decisionId}::uuid) AS "decisionStatus",
          (SELECT lifecycle FROM app_private.agent_runs
           WHERE id = ${fixture.runId}::uuid) AS "runLifecycle",
          (SELECT count(*)::int FROM app_private.command_ledger
           WHERE session_id = ${SESSION_ID}::uuid) AS "ledgerCount"
      `
      await expect(
        sql.begin(async (originalTransaction) => {
          const counter = { calls: 0 }
          const transaction = createTrackedTransaction(
            originalTransaction,
            counter,
          )
          const attempt = await prepareLiveCommitAttempt({
            transaction,
            fixture,
          })
          const capability = attempt.commits.issueCommitCapability({
            transaction,
            owner: fixture.owner,
            liveFacts: attempt.liveFacts,
          })
          await completeLiveCommitSurface({
            transaction,
            fixture,
            commits: attempt.commits,
            capability,
            registration: attempt.registration,
            recovery: attempt.recovery,
          })
          const callsAfterFirstConsumption = counter.calls
          await expect(
            attempt.commits.markCommitted({
              transaction,
              owner: fixture.owner,
              capability,
            }),
          ).rejects.toMatchObject({ code: 'player_commit_input_rejected' })
          expect(counter.calls).toBe(callsAfterFirstConsumption)
          throw new Error('M4.7 complete success surface rollback')
        }),
      ).rejects.toThrow('M4.7 complete success surface rollback')
      const afterRollback = await sql<readonly M47CommitSurface[]>`
        SELECT
          (SELECT state_version::float8 FROM app_private.sessions
           WHERE id = ${SESSION_ID}::uuid) AS "stateVersion",
          (SELECT status FROM app_private.hands
           WHERE session_id = ${SESSION_ID}::uuid) AS "handStatus",
          (SELECT status FROM app_private.player_decisions
           WHERE id = ${fixture.decisionId}::uuid) AS "decisionStatus",
          (SELECT lifecycle FROM app_private.agent_runs
           WHERE id = ${fixture.runId}::uuid) AS "runLifecycle",
          (SELECT count(*)::int FROM app_private.command_ledger
           WHERE session_id = ${SESSION_ID}::uuid) AS "ledgerCount"
      `
      expect(afterRollback).toEqual(beforeRollback)
    },
    () => clearFixtures(sql),
  )
}

async function assertM47ProductionGateRejection(
  sql: Sql,
  fixture: M47LiveFixture,
  before: M47CommitSurface,
  input: {
    readonly name: string
    readonly operation: (input: {
      readonly transaction: TransactionSql
      readonly fixture: M47LiveFixture
    }) => Promise<void>
  },
): Promise<void> {
  const rollback = `M4.7 ${input.name} fixture rollback`
  await expect(
    sql.begin(async (transaction) => {
      await input.operation({ transaction, fixture })
      throw new Error(rollback)
    }),
  ).rejects.toThrow(rollback)
  expect(await readM47CommitSurface(sql, fixture)).toEqual(before)
}

async function assertM47ProductionGateRejectionMatrix(sql: Sql): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      await clearFixtures(sql)
      const fixture = await insertSelectedDecisionFixture(sql)
      const before = await readM47CommitSurface(sql, fixture)

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '非 selected Decision',
        operation: async ({ transaction, fixture }) => {
          const attempt = await createLiveCommitAttemptInput({
            transaction,
            fixture,
          })
          await transaction`
            UPDATE app_private.player_decisions
            SET status = 'modelPrepared',
                model_choice_payload_version = NULL,
                model_choice_payload = NULL,
                validator_result_payload_version = NULL,
                validator_result_payload = NULL,
                accepted_attempt_id = NULL,
                selected_at = NULL
            WHERE id = ${fixture.decisionId}::uuid
          `
          await expect(
            attempt.commits.lockForCommit({
              transaction,
              owner: fixture.owner,
              authority: fixture.authority,
              claim: attempt.claim,
              recovery: attempt.recovery,
              prepared: attempt.prepared,
              registration: attempt.registration,
            }),
          ).rejects.toMatchObject({
            code: 'player_commit_selected_decision_invalid',
          })
        },
      })

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '错误 Decision',
        operation: async ({ transaction, fixture }) => {
          const decisionId = randomUUID()
          const attempt = await createLiveCommitAttemptInput({
            transaction,
            fixture,
            claim: {
              ...fixture.claim,
              decisionRecordId: decisionId,
              commandId: decisionId,
            },
          })
          await expect(
            attempt.commits.lockForCommit({
              transaction,
              owner: fixture.owner,
              authority: fixture.authority,
              claim: attempt.claim,
              recovery: attempt.recovery,
              prepared: attempt.prepared,
              registration: attempt.registration,
            }),
          ).rejects.toMatchObject({ code: 'player_commit_resource_missing' })
        },
      })

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '错误 Run',
        operation: async ({ transaction, fixture }) => {
          const runId = randomUUID()
          const authority = issueRuntimeCommitAuthority({
            runtimeType: 'player',
            runId,
            leaseOwner: fixture.authority.leaseOwner,
            fencingToken: fixture.authority.fencingToken,
          })
          const attempt = await createLiveCommitAttemptInput({
            transaction,
            fixture,
            claim: { ...fixture.claim, agentRunId: runId },
          })
          await expect(
            attempt.commits.lockForCommit({
              transaction,
              owner: fixture.owner,
              authority,
              claim: attempt.claim,
              recovery: attempt.recovery,
              prepared: attempt.prepared,
              registration: attempt.registration,
            }),
          ).rejects.toMatchObject({ code: 'player_commit_resource_missing' })
        },
      })

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '错误 Owner',
        operation: async ({ transaction, fixture }) => {
          const attempt = await createLiveCommitAttemptInput({
            transaction,
            fixture,
          })
          const originalIdentity = `m47-original-owner-${randomUUID()}`
          await transaction`
            UPDATE app_private.owners
            SET identity_key = ${originalIdentity}
            WHERE id = ${fixture.owner.databaseOwnerId}::uuid
          `
          await transaction`
            INSERT INTO app_private.owners (id, identity_key)
            VALUES (${randomUUID()}::uuid, 'local-user')
          `
          const wrongOwner = await resolveOwnerScope(transaction, {
            ownerId: 'local-user',
          })
          await expect(
            attempt.commits.lockForCommit({
              transaction,
              owner: wrongOwner,
              authority: fixture.authority,
              claim: attempt.claim,
              recovery: attempt.recovery,
              prepared: attempt.prepared,
              registration: attempt.registration,
            }),
          ).rejects.toMatchObject({ code: 'player_commit_resource_missing' })
        },
      })

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '错误 Session',
        operation: async ({ transaction, fixture }) => {
          const sessionId = randomUUID()
          await transaction`
            INSERT INTO app_private.sessions (
              id, owner_id, lifecycle_status, ended_at
            ) VALUES (
              ${sessionId}::uuid, ${fixture.owner.databaseOwnerId}::uuid,
              'ended', clock_timestamp()
            )
          `
          const attempt = await createLiveCommitAttemptInput({
            transaction,
            fixture,
            claim: {
              ...fixture.claim,
              binding: { ...fixture.claim.binding, sessionId },
            },
          })
          await expect(
            attempt.commits.lockForCommit({
              transaction,
              owner: fixture.owner,
              authority: fixture.authority,
              claim: attempt.claim,
              recovery: attempt.recovery,
              prepared: attempt.prepared,
              registration: attempt.registration,
            }),
          ).rejects.toMatchObject({ code: 'player_commit_decision_stale' })
        },
      })

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '错误 ledger',
        operation: async ({ transaction, fixture }) => {
          const attempt = await createLiveCommitAttemptInput({
            transaction,
            fixture,
          })
          const wrongPrepared = preparePrivateAiActionCommandRegistration({
            sessionId: fixture.claim.binding.sessionId,
            commandId: randomUUID(),
            expectedStateVersion: fixture.claim.binding.stateVersion,
            type: 'aiAction',
            payload: {
              decisionRequestId: fixture.claim.binding.decisionRequestId,
              handId: fixture.claim.binding.handId,
              actorSeatNumber: fixture.claim.binding.actorSeat,
              candidateActionId: 'fold',
              action: { type: 'fold' },
            },
          })
          const wrongRegistration = await registerCommand(
            transaction,
            fixture.owner,
            wrongPrepared,
          )
          if (wrongRegistration.status !== 'acquired') {
            throw new Error('M4.7 错误 ledger fixture 未获得 ledger。')
          }
          await expect(
            attempt.commits.lockForCommit({
              transaction,
              owner: fixture.owner,
              authority: fixture.authority,
              claim: attempt.claim,
              recovery: attempt.recovery,
              prepared: attempt.prepared,
              registration: wrongRegistration,
            }),
          ).rejects.toMatchObject({ code: 'player_commit_input_rejected' })
        },
      })

      await assertM47ProductionGateRejection(sql, fixture, before, {
        name: '未完成 ledger',
        operation: async ({ transaction, fixture }) => {
          const attempt = await prepareLiveCommitAttempt({
            transaction,
            fixture,
          })
          const capability = attempt.commits.issueCommitCapability({
            transaction,
            owner: fixture.owner,
            liveFacts: attempt.liveFacts,
          })
          await expect(
            attempt.commits.markCommitted({
              transaction,
              owner: fixture.owner,
              capability,
            }),
          ).rejects.toMatchObject({
            code: 'player_commit_persistence_rejected',
          })
        },
      })
    },
    () => clearFixtures(sql),
  )
}

export async function assertM47LockOrderAndDeletionRaces(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      await clearFixtures(sql)
      const fixture = await insertSelectedDecisionFixture(sql)
      const gateSql = createDatabaseTestSqlForRole(runtimeUrl, 'm47-gate')
      const handWaitSql = createDatabaseTestSqlForRole(
        runtimeUrl,
        'm47-hand-wait',
      )
      const runWaitSql = createDatabaseTestSqlForRole(
        runtimeUrl,
        'm47-run-wait',
      )
      const deleteSql = createDatabaseTestSqlForRole(
        runtimeUrl,
        'm47-delete-wait',
      )
      const clearSql = createDatabaseTestSqlForRole(
        runtimeUrl,
        'm47-clear-wait',
      )
      try {
        for (const conflict of ['delete', 'clear'] as const) {
          const handLocked = createDeferred<void>()
          const releaseHand = createDeferred<void>()
          const runLocked = createDeferred<void>()
          const releaseRun = createDeferred<void>()
          const gatePid = createDeferred<number>()
          let gateWork: Promise<unknown> | undefined
          let conflictWork: Promise<unknown> | undefined
          let handWaitWork: Promise<unknown> | undefined
          let runWaitWork: Promise<unknown> | undefined
          const conflictPid = createDeferred<number>()
          const handWaitPid = createDeferred<number>()
          const runWaitPid = createDeferred<number>()
          try {
            gateWork = gateSql.begin(async (transaction) => {
              gatePid.resolve(await readTransactionBackendPid(transaction))
              await prepareLiveCommitAttempt({
                transaction: pauseAfterGateLock({
                  transaction,
                  handLocked,
                  releaseHand,
                  runLocked,
                  releaseRun,
                }),
                fixture,
              })
              throw new Error(`M4.7 ${conflict} gate rollback`)
            })
            const lockedGatePid = await gatePid.promise
            await handLocked.promise
            handWaitWork = handWaitSql.begin(async (transaction) => {
              const pid = await readTransactionBackendPid(transaction)
              handWaitPid.resolve(pid)
              await transaction`
                SELECT id FROM app_private.hands
                WHERE session_id = ${SESSION_ID}::uuid
                FOR UPDATE
              `
              return pid
            })
            await waitForTransactionBlock(
              sql,
              lockedGatePid,
              await handWaitPid.promise,
            )

            conflictWork =
              conflict === 'delete'
                ? deleteSql.begin(async (transaction) => {
                    conflictPid.resolve(
                      await readTransactionBackendPid(transaction),
                    )
                    await transaction`
                      DELETE FROM app_private.sessions
                      WHERE id = ${SESSION_ID}::uuid
                    `
                    throw new Error('M4.7 delete race rollback')
                  })
                : clearSql.begin(async (transaction) => {
                    conflictPid.resolve(
                      await readTransactionBackendPid(transaction),
                    )
                    await clearOwnerSessionData(transaction, fixture.owner, {
                      deletedAt: await readDatabaseTimestamp(transaction),
                    })
                    throw new Error('M4.7 clear race rollback')
                  })
            await waitForTransactionBlock(
              sql,
              lockedGatePid,
              await conflictPid.promise,
            )
            releaseHand.resolve()
            await runLocked.promise
            runWaitWork = runWaitSql.begin(async (transaction) => {
              const pid = await readTransactionBackendPid(transaction)
              runWaitPid.resolve(pid)
              await transaction`
                SELECT id FROM app_private.agent_runs
                WHERE id = ${fixture.runId}::uuid
                FOR UPDATE
              `
              return pid
            })
            await waitForTransactionBlock(
              sql,
              lockedGatePid,
              await runWaitPid.promise,
            )
            releaseRun.resolve()
            await expect(gateWork).rejects.toThrow(
              `M4.7 ${conflict} gate rollback`,
            )
            await expect(conflictWork).rejects.toThrow(
              `M4.7 ${conflict} race rollback`,
            )
            await expect(handWaitWork).resolves.toEqual(expect.any(Number))
            await expect(runWaitWork).resolves.toEqual(expect.any(Number))
          } finally {
            releaseHand.resolve()
            releaseRun.resolve()
            await Promise.allSettled(
              [gateWork, conflictWork, handWaitWork, runWaitWork].filter(
                (work): work is Promise<unknown> => work !== undefined,
              ),
            )
          }
        }

        // Gate 已开始等待后，删除和 Owner clear 都必须真正提交。此处验证的
        // 是 Session recovery 的资源缺失；应用层再把它固定映射为
        // player_commit_resource_missing。
        for (const operation of ['delete', 'clear'] as const) {
          await clearFixtures(sql)
          const postCommitFixture = await insertSelectedDecisionFixture(sql)
          const deletionSql = createDatabaseTestSqlForRole(
            runtimeUrl,
            `m47-${operation}-first`,
          )
          const waitingGateSql = createDatabaseTestSqlForRole(
            runtimeUrl,
            `m47-gate-after-${operation}`,
          )
          const deletionPid = createDeferred<number>()
          const deletionLocked = createDeferred<void>()
          const releaseDeletion = createDeferred<void>()
          let deletionWork: Promise<unknown> | undefined
          let waitingGateWork: Promise<unknown> | undefined
          try {
            deletionWork = deletionSql.begin(async (transaction) => {
              deletionPid.resolve(await readTransactionBackendPid(transaction))
              if (operation === 'delete') {
                await transaction`
                  DELETE FROM app_private.sessions
                  WHERE id = ${SESSION_ID}::uuid
                `
              } else {
                await clearOwnerSessionData(
                  transaction,
                  postCommitFixture.owner,
                  {
                    deletedAt: await readDatabaseTimestamp(transaction),
                  },
                )
              }
              deletionLocked.resolve()
              await releaseDeletion.promise
            })
            await deletionLocked.promise
            const waitingGatePid = createDeferred<number>()
            waitingGateWork = waitingGateSql.begin(async (transaction) => {
              waitingGatePid.resolve(
                await readTransactionBackendPid(transaction),
              )
              await prepareLiveCommitAttempt({
                transaction,
                fixture: postCommitFixture,
              })
            })
            await waitForTransactionBlock(
              sql,
              await deletionPid.promise,
              await waitingGatePid.promise,
            )
            releaseDeletion.resolve()
            await expect(deletionWork).resolves.toBeUndefined()
            await expect(waitingGateWork).rejects.toBeInstanceOf(
              ResourceNotFoundError,
            )
            expect(
              await readM47DeletedCommitSurface(sql, postCommitFixture),
            ).toEqual({
              sessionCount: 0,
              handCount: 0,
              runCount: 0,
              decisionCount: 0,
              ledgerCount: 0,
            })
          } finally {
            releaseDeletion.resolve()
            await Promise.allSettled(
              [deletionWork, waitingGateWork].filter(
                (work): work is Promise<unknown> => work !== undefined,
              ),
            )
            await deletionSql.end({ timeout: 0 })
            await waitingGateSql.end({ timeout: 0 })
          }
        }
      } finally {
        await Promise.all([
          gateSql.end({ timeout: 0 }),
          handWaitSql.end({ timeout: 0 }),
          runWaitSql.end({ timeout: 0 }),
          deleteSql.end({ timeout: 0 }),
          clearSql.end({ timeout: 0 }),
        ])
      }
    },
    () => clearFixtures(sql),
  )
}

export async function assertM47PlayerCommitSchema(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const columns = await sql<readonly { readonly columnName: string }[]>`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND table_name = 'player_decisions'
      AND column_name IN ('command_ledger_id', 'committed_at')
    ORDER BY column_name
  `
  expect(columns).toEqual([
    { columnName: 'command_ledger_id' },
    { columnName: 'committed_at' },
  ])

  const constraints = await sql<readonly { readonly constraintName: string }[]>`
    SELECT conname AS "constraintName"
    FROM pg_constraint
    WHERE conrelid = 'app_private.player_decisions'::regclass
      AND conname IN (
        'player_decisions_status_check',
        'player_decisions_stage_matrix_check',
        'player_decisions_timestamp_order_check',
        'player_decisions_command_ledger_scope_fk',
        'player_decisions_command_ledger_unique'
      )
    ORDER BY conname
  `
  expect(constraints).toEqual([
    { constraintName: 'player_decisions_command_ledger_scope_fk' },
    { constraintName: 'player_decisions_command_ledger_unique' },
    { constraintName: 'player_decisions_stage_matrix_check' },
    { constraintName: 'player_decisions_status_check' },
    { constraintName: 'player_decisions_timestamp_order_check' },
  ])

  const committedStatus = await sql<
    readonly { readonly acceptsCommitted: boolean }[]
  >`
    SELECT
      pg_get_constraintdef(oid) LIKE '%''committed''%'
        AS "acceptsCommitted"
    FROM pg_constraint
    WHERE conrelid = 'app_private.player_decisions'::regclass
      AND conname = 'player_decisions_status_check'
  `
  expect(committedStatus).toEqual([{ acceptsCommitted: true }])

  await runDatabaseTestWithCleanup(
    async () => {
      await clearFixtures(sql)
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const { decisionId } = await insertSelectedDecisionFixture(sql)
      const ledgerId = randomUUID()
      const rollbackLedgerId = randomUUID()

      await expect(sql`
        UPDATE app_private.player_decisions
        SET status = 'committed', committed_at = clock_timestamp()
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({
        code: '23514',
        constraint_name: 'player_decisions_stage_matrix_check',
      })

      await expect(
        sql.begin(async (transaction) => {
          await transaction`
            INSERT INTO app_private.command_ledger (
              id, session_id, owner_id, command_id,
              canonical_payload_digest, processing_status,
              final_state_version, first_event_seq, last_event_seq,
              response_payload_version, response_payload, completed_at
            ) VALUES (
              ${rollbackLedgerId}::uuid, ${SESSION_ID}::uuid,
              ${owner.databaseOwnerId}::uuid, ${randomUUID()}::uuid,
              ${'a'.repeat(64)}, 'completed', 8, 20, 20,
              1, ${transaction.json({ snapshot: {} })}, clock_timestamp()
            )
          `
          await transaction`
            UPDATE app_private.player_decisions
            SET status = 'committed',
                command_ledger_id = ${rollbackLedgerId}::uuid,
                committed_at = clock_timestamp()
            WHERE id = ${decisionId}::uuid
          `
          throw new Error('M4.7 受控回滚')
        }),
      ).rejects.toThrow('M4.7 受控回滚')
      const rolledBack = await sql<
        readonly { readonly status: string; readonly ledgerCount: number }[]
      >`
        SELECT decision.status,
               (SELECT count(*)::int FROM app_private.command_ledger
                WHERE id = ${rollbackLedgerId}::uuid) AS "ledgerCount"
        FROM app_private.player_decisions AS decision
        WHERE decision.id = ${decisionId}::uuid
      `
      expect(rolledBack).toEqual([{ status: 'selected', ledgerCount: 0 }])

      await sql`
        INSERT INTO app_private.command_ledger (
          id, session_id, owner_id, command_id,
          canonical_payload_digest, processing_status,
          final_state_version, first_event_seq, last_event_seq,
          response_payload_version, response_payload, completed_at
        ) VALUES (
          ${ledgerId}::uuid, ${SESSION_ID}::uuid,
          ${owner.databaseOwnerId}::uuid, ${randomUUID()}::uuid,
          ${'b'.repeat(64)}, 'completed', 8, 20, 20,
          1, ${sql.json({ snapshot: {} })}, clock_timestamp()
        )
      `
      await sql`
        UPDATE app_private.player_decisions
        SET status = 'committed',
            command_ledger_id = ${ledgerId}::uuid,
            committed_at = clock_timestamp()
        WHERE id = ${decisionId}::uuid
      `
      const committed = await sql<
        readonly {
          readonly status: string
          readonly commandLedgerId: string | null
          readonly acceptedAttemptId: string | null
          readonly auditPayload: unknown
          readonly candidatePayload: unknown
          readonly choicePayload: unknown
          readonly validatorPayload: unknown
        }[]
      >`
        SELECT status,
               command_ledger_id::text AS "commandLedgerId",
               accepted_attempt_id::text AS "acceptedAttemptId",
               decision_audit_snapshot_payload AS "auditPayload",
               candidate_set_payload AS "candidatePayload",
               model_choice_payload AS "choicePayload",
               validator_result_payload AS "validatorPayload"
        FROM app_private.player_decisions
        WHERE id = ${decisionId}::uuid
      `
      expect(committed).toEqual([
        {
          status: 'committed',
          commandLedgerId: ledgerId,
          acceptedAttemptId: expect.any(String),
          auditPayload: { audit: 1 },
          candidatePayload: { candidates: 1 },
          choicePayload: { candidateActionId: 'fold' },
          validatorPayload: { valid: true },
        },
      ])
      await expect(sql`
        UPDATE app_private.player_decisions
        SET command_ledger_id = ${randomUUID()}::uuid
        WHERE id = ${decisionId}::uuid
      `).rejects.toMatchObject({ code: '23503' })
    },
    () => clearFixtures(sql),
  )
  await assertM47ProductionGateRepository(sql)
  await assertM47ProductionGateRejectionMatrix(sql)
  await assertM47LockOrderAndDeletionRaces(sql, runtimeUrl)
}
