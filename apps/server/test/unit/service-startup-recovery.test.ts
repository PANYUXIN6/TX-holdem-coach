import { describe, expect, test, vi } from 'vitest'
import { ResourceNotFoundError } from '../../src/persistence/errors.js'
import { createServiceStartupRecovery } from '../../src/sessions/startup-recovery/service-startup-recovery.js'

const firstSessionId = '10000000-0000-4000-8000-000000000001'
const secondSessionId = '20000000-0000-4000-8000-000000000002'

function transactionSql(input: { readonly onCommit?: () => void } = {}) {
  return {
    begin: async (operation: (transaction: object) => Promise<unknown>) => {
      const result = await operation({})
      input.onCommit?.()
      return result
    },
  } as never
}

function readyRecovery(sessionId: string) {
  return {
    kind: 'ready',
    locked: { sessionId, nextEventSeq: 0 },
  } as never
}

function unchangedRestartRecovery() {
  return {
    recovery: { kind: 'unchanged' },
    runEffects: [],
  } as never
}

describe('service startup recovery', () => {
  test('keeps an empty active-session scan zero-write and returns no wake intents', async () => {
    const recoverAfterProcessRestartWithEffects = vi.fn()
    const recovery = createServiceStartupRecovery({
      candidateReader: {
        async listActiveSessionIds() {
          return []
        },
      },
      sql: transactionSql(),
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

    await expect(
      recovery.recoverAtStartup({ signal: new AbortController().signal }),
    ).resolves.toEqual({
      replacementRunIds: [],
    })
    expect(recoverAfterProcessRestartWithEffects).not.toHaveBeenCalled()
  })

  test('allows the current transaction to settle, then stops before the next candidate after abort', async () => {
    const controller = new AbortController()
    const recoverSessionForMutation = vi.fn(
      async (_transaction, _owner, sessionId) => {
        if (sessionId === firstSessionId) controller.abort()
        return readyRecovery(sessionId)
      },
    )
    const recovery = createServiceStartupRecovery({
      candidateReader: {
        async listActiveSessionIds() {
          return [firstSessionId, secondSessionId]
        },
      },
      sql: transactionSql(),
      owner: {} as never,
      recoveryRepository: { recoverSessionForMutation } as never,
      playerRestartRecovery: {
        recoverAfterProcessRestartWithEffects: vi.fn(async () =>
          unchangedRestartRecovery(),
        ),
        publishCommittedRestartRunEffects: vi.fn(),
      },
      committedEventPublisher: { publish: vi.fn() },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await expect(
      recovery.recoverAtStartup({ signal: controller.signal } as never),
    ).rejects.toMatchObject({ name: 'StartupRecoveryAborted' })
    expect(recoverSessionForMutation).toHaveBeenCalledTimes(1)
  })

  test('does not treat a missing Player restart resource as a skipped Session candidate', async () => {
    const recovery = createServiceStartupRecovery({
      candidateReader: {
        async listActiveSessionIds() {
          return [firstSessionId]
        },
      },
      sql: transactionSql(),
      owner: {} as never,
      recoveryRepository: {
        recoverSessionForMutation: vi.fn(async () =>
          readyRecovery(firstSessionId),
        ),
      } as never,
      playerRestartRecovery: {
        recoverAfterProcessRestartWithEffects: vi.fn(async () => {
          throw new ResourceNotFoundError()
        }),
        publishCommittedRestartRunEffects: vi.fn(),
      },
      committedEventPublisher: { publish: vi.fn() },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await expect(
      recovery.recoverAtStartup({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      failure: 'startupRecoveryFailed',
    })
  })

  test('maps an invalid Player restart union to the closed contract failure', async () => {
    const recovery = createServiceStartupRecovery({
      candidateReader: {
        async listActiveSessionIds() {
          return [firstSessionId]
        },
      },
      sql: transactionSql(),
      owner: {} as never,
      recoveryRepository: {
        recoverSessionForMutation: vi.fn(async () =>
          readyRecovery(firstSessionId),
        ),
      } as never,
      playerRestartRecovery: {
        recoverAfterProcessRestartWithEffects: vi.fn(
          async () =>
            ({
              recovery: {
                kind: 'replacementQueued',
                replacementRunId: 'not-a-uuid',
                newlyPersistedEvents: [],
              },
              runEffects: [],
            }) as never,
        ),
        publishCommittedRestartRunEffects: vi.fn(),
      },
      committedEventPublisher: { publish: vi.fn() },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await expect(
      recovery.recoverAtStartup({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      failure: 'playerRestartRecoveryContractInvalid',
    })
  })

  test('rejects a restart result missing run effects before its transaction commits', async () => {
    const onCommit = vi.fn()
    const publish = vi.fn()
    const publishCommittedRestartRunEffects = vi.fn()
    const recovery = createServiceStartupRecovery({
      candidateReader: {
        async listActiveSessionIds() {
          return [firstSessionId]
        },
      },
      sql: transactionSql({ onCommit }),
      owner: {} as never,
      recoveryRepository: {
        recoverSessionForMutation: vi.fn(async () =>
          readyRecovery(firstSessionId),
        ),
      } as never,
      playerRestartRecovery: {
        recoverAfterProcessRestartWithEffects: vi.fn(
          async () => ({ recovery: { kind: 'unchanged' } }) as never,
        ),
        publishCommittedRestartRunEffects,
      },
      committedEventPublisher: { publish },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await expect(
      recovery.recoverAtStartup({ signal: new AbortController().signal }),
    ).rejects.toMatchObject({
      failure: 'playerRestartRecoveryContractInvalid',
    })
    expect(onCommit).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(publishCommittedRestartRunEffects).not.toHaveBeenCalled()
  })
})
