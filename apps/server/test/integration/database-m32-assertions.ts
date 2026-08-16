import { randomUUID } from 'node:crypto'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { getLegalActions } from '../../src/poker/betting.js'
import type { RandomSource } from '../../src/poker/random-source.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import {
  clearOwnerSessionData,
  deleteEndedSessionData,
} from '../../src/persistence/session-deletion-repository.js'
import { insertInProgressHandAudit } from '../../src/persistence/hand-audit-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  createSessionCreationRepository,
  type SessionCreationRepository,
} from '../../src/persistence/session-creation-repository.js'
import {
  productionSessionMutationRepository,
  type LockedSessionView,
  type SessionMutationBatch,
  type SessionMutationRepository,
} from '../../src/persistence/session-mutation-repository.js'
import { decodeCurrentSnapshotV1 } from '../../src/sessions/authoritative-state/snapshot-codec-v1.js'
import type { PrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { prepareCurrentCatalogRoster } from '../../src/sessions/roster-preparation.js'
import {
  createSessionCreationIdentityGraph,
  type SessionCreationIdentityGraph,
} from '../../src/sessions/session-creation/session-creation-consistency.js'
import type { SessionCreationSnapshotProjectionInput } from '../../src/sessions/session-creation/session-creation-projector.js'
import {
  createSessionCreationService,
  RosterSourceChangedServiceError,
  type HandAuditCreationWriter,
  type SessionCreationResult,
} from '../../src/sessions/session-creation/session-creation-service.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
  serializeJsonbFixture,
} from './database-test-runtime.js'

const CREATED_AT = '2026-08-09T12:00:00.000Z'

function projectCompletedHandSummary(
  summary: NonNullable<PrivateTableState['lastCompletedHandSummary']>,
): PublicSessionSnapshot['lastCompletedHandSummary'] {
  return {
    handId: summary.handId,
    terminationReason: summary.terminationReason,
    participantSeatNumbers: [...summary.participantSeatNumbers],
    buttonSeatNumber: summary.buttonSeatNumber,
    smallBlindSeatNumber: summary.smallBlindSeatNumber,
    bigBlindSeatNumber: summary.bigBlindSeatNumber,
    positions: summary.positions.map((position) => ({ ...position })),
    board: [...summary.board],
    seatResults: summary.seats.map(
      ({
        seatNumber,
        startingStack,
        endingStack,
        totalContribution,
        netChange,
      }) => ({
        seatNumber,
        startingStack,
        endingStack,
        totalContribution,
        netChange,
      }),
    ),
    uncalledBetReturns: summary.uncalledBetReturns.map((item) => ({
      ...item,
    })),
    pots: summary.pots.map((pot) => ({
      potIndex: pot.potIndex,
      kind: pot.kind,
      amount: pot.amount,
      winningSeatNumbers: [...pot.winningSeatNumbers],
      awards: pot.awards.map((award) => ({
        seatNumber: award.seatNumber,
        amount: award.amount,
      })),
    })),
    revealedHands: summary.participantHands.map((hand) => {
      const visible =
        hand.seatNumber === 0 ||
        (summary.terminationReason === 'showdown' &&
          hand.handEvaluation !== null)
      return {
        seatNumber: hand.seatNumber,
        holeCards: visible ? [...hand.holeCards] : null,
        handEvaluation:
          visible && hand.handEvaluation !== null
            ? {
                category: hand.handEvaluation.category,
                bestFive: [...hand.handEvaluation.bestFive],
              }
            : null,
      }
    }),
  }
}

type LockOwnerParameters = Parameters<
  SessionCreationRepository['lockOwnerForSessionCreation']
>
type LockLatestRosterParameters = Parameters<
  SessionCreationRepository['lockLatestEndedRosterForCreation']
>
type PersistMutationParameters = Parameters<
  SessionMutationRepository['persistSessionMutation']
>

export function projectPublicSnapshot(
  state: PrivateTableState,
  session: LockedSessionView,
  eventSeq: number,
): PublicSessionSnapshot {
  const hand = state.poker.hand
  const privateHeroHoleCards = hand?.holeCards.find(
    (cards) => cards.seatNumber === 0,
  )?.cards
  const heroHoleCards =
    privateHeroHoleCards === undefined ? null : [...privateHeroHoleCards]
  return {
    sessionId: session.sessionId,
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
            board: [...hand.board],
            pot: hand.pot,
            currentActorSeatNumber: hand.currentActorSeatNumber,
            heroHoleCards,
            legalActions:
              hand.currentActorSeatNumber === 0
                ? getLegalActions(state.poker)
                : [],
            actionTimeline: [],
          },
    lastCompletedHandSummary:
      hand !== null || state.lastCompletedHandSummary === null
        ? null
        : projectCompletedHandSummary(state.lastCompletedHandSummary),
  }
}

