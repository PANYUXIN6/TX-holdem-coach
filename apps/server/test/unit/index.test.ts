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

  test('drains HTTP after stopping Player runtime and force-closes a stuck SSE connection before database close', async () => {
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
          resolveDrain()
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
      await shutdown

      expect(calls).toEqual([
        'http.beginClose',
        'dispatcher.stop',
        'worker.stop',
        'http.forceClose',
        'database.close',
      ])
      expect(handle.waitForClose).toHaveBeenCalledOnce()
    } finally {
      vi.useRealTimers()
    }
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
    ).rejects.toThrow('composition failed')
    expect(database.close).toHaveBeenCalledOnce()
  })
})
