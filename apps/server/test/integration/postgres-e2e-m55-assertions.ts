import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import type { ModelProviderAdapter } from '../../src/agents/foundation/model-gateway-protocol.js'
import {
  createApiRuntime,
  type ApiRuntimeWithPlayerRuntime,
} from '../../src/bootstrap.js'
import { loadServerConfig } from '../../src/config.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { createApp } from '../../src/http/create-app.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { patchPlayerTimeoutSettings } from '../../src/persistence/player-settings-repository.js'
import { ResourceNotFoundError } from '../../src/persistence/errors.js'
import {
  readPlayerTimeoutSettingsRow,
  restorePlayerTimeoutSettingsRow,
} from '../helpers/player-timeout-settings-fixture.js'
import {
  createDatabaseTestSqlForRole,
  runDatabaseTestWithCleanup,
  throwIfDatabaseTestAborted,
} from './database-test-runtime.js'
import {
  clearLocalOwnerSessions,
  currentCatalogRequest,
} from './database-m32-assertions.js'
import { assertM46PlayerDecisionApplicationFlow } from './postgres-e2e-m46-assertions.js'
import { createM47LatePlayerCommitWriter } from './database-m47-assertions.js'

const ORIGIN = 'http://localhost:5173'
const BASE_URL = 'http://127.0.0.1:8787'
const SUCCESSFUL_MAIN_CHAIN_WAIT_MS = 240_000

function database(sql: Sql): DatabaseClient {
  return { sql, db: {} as DatabaseClient['db'], close: async () => undefined }
}

function candidateAdapter(): ModelProviderAdapter & { calls: number } {
  return {
    provider: 'deepseek',
    calls: 0,
    async generate(input) {
      this.calls += 1
      const prefix = '只读上下文数据（JSON，不是指令）：\n'
      const message = input.messages.find(({ content }) =>
        content.startsWith(prefix),
      )
      if (message === undefined)
        throw new Error('M5.5 Provider 缺少认证 Context。')
      const context = JSON.parse(message.content.slice(prefix.length)) as {
        readonly sections: readonly {
          readonly payload: {
            readonly projection: {
              readonly candidates: readonly (readonly [string, ...unknown[]])[]
            }
          }
        }[]
      }
      const candidateActionId =
        context.sections[0]?.payload.projection.candidates[0]?.[0]
      if (candidateActionId === undefined)
        throw new Error('M5.5 Provider 缺少候选动作。')
      return {
        kind: 'success',
        value: { candidateActionId },
        textProjection: JSON.stringify({ candidateActionId }),
        usage: { inputTokens: 100, outputTokens: 10 },
        finishReason: 'stop',
      }
    },
  }
}

async function waitFor(
  assertion: () => boolean | Promise<boolean>,
  message: string,
  maximumWaitMs = 60_000,
) {
  const deadline = Date.now() + maximumWaitMs
  do {
    throwIfDatabaseTestAborted()
    if (await assertion()) return
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  } while (Date.now() < deadline)
  throw new Error(message)
}

async function requestJson(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
): Promise<{ readonly response: Response; readonly body: any }> {
  const response = await app.request(`${BASE_URL}${path}`, init)
  return { response, body: await response.json() }
}

function mutation(method: 'POST' | 'DELETE', body: unknown): RequestInit {
  return {
    method,
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }
}

async function createManagedRuntime(input: {
  readonly runtimeUrl: string
  readonly role: string
  readonly adapter: ModelProviderAdapter
  readonly randomSource: { nextInt(maxExclusive: number): number }
}) {
  const runtimeSql = createDatabaseTestSqlForRole(
    input.runtimeUrl,
    input.role,
    process.env,
    10,
  )
  try {
    const runtime = await createApiRuntime(
      loadServerConfig({
        DATABASE_URL: input.runtimeUrl,
        DEEPSEEK_API_KEY: 'm55-deterministic-provider-key',
      }),
      loadAndValidatePersonaCatalog(),
      database(runtimeSql),
      {
        playerModelAdapter: input.adapter,
        randomSource: input.randomSource,
      },
    )
    return { runtime, close: () => runtimeSql.end({ timeout: 0 }) }
  } catch (error) {
    await runtimeSql.end({ timeout: 0 })
    throw error
  }
}

function requirePlayerRuntime(runtime: ApiRuntimeWithPlayerRuntime) {
  if (runtime.playerRuntime === undefined)
    throw new Error('M5.5 未安装 Player Runtime。')
  return runtime.playerRuntime
}