export function createM32Service(
  sql: Sql,
  onIdentity: (identity: SessionCreationIdentityGraph) => void,
  options: {
    readonly mutationRepository?: SessionMutationRepository
    readonly creationRepository?: SessionCreationRepository
    readonly handAuditWriter?: HandAuditCreationWriter
    readonly randomSource?: RandomSource
  } = {},
) {
  const catalog = loadAndValidatePersonaCatalog()
  return createSessionCreationService({
    sql,
    catalog,
    readProviderPolicy: () => ({
      deepSeekConfigured: true,
      kimiConfigured: true,
    }),
    createIdentityGraph: (seatNumbers) => {
      const identity = createSessionCreationIdentityGraph(seatNumbers)
      onIdentity(identity)
      return identity
    },
    randomSource: options.randomSource ?? { nextInt: () => 0 },
    now: () => CREATED_AT,
    creationRepository:
      options.creationRepository ?? createSessionCreationRepository(),
    mutationRepository:
      options.mutationRepository ?? productionSessionMutationRepository,
    handAuditWriter: options.handAuditWriter ?? {
      insertInProgress: insertInProgressHandAudit,
    },
    snapshotProjectorBinding: {
      bindReadPort: (transaction) => transaction,
      projector: {
        async project(
          input: SessionCreationSnapshotProjectionInput<TransactionSql>,
        ) {
          return projectPublicSnapshot(
            input.state,
            input.session,
            input.eventSeq,
          )
        },
      },
    },
    activeSessionSnapshotReaderBinding: {
      bindReadPort: (transaction) => transaction,
      reader: {
        async read({ reference, reads }) {
          const transaction = reads as TransactionSql
          const rows = await transaction<
            {
              readonly payloadVersion: number
              readonly payload: unknown
            }[]
          >`
            SELECT
              private_table_state_payload_version AS "payloadVersion",
              private_table_state_payload AS payload
            FROM app_private.session_snapshots
            WHERE session_id = ${reference.session.sessionId}::uuid
          `
          const row = rows[0]
          if (row === undefined || rows.length !== 1) {
            throw new Error('M3.2 active Session 缺少唯一权威快照。')
          }
          const stored = decodeCurrentSnapshotV1({
            payloadVersion: row.payloadVersion,
            payload: row.payload,
          })
          return projectPublicSnapshot(
            stored.payload.state,
            reference.session,
            reference.session.nextEventSeq - 1,
          )
        },
      },
    },
  })
}

export function currentCatalogRequest(aiCount: number) {
  return {
    rosterSource: {
      type: 'currentCatalog' as const,
      selections: loadAndValidatePersonaCatalog()
        .list()
        .slice(0, aiCount)
        .map((entry, index) => ({
          personaId: entry.personaId,
          seatNumber: index + 1,
        })),
    },
  }
}

export async function clearLocalOwnerSessions(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM app_private.sessions
    WHERE owner_id = (
      SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
    )
  `
}

function createDeferred<Value>(): {
  readonly promise: Promise<Value>
  readonly resolve: (value: Value) => void
} {
  let resolvePromise: ((value: Value) => void) | undefined
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value)
    },
  }
}

function pauseBeforeTransaction(
  sql: Sql,
  reached: ReturnType<typeof createDeferred<void>>,
  release: ReturnType<typeof createDeferred<void>>,
): Sql {
  return new Proxy(sql, {
    get(target, property, receiver) {
      if (property === 'begin') {
        return async <Result>(
          callback: (transaction: TransactionSql) => Promise<Result>,
        ) => {
          reached.resolve()
          await release.promise
          return target.begin(callback)
        }
      }
      return Reflect.get(target, property, receiver)
    },
  })
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
            AND held.pid = ${blockingBackendPid}::int
          WHERE waiting.pid = ${waitingBackendPid}::int
            AND waiting.locktype = 'transactionid'
            AND NOT waiting.granted
        ) AS "waitsForTransactionId",
        ${blockingBackendPid}::int = ANY(
          pg_blocking_pids(${waitingBackendPid}::int)
        ) AS "blockedByFirst"
    `
    if (rows[0]?.waitsForTransactionId && rows[0].blockedByFirst) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('M3.2 未观察到预期的真实 PostgreSQL 锁等待。')
}

async function assertCreationRowsRolledBack(
  sql: Sql,
  identity: SessionCreationIdentityGraph,
): Promise<void> {
  const rows = await sql<
    {
      readonly sessionCount: number
      readonly participantCount: number
      readonly agentCount: number
      readonly memoryCount: number
      readonly handCount: number
      readonly eventCount: number
      readonly snapshotCount: number
    }[]
  >`
    SELECT
      (SELECT count(*)::int FROM app_private.sessions WHERE id = ${identity.sessionId}::uuid) AS "sessionCount",
      (SELECT count(*)::int FROM app_private.session_participants WHERE session_id = ${identity.sessionId}::uuid) AS "participantCount",
      (SELECT count(*)::int FROM app_private.session_agents WHERE session_id = ${identity.sessionId}::uuid) AS "agentCount",
      (SELECT count(*)::int FROM app_private.agent_memory_revisions WHERE session_id = ${identity.sessionId}::uuid) AS "memoryCount",
      (SELECT count(*)::int FROM app_private.hands WHERE session_id = ${identity.sessionId}::uuid) AS "handCount",
      (SELECT count(*)::int FROM app_private.session_events WHERE session_id = ${identity.sessionId}::uuid) AS "eventCount",
      (SELECT count(*)::int FROM app_private.session_snapshots WHERE session_id = ${identity.sessionId}::uuid) AS "snapshotCount"
  `
  expect(rows[0]).toEqual({
    sessionCount: 0,
    participantCount: 0,
    agentCount: 0,
    memoryCount: 0,
    handCount: 0,
    eventCount: 0,
    snapshotCount: 0,
  })
}

