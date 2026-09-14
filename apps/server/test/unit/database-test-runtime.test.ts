import { describe, expect, test, vi } from 'vitest'
import type { ReservedSql, Sql, TransactionSql } from 'postgres'
import {
  acquireDatabaseTestSuiteLock,
  assertNoConflictingDatabaseTestConnections,
  bindDatabaseTestClientToAbortSignal,
  bindDatabaseTestClientToSuiteLock,
  createDatabaseTestConnectionOptions,
  createDatabaseTestSuiteLockClient,
  readTransactionBackendPid,
  runAbortableDatabasePhase,
  runDatabaseTestWithCleanup,
  runDatabaseTestCleanup,
  startDatabaseTestOperation,
  runTimedDatabasePhase,
  shouldRunDatabaseMilestone,
  serializeJsonbFixture,
  terminateConflictingDatabaseTestConnections,
  trackDatabaseTestAbortCleanupCompletion,
  waitForDatabaseTestAbortCleanup,
} from '../integration/database-test-runtime.js'
import type { DatabaseTestSuiteLockClient } from '../../src/db/database-test-suite-lock.js'

describe('database test runtime', () => {
  function createSuiteLockClient(input?: { readonly acquired?: boolean }): {
    readonly client: DatabaseTestSuiteLockClient
    readonly queries: readonly string[]
    readonly releaseReserved: ReturnType<typeof vi.fn>
    closeConnection(error: Error): void
    setBackendPid(pid: number): void
  } {
    const connectionClosedController = new AbortController()
    const queries: string[] = []
    const releaseReserved = vi.fn()
    let backendPid = 4242
    const applicationName = 'txhc-dbtest:0123456789abcdef:suite-lock'
    const reserved = Object.assign(
      (strings: TemplateStringsArray) => {
        const query = strings.join('?')
        queries.push(query)
        if (query.includes('set_config')) {
          return Promise.resolve([{ applicationName }])
        }
        if (query.includes('pg_try_advisory_lock')) {
          return Promise.resolve([
            { acquired: input?.acquired ?? true, backendPid },
          ])
        }
        if (query.includes('pg_advisory_unlock')) {
          return Promise.resolve([{ released: true, backendPid }])
        }
        if (query.includes('pg_backend_pid')) {
          return Promise.resolve([{ backendPid }])
        }
        throw new Error(`未预期的 suite-lock SQL：${query}`)
      },
      { release: releaseReserved },
    ) as unknown as ReservedSql
    const sql = {
      reserve: vi.fn(async () => reserved),
    } as unknown as Sql

    return {
      client: {
        applicationName,
        connectionClosedSignal: connectionClosedController.signal,
        sql,
      },
      queries,
      releaseReserved,
      closeConnection: (error) => connectionClosedController.abort(error),
      setBackendPid: (pid) => {
        backendPid = pid
      },
    }
  }

  test('selects every milestone for full mode and only the requested milestone otherwise', () => {
    expect(
      shouldRunDatabaseMilestone(
        {
          enabled: true,
          full: true,
          milestone: null,
          cleanupStale: false,
          runId: '0123456789abcdef',
        },
        'm27',
        true,
      ),
    ).toBe(true)
    expect(
      shouldRunDatabaseMilestone(
        {
          enabled: true,
          full: false,
          milestone: 'm27',
          cleanupStale: false,
          runId: '0123456789abcdef',
        },
        'm27',
        true,
      ),
    ).toBe(true)
    expect(
      shouldRunDatabaseMilestone(
        {
          enabled: true,
          full: false,
          milestone: 'm26',
          cleanupStale: false,
          runId: '0123456789abcdef',
        },
        'm27',
        true,
      ),
    ).toBe(false)
    expect(
      shouldRunDatabaseMilestone(
        {
          enabled: true,
          full: false,
          milestone: 'm27',
          cleanupStale: false,
          runId: '0123456789abcdef',
        },
        'm27',
        false,
      ),
    ).toBe(false)
  })

  test('reports phase start, success, and elapsed time through the public reporter', async () => {
    const output: string[] = []
    const times = [1_000, 2_500]

    await expect(
      runTimedDatabasePhase('M2.7', async () => 'completed', {
        now: () => times.shift() ?? 0,
        write: (message) => output.push(message),
      }),
    ).resolves.toBe('completed')
    expect(output).toEqual([
      '[database-test] START M2.7\n',
      '[database-test] PASS M2.7 (1500 ms)\n',
    ])
  })

  test('reports the failed phase before preserving its error', async () => {
    const output: string[] = []
    const failure = new Error('database unavailable')
    const times = [4_000, 4_250]

    await expect(
      runTimedDatabasePhase(
        'M2.6',
        async () => {
          throw failure
        },
        {
          now: () => times.shift() ?? 0,
          write: (message) => output.push(message),
        },
      ),
    ).rejects.toBe(failure)
    expect(output).toEqual([
      '[database-test] START M2.6\n',
      '[database-test] FAIL M2.6 (250 ms)\n',
    ])
  })

  test('reports a database operation start while its completion remains independently awaitable', async () => {
    let releaseOperation!: () => void
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    const operation = startDatabaseTestOperation(
      'second transaction',
      async (reportStarted) => {
        reportStarted(4242)
        await operationGate
        return 'completed'
      },
    )

    await expect(operation.started).resolves.toBe(4242)
    releaseOperation()
    await expect(operation.completion).resolves.toBe('completed')
  })

  test('propagates a connection failure that happens before the operation can report its start', async () => {
    const connectFailure = Object.assign(new Error('connection unavailable'), {
      code: 'CONNECT_TIMEOUT',
    })
    const operation = startDatabaseTestOperation(
      'second transaction',
      async () => {
        throw connectFailure
      },
    )

    await expect(operation.started).rejects.toBe(connectFailure)
    await expect(operation.completion).rejects.toBe(connectFailure)
  })

  test('aborts a phase, closes its database clients, and waits for fixture cleanup', async () => {
    const controller = new AbortController()
    const abortFailure = new Error('phase timed out')
    let releaseOperation!: () => void
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    let signalOperationStarted!: () => void
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve
    })
    const closeClient = vi.fn(async () => {
      releaseOperation()
    })
    const cleanup = vi.fn(async () => {
      releaseOperation()
    })

    const phase = runAbortableDatabasePhase(
      'abortable phase',
      controller.signal,
      async (signal) => {
        bindDatabaseTestClientToAbortSignal(
          { end: closeClient } as unknown as Pick<Sql, 'end'>,
          signal,
        )
        signalOperationStarted()
        return runDatabaseTestWithCleanup(async () => {
          await operationGate
          signal.throwIfAborted()
        }, cleanup)
      },
      { now: () => 0, write: () => undefined },
    )

    await operationStarted
    controller.abort(abortFailure)

    await expect(phase).rejects.toBe(abortFailure)
    expect(closeClient).toHaveBeenCalledExactlyOnceWith({ timeout: 5 })
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  test('preserves the abort reason when client shutdown rejects the in-flight operation', async () => {
    const controller = new AbortController()
    const lockLoss = new Error('数据库测试全局锁已丢失，已中止后续数据库写入。')
    const connectionEnded = Object.assign(new Error('write CONNECTION_ENDED'), {
      code: 'CONNECTION_ENDED',
    })
    let rejectOperation!: (error: Error) => void
    const operation = new Promise<never>((_resolve, reject) => {
      rejectOperation = reject
    })
    let reportStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const closeClient = vi.fn(async () => {
      rejectOperation(connectionEnded)
    })

    const phase = runAbortableDatabasePhase(
      'suite lock shutdown',
      controller.signal,
      async (signal) => {
        bindDatabaseTestClientToAbortSignal(
          { end: closeClient } as unknown as Pick<Sql, 'end'>,
          signal,
        )
        reportStarted()
        return operation
      },
      { now: () => 0, write: () => undefined },
    )

    await started
    controller.abort(lockLoss)

    await expect(phase).rejects.toBe(lockLoss)
    expect(closeClient).toHaveBeenCalledExactlyOnceWith({ timeout: 5 })
  })

  test('preserves an aborted phase failure and sanitizes abort cleanup diagnostics', async () => {
    const controller = new AbortController()
    const primaryFailure = new Error('phase timed out')
    const cleanupFailure = Object.assign(
      new Error('failed at postgresql://user:password@example.test/postgres'),
      { name: 'PostgresError', code: '55P03' },
    )
    const output: string[] = []
    let releaseOperation!: () => void
    const operationGate = new Promise<void>((resolve) => {
      releaseOperation = resolve
    })
    let signalOperationStarted!: () => void
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve
    })
    const reporter = {
      now: () => 0,
      write: (message: string) => output.push(message),
    }

    const phase = runAbortableDatabasePhase(
      'abort cleanup failure',
      controller.signal,
      async (signal) => {
        signalOperationStarted()
        return runDatabaseTestWithCleanup(
          async () => {
            await operationGate
            signal.throwIfAborted()
          },
          async () => {
            releaseOperation()
            throw cleanupFailure
          },
          reporter,
        )
      },
      reporter,
    )

    await operationStarted
    controller.abort(primaryFailure)

    await expect(phase).rejects.toBe(primaryFailure)
    expect(output.join('')).toContain('PostgresError(code=55P03)')
    expect(output.join('')).not.toContain('password')
    expect(output.join('')).not.toContain('postgresql://')
  })

  test('waits for business connections to stop before starting aborted fixture cleanup', async () => {
    const controller = new AbortController()
    const primaryFailure = new Error('phase timed out')
    const order: string[] = []
    let releaseShutdown!: () => void
    const shutdown = new Promise<void>((resolve) => {
      releaseShutdown = resolve
    })
    let reportStarted!: () => void
    const started = new Promise<void>((resolve) => {
      reportStarted = resolve
    })
    const phase = runAbortableDatabasePhase(
      'ordered cleanup',
      controller.signal,
      async (signal) => {
        bindDatabaseTestClientToAbortSignal(
          {
            end: async () => {
              order.push('stop')
              await shutdown
              order.push('stopped')
            },
          },
          signal,
        )
        reportStarted()
        await runDatabaseTestWithCleanup(
          async () => {
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            )
            signal.throwIfAborted()
          },
          async () => {
            order.push('cleanup')
          },
        )
      },
      { now: () => 0, write: () => undefined },
    )
    await started
    controller.abort(primaryFailure)
    await vi.waitFor(() => expect(order).toEqual(['stop']))
    releaseShutdown()
    await expect(phase).rejects.toBe(primaryFailure)
    expect(order).toEqual(['stop', 'stopped', 'cleanup'])
  })

  test('refuses cleanup writes after suite-lock authority has been lost', async () => {
    const controller = new AbortController()
    const authority = new AbortController()
    const cleanup = vi.fn()
    await expect(
      runAbortableDatabasePhase(
        'lost authority',
        controller.signal,
        async () => {
          authority.abort(new Error('suite lock lost'))
          await runDatabaseTestCleanup(cleanup)
        },
        { now: () => 0, write: () => undefined },
        authority.signal,
      ),
    ).rejects.toThrow('suite lock lost')
    expect(cleanup).not.toHaveBeenCalled()
  })

  test('waits for tracked process termination before abort cleanup settles', async () => {
    const controller = new AbortController()
    const primaryFailure = new Error('phase timed out')
    let releaseProcessTermination!: () => void
    const processTermination = new Promise<void>((resolve) => {
      releaseProcessTermination = resolve
    })
    let signalOperationStarted!: () => void
    const operationStarted = new Promise<void>((resolve) => {
      signalOperationStarted = resolve
    })
    const hookFinished = vi.fn()

    const phase = runAbortableDatabasePhase(
      'migration termination',
      controller.signal,
      async (signal) => {
        trackDatabaseTestAbortCleanupCompletion(processTermination)
        signalOperationStarted()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        signal.throwIfAborted()
      },
      { now: () => 0, write: () => undefined },
    )

    await operationStarted
    controller.abort(primaryFailure)
    const completionHook = waitForDatabaseTestAbortCleanup(controller.signal)
    void completionHook.then(hookFinished)
    await Promise.resolve()

    expect(hookFinished).not.toHaveBeenCalled()
    releaseProcessTermination()
    await completionHook
    await expect(phase).rejects.toBe(primaryFailure)
    expect(hookFinished).toHaveBeenCalledTimes(1)
  })

  test('preserves the primary failure when database fixture cleanup also fails', async () => {
    const output: string[] = []
    const primaryFailure = new Error('concurrent command timed out')
    const cleanupFailure = Object.assign(
      new Error(
        'canceling statement due to lock timeout at postgresql://user:password@example.test/postgres',
      ),
      { name: 'PostgresError', code: '55P03' },
    )

    await expect(
      runDatabaseTestWithCleanup(
        async () => {
          throw primaryFailure
        },
        async () => {
          throw cleanupFailure
        },
        { write: (message) => output.push(message) },
      ),
    ).rejects.toBe(primaryFailure)
    expect(output).toEqual([
      '[database-test] CLEANUP failed after preserving the primary failure: PostgresError(code=55P03)\n',
    ])
    expect(output.join('')).not.toContain('password')
  })

  test('throws a sanitized cleanup diagnostic when the operation succeeded', async () => {
    const cleanupFailure = Object.assign(
      new Error('postgresql://user:password@example.test/postgres'),
      { name: 'PostgresError', code: '55P03' },
    )

    const failure: unknown = await runDatabaseTestWithCleanup(
      async () => 'completed',
      async () => {
        throw new AggregateError([cleanupFailure], 'fixture cleanup failed')
      },
    ).then(
      () => undefined,
      (error: unknown) => error,
    )

    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) {
      throw new Error('预期数据库清理返回 Error。')
    }
    expect(failure.message).toBe(
      '数据库测试清理失败：AggregateError(causes=PostgresError(code=55P03))',
    )
    expect(failure).not.toHaveProperty('cause')
    expect(JSON.stringify(failure)).not.toContain('password')
    expect(JSON.stringify(failure)).not.toContain('postgresql://')
  })

  test('tags every test connection and bounds abandoned statements and transactions', () => {
    expect(
      createDatabaseTestConnectionOptions('0123456789abcdef', 'm27-primary'),
    ).toEqual({
      connect_timeout: 30,
      max: 1,
      prepare: false,
      ssl: 'require',
      connection: {
        application_name: 'txhc-dbtest:0123456789abcdef:m27-primary',
        statement_timeout: 90_000,
        idle_in_transaction_session_timeout: 60_000,
      },
    })
  })

  test('rejects a transaction-pooler endpoint for the persistent suite lock client', () => {
    expect(() =>
      createDatabaseTestSuiteLockClient(
        'postgresql://postgres.wlxjauqsesrmcyghibsr:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
        '0123456789abcdef',
      ),
    ).toThrow('Supabase 数据库连接配置无效。')
  })

  test('acquires one suite-wide advisory lock before remote test mutation', async () => {
    const suiteLockClient = createSuiteLockClient()
    const lock = await acquireDatabaseTestSuiteLock(suiteLockClient.client)

    await expect(lock.release()).resolves.toBeUndefined()
    expect(suiteLockClient.queries).toHaveLength(3)
    expect(suiteLockClient.queries[0]).toContain('set_config')
    expect(suiteLockClient.queries[1]).toContain('pg_try_advisory_lock')
    expect(suiteLockClient.queries[2]).toContain('pg_advisory_unlock')
    expect(suiteLockClient.releaseReserved).toHaveBeenCalledTimes(1)
  })

  test('rejects a concurrent remote suite before it mutates shared fixtures', async () => {
    const suiteLockClient = createSuiteLockClient({ acquired: false })
    await expect(
      acquireDatabaseTestSuiteLock(suiteLockClient.client),
    ).rejects.toThrow(
      '检测到另一套远程 PostgreSQL 测试正在运行。请等待其结束后再串行执行。',
    )
    expect(suiteLockClient.queries).toHaveLength(2)
    expect(suiteLockClient.queries).not.toContain(
      expect.stringContaining('pg_advisory_unlock'),
    )
    expect(suiteLockClient.releaseReserved).toHaveBeenCalledTimes(1)
  })

  test('aborts an active phase when the reserved suite lock connection closes', async () => {
    const connectionFailure = Object.assign(
      new Error(
        'connection failed at postgresql://user:password@example.test/postgres',
      ),
      { name: 'PostgresError', code: '08006' },
    )
    const suiteLockClient = createSuiteLockClient()
    const output: string[] = []
    const lock = await acquireDatabaseTestSuiteLock(suiteLockClient.client, {
      reporter: { write: (message) => output.push(message) },
    })
    const contextController = new AbortController()
    const phaseSignal = AbortSignal.any([contextController.signal, lock.signal])
    let reportPhaseStarted!: () => void
    const phaseStarted = new Promise<void>((resolve) => {
      reportPhaseStarted = resolve
    })
    const closeClient = vi.fn(async () => undefined)
    const phase = runAbortableDatabasePhase(
      'suite lock failure',
      phaseSignal,
      async (signal) => {
        bindDatabaseTestClientToAbortSignal(
          { end: closeClient } as unknown as Pick<Sql, 'end'>,
          signal,
        )
        reportPhaseStarted()
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        signal.throwIfAborted()
      },
      { now: () => 0, write: () => undefined },
    )

    await phaseStarted
    suiteLockClient.closeConnection(connectionFailure)

    await expect(phase).rejects.toThrow(
      '数据库测试全局锁已丢失，已中止后续数据库写入。',
    )
    expect(closeClient).toHaveBeenCalledExactlyOnceWith({ timeout: 5 })
    const releaseFailure: unknown = await lock.release().then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(releaseFailure).toMatchObject({
      message: '数据库测试全局锁已丢失，已中止后续数据库写入。',
    })
    expect(releaseFailure).not.toHaveProperty('cause')
    expect(String(releaseFailure)).not.toContain('password')
    expect(output).toEqual([
      '[database-test] SUITE LOCK lost: PostgresError(code=08006)\n',
    ])
    expect(output.join('')).not.toContain('password')
    expect(suiteLockClient.releaseReserved).not.toHaveBeenCalled()
  })

  test('terminates a protected database client when the suite lock is lost', async () => {
    const suiteLockClient = createSuiteLockClient()
    const lock = await acquireDatabaseTestSuiteLock(suiteLockClient.client, {
      reporter: { write: () => undefined },
    })
    const endClient = vi.fn(async () => undefined)
    const unbind = bindDatabaseTestClientToSuiteLock(
      { end: endClient } as unknown as Pick<Sql, 'end'>,
      lock,
    )

    suiteLockClient.closeConnection(new Error('suite lock connection failed'))

    await vi.waitFor(() => {
      expect(endClient).toHaveBeenCalledExactlyOnceWith({ timeout: 0 })
    })
    await expect(lock.release()).rejects.toThrow(
      '数据库测试全局锁已丢失，已中止后续数据库写入。',
    )
    unbind()
  })

  test('fails closed when a suite lock heartbeat observes another backend', async () => {
    const suiteLockClient = createSuiteLockClient()
    const lock = await acquireDatabaseTestSuiteLock(suiteLockClient.client, {
      heartbeatIntervalMs: 1,
      reporter: { write: () => undefined },
    })
    suiteLockClient.setBackendPid(4343)

    await vi.waitFor(() => expect(lock.signal.aborted).toBe(true))

    await expect(lock.release()).rejects.toThrow(
      '数据库测试全局锁已丢失，已中止后续数据库写入。',
    )
    expect(suiteLockClient.releaseReserved).not.toHaveBeenCalled()
  })

  test('fails fast with safe diagnostics when another tagged test transaction remains', async () => {
    const sql = (() =>
      Promise.resolve([
        {
          pid: 4242,
          applicationName: 'txhc-dbtest:fedcba9876543210:m27-primary',
          state: 'idle in transaction',
          transactionAge: '00:03:12',
        },
      ])) as unknown as Sql

    await expect(
      assertNoConflictingDatabaseTestConnections(sql, '0123456789abcdef'),
    ).rejects.toThrow(
      '检测到其他数据库测试事务：PID 4242，状态 idle in transaction，事务年龄 00:03:12。请先运行 pnpm --filter @tx-holdem-coach/server run db:test:cleanup。',
    )
  })

  test('cleanup returns only explicitly tagged conflicting backend PIDs', async () => {
    const sql = (() =>
      Promise.resolve([
        { pid: 4242, terminated: true },
        { pid: 4343, terminated: false },
      ])) as unknown as Sql

    await expect(
      terminateConflictingDatabaseTestConnections(sql, '0123456789abcdef'),
    ).resolves.toEqual([4242])
  })

  test('reports untagged transactions holding application locks without proposing automatic termination', async () => {
    const sql = (() =>
      Promise.resolve([
        {
          pid: 443087,
          applicationName: 'Supavisor',
          state: 'idle in transaction',
          transactionAge: '00:13:00',
        },
      ])) as unknown as Sql
    await expect(
      assertNoConflictingDatabaseTestConnections(sql, '0123456789abcdef'),
    ).rejects.toThrow(
      '检测到未标记的数据库事务持有 app_private 锁：PID 443087，状态 idle in transaction，事务年龄 00:13:00。请确认连接归属后处理；自动测试连接清理不会终止它。',
    )
  })

  test('preflight and cleanup include an idle foreign suite lock by its strict tag', async () => {
    const queries: {
      readonly text: string
      readonly values: readonly unknown[]
    }[] = []
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      queries.push({ text: strings.join('?'), values })
      return Promise.resolve([])
    }) as unknown as Sql

    await assertNoConflictingDatabaseTestConnections(sql, '0123456789abcdef')
    await terminateConflictingDatabaseTestConnections(sql, '0123456789abcdef')

    expect(queries).toHaveLength(2)
    for (const query of queries) {
      expect(query.text).toContain('application_name ~')
      expect(query.values).toContain('^txhc-dbtest:[a-f0-9]{16}:suite-lock$')
    }
  })

  test('reads the backend PID through the exact transaction under observation', async () => {
    const transaction = (() =>
      Promise.resolve([{ backendPid: 5252 }])) as unknown as TransactionSql

    await expect(readTransactionBackendPid(transaction)).resolves.toBe(5252)
  })

  test('serializes direct-SQL JSONB fixtures through one explicit text boundary', () => {
    expect(serializeJsonbFixture({ schemaVersion: 1, payload: {} })).toBe(
      '{"schemaVersion":1,"payload":{}}',
    )
  })
})