async function startPlayerRuntime(runtime: ApiRuntimeWithPlayerRuntime) {
  const playerRuntime = requirePlayerRuntime(runtime)
  const restartEffects = await playerRuntime.startupRecovery.recoverAtStartup({
    signal: new AbortController().signal,
  })
  const queuedRunIds = await playerRuntime.reconcileInitialTurns()
  await playerRuntime.worker.start()
  const startupRunIds = [
    ...new Set([...restartEffects.replacementRunIds, ...queuedRunIds]),
  ].sort()
  if (startupRunIds.length !== 0) {
    playerRuntime.worker.wake('player', startupRunIds)
  }
  await playerRuntime.dispatcher.start()
  return playerRuntime
}

async function stopPlayerRuntime(runtime: ApiRuntimeWithPlayerRuntime) {
  const playerRuntime = requirePlayerRuntime(runtime)
  await playerRuntime.dispatcher.stop()
  await playerRuntime.worker.stop()
}

async function createSession(app: ReturnType<typeof createApp>) {
  const created = await requestJson(
    app,
    '/api/sessions',
    mutation('POST', currentCatalogRequest(5)),
  )
  expect(created.response.status).toBe(201)
  return created.body.snapshot as {
    readonly sessionId: string
    readonly hand: { readonly handId: string } | null
  }
}

async function readSession(
  app: ReturnType<typeof createApp>,
  sessionId: string,
) {
  const result = await requestJson(app, `/api/sessions/${sessionId}`)
  expect(result.response.status).toBe(200)
  return result.body.snapshot as {
    readonly stateVersion: number
    readonly pokerPhase: string
    readonly agentRunState: string
    readonly seats: readonly {
      readonly seatNumber: number
      readonly stack: number
    }[]
    readonly hand: {
      readonly currentActorSeatNumber: number | null
    } | null
  }
}

async function readGetFootprint(sql: Sql, sessionId: string) {
  const rows = await sql<
    readonly {
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly ledgerCount: number
      readonly runCount: number
    }[]
  >`
    SELECT s.state_version::int AS "stateVersion",
      s.next_event_seq::int AS "nextEventSeq",
      (SELECT count(*)::int FROM app_private.command_ledger
       WHERE session_id = s.id AND owner_id = s.owner_id) AS "ledgerCount",
      (SELECT count(*)::int FROM app_private.agent_runs
       WHERE session_id = s.id AND owner_id = s.owner_id) AS "runCount"
    FROM app_private.sessions AS s
    WHERE s.id = ${sessionId}::uuid
  `
  expect(rows).toHaveLength(1)
  return rows[0]
}

async function executeCommand(
  app: ReturnType<typeof createApp>,
  sessionId: string,
  input: {
    readonly stateVersion: number
    readonly type: string
    readonly payload: unknown
  },
): Promise<void> {
  const result = await requestJson(
    app,
    `/api/sessions/${sessionId}/commands`,
    mutation('POST', {
      command: {
        sessionId,
        commandId: randomUUID(),
        expectedStateVersion: input.stateVersion,
        type: input.type,
        payload: input.payload,
      },
    }),
  )
  if (result.response.status !== 200) {
    throw new Error(
      `M5.5 命令失败（${result.response.status}）：${JSON.stringify(result.body)}`,
    )
  }
}