async function endSession(
  sql: Sql,
  sessionId: string,
  endedAt: string,
): Promise<void> {
  await sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'ended',
        ended_at = ${endedAt}::timestamptz,
        updated_at = ${endedAt}::timestamptz
    WHERE id = ${sessionId}::uuid
  `
}

async function createEndedSource(
  sql: Sql,
  endedAt: string,
  oldVersionBase?: number,
): Promise<SessionCreationIdentityGraph> {
  let identity: SessionCreationIdentityGraph | undefined
  requireCreated(
    await createM32Service(sql, (created) => {
      identity = created
    }).create(currentCatalogRequest(5)),
  )
  if (identity === undefined) throw new Error('M3.2 缺少历史来源身份图。')

  if (oldVersionBase !== undefined) {
    const rows = await sql<
      {
        readonly participantId: string
        readonly seatNumber: number
        readonly configPayload: Record<string, unknown>
      }[]
    >`
      SELECT
        agent.participant_id::text AS "participantId",
        participant.seat_number::int AS "seatNumber",
        agent.config_payload AS "configPayload"
      FROM app_private.session_agents AS agent
      JOIN app_private.session_participants AS participant
        ON participant.id = agent.participant_id
      WHERE agent.session_id = ${identity.sessionId}::uuid
      ORDER BY participant.seat_number
    `
    for (const row of rows) {
      const payload = {
        ...row.configPayload,
        personaVersion: oldVersionBase + row.seatNumber,
        name: `Historical M3.2 ${row.seatNumber}`,
      } as Parameters<typeof createConfigSnapshotKey>[1]
      const configSnapshotKey = createConfigSnapshotKey(
        PERSONA_CONFIG_PAYLOAD_VERSION,
        payload,
      )
      await sql`
        UPDATE app_private.session_agents
        SET display_name = ${payload.name},
            persona_version = ${payload.personaVersion},
            config_snapshot_key = ${configSnapshotKey},
            config_payload = ${serializeJsonbFixture(payload)}::text::jsonb
        WHERE participant_id = ${row.participantId}::uuid
      `
    }
  }

  await endSession(sql, identity.sessionId, endedAt)
  return identity
}

function requireCreated(
  result: SessionCreationResult,
): Extract<SessionCreationResult, { readonly kind: 'created' }> {
  expect(result.kind).toBe('created')
  if (result.kind !== 'created') {
    throw new Error('M3.2 期望创建成功。')
  }
  return result
}

async function assertCommittedCreation(
  sql: Sql,
  identity: SessionCreationIdentityGraph,
  totalSeatCount: number,
): Promise<void> {
  const summaryRows = await sql<
    {
      readonly lifecycleStatus: string
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly currentHandId: string | null
      readonly agentRunState: string
      readonly participantCount: number
      readonly agentCount: number
      readonly memoryCount: number
      readonly handCount: number
      readonly eventCount: number
      readonly snapshotCount: number
      readonly ledgerCount: number
    }[]
  >`
    SELECT
      session.lifecycle_status AS "lifecycleStatus",
      session.state_version::int AS "stateVersion",
      session.next_event_seq::int AS "nextEventSeq",
      session.current_hand_id::text AS "currentHandId",
      session.agent_run_state AS "agentRunState",
      (SELECT count(*)::int FROM app_private.session_participants WHERE session_id = session.id) AS "participantCount",
      (SELECT count(*)::int FROM app_private.session_agents WHERE session_id = session.id) AS "agentCount",
      (SELECT count(*)::int FROM app_private.agent_memory_revisions WHERE session_id = session.id) AS "memoryCount",
      (SELECT count(*)::int FROM app_private.hands WHERE session_id = session.id) AS "handCount",
      (SELECT count(*)::int FROM app_private.session_events WHERE session_id = session.id) AS "eventCount",
      (SELECT count(*)::int FROM app_private.session_snapshots WHERE session_id = session.id) AS "snapshotCount",
      (SELECT count(*)::int FROM app_private.command_ledger WHERE session_id = session.id) AS "ledgerCount"
    FROM app_private.sessions AS session
    WHERE session.id = ${identity.sessionId}::uuid
  `
  expect(summaryRows[0]).toEqual({
    lifecycleStatus: 'active',
    stateVersion: 1,
    nextEventSeq: 2,
    currentHandId: identity.handId,
    agentRunState: 'idle',
    participantCount: totalSeatCount,
    agentCount: totalSeatCount - 1,
    memoryCount: totalSeatCount - 1,
    handCount: 1,
    eventCount: 2,
    snapshotCount: 1,
    ledgerCount: 0,
  })

  const participantRows = await sql<
    {
      readonly participantId: string
      readonly participantType: string
      readonly seatNumber: number
    }[]
  >`
    SELECT
      id::text AS "participantId",
      participant_type AS "participantType",
      seat_number AS "seatNumber"
    FROM app_private.session_participants
    WHERE session_id = ${identity.sessionId}::uuid
    ORDER BY seat_number
  `
  expect(participantRows).toEqual([
    {
      participantId: identity.userParticipantId,
      participantType: 'user',
      seatNumber: 0,
    },
    ...identity.agentParticipants.map((participant) => ({
      participantId: participant.participantId,
      participantType: 'agent',
      seatNumber: participant.seatNumber,
    })),
  ])

  const eventRows = await sql<
    {
      readonly eventSeq: number
      readonly eventType: string
      readonly handId: string | null
      readonly commandLedgerId: string | null
    }[]
  >`
    SELECT
      event_seq::int AS "eventSeq",
      private_event_payload->'event'->>'type' AS "eventType",
      hand_id::text AS "handId",
      command_ledger_id::text AS "commandLedgerId"
    FROM app_private.session_events
    WHERE session_id = ${identity.sessionId}::uuid
    ORDER BY event_seq
  `
  expect(eventRows).toEqual([
    {
      eventSeq: 0,
      eventType: 'sessionCreated',
      handId: null,
      commandLedgerId: null,
    },
    {
      eventSeq: 1,
      eventType: 'handStarted',
      handId: identity.handId,
      commandLedgerId: null,
    },
  ])

  const memoryRows = await sql<
    {
      readonly currentRevisionIsZero: boolean
      readonly currentMemoryIsEmpty: boolean
      readonly revisionIsZero: boolean
      readonly revisionMemoryIsEmpty: boolean
    }[]
  >`
    SELECT
      agent.current_memory_revision = 0 AS "currentRevisionIsZero",
      agent.memory_payload = '{}'::jsonb AS "currentMemoryIsEmpty",
      revision.revision = 0 AS "revisionIsZero",
      revision.memory_payload = '{}'::jsonb AS "revisionMemoryIsEmpty"
    FROM app_private.session_agents AS agent
    JOIN app_private.agent_memory_revisions AS revision
      ON revision.participant_id = agent.participant_id
      AND revision.session_id = agent.session_id
      AND revision.owner_id = agent.owner_id
    WHERE agent.session_id = ${identity.sessionId}::uuid
    ORDER BY agent.participant_id
  `
  expect(memoryRows).toHaveLength(totalSeatCount - 1)
  expect(
    memoryRows.every(
      (row) =>
        row.currentRevisionIsZero &&
        row.currentMemoryIsEmpty &&
        row.revisionIsZero &&
        row.revisionMemoryIsEmpty,
    ),
  ).toBe(true)

  const snapshotRows = await sql<
    { readonly payloadVersion: number; readonly payload: unknown }[]
  >`
    SELECT
      private_table_state_payload_version AS "payloadVersion",
      private_table_state_payload AS payload
    FROM app_private.session_snapshots
    WHERE session_id = ${identity.sessionId}::uuid
  `
  const snapshotRow = snapshotRows[0]
  if (snapshotRow === undefined) throw new Error('M3.2 缺少最终快照。')
  const snapshot = decodeCurrentSnapshotV1(snapshotRow).payload.state
  expect(snapshot.stateVersion).toBe(1)
  expect(snapshot.poker.pokerPhase).toBe('inHand')
  expect(snapshot.poker.hand?.handId).toBe(identity.handId)
  expect(
    snapshot.poker.seats.reduce((total, seat) => total + seat.stack, 0) +
      (snapshot.poker.hand?.pot ?? 0),
  ).toBe(totalSeatCount * 2_000)
}

async function assertSixToNinePlayerCreation(sql: Sql): Promise<void> {
  for (const aiCount of [5, 6, 7, 8]) {
    await clearLocalOwnerSessions(sql)
    let identity: SessionCreationIdentityGraph | undefined
    const result = await createM32Service(sql, (created) => {
      identity = created
    }).create(currentCatalogRequest(aiCount))
    const created = requireCreated(result)
    expect(created.response.snapshot.seats).toHaveLength(aiCount + 1)
    expect(created.newlyPersistedEvents.map((event) => event.eventSeq)).toEqual(
      [0, 1],
    )
    if (identity === undefined) throw new Error('M3.2 缺少身份图。')
    await assertCommittedCreation(sql, identity, aiCount + 1)
  }
}

async function assertSameOwnerConflict(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await clearLocalOwnerSessions(sql)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm32-same-first')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm32-same-second')
  const firstLocked = createDeferred<number>()
  const secondStarted = createDeferred<number>()
  const releaseFirst = createDeferred<void>()
  const identities: SessionCreationIdentityGraph[] = []
  let firstCreate: Promise<SessionCreationResult> | undefined
  let secondCreate: Promise<SessionCreationResult> | undefined
  try {
    const firstBase = createSessionCreationRepository()
    const firstRepository: SessionCreationRepository = Object.freeze({
      ...firstBase,
      async lockOwnerForSessionCreation(
        transaction: LockOwnerParameters[0],
        owner: LockOwnerParameters[1],
      ) {
        const locked = await firstBase.lockOwnerForSessionCreation(
          transaction,
          owner,
        )
        firstLocked.resolve(await readTransactionBackendPid(transaction))
        await releaseFirst.promise
        return locked
      },
    })
    const secondBase = createSessionCreationRepository()
    const secondRepository: SessionCreationRepository = Object.freeze({
      ...secondBase,
      async lockOwnerForSessionCreation(
        transaction: LockOwnerParameters[0],
        owner: LockOwnerParameters[1],
      ) {
        secondStarted.resolve(await readTransactionBackendPid(transaction))
        return secondBase.lockOwnerForSessionCreation(transaction, owner)
      },
    })
    firstCreate = createM32Service(
      firstSql,
      (identity) => identities.push(identity),
      { creationRepository: firstRepository },
    ).create(currentCatalogRequest(5))
    const firstPid = await firstLocked.promise
    secondCreate = createM32Service(
      secondSql,
      (identity) => identities.push(identity),
      { creationRepository: secondRepository },
    ).create(currentCatalogRequest(5))
    await waitForTransactionBlock(sql, firstPid, await secondStarted.promise)
    releaseFirst.resolve()

    const results = await Promise.all([firstCreate, secondCreate])
    const created = results.find((result) => result.kind === 'created')
    const conflict = results.find(
      (result) => result.kind === 'activeSessionExists',
    )
    expect(created?.kind).toBe('created')
    expect(conflict?.kind).toBe('activeSessionExists')
    if (
      created?.kind !== 'created' ||
      conflict?.kind !== 'activeSessionExists'
    ) {
      throw new Error('M3.2 same-owner 竞争未稳定收敛。')
    }
    expect(conflict.response.latestSnapshot).toEqual(created.response.snapshot)
    const counts = await sql<
      { readonly sessionCount: number; readonly handCount: number }[]
    >`
      SELECT
        count(DISTINCT session.id)::int AS "sessionCount",
        count(hand.id)::int AS "handCount"
      FROM app_private.sessions AS session
      LEFT JOIN app_private.hands AS hand ON hand.session_id = session.id
      WHERE session.owner_id = (
        SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
      )
        AND session.lifecycle_status = 'active'
    `
    expect(counts[0]).toEqual({ sessionCount: 1, handCount: 1 })
    expect(identities).toHaveLength(2)
  } finally {
    releaseFirst.resolve()
    await Promise.allSettled(
      [firstCreate, secondCreate].filter(
        (value): value is Promise<SessionCreationResult> => value !== undefined,
      ),
    )
    await firstSql.end({ timeout: 0 })
    await secondSql.end({ timeout: 0 })
  }
}

async function assertDifferentOwnersEnterInParallel(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await clearLocalOwnerSessions(sql)
  const originalOwner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const originalTemporaryIdentity = `m32-owner-one-${randomUUID()}`
  const secondOwnerId = randomUUID()
  const secondTemporaryIdentity = `m32-owner-two-${randomUUID()}`
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm32-owner-one')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm32-owner-two')
  const firstEntered = createDeferred<number>()
  const secondEntered = createDeferred<number>()
  const release = createDeferred<void>()
  let firstWork: Promise<void> | undefined
  let secondWork: Promise<void> | undefined
  try {
    await sql`
      UPDATE app_private.owners
      SET identity_key = ${originalTemporaryIdentity}
      WHERE id = ${originalOwner.databaseOwnerId}::uuid
    `
    await sql`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${secondOwnerId}::uuid, 'local-user')
    `
    const secondOwner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    await sql`
      UPDATE app_private.owners
      SET identity_key = ${secondTemporaryIdentity}
      WHERE id = ${secondOwner.databaseOwnerId}::uuid
    `
    await sql`
      UPDATE app_private.owners
      SET identity_key = 'local-user'
      WHERE id = ${originalOwner.databaseOwnerId}::uuid
    `

    const runCreationGate = (
      connection: Sql,
      owner: typeof originalOwner,
      entered: ReturnType<typeof createDeferred<number>>,
    ) =>
      connection.begin(async (transaction) => {
        const repository = createSessionCreationRepository()
        const locked = await repository.lockOwnerForSessionCreation(
          transaction,
          owner,
        )
        await expect(
          repository.checkActiveSessionForCreation(transaction, locked),
        ).resolves.toEqual({ kind: 'noActiveSession' })
        entered.resolve(await readTransactionBackendPid(transaction))
        await release.promise
      })

    firstWork = runCreationGate(firstSql, originalOwner, firstEntered)
    secondWork = runCreationGate(secondSql, secondOwner, secondEntered)
    const [firstPid, secondPid] = await Promise.all([
      firstEntered.promise,
      secondEntered.promise,
    ])
    const blockingRows = await sql<
      {
        readonly firstBlockedBy: number[]
        readonly secondBlockedBy: number[]
      }[]
    >`
      SELECT
        pg_blocking_pids(${firstPid}::int) AS "firstBlockedBy",
        pg_blocking_pids(${secondPid}::int) AS "secondBlockedBy"
    `
    expect(blockingRows[0]).toEqual({
      firstBlockedBy: [],
      secondBlockedBy: [],
    })
    release.resolve()
    await Promise.all([firstWork, secondWork])
  } finally {
    release.resolve()
    await Promise.allSettled(
      [firstWork, secondWork].filter(
        (value): value is Promise<void> => value !== undefined,
      ),
    )
    await firstSql.end({ timeout: 0 })
    await secondSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.owners
      WHERE id = ${secondOwnerId}::uuid
    `
    await sql`
      UPDATE app_private.owners
      SET identity_key = 'local-user'
      WHERE id = ${originalOwner.databaseOwnerId}::uuid
    `
  }
}

