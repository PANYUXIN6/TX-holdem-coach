import { randomUUID } from 'node:crypto'
import type {
  HandHistoryListResponse,
  HandHistoryResponse,
} from '@tx-holdem-coach/contracts'
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

/** 生产组合主链：正式命令完成 Hand 后，经 /api/hands 返回摘要并与 M5.2 对照。 */
export async function assertM53CompletedHandHistoryListApplicationFlow(
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
          deepSeekApiKey: 'm53-deterministic-provider-key',
        }),
        loadAndValidatePersonaCatalog(),
        asDatabaseClient(sql),
        { randomSource: { nextInt: () => 0 } },
      )
      const app = createApp(runtime, {
        port: 8787,
        allowedOrigins: new Set([ORIGIN]),
      })

      await prepareTerminalUserTurn(sql, owner, identity)
      const beforeCompletion = await readPrivateState(sql, identity.sessionId)
      await createM33Executor({ sql, owner }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: beforeCompletion.stateVersion,
        type: 'playerAction',
        payload: { action: { type: 'fold' } },
      })
      const afterFirstCompletion = await readPrivateState(
        sql,
        identity.sessionId,
      )
      const nextHandId = randomUUID()
      await createM34Executor({
        sql,
        owner,
        nextHandId,
        commandAt: '2026-09-03T12:01:00.000Z',
      }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: afterFirstCompletion.stateVersion,
        type: 'startNextHand',
        payload: {},
      })
      const secondIdentity = { ...identity, handId: nextHandId }
      await prepareTerminalUserTurn(sql, owner, secondIdentity)
      const beforeSecondCompletion = await readPrivateState(
        sql,
        identity.sessionId,
      )
      await createM33Executor({ sql, owner }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: beforeSecondCompletion.stateVersion,
        type: 'playerAction',
        payload: { action: { type: 'fold' } },
      })
      const afterCompletion = await readPrivateState(sql, identity.sessionId)
      const listResponse = await app.request(
        `${BASE_URL}/api/hands?sessionId=${identity.sessionId}&limit=1`,
      )
      expect(listResponse.status).toBe(200)
      const list = (await listResponse.json()) as HandHistoryListResponse
      expect(list.nextCursor).toEqual(expect.any(String))
      expect(list.items).toHaveLength(1)
      const cursor = list.nextCursor
      if (cursor === null) throw new Error('M5.3 首页缺少续页游标。')
      const item = list.items[0]
      if (item === undefined) throw new Error('M5.3 列表缺少完成手。')
      expect(item.sessionId).toBe(identity.sessionId)
      expect(item.aiParticipants).toHaveLength(5)

      const nextPageResponse = await app.request(
        `${BASE_URL}/api/hands?sessionId=${identity.sessionId}&limit=1&cursor=${cursor}`,
      )
      expect(nextPageResponse.status).toBe(200)
      const nextPage =
        (await nextPageResponse.json()) as HandHistoryListResponse
      expect(nextPage.nextCursor).toBeNull()
      expect(nextPage.items).toHaveLength(1)
      expect([item.handId, nextPage.items[0]?.handId].sort()).toEqual(
        [identity.handId, nextHandId].sort(),
      )

      const filteredResponse = await app.request(
        `${BASE_URL}/api/hands?sessionId=${identity.sessionId}&startingHand=${item.user.startingHandCategory}`,
      )
      expect(filteredResponse.status).toBe(200)
      const filtered =
        (await filteredResponse.json()) as HandHistoryListResponse
      expect(filtered.items.map((entry) => entry.handId)).toContain(item.handId)

      const detailResponse = await app.request(
        `${BASE_URL}/api/hands/${item.handId}`,
      )
      expect(detailResponse.status).toBe(200)
      const detail = (await detailResponse.json()) as HandHistoryResponse
      const terminal = detail.history.phases.at(-1)
      if (terminal?.phase !== 'showdown') {
        throw new Error('M5.3 对照详情缺少终局。')
      }
      const detailUser = detail.history.participants.find(
        (participant) => participant.seatNumber === 0,
      )
      const detailUserHand = terminal.revealedHands.find(
        (hand) => hand.seatNumber === 0,
      )
      expect(item.user.position).toBe(detailUser?.position)
      expect(item.user.netChange).toBe(detailUser?.netChange)
      expect(item.user.holeCards).toEqual(detailUserHand?.holeCards)
      expect(item.board).toEqual(terminal.communityCards)
      expect(await readPrivateState(sql, identity.sessionId)).toEqual(
        afterCompletion,
      )

      const beforeEnd = await readPrivateState(sql, identity.sessionId)
      await createM34Executor({
        sql,
        owner,
        nextHandId: randomUUID(),
        commandAt: '2026-09-03T12:02:00.000Z',
      }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: beforeEnd.stateVersion,
        type: 'endSession',
        payload: {},
      })
      const deleted = await app.request(
        `${BASE_URL}/api/sessions/${identity.sessionId}`,
        {
          method: 'DELETE',
          headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirmation: '永久删除本场' }),
        },
      )
      expect(deleted.status).toBe(200)
      const empty = await app.request(
        `${BASE_URL}/api/hands?sessionId=${identity.sessionId}&limit=1&cursor=${cursor}`,
      )
      expect(empty.status).toBe(200)
      await expect(empty.json()).resolves.toEqual({
        items: [],
        nextCursor: null,
      })
    },
    () => clearLocalOwnerSessions(sql),
  )
}
