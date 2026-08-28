import { describe, expect, test } from 'vitest'
import {
  FoundationProtocolError,
  ModelGatewayProtocolError,
} from '../../src/agents/foundation/errors.js'
import { PlayerRuntimeExecutionError } from '../../src/agents/player/player-runtime-executor.js'
import { PlayerCommitGateError } from '../../src/persistence/player-commit-gate-repository.js'
import { DatabaseOperationError } from '../../src/persistence/errors.js'
import { classifyPlayerExecutionFailure } from '../../src/agents/player/player-execution-settlement.js'

describe('Player execution settlement classification', () => {
  test.each([
    [
      new PlayerRuntimeExecutionError('player_decision_authority_lost'),
      { kind: 'stale', reason: 'player_decision_authority_lost' },
    ],
    [
      new PlayerCommitGateError('player_commit_decision_stale'),
      { kind: 'stale', reason: 'player_commit_decision_stale' },
    ],
    [
      new PlayerRuntimeExecutionError('player_decision_persistence_rejected'),
      { kind: 'deferred', reason: 'local_persistence_error' },
    ],
    [
      new DatabaseOperationError(),
      { kind: 'deferred', reason: 'local_persistence_error' },
    ],
    [
      new ModelGatewayProtocolError('provider_timeout'),
      { kind: 'finalFailure', reason: 'provider_timeout' },
    ],
    [
      new FoundationProtocolError('capabilityDeadlineExhausted'),
      { kind: 'finalFailure', reason: 'execution_deadline_exhausted' },
    ],
    [
      new PlayerRuntimeExecutionError('player_decision_dependency_missing'),
      { kind: 'finalFailure', reason: 'player_dependency_unavailable' },
    ],
  ])(
    'classifies known stable outcomes without exposing error details',
    (error, expected) => {
      expect(
        classifyPlayerExecutionFailure(error, new AbortController().signal),
      ).toEqual(expected)
    },
  )

  test('treats aborts as deferred and unknown failures as a stable internal pause reason', () => {
    const controller = new AbortController()
    controller.abort('runtime_cancelled')

    expect(
      classifyPlayerExecutionFailure(
        new ModelGatewayProtocolError('provider_timeout'),
        controller.signal,
      ),
    ).toEqual({ kind: 'deferred', reason: 'runtime_cancelled' })
    expect(
      classifyPlayerExecutionFailure(
        new Error('sensitive raw failure'),
        new AbortController().signal,
      ),
    ).toEqual({ kind: 'finalFailure', reason: 'player_internal_failure' })
  })
})
