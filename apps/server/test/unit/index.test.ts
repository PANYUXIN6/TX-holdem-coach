import { describe, expect, test, vi } from 'vitest'
import { loadServerConfig, ServerConfigurationError } from '../../src/config.js'
import { bootstrap } from '../../src/bootstrap.js'
import { StartupError } from '../../src/startup.js'

const config = loadServerConfig({
  DATABASE_URL:
    'postgresql://postgres.project-ref:runtime-secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
})

describe('server bootstrap', () => {
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
})
