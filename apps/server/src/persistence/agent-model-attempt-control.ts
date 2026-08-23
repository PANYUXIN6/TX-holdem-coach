import type { Sql } from 'postgres'
import type { ModelAttemptControlPort } from '../agents/foundation/model-gateway-protocol.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import { AgentRunTransitionError } from '../agents/foundation/agent-run-lifecycle.js'
import type { AgentFoundationAuditRepository } from './agent-foundation-audit-repository.js'
import { runDatabaseTransaction } from './database-transaction.js'
import { DatabaseOperationError } from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

export function createDatabaseModelAttemptControl(input: {
  readonly sql: Sql
  readonly repository: AgentFoundationAuditRepository
  readonly owner: ResolvedOwnerScope
  readonly authority: RuntimeCommitAuthority
  readonly sessionId: string
  readonly agentRunId: string
}): ModelAttemptControlPort {
  if (
    !isResolvedOwnerScope(input.owner) ||
    !isRuntimeCommitAuthority(input.authority, input.authority.runtimeType) ||
    input.authority.runId !== input.agentRunId
  ) {
    throw new TypeError('Model Attempt 数据库控制输入无效。')
  }
  const control: ModelAttemptControlPort = {
    async startAttempt(attempt) {
      try {
        return await runDatabaseTransaction(input.sql, (transaction) =>
          input.repository.startBudgetedAgentAttemptAudit(
            transaction,
            input.owner,
            input.authority,
            {
              sessionId: input.sessionId,
              agentRunId: input.agentRunId,
              ...attempt,
            },
          ),
        )
      } catch (error) {
        if (error instanceof AgentRunTransitionError) {
          return Object.freeze({
            kind: 'rejected' as const,
            failure: 'runtime_authority_lost' as const,
          })
        }
        if (error instanceof DatabaseOperationError) {
          return Object.freeze({
            kind: 'rejected' as const,
            failure: 'local_persistence_error' as const,
          })
        }
        throw error
      }
    },
    async finishAttempt(attempt) {
      try {
        const result = await runDatabaseTransaction(input.sql, (transaction) =>
          input.repository.finishAgentAttemptAudit(
            transaction,
            input.owner,
            input.authority,
            {
              sessionId: input.sessionId,
              agentRunId: input.agentRunId,
              attemptId: attempt.attemptId,
              lifecycle: attempt.lifecycle,
              accepted: attempt.accepted,
              stale: false,
              interrupted: attempt.lifecycle === 'cancelled',
              inputTokens: attempt.inputTokens,
              outputTokens: attempt.outputTokens,
              costMicrounits: attempt.costMicrounits,
              durationMs: attempt.durationMs,
              errorCode: attempt.errorCode,
              responseProjectionHash: attempt.responseProjectionHash,
              validationStatus: attempt.validationStatus,
              usageAccounting: attempt.usageAccounting,
              costAccounting: attempt.costAccounting,
              completedAt: new Date().toISOString(),
            },
          ),
        )
        return result
      } catch (error) {
        if (error instanceof AgentRunTransitionError) return 'authorityLost'
        throw error
      }
    },
  }
  return Object.freeze(control)
}
