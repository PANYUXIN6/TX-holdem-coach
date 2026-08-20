import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { encodeAttemptAudit } from '../../src/agents/audit/attempt-audit-codec.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createAgentFoundationAuditRepository as createRawAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
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
      input: Parameters<typeof repository.startAgentAttemptAudit>[3],
    ) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        testAuthority(input.agentRunId),
        input,
      ),
    finishAgentAttemptAudit: (
      transaction: TransactionSql,
      owner: Parameters<typeof repository.finishAgentAttemptAudit>[1],
      input: Parameters<typeof repository.finishAgentAttemptAudit>[3],
    ) =>
      repository.finishAgentAttemptAudit(
        transaction,
        owner,
        testAuthority(input.agentRunId),
        input,
      ),
    appendCapabilityInvocationAudit: (
      transaction: TransactionSql,
      owner: Parameters<typeof repository.appendCapabilityInvocationAudit>[1],
      input: Parameters<typeof repository.appendCapabilityInvocationAudit>[3],
    ) =>
      repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        testAuthority(input.agentRunId),
        input,
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
        { agentRunId, sessionId, runtime: 'player', fencingToken: 1 },
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
            return { ...row, runtime: 'player', fencingToken: 1 }
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

describe('agent foundation audit repository', () => {
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
      [{ attemptId }],
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
    ).resolves.toBeUndefined()
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
      [{ attemptId }],
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
    ).resolves.toBeUndefined()
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

  test('appends one complete capability invocation on its independent sequence', async () => {
    const repository = createAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [{ agentRunId, sessionId }],
      [{ maxNumber: null }],
      (values: readonly unknown[]) => [
        {
          invocationId: values[0],
          invocationNumber: 0,
        },
      ],
    ])

    const result = await repository.appendCapabilityInvocationAudit(
      transaction,
      await resolvedOwner(),
      {
        sessionId,
        agentRunId,
        capabilityName: 'equity.calculate',
        capabilityVersion: 2,
        authorized: true,
        inputSchemaVersion: 3,
        inputHash: 'c'.repeat(64),
        outputSchemaVersion: 4,
        outputHash: 'd'.repeat(64),
        budgetCost: 1,
        durationMs: 125,
        errorCode: null,
        startedAt: '2026-08-04T12:00:01.000Z',
        completedAt: '2026-08-04T12:00:01.125Z',
      },
    )

    expect(result.invocationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(result.invocationNumber).toBe(0)
  })

  test.each([
    [true, null, null, null],
    [false, 'capability_not_authorized', null, null],
    [true, 'capability_failed', null, null],
  ] as const)(
    'accepts a complete Invocation matrix authorized=%s error=%s',
    async (authorized, errorCode, outputSchemaVersion, outputHash) => {
      const repository = createAgentFoundationAuditRepository()
      const transaction = createTransactionMock([
        [{ agentRunId, sessionId }],
        [{ maxNumber: null }],
        (values: readonly unknown[]) => [
          { invocationId: values[0], invocationNumber: 0 },
        ],
      ])

      await expect(
        repository.appendCapabilityInvocationAudit(
          transaction,
          await resolvedOwner(),
          {
            sessionId,
            agentRunId,
            capabilityName: 'equity.calculate',
            capabilityVersion: 2,
            authorized,
            inputSchemaVersion: 3,
            inputHash: 'c'.repeat(64),
            outputSchemaVersion,
            outputHash,
            budgetCost: 1,
            durationMs: 125,
            errorCode,
            startedAt: '2026-08-04T12:00:01.000Z',
            completedAt: '2026-08-04T12:00:01.125Z',
          },
        ),
      ).resolves.toMatchObject({ invocationNumber: 0 })
    },
  )

  test.each([
    [false, null, null, null],
    [false, 'capability_not_authorized', 4, 'd'.repeat(64)],
    [true, null, 4, null],
  ] as const)(
    'rejects an invalid Invocation matrix authorized=%s error=%s before SQL',
    async (authorized, errorCode, outputSchemaVersion, outputHash) => {
      const repository = createAgentFoundationAuditRepository()

      await expect(
        repository.appendCapabilityInvocationAudit(
          createTransactionMock([]),
          await resolvedOwner(),
          {
            sessionId,
            agentRunId,
            capabilityName: 'equity.calculate',
            capabilityVersion: 2,
            authorized,
            inputSchemaVersion: 3,
            inputHash: 'c'.repeat(64),
            outputSchemaVersion,
            outputHash,
            budgetCost: 1,
            durationMs: 125,
            errorCode,
            startedAt: '2026-08-04T12:00:01.000Z',
            completedAt: '2026-08-04T12:00:01.125Z',
          },
        ),
      ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
    },
  )

  test.each([
    'capabilityVersion',
    'inputSchemaVersion',
    'outputSchemaVersion',
  ] as const)(
    'rejects Invocation %s beyond the PostgreSQL integer boundary before SQL',
    async (field) => {
      const repository = createAgentFoundationAuditRepository()
      const transaction = createTransactionMock([])

      await expect(
        repository.appendCapabilityInvocationAudit(
          transaction,
          await resolvedOwner(),
          {
            sessionId,
            agentRunId,
            capabilityName: 'equity.calculate',
            capabilityVersion: 2,
            authorized: true,
            inputSchemaVersion: 3,
            inputHash: 'c'.repeat(64),
            outputSchemaVersion: 4,
            outputHash: 'd'.repeat(64),
            budgetCost: 1,
            durationMs: 125,
            errorCode: null,
            startedAt: '2026-08-04T12:00:01.000Z',
            completedAt: '2026-08-04T12:00:01.125Z',
            [field]: 2_147_483_648,
          },
        ),
      ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
    },
  )

  test('rejects Invocation numbering beyond the PostgreSQL integer boundary without misclassifying it as Attempt transition', async () => {
    const repository = createAgentFoundationAuditRepository()
    const transaction = createTransactionMock([
      [{ agentRunId, sessionId }],
      [{ maxNumber: 2_147_483_647 }],
    ])

    await expect(
      repository.appendCapabilityInvocationAudit(
        transaction,
        await resolvedOwner(),
        {
          sessionId,
          agentRunId,
          capabilityName: 'equity.calculate',
          capabilityVersion: 2,
          authorized: true,
          inputSchemaVersion: 3,
          inputHash: 'c'.repeat(64),
          outputSchemaVersion: null,
          outputHash: null,
          budgetCost: 1,
          durationMs: 125,
          errorCode: null,
          startedAt: '2026-08-04T12:00:01.000Z',
          completedAt: '2026-08-04T12:00:01.125Z',
        },
      ),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })
})
