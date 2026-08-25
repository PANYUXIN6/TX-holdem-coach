import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { AgentRunTransitionError } from '../../src/agents/foundation/agent-run-lifecycle.js'
import {
  issueRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../../src/agents/foundation/runtime-ports.js'
import type { AgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { createDatabaseModelAttemptControl } from '../../src/persistence/agent-model-attempt-control.js'
import { AgentAttemptAuditTransitionError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const sessionId = '22222222-2222-4222-8222-222222222222'
const agentRunId = '44444444-4444-4444-8444-444444444444'
const authority = issueRuntimeCommitAuthority({
  runtimeType: 'player',
  runId: agentRunId,
  leaseOwner: 'unit-test:player:0',
  fencingToken: 1,
})

async function owner() {
  const sql = (() =>
    Promise.resolve([
      { databaseOwnerId: '11111111-1111-4111-8111-111111111111' },
    ])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function transactionSql(): Sql {
  const transaction = (() => undefined) as unknown as TransactionSql
  return Object.assign(() => undefined, {
    begin: async <Value>(
      operation: (input: TransactionSql) => Promise<Value>,
    ): Promise<Value> => operation(transaction),
  }) as unknown as Sql
}

async function createControl(
  repository: Partial<AgentFoundationAuditRepository>,
  runtimeAuthority: RuntimeCommitAuthority = authority,
) {
  return createDatabaseModelAttemptControl({
    sql: transactionSql(),
    repository: repository as AgentFoundationAuditRepository,
    owner: await owner(),
    authority: runtimeAuthority,
    sessionId,
    agentRunId,
  })
}

const finishInput = {
  attemptId: '77777777-7777-4777-8777-777777777777',
  lifecycle: 'completed' as const,
  accepted: true,
  inputTokens: 10,
  outputTokens: 2,
  costMicrounits: 14,
  durationMs: 10,
  errorCode: null,
  responseProjectionHash: 'a'.repeat(64),
  validationStatus: 'valid' as const,
  usageAccounting: 'providerReported' as const,
  costAccounting: 'allInputAtCacheMiss' as const,
  validatedOutput: { candidateActionId: 'candidate-1' } as const,
}

describe('database model attempt control', () => {
  test('rejects forged or cross-Run authority during construction', async () => {
    const resolvedOwner = await owner()
    const forgedAuthority = {
      runtimeType: authority.runtimeType,
      runId: authority.runId,
      leaseOwner: authority.leaseOwner,
      fencingToken: authority.fencingToken,
    } as RuntimeCommitAuthority
    expect(() =>
      createDatabaseModelAttemptControl({
        sql: transactionSql(),
        repository: {} as AgentFoundationAuditRepository,
        owner: resolvedOwner,
        authority: forgedAuthority,
        sessionId,
        agentRunId,
      }),
    ).toThrow(TypeError)

    const otherRunAuthority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: '55555555-5555-4555-8555-555555555555',
      leaseOwner: 'unit-test:player:0',
      fencingToken: 1,
    })
    expect(() =>
      createDatabaseModelAttemptControl({
        sql: transactionSql(),
        repository: {} as AgentFoundationAuditRepository,
        owner: resolvedOwner,
        authority: otherRunAuthority,
        sessionId,
        agentRunId,
      }),
    ).toThrow(TypeError)
  })

  test('maps only Run transition failures to authority lost', async () => {
    const control = await createControl({
      finishAgentAttemptAudit: async () => {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      },
    })

    await expect(control.finishAttempt(finishInput)).resolves.toBe(
      'authorityLost',
    )
  })

  test('preserves Attempt transition failures', async () => {
    const control = await createControl({
      finishAgentAttemptAudit: async () => {
        throw new AgentAttemptAuditTransitionError()
      },
    })

    await expect(control.finishAttempt(finishInput)).rejects.toBeInstanceOf(
      AgentAttemptAuditTransitionError,
    )
  })
})
