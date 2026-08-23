import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { AgentRunTransitionError } from '../../src/agents/foundation/agent-run-lifecycle.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import type { AgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { createDatabaseCapabilityExecutionControl } from '../../src/persistence/agent-capability-execution-control.js'
import {
  CapabilityInvocationAuditTransitionError,
  PersistenceDataCorruptionError,
} from '../../src/persistence/errors.js'
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
) {
  return createDatabaseCapabilityExecutionControl({
    sql: transactionSql(),
    repository: repository as AgentFoundationAuditRepository,
    owner: await owner(),
    authority,
    manifest: productionRuntimeRegistry.resolveExact('player', 1)
      .capabilityManifest,
    sessionId,
    agentRunId,
  })
}

const reservation = {
  capability: { id: 'player.compute-decision-metrics', version: 1 },
  inputSchemaVersion: 1,
  inputHash: 'a'.repeat(64),
} as const

describe('database capability execution control', () => {
  test('accepts the authenticated Manifest from the exact Registry definition', async () => {
    const capabilityControl = await createControl({
      reserveCapabilityInvocationAudit: async () => ({
        kind: 'reserved',
        invocationId: '88888888-8888-4888-8888-888888888888',
        invocationNumber: 1,
      }),
    })

    await expect(
      capabilityControl.reserveInvocation(reservation),
    ).resolves.toEqual({
      kind: 'reserved',
      reservationId: '88888888-8888-4888-8888-888888888888',
    })
  })

  test('maps an explicit Run transition to authority lost', async () => {
    const capabilityControl = await createControl({
      reserveCapabilityInvocationAudit: async () => {
        throw new AgentRunTransitionError('agent_run_fencing_rejected')
      },
    })

    await expect(
      capabilityControl.reserveInvocation(reservation),
    ).resolves.toEqual({ kind: 'authorityLost' })
  })

  test('does not hide persistence corruption as authority lost', async () => {
    const capabilityControl = await createControl({
      reserveCapabilityInvocationAudit: async () => {
        throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
      },
    })

    await expect(
      capabilityControl.reserveInvocation(reservation),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })

  test('does not hide an Invocation transition failure as authority lost', async () => {
    const capabilityControl = await createControl({
      finishCapabilityInvocationAudit: async () => {
        throw new CapabilityInvocationAuditTransitionError()
      },
    })

    await expect(
      capabilityControl.finishInvocation({
        reservationId: '88888888-8888-4888-8888-888888888888',
        audit: {
          capability: reservation.capability,
          authorized: true,
          inputSchemaVersion: 1,
          inputHash: reservation.inputHash,
          outputSchemaVersion: 1,
          outputHash: 'b'.repeat(64),
          budgetCost: 1,
          durationMs: 1,
          errorCode: null,
        },
      }),
    ).rejects.toBeInstanceOf(CapabilityInvocationAuditTransitionError)
  })
})
