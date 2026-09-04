import { randomUUID } from 'node:crypto'
import type { HandHistoryResponse } from '@tx-holdem-coach/contracts'
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
import { runDatabaseTestWithCleanup } from './database-test-runtime.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'

function asDatabaseClient(sql: Sql): DatabaseClient {
  return { sql, db: {} as DatabaseClient['db'], close: async () => undefined }
}

function terminalOf(response: HandHistoryResponse) {
  const terminal = response.history.phases.at(-1)
  if (terminal?.phase !== 'showdown') {
    throw new Error('M5.2 HTTP 响应缺少终局分组。')
  }
  return terminal
}

/**
 * 生产组合 E2E：M3.3 正式命令路径写入完成 Hand，M5.2 只通过真实
 * createApiRuntime → Hono → Repository → M5.1 Reader → 查询服务读取它。
 */
export async function assertM52CompletedHandHistoryApplicationFlow(
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
          deepSeekApiKey: 'm52-deterministic-provider-key',
        }),
        loadAndValidatePersonaCatalog(),
        asDatabaseClient(sql),
        { randomSource: { nextInt: () => 0 } },
      )
      const app = createApp(runtime, {
        port: 8787,
        allowedOrigins: new Set([ORIGIN]),
      })
      const path = `/api/hands/${identity.handId}`

      for (const query of ['', '?view=auditReveal']) {
        const response = await app.request(`${BASE_URL}${path}${query}`)
        expect(response.status).toBe(404)
        await expect(response.json()).resolves.toEqual({
          code: 'HAND_NOT_FOUND',
          message: '手牌不存在。',
        })
      }

      await prepareTerminalUserTurn(sql, owner, identity)
      const beforeCompletion = await readPrivateState(sql, identity.sessionId)
      expect(beforeCompletion.poker.hand?.currentActorSeatNumber).toBe(0)
      const completed = await createM33Executor({ sql, owner }).execute({
        sessionId: identity.sessionId,
        commandId: randomUUID(),
        expectedStateVersion: beforeCompletion.stateVersion,
        type: 'playerAction',
        payload: { action: { type: 'fold' } },
      })
      expect(completed).toMatchObject({
        kind: 'completed',
        origin: 'newCommit',
      })

      const afterCompletion = await readPrivateState(sql, identity.sessionId)
      expect(afterCompletion.poker.hand).toBeNull()
      expect(afterCompletion.lastCompletedHandSummary?.handId).toBe(
        identity.handId,
      )

      const defaultResponse = await app.request(`${BASE_URL}${path}`)
      const publicResponse = await app.request(`${BASE_URL}${path}?view=public`)
      const auditResponse = await app.request(
        `${BASE_URL}${path}?view=auditReveal`,
      )
      expect(defaultResponse.status).toBe(200)
      expect(publicResponse.status).toBe(200)
      expect(auditResponse.status).toBe(200)
      const defaultBody = (await defaultResponse.json()) as HandHistoryResponse
      const publicBody = (await publicResponse.json()) as HandHistoryResponse
      const auditBody = (await auditResponse.json()) as HandHistoryResponse
      expect(defaultBody).toEqual(publicBody)
      expect(publicBody).toMatchObject({
        protocolVersion: 1,
        view: 'public',
        history: { handId: identity.handId, sessionId: identity.sessionId },
      })
      expect(auditBody).toMatchObject({ view: 'auditReveal' })

      const publicTerminal = terminalOf(publicBody)
      const auditTerminal = terminalOf(auditBody)
      expect(publicTerminal.terminationReason).toBe('complete')
      expect(publicTerminal.revealedHands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            seatNumber: 0,
            holeCards: expect.any(Array),
            handEvaluation: null,
          }),
          expect.objectContaining({
            seatNumber: 1,
            holeCards: null,
            handEvaluation: null,
          }),
        ]),
      )
      expect(
        auditTerminal.revealedHands.every((hand) => hand.holeCards !== null),
      ).toBe(true)
      expect(
        auditTerminal.revealedHands.every(
          (hand) => hand.handEvaluation === null,
        ),
      ).toBe(true)

      const afterReads = await readPrivateState(sql, identity.sessionId)
      expect(afterReads).toEqual(afterCompletion)
      const serialized = JSON.stringify({ publicBody, auditBody })
      for (const privateField of [
        'remainingDeck',
        'burnedCards',
        'checkpoint',
        'privateHands',
        'startingHandCategory',
        'comparisonGrade',
      ]) {
        expect(serialized).not.toContain(privateField)
      }
    },
    () => clearLocalOwnerSessions(sql),
  )
}
