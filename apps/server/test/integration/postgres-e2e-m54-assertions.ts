import { randomUUID } from 'node:crypto'
import type { StatisticsResponse } from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createApiRuntime } from '../../src/bootstrap.js'
import { ServerConfig } from '../../src/config.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { createApp } from '../../src/http/create-app.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  createM33Executor,
  createSessionFixture,
  prepareTerminalUserTurn,
  readPrivateState,
} from './database-m33-assertions.js'
import { clearLocalOwnerSessions } from './database-m32-assertions.js'
import { createM34Executor } from './database-m34-assertions.js'
import { runDatabaseTestWithCleanup } from './database-test-runtime.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'

function asDatabaseClient(sql: Sql): DatabaseClient {
  return { sql, db: {} as DatabaseClient['db'], close: async () => undefined }
}

async function readStatistics(
  app: ReturnType<typeof createApp>,
  query: string,
): Promise<StatisticsResponse> {
  const response = await app.request(`${BASE_URL}/api/statistics${query}`)
  expect(response.status).toBe(200)
  return (await response.json()) as StatisticsResponse
}

/** 正式组合链：完成 Hand → hands 统计 → 补码/结束 → sessions 统计 → 删除归零。 */
export async function assertM54FixedStatisticsApplicationFlow(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const identity = await createSessionFixture(sql, 3)
      const runtime = await createApiRuntime(
        new ServerConfig({
          port: 8787,
          databaseUrl: runtimeUrl,
          deepSeekApiKey: 'm54-deterministic-provider-key',
        }),
        loadAndValidatePersonaCatalog(),
        asDatabaseClient(sql),
        { randomSource: { nextInt: () => 0 } },
      )
      const app = createApp(runtime, {
        port: 8787,
        allowedOrigins: new Set([ORIGIN]),
      })

      const beforeCompletion = await readPrivateState(sql, identity.sessionId)
      const emptyBeforeCompletion = await readStatistics(
        app,
        `?scope=hands&sessionId=${identity.sessionId}&groupBy=position`,
      )
      expect(emptyBeforeCompletion).toMatchObject({
        scope: 'hands',
        totals: { handCount: 0, distinctHandCount: 0 },
      })

      await prepareTerminalUserTurn(sql, owner, identity)
      const beforeAction = await readPrivateState(sql, identity.sessionId)
      await createM33Executor({ sql, owner }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: beforeAction.stateVersion,
        type: 'playerAction',
        payload: { action: { type: 'fold' } },
      })
      const afterCompletion = await readPrivateState(sql, identity.sessionId)
      const userHands = await readStatistics(
        app,
        `?scope=hands&subject=user&sessionId=${identity.sessionId}&groupBy=position`,
      )
      const aiHands = await readStatistics(
        app,
        `?scope=hands&subject=ai&sessionId=${identity.sessionId}`,
      )
      expect(userHands).toMatchObject({
        scope: 'hands',
        totals: { handCount: 1, distinctHandCount: 1 },
      })
      expect(aiHands).toMatchObject({
        scope: 'hands',
        totals: { handCount: 5, distinctHandCount: 1 },
      })
      if (userHands.scope !== 'hands') {
        throw new Error('M5.4 HTTP hands 响应 scope 错误。')
      }
      expect(userHands.byPosition).toHaveLength(9)
      expect(await readPrivateState(sql, identity.sessionId)).toEqual(
        afterCompletion,
      )

      const userSeat = afterCompletion.poker.seats.find(
        (seat) => seat.seatNumber === 0,
      )
      const rebuyAmount = 2_000 - (userSeat?.stack ?? 2_000)
      expect(rebuyAmount).toBeGreaterThan(0)
      await createM34Executor({
        sql,
        owner,
        nextHandId: randomUUID(),
        commandAt: '2026-09-06T12:04:00.000Z',
      }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: afterCompletion.stateVersion,
        type: 'rebuy',
        payload: { amount: rebuyAmount },
      })
      const beforeEnd = await readPrivateState(sql, identity.sessionId)
      await createM34Executor({
        sql,
        owner,
        nextHandId: randomUUID(),
        commandAt: '2026-09-06T12:05:00.000Z',
      }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: beforeEnd.stateVersion,
        type: 'endSession',
        payload: {},
      })
      const sessions = await readStatistics(
        app,
        `?scope=sessions&subject=user&sessionId=${identity.sessionId}`,
      )
      expect(sessions).toMatchObject({
        scope: 'sessions',
        totals: { sessionCount: 1, participantSessionCount: 1 },
      })
      if (sessions.scope !== 'sessions') {
        throw new Error('M5.4 HTTP sessions 响应 scope 错误。')
      }
      expect(sessions.totals.sessionNetChange).toBe(
        sessions.totals.finalChips - sessions.totals.cumulativeBuyIn,
      )

      const deleted = await app.request(
        `${BASE_URL}/api/sessions/${identity.sessionId}`,
        {
          method: 'DELETE',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: '永久删除本场' }),
        },
      )
      expect(deleted.status).toBe(200)
      const emptyHands = await readStatistics(
        app,
        `?scope=hands&sessionId=${identity.sessionId}`,
      )
      const emptySessions = await readStatistics(
        app,
        `?scope=sessions&sessionId=${identity.sessionId}`,
      )
      expect(emptyHands).toMatchObject({
        scope: 'hands',
        totals: { handCount: 0, distinctHandCount: 0 },
      })
      expect(emptySessions).toMatchObject({
        scope: 'sessions',
        totals: { sessionCount: 0, participantSessionCount: 0 },
      })
      expect(beforeCompletion.stateVersion).toBeLessThan(
        afterCompletion.stateVersion,
      )
    },
    () => clearLocalOwnerSessions(sql),
  )
}
