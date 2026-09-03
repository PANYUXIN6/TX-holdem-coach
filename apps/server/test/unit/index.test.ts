import { describe, expect, test, vi } from 'vitest'
import { loadServerConfig, ServerConfigurationError } from '../../src/config.js'
import {
  bootstrap,
  type HttpServerHandle,
  ServiceStartupError,
} from '../../src/bootstrap.js'
import {
  loadAndValidatePersonaCatalog,
  PersonaCatalogValidationError,
} from '../../src/personas/catalog.js'
import { StartupError } from '../../src/startup.js'
import type { DatabaseClient } from '../../src/db/client.js'

const config = loadServerConfig({
  DATABASE_URL:
    'postgresql://postgres.abcdefghijklmnopqrst:runtime-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
})

function serverHandle(): HttpServerHandle {
  return {
    bound: Promise.resolve(),
    fatal: new Promise(() => undefined),
    beginClose: vi.fn(),
    waitForClose: vi.fn().mockResolvedValue(undefined),
    forceClose: vi.fn(),
  }
}

describe('server bootstrap', () => {
  test('waits for HTTP binding after config, personas, database, and runtime composition', async () => {
    const calls: string[] = []
    const catalog = loadAndValidatePersonaCatalog()
    const database = { close: vi.fn() } as unknown as DatabaseClient
    const handle = serverHandle()

    const running = await bootstrap({
      loadConfig: () => {
        calls.push('config')
        return config
      },
      loadPersonaCatalog: () => {
        calls.push('personas')
        return catalog
      },
      initializeDatabase: async () => {
        calls.push('database')
        return database
      },
      createRuntime: async () => {
        calls.push('runtime')
        return {} as never
      },
      listen: () => {
        calls.push('listen')
        return handle
      },
    })

    expect(calls).toEqual([
      'config',
      'personas',
      'database',
      'runtime',
      'listen',
    ])
    expect(database.close).not.toHaveBeenCalled()
    await running.shutdown()
    expect(handle.beginClose).toHaveBeenCalledOnce()
    expect(handle.waitForClose).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
  })

  test('rejects a ready handle when a Player Worker fatal is already latched with HTTP bound', async () => {
    const database = {
      close: vi.fn(async () => undefined),
    } as unknown as DatabaseClient
    const handle = serverHandle()
    const worker = {
      fatal: Promise.resolve({
        category: 'playerWorkerTerminatedUnexpectedly' as const,
      }),
      start: vi.fn(async () => undefined),
      wake: vi.fn(),
      stop: vi.fn(async () => undefined),
    }
    const dispatcher = {
      fatal: new Promise(() => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      notify: vi.fn(),
      reconcileStartup: vi.fn(async () => []),
    }
    const playerRuntime = {
      worker,
      dispatcher,
      startupRecovery: {
        recoverAtStartup: vi.fn(async () => ({ replacementRunIds: [] })),
      },
      reconcileInitialTurns: vi.fn(async () => []),
    }

    await expect(
      bootstrap({
        loadConfig: () => config,
        initializeDatabase: async () => database,
        createRuntime: async () => ({ playerRuntime }) as never,
        listen: () => handle,
      }),
    ).rejects.toMatchObject({
      failure: 'playerWorkerTerminatedUnexpectedly',
    })
    expect(handle.beginClose).toHaveBeenCalledOnce()
    expect(worker.stop).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
  })

  test('waits for forced HTTP close before closing the database', async () => {
    vi.useFakeTimers()
    try {
      const calls: string[] = []
      let resolveDrain!: () => void
      const drain = new Promise<void>((resolve) => {
        resolveDrain = resolve
      })
      const handle: HttpServerHandle = {
        bound: Promise.resolve(),
        fatal: new Promise(() => undefined),
        beginClose: vi.fn(() => calls.push('http.beginClose')),
        waitForClose: vi.fn(() => drain),
        forceClose: vi.fn(() => {
          calls.push('http.forceClose')
        }),
      }
      const database = {
        close: vi.fn(async () => calls.push('database.close')),
      } as unknown as DatabaseClient
      const playerRuntime = {
        worker: {
          fatal: new Promise(() => undefined),
          start: vi.fn(async () => undefined),
          wake: vi.fn(),
          stop: vi.fn(async () => calls.push('worker.stop')),
        },
        dispatcher: {
          fatal: new Promise(() => undefined),
          start: vi.fn(async () => undefined),
          stop: vi.fn(async () => calls.push('dispatcher.stop')),
          notify: vi.fn(),
          reconcileStartup: vi.fn(async () => []),
        },
        startupRecovery: {
          recoverAtStartup: vi.fn(async () => ({ replacementRunIds: [] })),
        },
        reconcileInitialTurns: vi.fn(async () => []),
      }
      const running = await bootstrap({
        loadConfig: () => config,
        initializeDatabase: async () => database,
        createRuntime: async () => ({ playerRuntime }) as never,
        listen: () => handle,
      })

      const shutdown = running.shutdown()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(calls).toEqual([
        'http.beginClose',
        'dispatcher.stop',
        'worker.stop',
        'http.forceClose',
      ])
      expect(database.close).not.toHaveBeenCalled()
      resolveDrain()
      await shutdown

      expect(calls).toEqual([
        'http.beginClose',
        'dispatcher.stop',
        'worker.stop',
        'http.forceClose',
        'database.close',
      ])
      expect(handle.waitForClose).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  test('keeps startup recovery, initial reconciliation, merged wake, and Dispatcher start in order', async () => {
    const calls: string[] = []
    const database = {
      close: vi.fn(async () => undefined),
    } as unknown as DatabaseClient
    const handle = serverHandle()
    const playerRuntime = {
      worker: {
        fatal: new Promise(() => undefined),
        start: vi.fn(async () => calls.push('workerStart')),
        wake: vi.fn((_runtimeType, runIds) =>
          calls.push(`wake:${runIds.join(',')}`),
        ),
        stop: vi.fn(async () => undefined),
      },
      dispatcher: {
        fatal: new Promise(() => undefined),
        start: vi.fn(async () => calls.push('dispatcherStart')),
        stop: vi.fn(async () => undefined),
        notify: vi.fn(),
        reconcileStartup: vi.fn(async () => []),
      },
      startupRecovery: {
        recoverAtStartup: vi.fn(async () => {
          calls.push('startupRecovery')
          return {
            replacementRunIds: [
              '40000000-0000-4000-8000-000000000002',
              '40000000-0000-4000-8000-000000000001',
            ],
          }
        }),
      },
      reconcileInitialTurns: vi.fn(async () => {
        calls.push('reconcileInitialTurns')
        return [
          '40000000-0000-4000-8000-000000000003',
          '40000000-0000-4000-8000-000000000001',
        ]
      }),
    }

    const running = await bootstrap({
      loadConfig: () => config,
      initializeDatabase: async () => database,
      createRuntime: async () => ({ playerRuntime }) as never,
      listen: () => {
        calls.push('listen')
        return handle
      },
    })

    expect(calls).toEqual([
      'startupRecovery',
      'reconcileInitialTurns',
      'workerStart',
      'wake:40000000-0000-4000-8000-000000000001,40000000-0000-4000-8000-000000000002,40000000-0000-4000-8000-000000000003',
      'dispatcherStart',
      'listen',
    ])
    await running.shutdown()
  })

  test('records a failed Worker wake but still binds HTTP after the durable Worker starts', async () => {
    const onDiagnostic = vi.fn()
    const listen = vi.fn(() => serverHandle())
    const database = {
      close: vi.fn(async () => undefined),
    } as unknown as DatabaseClient
    const playerRuntime = {
      worker: {
        fatal: new Promise(() => undefined),
        start: vi.fn(async () => undefined),
        wake: vi.fn(() => {
          throw new Error('wake failed')
        }),
        stop: vi.fn(async () => undefined),
      },
      dispatcher: {
        fatal: new Promise(() => undefined),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        notify: vi.fn(),
        reconcileStartup: vi.fn(async () => []),
      },
      startupRecovery: {
        recoverAtStartup: vi.fn(async () => ({
          replacementRunIds: ['40000000-0000-4000-8000-000000000001'],
        })),
      },
      reconcileInitialTurns: vi.fn(async () => []),
    }

    const running = await bootstrap({
      loadConfig: () => config,
      initializeDatabase: async () => database,
      createRuntime: async () => ({ playerRuntime }) as never,
      listen,
      onDiagnostic,
    } as never)

    expect(onDiagnostic).toHaveBeenCalledWith({
      category: 'startup_worker_wake_failed',
    })
    expect(listen).toHaveBeenCalledOnce()
    await running.shutdown()
  })

  test('stops a Worker whose start rejects and reports the stable start failure', async () => {
    const database = {
      close: vi.fn(async () => undefined),
    } as unknown as DatabaseClient
    const listen = vi.fn(() => serverHandle())
    const worker = {
      fatal: new Promise(() => undefined),
      start: vi.fn(async () => {
        throw new Error('partial worker start failed')
      }),
      wake: vi.fn(),
      stop: vi.fn(async () => undefined),
    }
    const dispatcher = {
      fatal: new Promise(() => undefined),
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      notify: vi.fn(),
      reconcileStartup: vi.fn(async () => []),
    }
    const playerRuntime = {
      worker,
      dispatcher,
      startupRecovery: {
        recoverAtStartup: vi.fn(async () => ({ replacementRunIds: [] })),
      },
      reconcileInitialTurns: vi.fn(async () => []),
    }

    await expect(
      bootstrap({
        loadConfig: () => config,
        initializeDatabase: async () => database,
        createRuntime: async () => ({ playerRuntime }) as never,
        listen,
      }),
    ).rejects.toMatchObject({ failure: 'workerStartFailed' })
    expect(worker.stop).toHaveBeenCalledOnce()
    expect(dispatcher.stop).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
    expect(listen).not.toHaveBeenCalled()
  })

  test('maps a Dispatcher start rejection after stopping both Player resources', async () => {
    const database = {
      close: vi.fn(async () => undefined),
    } as unknown as DatabaseClient
    const listen = vi.fn(() => serverHandle())
    const worker = {
      fatal: new Promise(() => undefined),
      start: vi.fn(async () => undefined),
      wake: vi.fn(),
      stop: vi.fn(async () => undefined),
    }
    const dispatcher = {
      fatal: new Promise(() => undefined),
      start: vi.fn(async () => {
        throw new Error('dispatcher start failed')
      }),
      stop: vi.fn(async () => undefined),
      notify: vi.fn(),
      reconcileStartup: vi.fn(async () => []),
    }
    const playerRuntime = {
      worker,
      dispatcher,
      startupRecovery: {
        recoverAtStartup: vi.fn(async () => ({ replacementRunIds: [] })),
      },
      reconcileInitialTurns: vi.fn(async () => []),
    }

    await expect(
      bootstrap({
        loadConfig: () => config,
        initializeDatabase: async () => database,
        createRuntime: async () => ({ playerRuntime }) as never,
        listen,
      }),
    ).rejects.toMatchObject({ failure: 'dispatcherStartFailed' })
    expect(worker.stop).toHaveBeenCalledOnce()
    expect(dispatcher.stop).toHaveBeenCalledOnce()
    expect(database.close).toHaveBeenCalledOnce()
    expect(listen).not.toHaveBeenCalled()
  })

  test('aborts during HTTP binding before ready and closes HTTP before Player resources', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    const database = {
      close: vi.fn(async () => calls.push('database.close')),
    } as unknown as DatabaseClient
    const handle: HttpServerHandle = {
      bound: new Promise(() => undefined),
      fatal: new Promise(() => undefined),
      beginClose: vi.fn(() => calls.push('http.beginClose')),
      waitForClose: vi.fn(async () => undefined),
      forceClose: vi.fn(),
    }
    const playerRuntime = {
      worker: {
        fatal: new Promise(() => undefined),
        start: vi.fn(async () => undefined),
        wake: vi.fn(),
        stop: vi.fn(async () => calls.push('worker.stop')),
      },
      dispatcher: {
        fatal: new Promise(() => undefined),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => calls.push('dispatcher.stop')),
        notify: vi.fn(),
        reconcileStartup: vi.fn(async () => []),
      },
      startupRecovery: {
        recoverAtStartup: vi.fn(async () => ({ replacementRunIds: [] })),
      },
      reconcileInitialTurns: vi.fn(async () => []),
    }
    const listen = vi.fn(() => handle)

    const booting = bootstrap({
      signal: controller.signal,
      loadConfig: () => config,
      initializeDatabase: async () => database,
      createRuntime: async () => ({ playerRuntime }) as never,
      listen,
    })
    await vi.waitFor(() => expect(listen).toHaveBeenCalledOnce())
    controller.abort()

    await expect(booting).rejects.toMatchObject({
      name: 'ServiceStartupAborted',
    })
    expect(calls).toEqual([
      'http.beginClose',
      'dispatcher.stop',
      'worker.stop',
      'database.close',
    ])
  })

  test('maps a configuration failure to a stable startup result', async () => {
    await expect(
      bootstrap({
        loadConfig: () => {
          throw new ServerConfigurationError()
        },
      }),
    ).rejects.toMatchObject({
      failure: 'configurationFailed',
    } satisfies Partial<ServiceStartupError>)
  })

  test('maps catalog and database gates to stable startup results', async () => {
    await expect(
      bootstrap({
        loadConfig: () => config,
        loadPersonaCatalog: () => {
          throw new PersonaCatalogValidationError()
        },
      }),
    ).rejects.toMatchObject({ failure: 'configurationFailed' })
    await expect(
      bootstrap({
        loadConfig: () => config,
        initializeDatabase: async () => {
          throw new StartupError('migrationRecordsMissing')
        },
      }),
    ).rejects.toMatchObject({ failure: 'databaseFailed' })
  })

  test('closes the initialized database when runtime composition fails', async () => {
    const database = {
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as DatabaseClient

    await expect(
      bootstrap({
        loadConfig: () => config,
        initializeDatabase: async () => database,
        createRuntime: async () => {
          throw new Error('composition failed')
        },
      }),
    ).rejects.toMatchObject({ failure: 'unexpectedStartupFailure' })
    expect(database.close).toHaveBeenCalledOnce()
  })
})
