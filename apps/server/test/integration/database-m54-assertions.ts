import { randomUUID } from 'node:crypto'
import type {
  HandStatisticsQuery,
  SessionStatisticsQuery,
} from '@tx-holdem-coach/contracts'
import type { JSONValue, Sql } from 'postgres'
import { expect } from 'vitest'
import { initializePokerTable } from '../../src/poker/poker-engine.js'
import { createStatisticsFactsRepository } from '../../src/persistence/statistics-facts-repository.js'
import { UnknownPayloadVersionError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createStatisticsQueryService } from '../../src/sessions/statistics/statistics-query-service.js'
import { insertTerminalEvents } from './database-m51-assertions.js'
import { insertCommittedM27CompletedHand } from './database-repository-assertions.js'
import {
  createDatabaseTestSqlForRole,
  runDatabaseTestWithCleanup,
} from './database-test-runtime.js'

const randomSource = Object.freeze({ nextInt: () => 0 })

function handQuery(
  overrides: Partial<HandStatisticsQuery> = {},
): HandStatisticsQuery {
  return {
    scope: 'hands',
    subject: 'user',
    from: null,
    to: null,
    sessionId: null,
    personaId: null,
    personaVersion: null,
    personaName: null,
    configSnapshotKey: null,
    position: null,
    groupBy: 'none',
    ...overrides,
  }
}

function sessionQuery(
  overrides: Partial<SessionStatisticsQuery> = {},
): SessionStatisticsQuery {
  return {
    scope: 'sessions',
    subject: 'user',
    from: null,
    to: null,
    sessionId: null,
    personaId: null,
    personaVersion: null,
    personaName: null,
    configSnapshotKey: null,
    groupBy: 'none',
    ...overrides,
  }
}

function createPlayerIds(): readonly string[] {
  return Array.from({ length: 6 }, () => randomUUID())
}

function createBetweenHandsState(playerIds: readonly string[]) {
  const seats = playerIds.map((playerId, seatNumber) => ({
    seatNumber,
    playerId,
    isUser: seatNumber === 0,
    stack: 1_000,
    status: 'active' as const,
    streetContribution: 0,
    totalContribution: 0,
  }))
  const poker = initializePokerTable(seats, randomSource)
  return createPrivateTableState({
    stateVersion: 0,
    poker,
    completedHandCount: 0,
    seatAccounting: seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: seat.stack,
    })),
    lastCompletedHandSummary: null,
  })
}