async function assertRollbackOnMutationFailures(sql: Sql): Promise<void> {
  const failureRepositories: readonly SessionMutationRepository[] = [
    Object.freeze({
      currentPrivateEventProtocol:
        productionSessionMutationRepository.currentPrivateEventProtocol,
      lockSessionForMutation:
        productionSessionMutationRepository.lockSessionForMutation,
      validateSessionMutation:
        productionSessionMutationRepository.validateSessionMutation,
      async persistSessionMutation(
        transaction: PersistMutationParameters[0],
        locked: PersistMutationParameters[1],
      ) {
        await transaction`
          INSERT INTO app_private.session_snapshots (
            session_id,
            owner_id,
            private_table_state_payload_version,
            private_table_state_payload,
            updated_at
          )
          SELECT
            id,
            owner_id,
            NULL,
            '{}'::jsonb,
            ${CREATED_AT}::timestamptz
          FROM app_private.sessions
          WHERE id = ${locked.sessionId}::uuid
        `
        throw new Error('M3.2 snapshot failure did not fail')
      },
    }),
    Object.freeze({
      currentPrivateEventProtocol:
        productionSessionMutationRepository.currentPrivateEventProtocol,
      lockSessionForMutation:
        productionSessionMutationRepository.lockSessionForMutation,
      validateSessionMutation:
        productionSessionMutationRepository.validateSessionMutation,
      async persistSessionMutation(
        transaction: PersistMutationParameters[0],
        locked: PersistMutationParameters[1],
        batch: PersistMutationParameters[2],
      ) {
        const firstEvent = batch.events[0]
        if (firstEvent === undefined) {
          throw new Error('M3.2 缺少第一条事件。')
        }
        const firstEventBatch: SessionMutationBatch = Object.freeze({
          ...batch,
          events: Object.freeze([firstEvent]),
        })
        await productionSessionMutationRepository.persistSessionMutation(
          transaction,
          locked,
          firstEventBatch,
        )
        await transaction`
          INSERT INTO app_private.session_events
          SELECT *
          FROM app_private.session_events
          WHERE id = ${firstEvent.eventId}::uuid
        `
        throw new Error('M3.2 second event failure did not fail')
      },
    }),
  ]

  for (const mutationRepository of failureRepositories) {
    await clearLocalOwnerSessions(sql)
    let identity: SessionCreationIdentityGraph | undefined
    const service = createM32Service(
      sql,
      (created) => {
        identity = created
      },
      { mutationRepository },
    )
    await expect(service.create(currentCatalogRequest(5))).rejects.toThrow()
    if (identity === undefined) throw new Error('M3.2 缺少失败身份图。')
    await assertCreationRowsRolledBack(sql, identity)
  }

  await clearLocalOwnerSessions(sql)
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const identity = createSessionCreationIdentityGraph([1, 2, 3, 4, 5])
  const catalog = loadAndValidatePersonaCatalog()
  const prepared = prepareCurrentCatalogRoster(catalog, {
    sessionId: identity.sessionId,
    userParticipantId: identity.userParticipantId,
    agents: identity.agentParticipants.map((participant) => ({
      seatNumber: participant.seatNumber,
      agentParticipantId: participant.participantId,
      personaId: catalog.list()[participant.seatNumber - 1]!.personaId,
    })),
  })
  await expect(
    sql.begin(async (transaction) => {
      const repository = createSessionCreationRepository()
      const lockedOwner = await repository.lockOwnerForSessionCreation(
        transaction,
        owner,
      )
      await expect(
        repository.checkActiveSessionForCreation(transaction, lockedOwner),
      ).resolves.toEqual({ kind: 'noActiveSession' })
      const roster = await repository.acceptCurrentCatalogRosterForCreation(
        transaction,
        lockedOwner,
        prepared,
      )
      await repository.insertLockedSessionRoster(transaction, roster)
      throw new Error('injected after roster repository return')
    }),
  ).rejects.toThrow('injected after roster repository return')
  await assertCreationRowsRolledBack(sql, identity)
}

