import { describe, expect, test, vi } from 'vitest'
import { createServiceStartupRecovery } from '../../src/sessions/startup-recovery/service-startup-recovery.js'

describe('service startup recovery', () => {
  test('keeps an empty active-session scan zero-write and returns no wake intents', async () => {
    const recoverAfterProcessRestartWithEffects = vi.fn()
    const recovery = createServiceStartupRecovery({
      candidateReader: {
        async listActiveSessionIds() {
          return []
        },
      },
      sql: (() => undefined) as never,
      owner: {} as never,
      recoveryRepository: {
        recoverSessionForMutation: vi.fn(),
      } as never,
      playerRestartRecovery: {
        recoverAfterProcessRestartWithEffects,
        publishCommittedRestartRunEffects: vi.fn(),
      },
      committedEventPublisher: { publish: vi.fn() },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await expect(recovery.recoverAtStartup()).resolves.toEqual({
      replacementRunIds: [],
    })
    expect(recoverAfterProcessRestartWithEffects).not.toHaveBeenCalled()
  })
})
