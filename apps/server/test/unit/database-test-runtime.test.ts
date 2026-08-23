import { describe, expect, test, vi } from 'vitest'
import type { Sql, TransactionSql } from 'postgres'
import {
  assertNoConflictingDatabaseTestConnections,
  bindDatabaseTestClientToAbortSignal,
  createDatabaseTestConnectionOptions,
  readTransactionBackendPid,
  runAbortableDatabasePhase,
  runDatabaseTestWithCleanup,
  runTimedDatabasePhase,
  shouldRunDatabaseMilestone,
  serializeJsonbFixture,
  terminateConflictingDatabaseTestConnections,
  trackDatabaseTestAbortCleanupCompletion,
  waitForDatabaseTestAbortCleanup,
} from '../integration/database-test-runtime.js'

describe('database test runtime', () => {
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
    expect(closeClient).toHaveBeenCalledExactlyOnceWith({ timeout: 0 })
    expect(cleanup).toHaveBeenCalledTimes(1)
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
      connect_timeout: 10,
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
