import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import { StableAuditCodeSchema } from '../agents/audit/audit-primitives.js'
import type { HandStartCheckpointV2 } from '../sessions/hand-audit/hand-start-checkpoint.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import { readHandAudit } from './hand-audit-repository.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const LoadPausedAbortContextInputSchema = z.strictObject({
  sessionId: z.uuid(),
  handId: z.uuid(),
  actorParticipantId: z.uuid(),
  sourceStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
})
const FailedPlayerRunRowSchema = z.strictObject({
  failedPlayerRunId: z.uuid(),
  failureReasonCode: StableAuditCodeSchema,
})

export interface PausedAbortContext {
  readonly handId: string
  readonly checkpoint: HandStartCheckpointV2
  readonly failedPlayerRunId: string
  readonly failureReasonCode: string
}

export interface LoadPausedAbortContextInput {
  readonly sessionId: string
  readonly handId: string
  readonly actorParticipantId: string
  readonly sourceStateVersion: number
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export async function loadPausedAbortContext(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: LoadPausedAbortContextInput,
): Promise<PausedAbortContext> {
  const parsed = LoadPausedAbortContextInputSchema.safeParse(input)
  if (!isResolvedOwnerScope(owner) || !parsed.success) {
    throw new RepositoryInputValidationError()
  }
  const hand = await readHandAudit(
    transaction,
    owner,
    parsed.data.sessionId,
    parsed.data.handId,
  )
  if (
    hand.status !== 'inProgress' ||
    hand.checkpoint.startedHand.handId.toLowerCase() !==
      parsed.data.handId.toLowerCase()
  ) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }

  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        id::text AS "failedPlayerRunId",
        termination_reason AS "failureReasonCode"
      FROM app_private.agent_runs
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND session_id = ${parsed.data.sessionId}::uuid
        AND hand_id = ${parsed.data.handId}::uuid
        AND runtime = 'player'
        AND participant_id = ${parsed.data.actorParticipantId}::uuid
        AND source_state_version = ${parsed.data.sourceStateVersion}::bigint
        AND lifecycle = 'failed'
        AND replacement_run_id IS NULL
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const failedRuns = z.array(FailedPlayerRunRowSchema).safeParse(rows)
  if (!failedRuns.success || failedRuns.data.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
  }
  const failedRun = failedRuns.data[0]
  if (failedRun === undefined) {
    throw new PersistenceDataCorruptionError('invalidAgentRunAudit')
  }
  return deepFreeze({
    handId: hand.handId,
    checkpoint: hand.checkpoint,
    ...failedRun,
  })
}