async function assertLatestEndedReuse(sql: Sql): Promise<void> {
  await clearLocalOwnerSessions(sql)
  const sourceIdentity = await createEndedSource(
    sql,
    '2026-08-09T12:01:00.000Z',
    700,
  )
  let reusedIdentity: SessionCreationIdentityGraph | undefined
  const reused = requireCreated(
    await createM32Service(sql, (identity) => {
      reusedIdentity = identity
    }).create({
      rosterSource: { type: 'latestEnded' },
    }),
  )
  if (reusedIdentity === undefined) {
    throw new Error('M3.2 latest-ended 缺少身份图。')
  }
  const rows = await sql<
    {
      readonly sourceKeys: string[]
      readonly reusedKeys: string[]
      readonly sourceVersions: number[]
      readonly reusedVersions: number[]
      readonly reusedMemoryRevisions: number[]
    }[]
  >`
    SELECT
      ARRAY(
        SELECT config_snapshot_key
        FROM app_private.session_agents
        WHERE session_id = ${sourceIdentity.sessionId}::uuid
        ORDER BY persona_id
      ) AS "sourceKeys",
      ARRAY(
        SELECT config_snapshot_key
        FROM app_private.session_agents
        WHERE session_id = ${reusedIdentity.sessionId}::uuid
        ORDER BY persona_id
      ) AS "reusedKeys",
      ARRAY(
        SELECT persona_version::int
        FROM app_private.session_agents
        WHERE session_id = ${sourceIdentity.sessionId}::uuid
        ORDER BY persona_id
      ) AS "sourceVersions",
      ARRAY(
        SELECT persona_version::int
        FROM app_private.session_agents
        WHERE session_id = ${reusedIdentity.sessionId}::uuid
        ORDER BY persona_id
      ) AS "reusedVersions",
      ARRAY(
        SELECT current_memory_revision::int
        FROM app_private.session_agents
        WHERE session_id = ${reusedIdentity.sessionId}::uuid
        ORDER BY persona_id
      ) AS "reusedMemoryRevisions"
  `
  expect(rows[0]?.reusedKeys).toEqual(rows[0]?.sourceKeys)
  expect(rows[0]?.reusedVersions).toEqual(rows[0]?.sourceVersions)
  expect(rows[0]?.sourceVersions.every((version) => version >= 701)).toBe(true)
  expect(rows[0]?.reusedMemoryRevisions).toEqual([0, 0, 0, 0, 0])
  expect(reused.response.snapshot.pokerPhase).toBe('inHand')
}

async function assertCurrentCatalogClearContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })

  await clearLocalOwnerSessions(sql)
  const clearFirstSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-current-clear-first',
  )
  const waitingCreateSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-current-create-wait',
  )
  const clearHeld = createDeferred<number>()
  const createStarted = createDeferred<number>()
  const releaseClear = createDeferred<void>()
  let clearWork: Promise<unknown> | undefined
  let createWork: Promise<SessionCreationResult> | undefined
  try {
    clearWork = clearFirstSql.begin(async (transaction) => {
      const pid = await readTransactionBackendPid(transaction)
      await clearOwnerSessionData(transaction, owner, {
        deletedAt: '2026-08-09T13:00:00.000Z',
      })
      clearHeld.resolve(pid)
      await releaseClear.promise
    })
    const clearPid = await clearHeld.promise
    const base = createSessionCreationRepository()
    const waitingRepository: SessionCreationRepository = Object.freeze({
      ...base,
      async lockOwnerForSessionCreation(
        transaction: LockOwnerParameters[0],
        lockedOwner: LockOwnerParameters[1],
      ) {
        createStarted.resolve(await readTransactionBackendPid(transaction))
        return base.lockOwnerForSessionCreation(transaction, lockedOwner)
      },
    })
    createWork = createM32Service(waitingCreateSql, () => undefined, {
      creationRepository: waitingRepository,
    }).create(currentCatalogRequest(5))
    await waitForTransactionBlock(sql, clearPid, await createStarted.promise)
    releaseClear.resolve()
    await clearWork
    requireCreated(await createWork)
  } finally {
    releaseClear.resolve()
    await Promise.allSettled(
      [clearWork, createWork].filter(
        (value): value is Promise<unknown> => value !== undefined,
      ),
    )
    await clearFirstSql.end({ timeout: 0 })
    await waitingCreateSql.end({ timeout: 0 })
  }

  await clearLocalOwnerSessions(sql)
  const creatingSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-current-create-first',
  )
  const waitingClearSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-current-clear-wait',
  )
  const createHeld = createDeferred<number>()
  const clearStarted = createDeferred<number>()
  const releaseCreate = createDeferred<void>()
  createWork = undefined
  clearWork = undefined
  try {
    const base = createSessionCreationRepository()
    const holdingRepository: SessionCreationRepository = Object.freeze({
      ...base,
      async lockOwnerForSessionCreation(
        transaction: LockOwnerParameters[0],
        lockedOwner: LockOwnerParameters[1],
      ) {
        const locked = await base.lockOwnerForSessionCreation(
          transaction,
          lockedOwner,
        )
        createHeld.resolve(await readTransactionBackendPid(transaction))
        await releaseCreate.promise
        return locked
      },
    })
    createWork = createM32Service(creatingSql, () => undefined, {
      creationRepository: holdingRepository,
    }).create(currentCatalogRequest(5))
    const createPid = await createHeld.promise
    clearWork = waitingClearSql.begin(async (transaction) => {
      clearStarted.resolve(await readTransactionBackendPid(transaction))
      return clearOwnerSessionData(transaction, owner, {
        deletedAt: '2026-08-09T13:01:00.000Z',
      })
    })
    await waitForTransactionBlock(sql, createPid, await clearStarted.promise)
    releaseCreate.resolve()
    requireCreated(await createWork)
    await clearWork
    const rows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
    `
    expect(rows[0]?.count).toBe(0)
  } finally {
    releaseCreate.resolve()
    await Promise.allSettled(
      [clearWork, createWork].filter(
        (value): value is Promise<unknown> => value !== undefined,
      ),
    )
    await creatingSql.end({ timeout: 0 })
    await waitingClearSql.end({ timeout: 0 })
  }
}

async function assertLatestEndedClearContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })

  await clearLocalOwnerSessions(sql)
  await createEndedSource(sql, '2026-08-09T13:10:00.000Z', 810)
  const clearFirstSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-latest-clear-first',
  )
  const waitingCreateSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-latest-create-wait',
  )
  const clearHeld = createDeferred<number>()
  const createStarted = createDeferred<number>()
  const releaseClear = createDeferred<void>()
  let clearWork: Promise<unknown> | undefined
  let createWork: Promise<SessionCreationResult> | undefined
  try {
    clearWork = clearFirstSql.begin(async (transaction) => {
      const pid = await readTransactionBackendPid(transaction)
      await clearOwnerSessionData(transaction, owner, {
        deletedAt: '2026-08-09T13:11:00.000Z',
      })
      clearHeld.resolve(pid)
      await releaseClear.promise
    })
    const clearPid = await clearHeld.promise
    const base = createSessionCreationRepository()
    const waitingRepository: SessionCreationRepository = Object.freeze({
      ...base,
      async lockOwnerForSessionCreation(
        transaction: LockOwnerParameters[0],
        lockedOwner: LockOwnerParameters[1],
      ) {
        createStarted.resolve(await readTransactionBackendPid(transaction))
        return base.lockOwnerForSessionCreation(transaction, lockedOwner)
      },
    })
    createWork = createM32Service(waitingCreateSql, () => undefined, {
      creationRepository: waitingRepository,
    }).create({
      rosterSource: { type: 'latestEnded' },
    })
    await waitForTransactionBlock(sql, clearPid, await createStarted.promise)
    releaseClear.resolve()
    await clearWork
    await expect(createWork).rejects.toBeInstanceOf(
      RosterSourceChangedServiceError,
    )
  } finally {
    releaseClear.resolve()
    await Promise.allSettled(
      [clearWork, createWork].filter(
        (value): value is Promise<unknown> => value !== undefined,
      ),
    )
    await clearFirstSql.end({ timeout: 0 })
    await waitingCreateSql.end({ timeout: 0 })
  }

  await clearLocalOwnerSessions(sql)
  await createEndedSource(sql, '2026-08-09T13:20:00.000Z', 820)
  const creatingSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-latest-create-first',
  )
  const waitingClearSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-latest-clear-wait',
  )
  const sourceHeld = createDeferred<number>()
  const clearStarted = createDeferred<number>()
  const releaseCreate = createDeferred<void>()
  clearWork = undefined
  createWork = undefined
  try {
    const base = createSessionCreationRepository()
    const holdingRepository: SessionCreationRepository = Object.freeze({
      ...base,
      async lockLatestEndedRosterForCreation(
        transaction: LockLatestRosterParameters[0],
        lockedOwner: LockLatestRosterParameters[1],
        preflight: LockLatestRosterParameters[2],
        identity: LockLatestRosterParameters[3],
      ) {
        const roster = await base.lockLatestEndedRosterForCreation(
          transaction,
          lockedOwner,
          preflight,
          identity,
        )
        sourceHeld.resolve(await readTransactionBackendPid(transaction))
        await releaseCreate.promise
        return roster
      },
    })
    createWork = createM32Service(creatingSql, () => undefined, {
      creationRepository: holdingRepository,
    }).create({
      rosterSource: { type: 'latestEnded' },
    })
    const createPid = await sourceHeld.promise
    clearWork = waitingClearSql.begin(async (transaction) => {
      clearStarted.resolve(await readTransactionBackendPid(transaction))
      return clearOwnerSessionData(transaction, owner, {
        deletedAt: '2026-08-09T13:21:00.000Z',
      })
    })
    await waitForTransactionBlock(sql, createPid, await clearStarted.promise)
    releaseCreate.resolve()
    requireCreated(await createWork)
    await clearWork
    const rows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
    `
    expect(rows[0]?.count).toBe(0)
  } finally {
    releaseCreate.resolve()
    await Promise.allSettled(
      [clearWork, createWork].filter(
        (value): value is Promise<unknown> => value !== undefined,
      ),
    )
    await creatingSql.end({ timeout: 0 })
    await waitingClearSql.end({ timeout: 0 })
  }
}