async function seedCompletedStatisticsSession(
  sql: Sql,
  startedAt: string,
  endedAt: string,
): Promise<{
  readonly sessionId: string
  readonly handId: string
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
}> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const playerIds = createPlayerIds()
  const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId, {
    playerIds,
  })
  await insertTerminalEvents(sql, {
    sessionId,
    handId,
    databaseOwnerId: owner.databaseOwnerId,
    playerIds,
  })
  const snapshot = encodeSnapshot(createBetweenHandsState(playerIds))
  await sql`
    INSERT INTO app_private.session_snapshots (
      session_id,
      owner_id,
      private_table_state_payload_version,
      private_table_state_payload
    ) VALUES (
      ${sessionId}::uuid,
      ${owner.databaseOwnerId}::uuid,
      ${snapshot.payloadVersion},
      ${sql.json(snapshot.payload as unknown as JSONValue)}
    )
  `
  await sql`
    UPDATE app_private.hands
    SET started_at = ${startedAt}::timestamptz,
        completed_at = ${startedAt}::timestamptz + interval '1 minute'
    WHERE id = ${handId}::uuid
  `
  await sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'ended',
        ended_at = ${endedAt}::timestamptz
    WHERE id = ${sessionId}::uuid
  `
  return { sessionId, handId, owner }
}

async function readFirstPersona(sql: Sql, sessionId: string) {
  const rows = await sql<
    {
      readonly personaId: string
      readonly personaVersion: number
      readonly personaName: string
      readonly configSnapshotKey: string
    }[]
  >`
    SELECT
      persona_id AS "personaId",
      persona_version::int AS "personaVersion",
      display_name AS "personaName",
      config_snapshot_key AS "configSnapshotKey"
    FROM app_private.session_agents
    WHERE session_id = ${sessionId}::uuid
    ORDER BY participant_id
    LIMIT 1
  `
  const persona = rows[0]
  if (persona === undefined || rows.length !== 1) {
    throw new Error('M5.4 fixture 缺少历史人物快照。')
  }
  return persona
}

/**
 * 真实 PostgreSQL Reader：用 M2.7 完成 Hand writer 与 current Codec 事实
 * 构造跨批数据，验证 SQL owner/人物筛选、只读快照和 payload 错误分类。
 */
export async function assertM54FixedStatistics(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      const first = await seedCompletedStatisticsSession(
        sql,
        '2026-09-06T09:00:00.000000Z',
        '2026-09-06T10:00:00.000000Z',
      )
      const second = await seedCompletedStatisticsSession(
        sql,
        '2026-09-06T11:00:00.000000Z',
        '2026-09-06T12:00:00.000000Z',
      )
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      expect(owner.databaseOwnerId).toBe(first.owner.databaseOwnerId)
      expect(owner.databaseOwnerId).toBe(second.owner.databaseOwnerId)

      const reader = createStatisticsFactsRepository({
        sql,
        owner,
        batchSize: 1,
      })
      const statistics = createStatisticsQueryService({ reader })
      const userHands = await statistics.read(
        handQuery({ groupBy: 'position' }),
      )
      expect(userHands).toMatchObject({
        scope: 'hands',
        totals: { handCount: 2, distinctHandCount: 2 },
      })
      if (userHands.scope !== 'hands') {
        throw new Error('M5.4 hands 查询返回了错误 scope。')
      }
      expect(userHands.byPosition).toHaveLength(9)
      expect(
        userHands.byPosition.reduce(
          (total, bucket) => total + bucket.metrics.handCount,
          0,
        ),
      ).toBe(userHands.totals.handCount)
      await expect(
        statistics.read(
          handQuery({
            from: '2026-09-06T09:00:00.000000Z',
            to: '2026-09-06T11:00:00.000000Z',
          }),
        ),
      ).resolves.toMatchObject({
        scope: 'hands',
        totals: { handCount: 1, distinctHandCount: 1 },
      })

      const persona = await readFirstPersona(sql, first.sessionId)
      await expect(
        statistics.read(
          handQuery({
            subject: 'ai',
            sessionId: first.sessionId,
            ...persona,
          }),
        ),
      ).resolves.toMatchObject({
        scope: 'hands',
        totals: { handCount: 1, distinctHandCount: 1 },
      })
      await expect(
        statistics.read(handQuery({ sessionId: first.sessionId, ...persona })),
      ).resolves.toMatchObject({
        scope: 'hands',
        totals: { handCount: 1, distinctHandCount: 1 },
      })
      await expect(
        statistics.read(handQuery({ sessionId: randomUUID() })),
      ).resolves.toMatchObject({
        scope: 'hands',
        totals: { handCount: 0, distinctHandCount: 0 },
      })
      await expect(statistics.read(sessionQuery())).resolves.toMatchObject({
        scope: 'sessions',
        totals: {
          sessionCount: 2,
          participantSessionCount: 2,
          finalChips: 2_000,
          cumulativeBuyIn: 2_000,
          sessionNetChange: 0,
        },
      })

      let releaseScan!: () => void
      const scanReleased = new Promise<void>((resolve) => {
        releaseScan = resolve
      })
      let firstBatchSeen!: () => void
      const firstBatchSeenPromise = new Promise<void>((resolve) => {
        firstBatchSeen = resolve
      })
      const scannedHandIds: string[] = []
      const scan = reader.scanHandFacts(handQuery(), async (fact) => {
        scannedHandIds.push(fact.history.handId)
        if (scannedHandIds.length === 1) {
          firstBatchSeen()
          await scanReleased
        }
      })
      await firstBatchSeenPromise
      const writer = createDatabaseTestSqlForRole(runtimeUrl, 'm54-writer')
      try {
        await seedCompletedStatisticsSession(
          writer,
          '2026-09-06T13:00:00.000000Z',
          '2026-09-06T14:00:00.000000Z',
        )
      } finally {
        await writer.end({ timeout: 0 })
      }
      releaseScan()
      await scan
      expect(scannedHandIds).toHaveLength(2)
      await expect(statistics.read(handQuery())).resolves.toMatchObject({
        scope: 'hands',
        totals: { handCount: 3, distinctHandCount: 3 },
      })

      await sql`
        UPDATE app_private.hands
        SET completed_result_payload_version = 999
        WHERE id = ${first.handId}::uuid
      `
      await expect(statistics.read(handQuery())).rejects.toBeInstanceOf(
        UnknownPayloadVersionError,
      )
      await sql`
        UPDATE app_private.hands
        SET completed_result_payload_version = 1
        WHERE id = ${first.handId}::uuid
      `
    },
    async () => {
      await sql`
        DELETE FROM app_private.sessions
        WHERE owner_id = (
          SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
        )
      `
    },
  )
}
