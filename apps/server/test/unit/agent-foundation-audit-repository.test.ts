import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { encodeAttemptAuditV1 } from '../../src/agents/audit/attempt-audit-codec-v1.js'
import { encodeExecutionBudgetAuditV1 } from '../../src/agents/audit/execution-budget-audit-codec-v1.js'
import { encodeRunConfigurationAuditV1 } from '../../src/agents/audit/run-configuration-audit-codec-v1.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { UnknownPayloadVersionError } from '../../src/persistence/errors.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const handId = '33333333-3333-4333-8333-333333333333'
const agentRunId = '44444444-4444-4444-8444-444444444444'
const participantId = '55555555-5555-4555-8555-555555555555'
const decisionRequestId = '66666666-6666-4666-8666-666666666666'

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
    const next = pending.shift()
    const response = typeof next === 'function' ? next(values) : next
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return transaction
}

async function resolvedOwner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function runConfiguration() {
  return {
    runtime: 'player' as const,
    runtimeDefinitionVersion: 4,
    contextSchemaVersion: 2,
    promptModules: [{ id: 'prompt/player', version: 3 }],
    capabilityManifest: { id: 'capability/player', version: 5 },
    capabilities: [{ id: 'capability/equity', version: 2 }],
    routePolicy: { id: 'route/player', version: 3 },
    outputSchema: { id: 'output/player', version: 2 },
    validator: { id: 'validator/player', version: 6 },
    commitGate: { id: 'commit/player', version: 3 },
    recoveryPolicy: { id: 'recovery/player', version: 1 },
    dataDependencies: [{ id: 'strategy/preflop', version: 8 }],
  }
}

function executionBudget() {
  return {
    maxAttempts: 3,
    maxInputTokens: 20_000,
    maxOutputTokens: 1_000,
    maxWallClockMs: 45_000,
    maxCapabilityInvocations: 2,
    maxCostMicrounits: 1_000,
  }
}

function queuedPlayerRunRow() {
  const configuration = encodeRunConfigurationAuditV1(runConfiguration())
  const budget = encodeExecutionBudgetAuditV1(executionBudget())
  return {
    agentRunId,
    databaseOwnerId,
    sessionId,
    handId,
    runtime: 'player' as const,
    triggerType: 'player_action_required',
    lifecycle: 'queued' as const,
    idempotencyKey: 'decision/0001',
    participantId,
    sourceStateVersion: 7,
    decisionRequestId,
    parentRunId: null,
    replacementRunId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    deadlineAt: '2026-08-04T12:00:45.000000Z',
    runtimeDefinitionVersion: 4,
    terminationCode: null,
    runConfigurationPayloadVersion: configuration.payloadVersion,
    runConfigurationPayload: configuration.payload,
    budgetPayloadVersion: budget.payloadVersion,
    budgetPayload: budget.payload,
    checkpointPayloadVersion: null,
    checkpointPayload: null,
    resultPayloadVersion: null,
    resultPayload: null,
    createdAt: '2026-08-04T12:00:00.000000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-08-04T12:00:00.000000Z',
    attempts: [],
    invocations: [],
    playerDecision: null,
  }
}

function queuedCoachRunRow() {
  const configuration = encodeRunConfigurationAuditV1({
    ...runConfiguration(),
    runtime: 'coach',
  })
  return {
    ...queuedPlayerRunRow(),
    runtime: 'coach' as const,
    triggerType: 'hand_completed',
    idempotencyKey: 'review/0001',
    participantId: null,
    sourceStateVersion: null,
    decisionRequestId: null,
    runConfigurationPayloadVersion: configuration.payloadVersion,
    runConfigurationPayload: configuration.payload,
  }
}