async function assertPreflightClearDoesNotReviveHistory(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await clearLocalOwnerSessions(sql)
  await createEndedSource(sql, '2026-08-09T13:30:00.000Z', 830)
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const creationSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-preflight-clear',
  )
  const preflightComplete = createDeferred<void>()
  const releaseTransaction = createDeferred<void>()
  let identity: SessionCreationIdentityGraph | undefined
  let createWork: Promise<SessionCreationResult> | undefined
  try {
    createWork = createM32Service(
      pauseBeforeTransaction(
        creationSql,
        preflightComplete,
        releaseTransaction,
      ),
      (created) => {
        identity = created
      },
    ).create({
      rosterSource: { type: 'latestEnded' },
    })
    await preflightComplete.promise
    await sql.begin((transaction) =>
      clearOwnerSessionData(transaction, owner, {
        deletedAt: '2026-08-09T13:31:00.000Z',
      }),
    )
    releaseTransaction.resolve()
    await expect(createWork).rejects.toBeInstanceOf(
      RosterSourceChangedServiceError,
    )
    if (identity === undefined) {
      throw new Error('M3.2 stale preflight 缺少创建身份图。')
    }
    await assertCreationRowsRolledBack(sql, identity)
  } finally {
    releaseTransaction.resolve()
    await Promise.allSettled(createWork === undefined ? [] : [createWork])
    await creationSql.end({ timeout: 0 })
  }
}

