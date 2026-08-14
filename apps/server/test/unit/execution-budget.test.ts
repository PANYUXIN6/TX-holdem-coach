import { describe, expect, test } from 'vitest'
import {
  createExecutionBudget,
  evaluateExecutionBudget,
  type ExecutionUsage,
} from '../../src/agents/foundation/execution-budget.js'
import { coachRuntimeBudgetPolicyV1 } from '../../src/agents/coach/foundation-definition.js'
import { playerRuntimeBudgetPolicyV1 } from '../../src/agents/player/foundation-definition.js'

const emptyUsage: ExecutionUsage = {
  attempts: 0,
  inputTokens: 0,
  outputTokens: 0,
  capabilityInvocations: 0,
  costMicrounits: 0,
  elapsedMs: 0,
}

describe('M4.1 execution budget', () => {
  test('maps strict Player timeouts and keeps Player and Coach snapshots isolated', () => {
    const player = playerRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })
    const coach = coachRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'coach',
    })

    expect(player).toMatchObject({
      attemptTimeoutMs: 15_000,
      maxWallClockMs: 45_000,
      minimumAttemptStartRemainingMs: 5_000,
    })
    expect(coach.maxSystemConcurrentRuns).not.toBe(
      player.maxSystemConcurrentRuns,
    )
    expect(Object.isFrozen(player)).toBe(true)
    expect(Object.isFrozen(coach)).toBe(true)
  })

  test('rejects invalid or unbounded sentinel budgets', () => {
    const valid = playerRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })

    for (const invalid of [
      { ...valid, maxAttempts: 0 },
      { ...valid, attemptTimeoutMs: valid.maxWallClockMs + 1 },
      { ...valid, minimumAttemptStartRemainingMs: valid.attemptTimeoutMs + 1 },
      { ...valid, maxOwnerConcurrentRuns: valid.maxSystemConcurrentRuns + 1 },
      { ...valid, maxInputTokens: Number.MAX_SAFE_INTEGER + 1 },
    ]) {
      expect(() => createExecutionBudget(invalid)).toThrow(
        'Agent Foundation 协议校验失败。',
      )
    }
  })

  test('classifies every hard limit and the minimum attempt window without resetting usage', () => {
    const budget = playerRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })
    const cases = [
      ['attempts', { attempts: budget.maxAttempts }],
      ['inputTokens', { inputTokens: budget.maxInputTokens }],
      ['outputTokens', { outputTokens: budget.maxOutputTokens }],
      [
        'capabilityInvocations',
        { capabilityInvocations: budget.maxCapabilityInvocations },
      ],
      ['cost', { costMicrounits: budget.maxCostMicrounits }],
      ['wallClock', { elapsedMs: budget.maxWallClockMs }],
    ] as const

    for (const [reason, addition] of cases) {
      expect(
        evaluateExecutionBudget(budget, { ...emptyUsage, ...addition }),
      ).toEqual({ kind: 'exhausted', reason })
    }
    expect(
      evaluateExecutionBudget(
        budget,
        {
          ...emptyUsage,
          elapsedMs:
            budget.maxWallClockMs - budget.minimumAttemptStartRemainingMs + 1,
        },
        'startAttempt',
      ),
    ).toEqual({ kind: 'exhausted', reason: 'minimumAttemptWindow' })
    expect(evaluateExecutionBudget(budget, emptyUsage)).toEqual({
      kind: 'allowed',
      remainingWallClockMs: budget.maxWallClockMs,
    })
  })
})