async function assertSuccessfulMainChain(sql: Sql, runtimeUrl: string) {
  let randomCall = 0
  const adapter = candidateAdapter()
  const managed = await createManagedRuntime({
    runtimeUrl,
    role: 'm55-success-runtime',
    adapter,
    randomSource: {
      nextInt(maxExclusive) {
        const value = randomCall++ === 0 ? 5 : 0
        return Math.min(value, maxExclusive - 1)
      },
    },
  })
  const app = createApp(managed.runtime, {
    port: 8787,
    allowedOrigins: new Set([ORIGIN]),
  })
  try {
    const playerRuntime = await startPlayerRuntime(managed.runtime)
    const created = await createSession(app)
    const sessionId = created.sessionId
    const handId = created.hand?.handId
    if (handId === undefined) throw new Error('M5.5 新场次缺少首手。')
    try {
      const mainChainDeadline = Date.now() + SUCCESSFUL_MAIN_CHAIN_WAIT_MS
      await Promise.race([
        (async () => {
          // 六人桌由四个 AI fold 把行动推进到用户。先观察确定性
          // Provider 的本地调用计数，避免在四条完整提交链执行期间用
          // Session GET 持续增加远程数据库负载；最终状态仍由正式读取认证。
          await waitFor(
            () => adapter.calls >= 4,
            'M5.5 成功主链未执行四次 AI 调用。',
            Math.max(1, mainChainDeadline - Date.now()),
          )
          await waitFor(
            async () =>
              (await readSession(app, sessionId)).hand
                ?.currentActorSeatNumber === 0,
            'M5.5 成功主链未推进到用户行动。',
            Math.max(1, mainChainDeadline - Date.now()),
          )
        })(),
        playerRuntime.worker.fatal.then((fatal) => {
          throw new Error(`M5.5 Worker 提前终止：${fatal.category}`)
        }),
      ])
    } catch (error) {
      const diagnostics = await sql`
        SELECT lifecycle, termination_reason AS "terminationReason",
          deadline_at > clock_timestamp() AS "deadlineValid",
          lease_expires_at > clock_timestamp() AS "leaseValid"
        FROM app_private.agent_runs
        WHERE session_id = ${sessionId}::uuid
        ORDER BY created_at, id
      `
      throw new Error(
        `M5.5 成功主链失败，Provider 调用 ${adapter.calls} 次，Run=${JSON.stringify(diagnostics)}。`,
        {
          cause: error,
        },
      )
    }
    expect(adapter.calls).toBe(4)
    const beforeFold = await readSession(app, sessionId)
    await executeCommand(app, sessionId, {
      stateVersion: beforeFold.stateVersion,
      type: 'playerAction',
      payload: { action: { type: 'fold' } },
    })
    await waitFor(
      async () =>
        (await readSession(app, sessionId)).pokerPhase === 'betweenHands',
      'M5.5 成功主链未完成 Hand。',
    )

    const stable = await readSession(app, sessionId)
    const footprintBeforeGets = await readGetFootprint(sql, sessionId)
    const [sessions, history, statistics, calls, aiStatus] = await Promise.all([
      requestJson(app, '/api/sessions?limit=1'),
      requestJson(app, `/api/hands?sessionId=${sessionId}`),
      requestJson(app, `/api/statistics?scope=hands&sessionId=${sessionId}`),
      requestJson(app, `/api/hands/${handId}/agent-calls?limit=1`),
      requestJson(app, `/api/sessions/${sessionId}/ai-status`),
    ])
    expect(aiStatus.response.status).toBe(200)
    expect(aiStatus.body.coordination).toEqual({ state: 'idle' })
    expect(aiStatus.body.personas).toHaveLength(5)
    expect(sessions.response.status).toBe(200)
    expect(history.response.status).toBe(200)
    expect(statistics.response.status).toBe(200)
    expect(calls.response.status).toBe(200)
    expect(sessions.body.items).toHaveLength(1)
    expect(history.body.items).toHaveLength(1)
    expect(statistics.body.totals.distinctHandCount).toBe(1)
    expect(calls.body.items).toHaveLength(1)
    expect(calls.body.nextCursor).toEqual(expect.any(String))
    const runId = calls.body.items[0]?.runId as string | undefined
    if (runId === undefined) throw new Error('M5.5 成功主链缺少 Run。')
    const [detail, attempts, capabilities] = await Promise.all([
      requestJson(app, `/api/agent-runs/${runId}`),
      requestJson(app, `/api/agent-runs/${runId}/attempts?limit=1`),
      requestJson(
        app,
        `/api/agent-runs/${runId}/capability-invocations?limit=1`,
      ),
    ])
    expect(detail.response.status).toBe(200)
    expect(detail.body.commandEventRange).not.toBeNull()
    expect(attempts.body.items).toHaveLength(1)
    expect(capabilities.body.items).toHaveLength(1)
    const [stableAfterGets, footprintAfterGets] = await Promise.all([
      readSession(app, sessionId),
      readGetFootprint(sql, sessionId),
    ])
    expect(stableAfterGets).toEqual(stable)
    expect(footprintAfterGets).toEqual(footprintBeforeGets)

    const afterHand = stableAfterGets
    const userStack = afterHand.seats.find(
      ({ seatNumber }) => seatNumber === 0,
    )?.stack
    const rebuyAmount = 2_000 - (userStack ?? 2_000)
    expect(rebuyAmount).toBeGreaterThan(0)
    await executeCommand(app, sessionId, {
      stateVersion: afterHand.stateVersion,
      type: 'rebuy',
      payload: { amount: rebuyAmount },
    })
    const afterRebuy = await readSession(app, sessionId)
    await executeCommand(app, sessionId, {
      stateVersion: afterRebuy.stateVersion,
      type: 'endSession',
      payload: {},
    })
    const [endedSessions, sessionStatistics, aiSessionStatistics] =
      await Promise.all([
        requestJson(app, '/api/sessions?lifecycle=ended'),
        requestJson(
          app,
          `/api/statistics?scope=sessions&subject=user&sessionId=${sessionId}`,
        ),
        requestJson(
          app,
          `/api/statistics?scope=sessions&subject=ai&sessionId=${sessionId}`,
        ),
      ])
    const accounting = endedSessions.body.items[0]?.accounting
    expect(accounting?.status).toBe('available')
    expect(sessionStatistics.body.totals.sessionCount).toBe(1)
    const accountingSeats = accounting?.seats ?? []
    for (const [statisticsResponse, seats] of [
      [
        sessionStatistics,
        accountingSeats.filter(
          ({ seatNumber }: { readonly seatNumber: number }) => seatNumber === 0,
        ),
      ],
      [
        aiSessionStatistics,
        accountingSeats.filter(
          ({ seatNumber }: { readonly seatNumber: number }) => seatNumber !== 0,
        ),
      ],
    ] as const) {
      expect(statisticsResponse.body.totals).toMatchObject({
        finalChips: seats.reduce(
          (sum: number, seat: { readonly finalChips: number }) =>
            sum + seat.finalChips,
          0,
        ),
        cumulativeBuyIn: seats.reduce(
          (sum: number, seat: { readonly cumulativeBuyIn: number }) =>
            sum + seat.cumulativeBuyIn,
          0,
        ),
        sessionNetChange: seats.reduce(
          (sum: number, seat: { readonly sessionNetChange: number }) =>
            sum + seat.sessionNetChange,
          0,
        ),
      })
    }

    const deleted = await requestJson(
      app,
      `/api/sessions/${sessionId}`,
      mutation('DELETE', { confirmation: '永久删除本场' }),
    )
    expect(deleted.response.status).toBe(200)
    const [deletedCalls, deletedRun, emptySessions, emptyHistory, emptyStats] =
      await Promise.all([
        app.request(`${BASE_URL}/api/hands/${handId}/agent-calls`),
        app.request(`${BASE_URL}/api/agent-runs/${runId}`),
        requestJson(app, '/api/sessions'),
        requestJson(app, `/api/hands?sessionId=${sessionId}`),
        requestJson(app, `/api/statistics?scope=hands&sessionId=${sessionId}`),
      ])
    expect(deletedCalls.status).toBe(404)
    expect(deletedRun.status).toBe(404)
    expect(emptySessions.body.items).toEqual([])
    expect(emptyHistory.body.items).toEqual([])
    expect(emptyStats.body.totals.distinctHandCount).toBe(0)
  } finally {
    await stopPlayerRuntime(managed.runtime)
    await managed.close()
  }
}

