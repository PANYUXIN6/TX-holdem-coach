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

type AnticipatedUsage = Omit<ExecutionUsage, 'attempts'>

const emptyAnticipatedUsage: AnticipatedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  capabilityInvocations: 0,
  costMicrounits: 0,
  elapsedMs: 0,
}

function budgetCheck(
  anticipatedUsage: Partial<AnticipatedUsage> = {},
  purpose: 'continue' | 'startAttempt' = 'continue',
) {
  return {
    purpose,
    anticipatedUsage: { ...emptyAnticipatedUsage, ...anticipatedUsage },
  } as const
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

  test('classifies an operation that would exceed each hard limit and the minimum attempt window', () => {
    const budget = playerRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })
    const cases = [
      [
        'inputTokens',
        { inputTokens: budget.maxInputTokens },
        { inputTokens: 1 },
      ],
      [
        'outputTokens',
        { outputTokens: budget.maxOutputTokens },
        { outputTokens: 1 },
      ],
      [
        'capabilityInvocations',
        { capabilityInvocations: budget.maxCapabilityInvocations },
        { capabilityInvocations: 1 },
      ],
      [
        'cost',
        { costMicrounits: budget.maxCostMicrounits },
        { costMicrounits: 1 },
      ],
      ['wallClock', { elapsedMs: budget.maxWallClockMs }, { elapsedMs: 1 }],
    ] as const

    for (const [reason, addition, anticipatedUsage] of cases) {
      expect(
        evaluateExecutionBudget(
          budget,
          { ...emptyUsage, ...addition },
          budgetCheck(anticipatedUsage),
        ),
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
        budgetCheck({}, 'startAttempt'),
      ),
    ).toEqual({ kind: 'exhausted', reason: 'minimumAttemptWindow' })
    expect(evaluateExecutionBudget(budget, emptyUsage, budgetCheck())).toEqual({
      kind: 'allowed',
      remainingWallClockMs: budget.maxWallClockMs,
    })
  })

  test('binds startAttempt to one protocol-owned Attempt increment', () => {
    const budget = playerRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })

    expect(
      evaluateExecutionBudget(
        budget,
        { ...emptyUsage, attempts: budget.maxAttempts },
        budgetCheck({}, 'startAttempt'),
      ),
    ).toEqual({ kind: 'exhausted', reason: 'attempts' })
    expect(() =>
      evaluateExecutionBudget(budget, emptyUsage, {
        purpose: 'startAttempt',
        anticipatedUsage: {
          ...emptyAnticipatedUsage,
          attempts: 0,
        },
      }),
    ).toThrow('Agent Foundation 协议校验失败。')
  })

  test('rejects an Attempt increment disguised as continue', () => {
    const budget = playerRuntimeBudgetPolicyV1.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
    })

    expect(() =>
      evaluateExecutionBudget(
        budget,
        {
          ...emptyUsage,
          elapsedMs:
            budget.maxWallClockMs - budget.minimumAttemptStartRemainingMs + 1,
        },
        {
          purpose: 'continue',
          anticipatedUsage: {
            ...emptyAnticipatedUsage,
            attempts: 1,
          },
        },
      ),
    ).toThrow('Agent Foundation 协议校验失败。')
  })

  test('allows zero-consumption stages when capability invocations are disabled', () => {
    const budget = createExecutionBudget({
      ...playerRuntimeBudgetPolicyV1.createSnapshot({
        runtimeType: 'player',
        attemptTimeoutSeconds: 15,
        decisionDeadlineSeconds: 45,
      }),
      maxCapabilityInvocations: 0,
    })

    expect(
      evaluateExecutionBudget(budget, emptyUsage, budgetCheck()),
    ).toMatchObject({ kind: 'allowed' })
    expect(
      evaluateExecutionBudget(
        budget,
        emptyUsage,
        budgetCheck({ capabilityInvocations: 1 }),
      ),
    ).toEqual({ kind: 'exhausted', reason: 'capabilityInvocations' })
  })

  test('allows zero-cost stages when monetary spend is disabled', () => {
    const budget = createExecutionBudget({
      ...playerRuntimeBudgetPolicyV1.createSnapshot({
        runtimeType: 'player',
        attemptTimeoutSeconds: 15,
        decisionDeadlineSeconds: 45,
      }),
      maxCostMicrounits: 0,
    })

    expect(
      evaluateExecutionBudget(budget, emptyUsage, budgetCheck()),
    ).toMatchObject({ kind: 'allowed' })
    expect(
      evaluateExecutionBudget(
        budget,
        emptyUsage,
        budgetCheck({ costMicrounits: 1 }),
      ),
    ).toEqual({ kind: 'exhausted', reason: 'cost' })
  })
})