function attemptRow(attemptNumber: number, lifecycle: 'started' | 'completed') {
  const attemptId = `77777777-7777-4777-8777-77777777777${attemptNumber}`
  const payload = encodeAttemptAuditV1(
    lifecycle === 'started'
      ? {
          lifecycle,
          actualTimeoutMs: 15_000,
          remainingDeadlineMsAtStart: 45_000,
          requestProjectionHash: 'a'.repeat(64),
        }
      : {
          lifecycle,
          actualTimeoutMs: 15_000,
          remainingDeadlineMsAtStart: 45_000,
          requestProjectionHash: 'a'.repeat(64),
          responseProjectionHash: 'b'.repeat(64),
          validationStatus: 'valid',
        },
  )
  return {
    attemptId,
    agentRunId,
    databaseOwnerId,
    sessionId,
    attemptNumber,
    stage: 'model_selection',
    lifecycle,
    accepted: lifecycle === 'completed',
    stale: false,
    interrupted: false,
    provider: 'openai',
    model: 'gpt-5.6',
    attemptType: 'primary',
    routingReasonCode: 'primary_route',
    inputTokens: lifecycle === 'completed' ? 100 : 0,
    outputTokens: lifecycle === 'completed' ? 20 : 0,
    costMicrounits: lifecycle === 'completed' ? 800 : 0,
    durationMs: lifecycle === 'completed' ? 1_250 : null,
    errorCode: null,
    payloadVersion: payload.payloadVersion,
    payload: payload.payload,
    startedAt: '2026-08-04T12:00:01.000000Z',
    completedAt:
      lifecycle === 'completed' ? '2026-08-04T12:00:02.250000Z' : null,
    createdAt: '2026-08-04T12:00:01.000000Z',
  }
}

function invocationRow(invocationNumber: number) {
  return {
    invocationId: `88888888-8888-4888-8888-88888888888${invocationNumber}`,
    agentRunId,
    databaseOwnerId,
    sessionId,
    invocationNumber,
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
    payloadVersion: null,
    payload: null,
    startedAt: '2026-08-04T12:00:01.000000Z',
    completedAt: '2026-08-04T12:00:01.125000Z',
    createdAt: '2026-08-04T12:00:01.000000Z',
  }
}

function playerDecisionRow() {
  return {
    decisionId: '99999999-9999-4999-8999-999999999999',
    agentRunId,
    databaseOwnerId,
    sessionId,
    handId,
    participantId,
    sourceStateVersion: 7,
    decisionRequestId,
    memoryRevision: 3,
    runtime: 'player' as const,
    submissionStatus: 'pending' as const,
    commandLedgerId: null,
    decisionPacketPayloadVersion: 1,
    decisionPacketPayload: { schemaVersion: 1, action: 'check' },
    candidateSetPayloadVersion: 1,
    candidateSetPayload: { schemaVersion: 1, actions: ['check'] },
    validatorResultPayloadVersion: 1,
    validatorResultPayload: { schemaVersion: 1, valid: true },
    createdAt: '2026-08-04T12:00:02.000000Z',
    submittedAt: null,
  }
}

