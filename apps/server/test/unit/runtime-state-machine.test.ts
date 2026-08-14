import { describe, expect, test } from 'vitest'
import {
  assertModelOutputHasNoRuntimeControlFields,
  assertRuntimeCheckpoint,
  createRuntimeStateMachineDefinition,
  transitionRuntimeState,
} from '../../src/agents/foundation/runtime-state-machine.js'
import { coachRuntimeStateMachineV1 } from '../../src/agents/coach/foundation-definition.js'
import { playerRuntimeStateMachineV1 } from '../../src/agents/player/foundation-definition.js'

describe('M4.1 runtime state machines', () => {
  test('advances the fixed Player and Coach happy paths', () => {
    let player = playerRuntimeStateMachineV1.initialState
    for (const event of [
      'contextPrepared',
      'preprocessingCompleted',
      'modelCompleted',
      'outputValid',
      'commitSucceeded',
    ]) {
      player = transitionRuntimeState(
        playerRuntimeStateMachineV1,
        player,
        event,
      )
    }
    expect(player).toBe('succeeded')

    let coach = coachRuntimeStateMachineV1.initialState
    for (const event of [
      'decisionContextPrepared',
      'evidencePrepared',
      'decisionAnalysisCompleted',
      'hindsightContextPrepared',
      'hindsightAnalysisCompleted',
      'reportValid',
      'commitSucceeded',
    ]) {
      coach = transitionRuntimeState(coachRuntimeStateMachineV1, coach, event)
    }
    expect(coach).toBe('succeeded')
  })

  test('permits only declared repair and checkpoint states', () => {
    expect(
      transitionRuntimeState(
        playerRuntimeStateMachineV1,
        'outputValidation',
        'repairRequested',
      ),
    ).toBe('modelPending')
    expect(() =>
      transitionRuntimeState(
        playerRuntimeStateMachineV1,
        'modelPending',
        'toolRequestedByModel',
      ),
    ).toThrow()
    expect(() =>
      transitionRuntimeState(
        playerRuntimeStateMachineV1,
        'succeeded',
        'contextPrepared',
      ),
    ).toThrow()
    expect(() =>
      assertRuntimeCheckpoint(playerRuntimeStateMachineV1, 'preprocessing'),
    ).toThrow()
    expect(() =>
      assertRuntimeCheckpoint(playerRuntimeStateMachineV1, 'modelPending'),
    ).not.toThrow()
    expect(() =>
      assertModelOutputHasNoRuntimeControlFields({
        action: 'check',
        nextState: 'commitPending',
      }),
    ).toThrow()
    expect(() =>
      assertModelOutputHasNoRuntimeControlFields({ action: 'check' }),
    ).not.toThrow()
  })

  test('rejects ambiguous, unreachable and terminal outgoing graphs', () => {
    const base = {
      runtimeType: 'player' as const,
      stateMachineVersion: 1,
      initialState: 'start',
      states: ['start', 'done'],
      checkpointStates: ['start'],
      terminalStates: ['done'],
    }
    expect(() =>
      createRuntimeStateMachineDefinition({
        ...base,
        transitions: [
          { from: 'start', event: 'finish', to: 'done' },
          { from: 'start', event: 'finish', to: 'start' },
        ],
      }),
    ).toThrow()
    expect(() =>
      createRuntimeStateMachineDefinition({
        ...base,
        states: ['start', 'orphan', 'done'],
        transitions: [{ from: 'start', event: 'finish', to: 'done' }],
      }),
    ).toThrow()
    expect(() =>
      createRuntimeStateMachineDefinition({
        ...base,
        transitions: [
          { from: 'start', event: 'finish', to: 'done' },
          { from: 'done', event: 'restart', to: 'start' },
        ],
      }),
    ).toThrow()
  })
})