async function assertPauseAbortAndClearChain(sql: Sql, runtimeUrl: string) {
  const managed = await createManagedRuntime({
    runtimeUrl,
    role: 'm55-failure-runtime',
    adapter: candidateAdapter(),
    randomSource: { nextInt: () => 0 },
  })
  const app = createApp(managed.runtime, {
    port: 8787,
    allowedOrigins: new Set([ORIGIN]),
  })
  try {
    await assertM46PlayerDecisionApplicationFlow(sql, {
      pauseAfterSelectedResultFailure: true,
      onSelected: async ({ sessionId, handId, runId }) => {
        const paused = await readSession(app, sessionId)
        expect(paused.agentRunState).toBe('paused')
        const beforeAiGet = await readGetFootprint(sql, sessionId)
        const ai = await requestJson(
          app,
          `/api/sessions/${sessionId}/ai-status`,
        )
        expect(ai.response.status).toBe(200)
        expect(ai.body.coordination).toMatchObject({
          state: 'paused',
          run: { runId, sourceStateVersion: paused.stateVersion },
        })
        expect(await readGetFootprint(sql, sessionId)).toEqual(beforeAiGet)
        const wrongTarget = await requestJson(
          app,
          `/api/sessions/${sessionId}/commands`,
          mutation('POST', {
            command: {
              sessionId,
              commandId: randomUUID(),
              expectedStateVersion: paused.stateVersion,
              type: 'endSession',
              payload: { expectedPausedRunId: randomUUID() },
            },
          }),
        )
        expect(wrongTarget.response.status).toBe(409)
        expect(wrongTarget.body.code).toBe('PAUSED_RUN_CONFLICT')
        const rejectedFootprint = await readGetFootprint(sql, sessionId)
        expect(rejectedFootprint).toEqual({
          ...beforeAiGet,
          ledgerCount: beforeAiGet!.ledgerCount + 1,
        })

        const calls = await requestJson(app, `/api/hands/${handId}/agent-calls`)
        expect(calls.response.status).toBe(200)
        expect(JSON.stringify(calls.body)).not.toMatch(
          /holeCards|remainingDeck/,
        )
        expect(calls.body.items[0]?.lifecycle).toBe('failed')
        expect(calls.body.items[0]?.runId).toBe(runId)
        const pausedDetail = await requestJson(app, `/api/agent-runs/${runId}`)
        expect(pausedDetail.response.status).toBe(200)
        expect(pausedDetail.body).toMatchObject({
          lifecycle: 'failed',
          decision: {
            kind: 'summary',
            status: 'selected',
            terminalOutcome: 'failed',
            commandLedgerId: null,
            normalizedAction: { status: 'withheld' },
          },
        })

        await executeCommand(app, sessionId, {
          stateVersion: paused.stateVersion,
          type: 'endSession',
          payload: { expectedPausedRunId: runId },
        })
        const aborted = await requestJson(
          app,
          `/api/hands/${handId}/agent-calls`,
        )
        expect(aborted.body.hand.status).toBe('aborted')
        expect(aborted.body.items).toHaveLength(1)
        expect(aborted.body.items[0]?.runId).toBe(runId)
        const detail = await requestJson(app, `/api/agent-runs/${runId}`)
        expect(detail.body.decision).toMatchObject({
          kind: 'summary',
          normalizedAction: { status: 'withheld' },
        })

        const lateWriter = await createM47LatePlayerCommitWriter(sql)
        const lateSurface = await sql<
          readonly {
            readonly sessionLifecycle: string
            readonly runLifecycle: string
            readonly decisionStatus: string
          }[]
        >`
          SELECT session.lifecycle_status AS "sessionLifecycle",
            run.lifecycle AS "runLifecycle",
            decision.status AS "decisionStatus"
          FROM app_private.sessions AS session
          JOIN app_private.agent_runs AS run
            ON run.session_id = session.id AND run.owner_id = session.owner_id
          JOIN app_private.player_decisions AS decision
            ON decision.agent_run_id = run.id
          WHERE session.id = ${lateWriter.sessionId}::uuid
            AND run.id = ${lateWriter.runId}::uuid
            AND decision.id = ${lateWriter.decisionId}::uuid
        `
        expect(lateSurface).toEqual([
          {
            sessionLifecycle: 'active',
            runLifecycle: 'running',
            decisionStatus: 'selected',
          },
        ])

        const cleared = await requestJson(
          app,
          '/api/data',
          mutation('DELETE', { confirmation: '永久清空全部数据' }),
        )
        expect(cleared.response.status).toBe(200)
        await expect(lateWriter.commit()).rejects.toBeInstanceOf(
          ResourceNotFoundError,
        )
        const health = await requestJson(app, '/api/health')
        expect(health.response.status).toBe(200)
        expect(health.body).toEqual({
          status: 'ok',
          database: 'available',
        })
        const [
          deletedCalls,
          deletedRun,
          deletedLateRun,
          emptySessions,
          emptyStatistics,
          personas,
          settings,
        ] = await Promise.all([
          app.request(`${BASE_URL}/api/hands/${handId}/agent-calls`),
          app.request(`${BASE_URL}/api/agent-runs/${runId}`),
          app.request(`${BASE_URL}/api/agent-runs/${lateWriter.runId}`),
          requestJson(app, '/api/sessions'),
          requestJson(app, '/api/statistics?scope=sessions'),
          app.request(`${BASE_URL}/api/agent-personas`),
          app.request(`${BASE_URL}/api/settings/agent`),
        ])
        expect(deletedCalls.status).toBe(404)
        expect(deletedRun.status).toBe(404)
        expect(deletedLateRun.status).toBe(404)
        expect(emptySessions.body.items).toEqual([])
        expect(emptyStatistics.body.totals.sessionCount).toBe(0)
        expect(personas.status).toBe(200)
        expect(settings.status).toBe(200)
      },
    })
  } finally {
    await managed.close()
  }
}

export async function assertM55SessionAndAgentCallHttpSuccessFlow(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const originalTimeoutSettings = await readPlayerTimeoutSettingsRow(
        sql,
        owner.databaseOwnerId,
      )
      try {
        await sql.begin((transaction) =>
          patchPlayerTimeoutSettings(transaction, owner, {
            attemptTimeoutSeconds: 15,
            decisionDeadlineSeconds: 120,
          }),
        )
        await assertSuccessfulMainChain(sql, runtimeUrl)
      } finally {
        await restorePlayerTimeoutSettingsRow({
          sql,
          owner,
          original: originalTimeoutSettings,
        })
      }
    },
    () => clearLocalOwnerSessions(sql),
  )
}

export async function assertM55PauseAbortAndClearHttpFlow(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertPauseAbortAndClearChain(sql, runtimeUrl)
}
