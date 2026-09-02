import { describe, expect, test, vi } from 'vitest'
import {
  createPlayerTurnDispatcher,
  type PlayerCurrentTurnCoordinator,
} from '../../src/agents/player/player-turn-dispatcher.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const runId = '40000000-0000-4000-8000-000000000001'

describe('PlayerTurnDispatcher', () => {
  test('startup reconcile serially returns newly queued runs without waking a stopped Worker', async () => {
    const reconcileCurrentTurn = vi.fn(async () => ({
      kind: 'started' as const,
      runId,
    })) satisfies PlayerCurrentTurnCoordinator['reconcileCurrentTurn']
    const wake = vi.fn()
    const dispatcher = createPlayerTurnDispatcher({
      currentTurnCoordinator: { reconcileCurrentTurn },
      candidateReader: {
        async listActiveSessionIds() {
          return [sessionId]
        },
      },
      worker: { wake },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await expect(dispatcher.reconcileStartup([sessionId])).resolves.toEqual([
      runId,
    ])
    expect(reconcileCurrentTurn).toHaveBeenCalledWith({
      sessionId,
      trigger: 'startupRepair',
      observedAt: '2026-09-01T00:00:00.000Z',
    })
    expect(wake).not.toHaveBeenCalled()
  })

  test('deduplicates a committed hint and wakes the installed Player Worker', async () => {
    const reconcileCurrentTurn = vi.fn(async () => ({
      kind: 'alreadyActive' as const,
      runId,
    })) satisfies PlayerCurrentTurnCoordinator['reconcileCurrentTurn']
    const wake = vi.fn()
    const dispatcher = createPlayerTurnDispatcher({
      currentTurnCoordinator: { reconcileCurrentTurn },
      candidateReader: {
        async listActiveSessionIds() {
          return []
        },
      },
      worker: { wake },
      now: () => '2026-09-01T00:00:00.000Z',
    })

    await dispatcher.start()
    dispatcher.notify(sessionId)
    dispatcher.notify(sessionId)
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce())
    await dispatcher.stop()

    expect(reconcileCurrentTurn).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith('player', [runId])
  })
})
