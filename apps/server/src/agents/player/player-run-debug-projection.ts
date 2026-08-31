import type { PlayerAuditReplayV1 } from './player-audit-replay-service.js'
import type { PlayerAuditReplayService } from './player-audit-replay-service.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'

export type PlayerRunDebugNodeKind =
  | 'run'
  | 'attempt'
  | 'capabilityInvocation'
  | 'memoryRevision'
  | 'playerDecision'

export type PlayerRunDebugEdgeRelation =
  | 'HAS_ATTEMPT'
  | 'INVOKED'
  | 'USED_MEMORY'
  | 'PRODUCED'
  | 'ACCEPTED_FROM'
  | 'COMMITTED_AS'
  | 'REEXECUTES'

export interface PlayerRunDebugNodeV1 {
  readonly id: string
  readonly kind: PlayerRunDebugNodeKind
  readonly status: string
  readonly digest: string | null
}

export interface PlayerRunDebugEdgeV1 {
  readonly from: string
  readonly to: string
  readonly relation: PlayerRunDebugEdgeRelation
}

export interface PlayerRunDebugTraceV1 {
  readonly traceSchemaVersion: 1
  readonly runId: string
  readonly nodes: readonly PlayerRunDebugNodeV1[]
  readonly edges: readonly PlayerRunDebugEdgeV1[]
}

export interface PlayerRunDebugProjectionService {
  projectRun(input: {
    readonly owner: ResolvedOwnerScope
    readonly runId: string
  }): Promise<PlayerRunDebugTraceV1>
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

/**
 * 将已经 Owner-scoped 且严格解码的 Replay 事实压缩为稳定的关联图。
 * 该投影刻意不带任何可重放的大 payload；调用方需要查看详情时必须回到
 * Replay 的受限端口。
 */
export function buildPlayerRunDebugTraceV1(
  replay: PlayerAuditReplayV1,
): PlayerRunDebugTraceV1 {
  const runId = replay.decision.runId
  const memoryId = `memory:${String(replay.memory.revision)}`
  const nodes: PlayerRunDebugNodeV1[] = [
    {
      id: runId,
      kind: 'run',
      status: replay.decision.lifecycle,
      digest: null,
    },
    ...replay.attempts.map((attempt) => ({
      id: attempt.attemptId,
      kind: 'attempt' as const,
      status: attempt.lifecycle,
      digest: attempt.requestProjectionHash,
    })),
    ...replay.capabilityInvocations.map((invocation) => ({
      id: invocation.invocationId,
      kind: 'capabilityInvocation' as const,
      status: invocation.authorized ? 'authorized' : 'rejected',
      digest: invocation.outputHash ?? invocation.inputHash,
    })),
    {
      id: memoryId,
      kind: 'memoryRevision',
      status: `revision:${String(replay.memory.revision)}`,
      digest: replay.memory.sha256,
    },
    {
      id: replay.decision.decisionId,
      kind: 'playerDecision',
      status: replay.decision.status,
      digest: replay.decision.snapshotSha256,
    },
    ...(replay.decision.sourceDecisionId === null
      ? []
      : [
          {
            id: replay.decision.sourceDecisionId,
            kind: 'playerDecision' as const,
            status: 'source',
            digest: null,
          },
        ]),
  ]
  const decisionId = replay.decision.decisionId
  const edges: PlayerRunDebugEdgeV1[] = [
    ...replay.attempts.map((attempt) => ({
      from: runId,
      to: attempt.attemptId,
      relation: 'HAS_ATTEMPT' as const,
    })),
    ...replay.capabilityInvocations.map((invocation) => ({
      from: runId,
      to: invocation.invocationId,
      relation: 'INVOKED' as const,
    })),
    { from: runId, to: memoryId, relation: 'USED_MEMORY' },
    { from: runId, to: decisionId, relation: 'PRODUCED' },
    ...(replay.decision.sourceDecisionId === null
      ? []
      : [
          {
            from: runId,
            to: replay.decision.sourceDecisionId,
            relation: 'REEXECUTES' as const,
          },
        ]),
    ...replay.attempts
      .filter((attempt) => attempt.accepted)
      .map((attempt) => ({
        from: decisionId,
        to: attempt.attemptId,
        relation: 'ACCEPTED_FROM' as const,
      })),
    ...(replay.decision.status === 'committed'
      ? [
          {
            from: decisionId,
            to: runId,
            relation: 'COMMITTED_AS' as const,
          },
        ]
      : []),
  ]
  return deepFreeze({
    traceSchemaVersion: 1 as const,
    runId,
    nodes,
    edges,
  })
}

export function createPlayerRunDebugProjectionService(input: {
  readonly auditReplay: PlayerAuditReplayService
}): PlayerRunDebugProjectionService {
  return Object.freeze({
    async projectRun({
      owner,
      runId,
    }: Parameters<PlayerRunDebugProjectionService['projectRun']>[0]) {
      return buildPlayerRunDebugTraceV1(
        await input.auditReplay.replayRun({ owner, runId }),
      )
    },
  })
}
