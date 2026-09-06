import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { encodeAttemptAudit } from '../../src/agents/audit/attempt-audit-codec.js'
import { encodeExecutionBudgetAudit } from '../../src/agents/audit/execution-budget-audit-codec.js'
import { AgentRunTransitionError } from '../../src/agents/foundation/agent-run-lifecycle.js'
import {
  issueRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../../src/agents/foundation/runtime-ports.js'
import { playerRuntimeBudgetPolicy } from '../../src/agents/player/foundation-definition.js'
import { createAgentFoundationAuditRepository as createRawAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import type {
  FinishAgentAttemptAuditInput,
  StartAgentAttemptAuditInput,
} from '../../src/persistence/agent-foundation-audit-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const agentRunId = '44444444-4444-4444-8444-444444444444'

function testAuthority(runId = agentRunId) {
  return issueRuntimeCommitAuthority({
    runtimeType: 'player',
    runId,
    leaseOwner: 'unit-test:player:0',
    fencingToken: 1,
  })
}

function createAgentFoundationAuditRepository() {
  const repository = createRawAgentFoundationAuditRepository()
  return {
    ...repository,
    startAgentAttemptAudit: (
      transaction: TransactionSql,
      owner: Parameters<typeof repository.startAgentAttemptAudit>[1],
      input: Omit<
        StartAgentAttemptAuditInput,
        | 'reservedInputTokens'
        | 'reservedOutputTokens'
        | 'reservedCostMicrounits'
      > &
        Partial<
          Pick<
            StartAgentAttemptAuditInput,
            | 'reservedInputTokens'
            | 'reservedOutputTokens'
            | 'reservedCostMicrounits'
          >
        >,
    ) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        testAuthority(input.agentRunId),
        {
          reservedInputTokens: 100,
          reservedOutputTokens: 20,
          reservedCostMicrounits: 800,
          ...input,
        },
      ),
    finishAgentAttemptAudit: (
      transaction: TransactionSql,
      owner: Parameters<typeof repository.finishAgentAttemptAudit>[1],
      input: Omit<
        FinishAgentAttemptAuditInput,
        'usageAccounting' | 'costAccounting'
      > &
        Partial<
          Pick<
            FinishAgentAttemptAuditInput,
            'usageAccounting' | 'costAccounting'
          >
        >,
    ) =>
      repository.finishAgentAttemptAudit(
        transaction,
        owner,
        testAuthority(input.agentRunId),
        {
          usageAccounting:
            input.lifecycle === 'completed'
              ? 'providerReported'
              : 'reservedUpperBound',
          costAccounting:
            input.lifecycle === 'completed'
              ? 'allInputAtCacheMiss'
              : 'reservedUpperBound',
          ...input,
        },
      ),
  }
}

type SqlResponse =
  unknown | Error | ((values: readonly unknown[]) => unknown | Error)

function createTransactionMock(
  responses: readonly SqlResponse[],
): TransactionSql {
  const pending = [...responses]
  const transaction = ((
    template: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    if (!('raw' in template)) throw new Error('Unexpected helper call.')
    const sqlText = template.join(' ')
    const nextPending = pending[0]
    if (
      sqlText.includes("AND lifecycle = 'running'") &&
      Array.isArray(nextPending) &&
      nextPending.some(
        (row) => row !== null && typeof row === 'object' && 'attemptId' in row,
      )
    ) {
      return Promise.resolve([
        {
          agentRunId,
          sessionId,
          runtime: 'player',
          fencingToken: 1,
          deadlineExpired: false,
        },
      ])
    }
    const next = pending.shift()
    const rawResponse = typeof next === 'function' ? next(values) : next
    const response = Array.isArray(rawResponse)
      ? rawResponse.map((row) => {
          if (
            row !== null &&
            typeof row === 'object' &&
            Object.keys(row).sort().join(',') === 'agentRunId,sessionId'
          ) {
            return {
              ...row,
              runtime: 'player',
              fencingToken: 1,
              deadlineExpired: false,
            }
          }
          if (
            row !== null &&
            typeof row === 'object' &&
            'attemptId' in row &&
            'lifecycle' in row &&
            !('fencingToken' in row)
          ) {
            return { ...row, fencingToken: 1 }
          }
          return row
        })
      : rawResponse
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
  })
  return transaction
}

async function resolvedOwner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

const storedPlayerBudget = encodeExecutionBudgetAudit(
  playerRuntimeBudgetPolicy.createSnapshot({
    runtimeType: 'player',
    attemptTimeoutSeconds: 15,
    decisionDeadlineSeconds: 45,
  }),
)

function finishBudgetResponses(attemptId: string): readonly SqlResponse[] {
  return [
    [
      {
        budgetPayloadVersion: storedPlayerBudget.payloadVersion,
        budgetPayload: storedPlayerBudget.payload,
        elapsedMs: 1_000,
      },
    ],
    [],
    [{ budgetCost: 0 }],
    [{ attemptId }],
  ]
}

describe('agent foundation audit repository', () => {
  test('rejects an unauthenticated authority before starting a budgeted Attempt', async () => {
    const repository = createRawAgentFoundationAuditRepository()
    let queried = false
    const transaction = (() => {
      queried = true
      throw new Error('must not query')
    }) as unknown as TransactionSql
    const forgedAuthority = {
      runtimeType: 'player',
      runId: agentRunId,
      leaseOwner: 'unit-test:player:0',
      fencingToken: 1,
    } as RuntimeCommitAuthority<'player'>

    await expect(
      repository.startBudgetedAgentAttemptAudit(
        transaction,
        await resolvedOwner(),
        forgedAuthority,
        {
          sessionId,
          agentRunId,
          stage: 'decision',
          provider: 'deepseek',
          model: 'deepseek-v4-flash',
          attemptType: 'initial',
          routingReasonCode: null,
          estimatedInputTokens: 100,
          requestedMaximumOutputTokens: 20,
          reservedCostMicrounits: 140,
          requestProjectionHash: 'a'.repeat(64),
        },
      ),
    ).rejects.toBeInstanceOf(AgentRunTransitionError)
    expect(queried).toBe(false)
  })

  test('starts a persisted Attempt with an independently allocated zero-based number', async () => {
    const repository = createAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [{ agentRunId, sessionId }],
      [{ maxNumber: null }],
      (values: readonly unknown[]) => [
        {
          attemptId: values[0],
          attemptNumber: 0,
        },
      ],
    ])

    const result = await repository.startAgentAttemptAudit(
      transaction,
      await resolvedOwner(),
      {
        sessionId,
        agentRunId,
        stage: 'model_selection',
        provider: 'openai',
        model: 'gpt-5.6',
        attemptType: 'primary',
        routingReasonCode: 'primary_route',
        actualTimeoutMs: 15_000,
        remainingDeadlineMsAtStart: 45_000,
        requestProjectionHash: 'a'.repeat(64),
        startedAt: '2026-08-04T12:00:01.000Z',
      },
    )

    expect(result.attemptId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(result.attemptNumber).toBe(0)
  })

  test('rejects Attempt numbering beyond the PostgreSQL integer boundary', async () => {
    const repository = createAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [{ agentRunId, sessionId }],
      [{ maxNumber: 2_147_483_647 }],
    ])

    await expect(
      repository.startAgentAttemptAudit(transaction, await resolvedOwner(), {
        sessionId,
        agentRunId,
        stage: 'model_selection',
        provider: 'openai',
        model: 'gpt-5.6',
        attemptType: 'primary',
        routingReasonCode: 'primary_route',
        actualTimeoutMs: 15_000,
        remainingDeadlineMsAtStart: 45_000,
        requestProjectionHash: 'a'.repeat(64),
        startedAt: '2026-08-04T12:00:01.000Z',
      }),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })

  test('finishes one persisted started Attempt exactly once with the terminal matrix', async () => {
    const repository = createAgentFoundationAuditRepository()
    const attemptId = '77777777-7777-4777-8777-777777777777'
    const started = encodeAttemptAudit({
      lifecycle: 'started',
      actualTimeoutMs: 15_000,
      remainingDeadlineMsAtStart: 45_000,
      requestProjectionHash: 'a'.repeat(64),
      reservedInputTokens: 100,
      reservedOutputTokens: 20,
      reservedCostMicrounits: 800,
      usageAccounting: 'pending',
      costAccounting: 'pending',
    })
    const transaction = createTransactionMock([
      [
        {
          attemptId,
          agentRunId,
          sessionId,
          lifecycle: 'started',
          payloadVersion: started.payloadVersion,
          payload: started.payload,
        },
      ],
      ...finishBudgetResponses(attemptId),
    ])

    await expect(
      repository.finishAgentAttemptAudit(transaction, await resolvedOwner(), {
        sessionId,
        agentRunId,
        attemptId,
        lifecycle: 'completed',
        accepted: true,
        stale: false,
        interrupted: false,
        inputTokens: 100,
        outputTokens: 20,
        costMicrounits: 800,
        durationMs: 1_250,
        errorCode: null,
        responseProjectionHash: 'b'.repeat(64),
        validationStatus: 'valid',
        completedAt: '2026-08-04T12:00:02.250Z',
      }),
    ).resolves.toBe('recorded')
  })

  test.each([
    [
      'completed but not accepted',
      {
        lifecycle: 'completed',
        accepted: false,
        stale: false,
        interrupted: false,
        errorCode: null,
        responseProjectionHash: 'b'.repeat(64),
        validationStatus: 'invalid',
      },
    ],
    [
      'failed',
      {
        lifecycle: 'failed',
        accepted: false,
        stale: false,
        interrupted: false,
        errorCode: 'provider_failed',
        responseProjectionHash: null,
        validationStatus: 'notRun',
      },
    ],
    [
      'cancelled after provider consumption',
      {
        lifecycle: 'cancelled',
        accepted: false,
        stale: false,
        interrupted: true,
        errorCode: 'run_cancelled',
        responseProjectionHash: null,
        validationStatus: 'notRun',
      },
    ],
    [
      'stale after validation',
      {
        lifecycle: 'stale',
        accepted: false,
        stale: true,
        interrupted: false,
        errorCode: null,
        responseProjectionHash: 'b'.repeat(64),
        validationStatus: 'valid',
      },
    ],
    [
      'stale before validation',
      {
        lifecycle: 'stale',
        accepted: false,
        stale: true,
        interrupted: false,
        errorCode: null,
        responseProjectionHash: null,
        validationStatus: 'notRun',
      },
    ],
    [
      'stale after invalid validation',
      {
        lifecycle: 'stale',
        accepted: false,
        stale: true,
        interrupted: false,
        errorCode: null,
        responseProjectionHash: 'b'.repeat(64),
        validationStatus: 'invalid',
      },
    ],
  ] as const)('finishes a valid %s Attempt fact', async (_name, terminal) => {
    const repository = createAgentFoundationAuditRepository()
    const attemptId = '77777777-7777-4777-8777-777777777777'
    const started = encodeAttemptAudit({
      lifecycle: 'started',
      actualTimeoutMs: 15_000,
      remainingDeadlineMsAtStart: 45_000,
      requestProjectionHash: 'a'.repeat(64),
      reservedInputTokens: 100,
      reservedOutputTokens: 20,
      reservedCostMicrounits: 800,
      usageAccounting: 'pending',
      costAccounting: 'pending',
    })
    const transaction = createTransactionMock([
      [
        {
          attemptId,
          agentRunId,
          sessionId,
          lifecycle: 'started',
          payloadVersion: started.payloadVersion,
          payload: started.payload,
        },
      ],
      ...finishBudgetResponses(attemptId),
    ])

    await expect(
      repository.finishAgentAttemptAudit(transaction, await resolvedOwner(), {
        sessionId,
        agentRunId,
        attemptId,
        ...terminal,
        inputTokens: 100,
        outputTokens: 20,
        costMicrounits: 800,
        durationMs: 1_250,
        completedAt: '2026-08-04T12:00:02.250Z',
      }),
    ).resolves.toBe('recorded')
  })

  test('records actual usage but rejects acceptance when it exceeds the reservation', async () => {
    const repository = createAgentFoundationAuditRepository()
    const attemptId = '77777777-7777-4777-8777-777777777777'
    const started = encodeAttemptAudit({
      lifecycle: 'started',
      actualTimeoutMs: 15_000,
      remainingDeadlineMsAtStart: 45_000,
      requestProjectionHash: 'a'.repeat(64),
      reservedInputTokens: 100,
      reservedOutputTokens: 20,
      reservedCostMicrounits: 800,
      usageAccounting: 'pending',
      costAccounting: 'pending',
    })
    let acceptedValue: unknown
    const transaction = createTransactionMock([
      [
        {
          attemptId,
          agentRunId,
          sessionId,
          lifecycle: 'started',
          payloadVersion: started.payloadVersion,
          payload: started.payload,
        },
      ],
      ...finishBudgetResponses(attemptId).slice(0, -1),
      (values: readonly unknown[]) => {
        acceptedValue = values[1]
        return [{ attemptId }]
      },
    ])

    await expect(
      repository.finishAgentAttemptAudit(transaction, await resolvedOwner(), {
        sessionId,
        agentRunId,
        attemptId,
        lifecycle: 'completed',
        accepted: true,
        stale: false,
        interrupted: false,
        inputTokens: 101,
        outputTokens: 20,
        costMicrounits: 800,
        durationMs: 1_250,
        errorCode: null,
        responseProjectionHash: 'b'.repeat(64),
        validationStatus: 'valid',
        completedAt: '2026-08-04T12:00:02.250Z',
      }),
    ).resolves.toBe('budgetExceeded')
    expect(acceptedValue).toBe(false)
  })

  test.each([
    {
      lifecycle: 'completed',
      accepted: true,
      stale: false,
      interrupted: false,
      errorCode: null,
      responseProjectionHash: 'b'.repeat(64),
      validationStatus: 'invalid',
    },
    {
      lifecycle: 'failed',
      accepted: true,
      stale: false,
      interrupted: false,
      errorCode: 'provider_failed',
      responseProjectionHash: null,
      validationStatus: 'notRun',
    },
    {
      lifecycle: 'cancelled',
      accepted: false,
      stale: false,
      interrupted: true,
      errorCode: 'run_cancelled',
      responseProjectionHash: 'b'.repeat(64),
      validationStatus: 'notRun',
    },
    {
      lifecycle: 'stale',
      accepted: true,
      stale: true,
      interrupted: false,
      errorCode: null,
      responseProjectionHash: null,
      validationStatus: 'notRun',
    },
  ] as const)(
    'rejects an invalid $lifecycle Attempt terminal matrix before SQL',
    async (terminal) => {
      const repository = createAgentFoundationAuditRepository()

      await expect(
        repository.finishAgentAttemptAudit(
          createTransactionMock([]),
          await resolvedOwner(),
          {
            sessionId,
            agentRunId,
            attemptId: '77777777-7777-4777-8777-777777777777',
            ...terminal,
            inputTokens: 100,
            outputTokens: 20,
            costMicrounits: 800,
            durationMs: 1_250,
            completedAt: '2026-08-04T12:00:02.250Z',
          },
        ),
      ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
    },
  )

  test('uses the persisted Run budget for capability reservations', async () => {
    const repository = createRawAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [
        {
          agentRunId,
          sessionId,
          runtime: 'player',
          fencingToken: 1,
          deadlineExpired: false,
        },
      ],
      [
        {
          budgetPayloadVersion: storedPlayerBudget.payloadVersion,
          budgetPayload: storedPlayerBudget.payload,
        },
      ],
      [{ totalBudgetCost: 4, capabilityBudgetCost: 0 }],
      [{ maxNumber: 3 }],
    ])

    await expect(
      repository.reserveCapabilityInvocationAudit(
        transaction,
        await resolvedOwner(),
        testAuthority(),
        {
          sessionId,
          agentRunId,
          capabilityName: 'player.compute-decision-metrics',
          capabilityVersion: 1,
          inputSchemaVersion: 1,
          inputHash: 'c'.repeat(64),
          grantMaximum: 100,
          startedAt: '2026-08-04T12:00:01.000Z',
        },
      ),
    ).resolves.toEqual({ kind: 'budgetExhausted' })
  })

  test('converges a capability finished after the Run deadline as stale', async () => {
    const repository = createRawAgentFoundationAuditRepository()
    const invocationId = '88888888-8888-4888-8888-888888888888'
    let terminalValues: readonly unknown[] = []
    const transaction = createTransactionMock([
      [
        {
          agentRunId,
          sessionId,
          runtime: 'player',
          fencingToken: 1,
          deadlineExpired: true,
        },
      ],
      [
        {
          invocationId,
          agentRunId,
          sessionId,
          fencingToken: 1,
          capabilityName: 'player.compute-decision-metrics',
          capabilityVersion: 1,
          authorized: true,
          inputSchemaVersion: 1,
          inputHash: 'c'.repeat(64),
          budgetCost: 1,
        },
      ],
      (values: readonly unknown[]) => {
        terminalValues = values
        return [{ invocationId }]
      },
    ])

    await expect(
      repository.finishCapabilityInvocationAudit(
        transaction,
        await resolvedOwner(),
        testAuthority(),
        {
          sessionId,
          agentRunId,
          invocationId,
          capabilityName: 'player.compute-decision-metrics',
          capabilityVersion: 1,
          authorized: true,
          inputSchemaVersion: 1,
          inputHash: 'c'.repeat(64),
          outputSchemaVersion: 1,
          outputHash: 'd'.repeat(64),
          budgetCost: 1,
          durationMs: 10,
          errorCode: null,
          completedAt: '2026-08-04T12:00:02.000Z',
        },
      ),
    ).resolves.toBe('stale')
    expect(terminalValues.slice(0, 4)).toEqual([
      null,
      null,
      10,
      'capability_deadline_exhausted',
    ])
  })

  test('reserves one capability invocation on its independent sequence', async () => {
    const repository = createRawAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [
        {
          agentRunId,
          sessionId,
          runtime: 'player',
          fencingToken: 1,
          deadlineExpired: false,
        },
      ],
      [
        {
          budgetPayloadVersion: storedPlayerBudget.payloadVersion,
          budgetPayload: storedPlayerBudget.payload,
        },
      ],
      [{ totalBudgetCost: 0, capabilityBudgetCost: 0 }],
      [{ maxNumber: null }],
      (values: readonly unknown[]) => [
        {
          invocationId: values[0],
          invocationNumber: 0,
        },
      ],
    ])

    const result = await repository.reserveCapabilityInvocationAudit(
      transaction,
      await resolvedOwner(),
      testAuthority(),
      {
        sessionId,
        agentRunId,
        capabilityName: 'player.compute-decision-metrics',
        capabilityVersion: 1,
        inputSchemaVersion: 1,
        inputHash: 'c'.repeat(64),
        grantMaximum: 1,
        startedAt: '2026-08-04T12:00:01.000Z',
      },
    )

    expect(result).toMatchObject({ kind: 'reserved', invocationNumber: 0 })
    if (result.kind !== 'reserved') throw new Error('Capability 未预留。')
    expect(result.invocationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  test.each([
    ['success', null, 1, 'd'.repeat(64)],
    ['failure', 'capability_failed', null, null],
  ] as const)(
    'finishes a current %s capability invocation',
    async (_name, errorCode, outputSchemaVersion, outputHash) => {
      const repository = createRawAgentFoundationAuditRepository()
      const invocationId = '88888888-8888-4888-8888-888888888888'
      const transaction = createTransactionMock([
        [
          {
            agentRunId,
            sessionId,
            runtime: 'player',
            fencingToken: 1,
            deadlineExpired: false,
          },
        ],
        [
          {
            invocationId,
            agentRunId,
            sessionId,
            fencingToken: 1,
            capabilityName: 'player.compute-decision-metrics',
            capabilityVersion: 1,
            authorized: true,
            inputSchemaVersion: 1,
            inputHash: 'c'.repeat(64),
            budgetCost: 1,
          },
        ],
        [{ invocationId }],
      ])

      await expect(
        repository.finishCapabilityInvocationAudit(
          transaction,
          await resolvedOwner(),
          testAuthority(),
          {
            sessionId,
            agentRunId,
            invocationId,
            capabilityName: 'player.compute-decision-metrics',
            capabilityVersion: 1,
            authorized: true,
            inputSchemaVersion: 1,
            inputHash: 'c'.repeat(64),
            outputSchemaVersion,
            outputHash,
            budgetCost: 1,
            durationMs: 10,
            errorCode,
            completedAt: '2026-08-04T12:00:02.000Z',
          },
        ),
      ).resolves.toBe('recorded')
    },
  )

  test.each([
    [null, 'd'.repeat(64), null],
    [1, 'd'.repeat(64), 'capability_failed'],
  ] as const)(
    'rejects an invalid current Invocation matrix before SQL',
    async (outputSchemaVersion, outputHash, errorCode) => {
      const repository = createRawAgentFoundationAuditRepository()

      await expect(
        repository.finishCapabilityInvocationAudit(
          createTransactionMock([]),
          await resolvedOwner(),
          testAuthority(),
          {
            sessionId,
            agentRunId,
            invocationId: '88888888-8888-4888-8888-888888888888',
            capabilityName: 'player.compute-decision-metrics',
            capabilityVersion: 1,
            authorized: true,
            inputSchemaVersion: 1,
            inputHash: 'c'.repeat(64),
            outputSchemaVersion,
            outputHash,
            budgetCost: 1,
            durationMs: 10,
            errorCode,
            completedAt: '2026-08-04T12:00:02.000Z',
          },
        ),
      ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
    },
  )

  test.each(['capabilityVersion', 'inputSchemaVersion'] as const)(
    'rejects capability reservation %s beyond the PostgreSQL integer boundary before SQL',
    async (field) => {
      const repository = createRawAgentFoundationAuditRepository()

      await expect(
        repository.reserveCapabilityInvocationAudit(
          createTransactionMock([]),
          await resolvedOwner(),
          testAuthority(),
          {
            sessionId,
            agentRunId,
            capabilityName: 'player.compute-decision-metrics',
            capabilityVersion: 1,
            inputSchemaVersion: 1,
            inputHash: 'c'.repeat(64),
            grantMaximum: 1,
            startedAt: '2026-08-04T12:00:01.000Z',
            [field]: 2_147_483_648,
          },
        ),
      ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
    },
  )

  test('rejects capability outputSchemaVersion beyond the PostgreSQL integer boundary before SQL', async () => {
    const repository = createRawAgentFoundationAuditRepository()

    await expect(
      repository.finishCapabilityInvocationAudit(
        createTransactionMock([]),
        await resolvedOwner(),
        testAuthority(),
        {
          sessionId,
          agentRunId,
          invocationId: '88888888-8888-4888-8888-888888888888',
          capabilityName: 'player.compute-decision-metrics',
          capabilityVersion: 1,
          authorized: true,
          inputSchemaVersion: 1,
          inputHash: 'c'.repeat(64),
          outputSchemaVersion: 2_147_483_648,
          outputHash: 'd'.repeat(64),
          budgetCost: 1,
          durationMs: 10,
          errorCode: null,
          completedAt: '2026-08-04T12:00:02.000Z',
        },
      ),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })

  test('rejects Invocation numbering beyond the PostgreSQL integer boundary without misclassifying it as Attempt transition', async () => {
    const repository = createRawAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [
        {
          agentRunId,
          sessionId,
          runtime: 'player',
          fencingToken: 1,
          deadlineExpired: false,
        },
      ],
      [
        {
          budgetPayloadVersion: storedPlayerBudget.payloadVersion,
          budgetPayload: storedPlayerBudget.payload,
        },
      ],
      [{ totalBudgetCost: 0, capabilityBudgetCost: 0 }],
      [{ maxNumber: 2_147_483_647 }],
    ])

    await expect(
      repository.reserveCapabilityInvocationAudit(
        transaction,
        await resolvedOwner(),
        testAuthority(),
        {
          sessionId,
          agentRunId,
          capabilityName: 'player.compute-decision-metrics',
          capabilityVersion: 1,
          inputSchemaVersion: 1,
          inputHash: 'c'.repeat(64),
          grantMaximum: 1,
          startedAt: '2026-08-04T12:00:01.000Z',
        },
      ),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })
})
