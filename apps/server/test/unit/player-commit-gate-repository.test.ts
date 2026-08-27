import { describe, expect, test, vi } from 'vitest'
import {
  createPlayerCommitGateRepository,
  PlayerCommitGateError,
} from '../../src/persistence/player-commit-gate-repository.js'

describe('Player Commit Gate repository capability', () => {
  test('rejects forged capability before issuing SQL', async () => {
    const repository = createPlayerCommitGateRepository()
    const transaction = vi.fn() as never

    await expect(
      repository.markCommitted({
        transaction,
        owner: {} as never,
        capability: {} as never,
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlayerCommitGateError>>({
        code: 'player_commit_input_rejected',
      }),
    )
    expect(transaction).not.toHaveBeenCalled()
  })

  test('rejects a forged live-facts object before issuing a capability', () => {
    const repository = createPlayerCommitGateRepository()
    const transaction = vi.fn() as never

    expect(() =>
      repository.issueCommitCapability({
        transaction,
        owner: {} as never,
        liveFacts: {} as never,
      }),
    ).toThrow(
      expect.objectContaining<Partial<PlayerCommitGateError>>({
        code: 'player_commit_input_rejected',
      }),
    )
    expect(transaction).not.toHaveBeenCalled()
  })
})
