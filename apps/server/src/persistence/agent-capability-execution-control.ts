import type { Sql } from 'postgres'
import type { CapabilityExecutionControlPort } from '../agents/foundation/capability-executor.js'
import { AgentRunTransitionError } from '../agents/foundation/agent-run-lifecycle.js'
import {
  isCapabilityManifest,
  type CapabilityManifest,
} from '../agents/foundation/capability-protocol.js'
import { FoundationProtocolError } from '../agents/foundation/errors.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import type { AgentFoundationAuditRepository } from './agent-foundation-audit-repository.js'
import { runDatabaseTransaction } from './database-transaction.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

export function createDatabaseCapabilityExecutionControl(input: {
  readonly sql: Sql
  readonly repository: AgentFoundationAuditRepository
  readonly owner: ResolvedOwnerScope
  readonly authority: RuntimeCommitAuthority
  readonly manifest: CapabilityManifest<RuntimeCommitAuthority['runtimeType']>
  readonly sessionId: string
  readonly agentRunId: string
}): CapabilityExecutionControlPort {
  if (
    !isResolvedOwnerScope(input.owner) ||
    !isRuntimeCommitAuthority(input.authority, input.authority.runtimeType) ||
    !isCapabilityManifest(input.manifest, input.authority.runtimeType) ||
    input.authority.runId !== input.agentRunId
  ) {
    throw new TypeError('Capability 数据库控制输入无效。')
  }
  const grants = new Map(
    input.manifest.grants.map((grant) => [
      `${grant.capability.id}@${String(grant.capability.version)}`,
      grant,
    ]),
  )
  const control: CapabilityExecutionControlPort = {
    async reserveInvocation(reservation) {
      const grant = grants.get(
        `${reservation.capability.id}@${String(reservation.capability.version)}`,
      )
      if (grant === undefined) {
        throw new FoundationProtocolError('capabilityNotDeclared')
      }
      try {
        const result = await runDatabaseTransaction(input.sql, (transaction) =>
          input.repository.reserveCapabilityInvocationAudit(
            transaction,
            input.owner,
            input.authority,
            {
              sessionId: input.sessionId,
              agentRunId: input.agentRunId,
              capabilityName: reservation.capability.id,
              capabilityVersion: reservation.capability.version,
              inputSchemaVersion: reservation.inputSchemaVersion,
              inputHash: reservation.inputHash,
              grantMaximum: grant.maxInvocations,
              startedAt: new Date().toISOString(),
            },
          ),
        )
        return result.kind === 'reserved'
          ? Object.freeze({
              kind: 'reserved' as const,
              reservationId: result.invocationId,
            })
          : result
      } catch (error) {
        if (error instanceof AgentRunTransitionError) {
          return Object.freeze({ kind: 'authorityLost' as const })
        }
        throw error
      }
    },
    async finishInvocation({ reservationId, audit }) {
      try {
        return await runDatabaseTransaction(input.sql, (transaction) => {
          const completedAt = new Date().toISOString()
          return input.repository.finishCapabilityInvocationAudit(
            transaction,
            input.owner,
            input.authority,
            {
              sessionId: input.sessionId,
              agentRunId: input.agentRunId,
              invocationId: reservationId,
              capabilityName: audit.capability.id,
              capabilityVersion: audit.capability.version,
              authorized: audit.authorized,
              inputSchemaVersion: audit.inputSchemaVersion,
              inputHash: audit.inputHash,
              outputSchemaVersion: audit.outputSchemaVersion,
              outputHash: audit.outputHash,
              budgetCost: audit.budgetCost,
              durationMs: audit.durationMs,
              errorCode: audit.errorCode,
              completedAt,
            },
          )
        })
      } catch (error) {
        if (error instanceof AgentRunTransitionError) return 'authorityLost'
        throw error
      }
    },
  }
  return Object.freeze(control)
}
