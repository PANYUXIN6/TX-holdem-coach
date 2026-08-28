import { createHash } from 'node:crypto'
import type { Sql } from 'postgres'
import { canonicalJson, type JsonValue } from '../persisted-json.js'
import type { ModelAttemptControlPort } from '../agents/foundation/model-gateway-protocol.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import {
  createPlayerValidatorResultV1,
  type PlayerBoundedChoiceV1,
} from '../agents/player/player-bounded-choice.js'
import {
  hashPlayerDecisionPacketBindingV1,
  isPlayerDecisionPacketV1,
  type PlayerDecisionPacketV1,
} from '../agents/player/player-decision-packet-leak-guard.js'
import { AgentRunTransitionError } from '../agents/foundation/agent-run-lifecycle.js'
import type { AgentFoundationAuditRepository } from './agent-foundation-audit-repository.js'
import { runDatabaseTransaction } from './database-transaction.js'
import { DatabaseOperationError } from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'
import type { PlayerDecisionRepository } from './player-decision-repository.js'
import type { SessionAgentCoordinator } from '../agents/player/session-agent-coordinator.js'

declare const playerModelAttemptControlBrand: unique symbol

export interface PlayerModelAttemptControlV1 extends ModelAttemptControlPort<PlayerBoundedChoiceV1> {
  readonly decisionRecordId: string
  readonly candidateSetSha256: string
  readonly authorityBindingSha256: string
  readonly [playerModelAttemptControlBrand]: never
}

export interface PlayerCorrectionAttemptStartPort {
  startCorrectionAttempt: SessionAgentCoordinator['startCorrectionAttempt']
}

const playerControls = new WeakSet<object>()

function shouldCarryOutput(input: {
  readonly lifecycle: 'completed' | 'failed' | 'cancelled'
  readonly accepted: boolean
  readonly validationStatus: 'notRun' | 'valid' | 'invalid'
}): boolean {
  return (
    input.lifecycle === 'completed' &&
    input.accepted &&
    input.validationStatus === 'valid'
  )
}

export function createPlayerModelAttemptControlV1(input: {
  readonly sql: Sql
  readonly foundationRepository: AgentFoundationAuditRepository
  readonly decisionRepository: PlayerDecisionRepository
  readonly owner: ResolvedOwnerScope
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly packet: PlayerDecisionPacketV1
  readonly correctionAttemptPort: PlayerCorrectionAttemptStartPort
  readonly now?: () => string
}): PlayerModelAttemptControlV1 {
  if (
    !isResolvedOwnerScope(input.owner) ||
    !isRuntimeCommitAuthority(input.authority, 'player') ||
    !isPlayerDecisionPacketV1(input.packet) ||
    typeof input.correctionAttemptPort?.startCorrectionAttempt !== 'function'
  ) {
    throw new TypeError('Player Model Attempt 控制输入无效。')
  }
  const authorityBindingSha256 = createHash('sha256')
    .update(
      canonicalJson({
        packetBindingSha256: hashPlayerDecisionPacketBindingV1(input.packet),
        runtimeType: input.authority.runtimeType,
        runId: input.authority.runId,
        leaseOwner: input.authority.leaseOwner,
        fencingToken: input.authority.fencingToken,
      } as JsonValue),
      'utf8',
    )
    .digest('hex')
  const control: PlayerModelAttemptControlV1 = {
    decisionRecordId: input.packet.decisionRecordId,
    candidateSetSha256: input.packet.candidateSetSha256,
    authorityBindingSha256,
    async startAttempt(attempt) {
      if (attempt.stage !== 'player.bounded-choice') {
        return Object.freeze({
          kind: 'rejected' as const,
          failure: 'runtime_authority_lost' as const,
        })
      }
      try {
        if (attempt.attemptType === 'correction') {
          return await input.correctionAttemptPort.startCorrectionAttempt({
            sessionId: input.packet.binding.sessionId,
            agentRunId: input.authority.runId,
            decisionRequestId: input.packet.binding.decisionRequestId,
            authority: input.authority,
            ...attempt,
            attemptAt: (input.now ?? (() => new Date().toISOString()))(),
          })
        }
        return await runDatabaseTransaction(input.sql, (transaction) =>
          input.foundationRepository.startBudgetedAgentAttemptAudit(
            transaction,
            input.owner,
            input.authority,
            {
              sessionId: input.packet.binding.sessionId,
              agentRunId: input.authority.runId,
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
      if ((attempt.validatedOutput !== null) !== shouldCarryOutput(attempt)) {
        throw new TypeError('Player Model Attempt 验收输出状态不一致。')
      }
      try {
        return await runDatabaseTransaction(input.sql, async (transaction) => {
          const result =
            await input.foundationRepository.finishAgentAttemptAudit(
              transaction,
              input.owner,
              input.authority,
              {
                sessionId: input.packet.binding.sessionId,
                agentRunId: input.authority.runId,
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
            )
          if (result !== 'recorded' || attempt.validatedOutput === null) {
            return result
          }
          const validatorResult = createPlayerValidatorResultV1({
            packet: input.packet,
            choice: attempt.validatedOutput,
          })
          await input.decisionRepository.markSelected(
            transaction,
            input.owner,
            input.authority,
            {
              decisionRecordId: input.packet.decisionRecordId,
              acceptedAttemptId: attempt.attemptId,
              candidateSetSha256: input.packet.candidateSetSha256,
              choice: attempt.validatedOutput,
              validatorResult,
            },
          )
          return 'recorded' as const
        })
      } catch (error) {
        if (error instanceof AgentRunTransitionError) return 'authorityLost'
        throw error
      }
    },
  } as PlayerModelAttemptControlV1
  playerControls.add(control)
  return Object.freeze(control)
}

export function isPlayerModelAttemptControlV1(
  value: unknown,
): value is PlayerModelAttemptControlV1 {
  return (
    typeof value === 'object' && value !== null && playerControls.has(value)
  )
}