async function assertDeletedLatestDoesNotFallback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await clearLocalOwnerSessions(sql)
  const older = await createEndedSource(sql, '2026-08-09T13:40:00.000Z', 840)
  const latest = await createEndedSource(sql, '2026-08-09T13:41:00.000Z', 850)
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const deletionSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-delete-latest',
  )
  const creationSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm32-delete-latest-wait',
  )
  const deletionHeld = createDeferred<number>()
  const creationStarted = createDeferred<number>()
  const releaseDeletion = createDeferred<void>()
  let deleteWork: Promise<unknown> | undefined
  let createWork: Promise<SessionCreationResult> | undefined
  try {
    deleteWork = deletionSql.begin(async (transaction) => {
      const pid = await readTransactionBackendPid(transaction)
      await deleteEndedSessionData(transaction, owner, {
        sessionId: latest.sessionId,
        deletedAt: '2026-08-09T13:42:00.000Z',
      })
      deletionHeld.resolve(pid)
      await releaseDeletion.promise
    })
    const deletionPid = await deletionHeld.promise
    const base = createSessionCreationRepository()
    const waitingRepository: SessionCreationRepository = Object.freeze({
      ...base,
      async lockLatestEndedRosterForCreation(
        transaction: LockLatestRosterParameters[0],
        lockedOwner: LockLatestRosterParameters[1],
        preflight: LockLatestRosterParameters[2],
        identity: LockLatestRosterParameters[3],
      ) {
        creationStarted.resolve(await readTransactionBackendPid(transaction))
        return base.lockLatestEndedRosterForCreation(
          transaction,
          lockedOwner,
          preflight,
          identity,
        )
      },
    })
    createWork = createM32Service(creationSql, () => undefined, {
      creationRepository: waitingRepository,
    }).create({
      rosterSource: { type: 'latestEnded' },
    })
    await waitForTransactionBlock(
      sql,
      deletionPid,
      await creationStarted.promise,
    )
    releaseDeletion.resolve()
    await deleteWork
    await expect(createWork).rejects.toBeInstanceOf(
      RosterSourceChangedServiceError,
    )
    const rows = await sql<
      {
        readonly olderCount: number
        readonly latestCount: number
        readonly activeCount: number
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${older.sessionId}::uuid) AS "olderCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${latest.sessionId}::uuid) AS "latestCount",
        (
          SELECT count(*)::int
          FROM app_private.sessions
          WHERE owner_id = ${owner.databaseOwnerId}::uuid
            AND lifecycle_status = 'active'
        ) AS "activeCount"
    `
    expect(rows[0]).toEqual({
      olderCount: 1,
      latestCount: 0,
      activeCount: 0,
    })
  } finally {
    releaseDeletion.resolve()
    await Promise.allSettled(
      [deleteWork, createWork].filter(
        (value): value is Promise<unknown> => value !== undefined,
      ),
    )
    await deletionSql.end({ timeout: 0 })
    await creationSql.end({ timeout: 0 })
  }
}

export async function assertM32SessionCreation(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  try {
    await assertSixToNinePlayerCreation(sql)
    await assertLatestEndedReuse(sql)
    await assertRollbackOnMutationFailures(sql)
    await assertSameOwnerConflict(sql, runtimeUrl)
    await assertDifferentOwnersEnterInParallel(sql, runtimeUrl)
    await assertCurrentCatalogClearContention(sql, runtimeUrl)
    await assertLatestEndedClearContention(sql, runtimeUrl)
    await assertPreflightClearDoesNotReviveHistory(sql, runtimeUrl)
    await assertDeletedLatestDoesNotFallback(sql, runtimeUrl)
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
