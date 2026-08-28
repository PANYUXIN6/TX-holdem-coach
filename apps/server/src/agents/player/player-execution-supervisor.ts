import { randomUUID } from 'node:crypto'
import type { LeasedAgentRun } from '../foundation/agent-run-types.js'
import type { RuntimeExecutionPort } from '../foundation/agent-worker-ports.js'
import { issueRuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import { classifyPlayerExecutionFailure } from './player-execution-settlement.js'
import type { SessionAgentCoordinator } from './session-agent-coordinator.js'

const CanonicalTimestampPattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function defaultNow(): string {
  return new Date().toISOString()
}

function assertCanonicalTimestamp(value: string): void {
  if (
    !CanonicalTimestampPattern.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new TypeError('Player supervisor 时间戳无效。')
  }
}

export interface PlayerExecutionSupervisorDependencies {
  readonly executor: RuntimeExecutionPort<'player'>
  readonly coordinator: SessionAgentCoordinator
  readonly now?: () => string
  readonly nextRunId?: () => string
  readonly nextDecisionRequestId?: () => string
  readonly nextIdempotencyKey?: () => string
}

/**
 * Preserves Player-specific settlement classification outside the shared Worker.
 * A coordinator failure deliberately rejects execution so the Worker reports that
 * a durable settlement is still required instead of claiming a terminal result.
 */
export function createPlayerExecutionSupervisor(
  dependencies: PlayerExecutionSupervisorDependencies,
): RuntimeExecutionPort<'player'> {
  if (
    dependencies.executor.runtimeType !== 'player' ||
    typeof dependencies.coordinator.pauseAfterFailure !== 'function' ||
    typeof dependencies.coordinator.reconcileStale !== 'function'
  ) {
    throw new TypeError('Player supervisor 依赖无效。')
  }
  const now = dependencies.now ?? defaultNow
  const nextRunId = dependencies.nextRunId ?? randomUUID
  const nextDecisionRequestId = dependencies.nextDecisionRequestId ?? randomUUID
  const nextIdempotencyKey = dependencies.nextIdempotencyKey ?? randomUUID

  return Object.freeze({
    runtimeType: 'player' as const,
    async execute(
      run: LeasedAgentRun<'player'>,
      signal: AbortSignal,
    ): Promise<void> {
      try {
        await dependencies.executor.execute(run, signal)
      } catch (error) {
        const settlement = classifyPlayerExecutionFailure(error, signal)
        if (settlement.kind === 'deferred') return

        const settledAt = now()
        assertCanonicalTimestamp(settledAt)
        const authority = issueRuntimeCommitAuthority({
          runtimeType: 'player',
          runId: run.runId,
          leaseOwner: run.leaseOwner,
          fencingToken: run.fencingToken,
        })
        if (settlement.kind === 'finalFailure') {
          await dependencies.coordinator.pauseAfterFailure({
            sessionId: run.sessionId,
            agentRunId: run.runId,
            decisionRequestId: run.decisionRequestId,
            authority,
            reason: settlement.reason,
            settledAt,
          })
          return
        }
        await dependencies.coordinator.reconcileStale({
          sessionId: run.sessionId,
          agentRunId: run.runId,
          decisionRequestId: run.decisionRequestId,
          authority,
          reason: settlement.reason,
          replacementRunId: nextRunId(),
          replacementDecisionRequestId: nextDecisionRequestId(),
          replacementIdempotencyKey: nextIdempotencyKey(),
          settledAt,
        })
      }
    },
  })
}