describe('agent foundation audit repository', () => {
  test('inserts only the fixed queued AgentRun initial state from current codecs', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([
      [{ handId, participantId, parentRunExists: true }],
      [{ agentRunId }],
    ])

    await expect(
      repository.insertAgentRunAudit(transaction, await resolvedOwner(), {
        agentRunId,
        sessionId,
        handId,
        runtime: 'player',
        triggerType: 'player_action_required',
        idempotencyKey: 'decision/0001',
        participantId,
        sourceStateVersion: 7,
        decisionRequestId,
        parentRunId: null,
        deadlineAt: '2026-08-04T12:00:45.000Z',
        runtimeDefinitionVersion: 4,
        runConfiguration: runConfiguration(),
        budget: executionBudget(),
        createdAt: '2026-08-04T12:00:00.000Z',
      }),
    ).resolves.toEqual({ agentRunId })
  })

  test.each([
    ['Hand', [], null],
    [
      'Player participant',
      [{ handId, participantId: null, parentRunExists: true }],
      null,
    ],
    [
      'parent AgentRun',
      [{ handId, participantId, parentRunExists: false }],
      '77777777-7777-4777-8777-777777777777',
    ],
  ])(
    'reports a missing Owner-scoped %s before inserting an AgentRun',
    async (_resource, parentRows, parentRunId) => {
      const repository = createAgentFoundationAuditRepository({
        runtimeAuditDecoders: {},
      })
      const transaction = createTransactionMock([parentRows])

      await expect(
        repository.insertAgentRunAudit(transaction, await resolvedOwner(), {
          agentRunId,
          sessionId,
          handId,
          runtime: 'player',
          triggerType: 'player_action_required',
          idempotencyKey: 'decision/0001',
          participantId,
          sourceStateVersion: 7,
          decisionRequestId,
          parentRunId,
          deadlineAt: '2026-08-04T12:00:45.000Z',
          runtimeDefinitionVersion: 4,
          runConfiguration: runConfiguration(),
          budget: executionBudget(),
          createdAt: '2026-08-04T12:00:00.000Z',
        }),
      ).rejects.toMatchObject({ name: 'ResourceNotFoundError' })
    },
  )

  test('rejects forbidden Run Configuration fields before issuing any repository SQL', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([])

    await expect(
      repository.insertAgentRunAudit(transaction, await resolvedOwner(), {
        agentRunId,
        sessionId,
        handId,
        runtime: 'player',
        triggerType: 'player_action_required',
        idempotencyKey: 'decision/0001',
        participantId,
        sourceStateVersion: 7,
        decisionRequestId,
        parentRunId: null,
        deadlineAt: '2026-08-04T12:00:45.000Z',
        runtimeDefinitionVersion: 4,
        runConfiguration: {
          ...runConfiguration(),
          reasoning_content: 'secret-sentinel',
        } as never,
        budget: executionBudget(),
        createdAt: '2026-08-04T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })

  test('rejects a Run definition version beyond the PostgreSQL integer boundary before SQL', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([])
    const runtimeDefinitionVersion = 2_147_483_648

    await expect(
      repository.insertAgentRunAudit(transaction, await resolvedOwner(), {
        agentRunId,
        sessionId,
        handId,
        runtime: 'player',
        triggerType: 'player_action_required',
        idempotencyKey: 'decision/0001',
        participantId,
        sourceStateVersion: 7,
        decisionRequestId,
        parentRunId: null,
        deadlineAt: '2026-08-04T12:00:45.000Z',
        runtimeDefinitionVersion,
        runConfiguration: {
          ...runConfiguration(),
          runtimeDefinitionVersion,
        },
        budget: executionBudget(),
        createdAt: '2026-08-04T12:00:00.000Z',
      }),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })

  test('starts a persisted Attempt with an independently allocated zero-based number', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
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
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
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
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const attemptId = '77777777-7777-4777-8777-777777777777'
    const started = encodeAttemptAuditV1({
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
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const attemptId = '77777777-7777-4777-8777-777777777777'
    const started = encodeAttemptAuditV1({
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
      const repository = createAgentFoundationAuditRepository({
        runtimeAuditDecoders: {},
      })

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
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
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
      const repository = createAgentFoundationAuditRepository({
        runtimeAuditDecoders: {},
      })
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
      const repository = createAgentFoundationAuditRepository({
        runtimeAuditDecoders: {},
      })

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
      const repository = createAgentFoundationAuditRepository({
        runtimeAuditDecoders: {},
      })
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
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
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

  test('reads a complete queued Player Run with legal absent runtime facts', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([[queuedPlayerRunRow()]])

    const audit = await repository.readAgentRunAudit(
      transaction,
      await resolvedOwner(),
      sessionId,
      agentRunId,
    )

    expect(audit).toMatchObject({
      ownerId: 'local-user',
      agentRunId,
      sessionId,
      handId,
      runtime: 'player',
      lifecycle: 'queued',
      participantId,
      sourceStateVersion: 7,
      decisionRequestId,
      runtimeDefinitionVersion: 4,
      runConfiguration: runConfiguration(),
      budget: executionBudget(),
      attempts: [],
      invocations: [],
      runtimeAudit: {
        checkpoint: null,
        result: null,
        decision: null,
      },
    })
    expect(Object.isFrozen(audit)).toBe(true)
    expect(Object.isFrozen(audit.runConfiguration.promptModules)).toBe(true)
  })

  test('reads a nonblank Runtime-owned lease identifier without inventing a Foundation character set', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          lifecycle: 'leased',
          leaseOwner: 'Worker#1',
          leaseExpiresAt: '2026-08-04T12:00:30.000000Z',
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).resolves.toMatchObject({
      lifecycle: 'leased',
      leaseOwner: 'Worker#1',
      leaseExpiresAt: '2026-08-04T12:00:30.000000Z',
    })
  })

  test('reads Attempts and Invocations independently without duplicates and in number order', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          attempts: [attemptRow(1, 'completed'), attemptRow(0, 'started')],
          invocations: [invocationRow(1), invocationRow(0)],
        },
      ],
    ])

    const audit = await repository.readAgentRunAudit(
      transaction,
      await resolvedOwner(),
      sessionId,
      agentRunId,
    )

    expect(audit.attempts.map(({ attemptNumber }) => attemptNumber)).toEqual([
      0, 1,
    ])
    expect(
      audit.invocations.map(({ invocationNumber }) => invocationNumber),
    ).toEqual([0, 1])
    expect(audit.attempts).toHaveLength(2)
    expect(audit.invocations).toHaveLength(2)
    expect(audit.attempts[1]).toMatchObject({
      lifecycle: 'completed',
      accepted: true,
      validationStatus: 'valid',
    })
    expect(Object.isFrozen(audit.attempts)).toBe(true)
  })

  test('rejects malformed Attempt lifecycle facts during aggregate read', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          attempts: [{ ...attemptRow(0, 'started'), inputTokens: 1 }],
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'PersistenceDataCorruptionError',
      corruption: 'invalidAgentAttemptAudit',
    })
  })

  test('rejects any nonempty Foundation capability payload as an unknown version', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          invocations: [
            {
              ...invocationRow(0),
              payloadVersion: 1,
              payload: { schemaVersion: 1 },
            },
          ],
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'UnknownPayloadVersionError',
      payloadKind: 'capabilityInvocationPayload',
    })
  })

  test('reports the first nonempty Player payload kind when no Runtime decoder is installed', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          checkpointPayloadVersion: 1,
          checkpointPayload: { schemaVersion: 1 },
          playerDecision: playerDecisionRow(),
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'UnknownPayloadVersionError',
      payloadKind: 'agentRunCheckpoint',
    })
  })

  test('rejects a Player identity mirror mismatch before invoking its Runtime decoder', async () => {
    let decoderCalled = false
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        player: {
          runtime: 'player',
          decode() {
            decoderCalled = true
            return {
              checkpoint: { decoded: true },
              result: null,
              decision: { decoded: true },
            }
          },
        },
      },
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          checkpointPayloadVersion: 1,
          checkpointPayload: { schemaVersion: 1 },
          playerDecision: {
            ...playerDecisionRow(),
            participantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          },
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'PersistenceDataCorruptionError',
      corruption: 'invalidRuntimeAuditExtension',
    })
    expect(decoderCalled).toBe(false)
  })

  test('passes fixed Player facts through the installed Runtime decoder and freezes its result', async () => {
    let received: unknown
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        player: {
          runtime: 'player',
          decode(input) {
            received = input
            return {
              checkpoint: { decoded: 'checkpoint' },
              result: { decoded: 'result' },
              decision: { decoded: 'decision' },
            }
          },
        },
      },
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          checkpointPayloadVersion: 2,
          checkpointPayload: { schemaVersion: 3 },
          resultPayloadVersion: 4,
          resultPayload: { schemaVersion: 5 },
          playerDecision: playerDecisionRow(),
        },
      ],
    ])

    const audit = await repository.readAgentRunAudit(
      transaction,
      await resolvedOwner(),
      sessionId,
      agentRunId,
    )

    expect(received).toMatchObject({
      ownerId: databaseOwnerId,
      sessionId,
      handId,
      agentRunId,
      runtime: 'player',
      checkpoint: { rowPayloadVersion: 2, payload: { schemaVersion: 3 } },
      result: { rowPayloadVersion: 4, payload: { schemaVersion: 5 } },
      decision: {
        ownerId: databaseOwnerId,
        participantId,
        sourceStateVersion: 7,
        decisionRequestId,
        memoryRevision: 3,
        decisionPacket: { rowPayloadVersion: 1 },
        candidateSet: { rowPayloadVersion: 1 },
        validatorResult: { rowPayloadVersion: 1 },
      },
    })
    expect(Object.isFrozen(received)).toBe(true)
    expect(audit.runtime).toBe('player')
    if (audit.runtime !== 'player') throw new Error('Expected Player audit.')
    expect(audit.runtimeAudit).toEqual({
      checkpoint: { decoded: 'checkpoint' },
      result: { decoded: 'result' },
      decision: { decoded: 'decision' },
    })
    expect(Object.isFrozen(audit.runtimeAudit.decision)).toBe(true)
  })

  test('does not invoke an installed Runtime decoder when every extension fact is absent', async () => {
    let decoderCalled = false
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        player: {
          runtime: 'player',
          decode() {
            decoderCalled = true
            throw new Error(
              'Decoder must not be called for an empty extension.',
            )
          },
        },
      },
    })
    const transaction = createTransactionMock([[queuedPlayerRunRow()]])

    const audit = await repository.readAgentRunAudit(
      transaction,
      await resolvedOwner(),
      sessionId,
      agentRunId,
    )

    expect(decoderCalled).toBe(false)
    expect(audit.runtimeAudit).toEqual({
      checkpoint: null,
      result: null,
      decision: null,
    })
  })

  test('rejects undefined in a decoder result slot whose source fact exists', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        player: {
          runtime: 'player',
          decode() {
            return {
              checkpoint: undefined,
              result: null,
              decision: null,
            } as never
          },
        },
      },
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          checkpointPayloadVersion: 1,
          checkpointPayload: { schemaVersion: 1 },
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'PersistenceDataCorruptionError',
      corruption: 'invalidRuntimeAuditExtension',
    })
  })

  test('requires an absent decoder result slot to be exactly null rather than undefined', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        player: {
          runtime: 'player',
          decode() {
            return {
              checkpoint: { decoded: true },
              result: undefined,
              decision: null,
            } as never
          },
        },
      },
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          checkpointPayloadVersion: 1,
          checkpointPayload: { schemaVersion: 1 },
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'PersistenceDataCorruptionError',
      corruption: 'invalidRuntimeAuditExtension',
    })
  })

  test('rejects non-enumerable extra keys returned by a Runtime decoder', async () => {
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        player: {
          runtime: 'player',
          decode() {
            const decoded = {
              checkpoint: { decoded: true },
              result: null,
              decision: null,
            }
            Object.defineProperty(decoded, 'hiddenExtra', {
              enumerable: false,
              value: { secret: true },
            })
            return decoded
          },
        },
      },
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedPlayerRunRow(),
          checkpointPayloadVersion: 1,
          checkpointPayload: { schemaVersion: 1 },
        },
      ],
    ])

    await expect(
      repository.readAgentRunAudit(
        transaction,
        await resolvedOwner(),
        sessionId,
        agentRunId,
      ),
    ).rejects.toMatchObject({
      name: 'PersistenceDataCorruptionError',
      corruption: 'invalidRuntimeAuditExtension',
    })
  })

  test('passes Coach checkpoint and result slots through its decoder', async () => {
    let received: unknown
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {
        coach: {
          runtime: 'coach',
          decode(input) {
            received = input
            return {
              checkpoint: { decoded: true },
              result: null,
            }
          },
        },
      },
    })
    const transaction = createTransactionMock([
      [
        {
          ...queuedCoachRunRow(),
          checkpointPayloadVersion: 1,
          checkpointPayload: { schemaVersion: 1 },
        },
      ],
    ])

    const audit = await repository.readAgentRunAudit(
      transaction,
      await resolvedOwner(),
      sessionId,
      agentRunId,
    )

    expect(received).toMatchObject({
      runtime: 'coach',
      checkpoint: { rowPayloadVersion: 1 },
      result: null,
    })
    expect(audit.runtime).toBe('coach')
    if (audit.runtime !== 'coach') throw new Error('Expected Coach audit.')
    expect(audit.runtimeAudit).toEqual({
      checkpoint: { decoded: true },
      result: null,
    })
    expect(Object.isFrozen(audit.runtimeAudit)).toBe(true)
  })

  test.each(['playerCandidateSet', 'playerValidatorResult'] as const)(
    'preserves an injected Player decoder unknown-version error for %s',
    async (payloadKind) => {
      const repository = createAgentFoundationAuditRepository({
        runtimeAuditDecoders: {
          player: {
            runtime: 'player',
            decode() {
              throw new UnknownPayloadVersionError(payloadKind)
            },
          },
        },
      })
      const transaction = createTransactionMock([
        [{ ...queuedPlayerRunRow(), playerDecision: playerDecisionRow() }],
      ])

      await expect(
        repository.readAgentRunAudit(
          transaction,
          await resolvedOwner(),
          sessionId,
          agentRunId,
        ),
      ).rejects.toMatchObject({
        name: 'UnknownPayloadVersionError',
        payloadKind,
      })
    },
  )
})
