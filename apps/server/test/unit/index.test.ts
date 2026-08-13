import { describe, expect, test, vi } from 'vitest'
import { loadServerConfig, ServerConfigurationError } from '../../src/config.js'
import { bootstrap } from '../../src/bootstrap.js'
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

describe('server bootstrap', () => {
  test('loads the persona catalog after config and before database/listen', async () => {
    const calls: string[] = []
    const catalog = loadAndValidatePersonaCatalog()
    const database = {
      close: vi.fn(),
    } as unknown as DatabaseClient

    await bootstrap({
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
      createRuntime: async (_config, receivedCatalog, receivedDatabase) => {
        calls.push('runtime')
        expect(receivedCatalog).toBe(catalog)
        expect(receivedDatabase).toBe(database)
        return {} as never
      },
      listen: () => {
        calls.push('listen')
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
  })

  test('sanitizes catalog validation failures before database initialization', async () => {
    const initializeDatabase = vi.fn()
    const listen = vi.fn()
    const logError = vi.fn()
    const setExitCode = vi.fn()

    await bootstrap({
      loadConfig: () => config,
      loadPersonaCatalog: () => {
        throw new PersonaCatalogValidationError()
      },
      initializeDatabase,
      listen,
      logError,
      setExitCode,
    })

    expect(initializeDatabase).not.toHaveBeenCalled()
    expect(listen).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('人物目录配置无效，服务未启动。')
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  test('does not listen when the database gate fails', async () => {
    const listen = vi.fn()
    const logError = vi.fn()
    const setExitCode = vi.fn()

    await bootstrap({
      loadConfig: () => config,
      initializeDatabase: async () => {
        throw new StartupError('migrationRecordsMissing')
      },
      listen,
      logError,
      setExitCode,
    })

    expect(listen).not.toHaveBeenCalled()
    expect(logError).toHaveBeenCalledWith('数据库迁移记录缺失，服务未启动。')
    expect(setExitCode).toHaveBeenCalledWith(1)
  })

  test('keeps server configuration failures separate from database startup failures', async () => {
    const logError = vi.fn()
    const setExitCode = vi.fn()

    await bootstrap({
      loadConfig: () => {
        throw new ServerConfigurationError()
      },
      logError,
      setExitCode,
    })

    expect(logError).toHaveBeenCalledWith(
      '服务配置无效，请检查后端 .env 文件。',
    )
    expect(setExitCode).toHaveBeenCalledWith(1)
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
