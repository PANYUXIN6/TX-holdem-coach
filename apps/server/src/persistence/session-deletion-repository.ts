import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  DatabaseOperationError,
  OwnerScopeResolutionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  SessionDeletionTransitionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

export interface InvalidatedAgentRunReference {
  readonly agentRunId: string
  readonly runtime: 'player' | 'coach'
}

export interface DeleteEndedSessionDataResult {
  readonly sessionId: string
  readonly invalidatedRuns: readonly InvalidatedAgentRunReference[]
}

export interface DeleteEndedSessionDataInput {
  readonly sessionId: string
  readonly deletedAt: string
}

export interface ClearOwnerSessionDataResult {
  readonly deletedSessionCount: number
  readonly invalidatedRuns: readonly InvalidatedAgentRunReference[]
}

export interface ClearOwnerSessionDataInput {
  readonly deletedAt: string
}

const CanonicalUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const milliseconds = Date.parse(value)
    return (
      Number.isFinite(milliseconds) &&
      new Date(milliseconds).toISOString() === value
    )
  })

const DeleteEndedSessionDataInputSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
  deletedAt: CanonicalUtcTimestampSchema,
})

const ClearOwnerSessionDataInputSchema = z.strictObject({
  deletedAt: CanonicalUtcTimestampSchema,
})

const LockedSessionRowSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
})

const LockedRunRowSchema = z.strictObject({
  agentRunId: z.uuid().transform((value) => value.toLowerCase()),
  runtime: z.enum(['player', 'coach']),
})

const ReturnedRunRowSchema = z.strictObject({
  agentRunId: z.uuid().transform((value) => value.toLowerCase()),
})

const ReturnedSessionRowSchema = z.strictObject({
  sessionId: z.uuid().transform((value) => value.toLowerCase()),
})

const LockedOwnerRowSchema = z.strictObject({
  databaseOwnerId: z.uuid().transform((value) => value.toLowerCase()),
})

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

async function executeDatabaseRows(
  operation: () => PromiseLike<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await operation()
  } catch {
    throw new DatabaseOperationError()
  }
}

function hasSameIdentifiers(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  if (actual.length !== expected.length) {
    return false
  }
  const actualIds = new Set(actual)
  const expectedIds = new Set(expected)
  return (
    actualIds.size === actual.length &&
    expectedIds.size === expected.length &&
    expected.every((id) => actualIds.has(id))
  )
}

export async function deleteEndedSessionData(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: DeleteEndedSessionDataInput,
): Promise<DeleteEndedSessionDataResult> {
  const parsedInput = DeleteEndedSessionDataInputSchema.safeParse(input)
  if (
    typeof transaction !== 'function' ||
    !isResolvedOwnerScope(owner) ||
    !parsedInput.success
  ) {
    throw new RepositoryInputValidationError()
  }

  const sessionRows = await executeDatabaseRows(
    () => transaction`
      SELECT
        id::text AS "sessionId",
        lifecycle_status AS "lifecycleStatus"
      FROM app_private.sessions
      WHERE id = ${parsedInput.data.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
      FOR UPDATE
    `,
  )
  if (sessionRows.length === 0) {
    throw new ResourceNotFoundError()
  }
  const parsedSession = LockedSessionRowSchema.safeParse(sessionRows[0])
  if (
    sessionRows.length !== 1 ||
    !parsedSession.success ||
    parsedSession.data.sessionId !== parsedInput.data.sessionId
  ) {
    throw new DatabaseOperationError()
  }
  if (parsedSession.data.lifecycleStatus !== 'ended') {
    throw new SessionDeletionTransitionError()
  }

  const runRows = await executeDatabaseRows(
    () => transaction`
      SELECT
        id::text AS "agentRunId",
        runtime
      FROM app_private.agent_runs
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND session_id = ${parsedInput.data.sessionId}::uuid
        AND lifecycle IN ('queued', 'leased', 'running')
      ORDER BY id ASC
      FOR UPDATE
    `,
  )
  const parsedRuns = z.array(LockedRunRowSchema).safeParse(runRows)
  if (!parsedRuns.success) {
    throw new DatabaseOperationError()
  }
  const lockedRunIds = parsedRuns.data.map((row) => row.agentRunId)
  if (new Set(lockedRunIds).size !== lockedRunIds.length) {
    throw new DatabaseOperationError()
  }

  const cancelledRows = await executeDatabaseRows(
    () => transaction`
      UPDATE app_private.agent_runs
      SET lifecycle = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          termination_reason = 'session_data_deleted',
          completed_at = ${parsedInput.data.deletedAt}::timestamptz,
          updated_at = ${parsedInput.data.deletedAt}::timestamptz
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND session_id = ${parsedInput.data.sessionId}::uuid
        AND lifecycle IN ('queued', 'leased', 'running')
      RETURNING id::text AS "agentRunId"
    `,
  )
  const parsedCancelledRows = z
    .array(ReturnedRunRowSchema)
    .safeParse(cancelledRows)
  if (
    !parsedCancelledRows.success ||
    !hasSameIdentifiers(
      parsedCancelledRows.data.map((row) => row.agentRunId),
      lockedRunIds,
    )
  ) {
    throw new SessionDeletionTransitionError()
  }

  const updatedSessionRows = await executeDatabaseRows(
    () => transaction`
      UPDATE app_private.sessions
      SET agent_run_state = 'idle',
          active_player_run_id = NULL,
          active_decision_request_id = NULL
      WHERE id = ${parsedInput.data.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle_status = 'ended'
      RETURNING id::text AS "sessionId"
    `,
  )
  const parsedUpdatedSessions = z
    .array(ReturnedSessionRowSchema)
    .safeParse(updatedSessionRows)
  if (
    !parsedUpdatedSessions.success ||
    !hasSameIdentifiers(
      parsedUpdatedSessions.data.map((row) => row.sessionId),
      [parsedInput.data.sessionId],
    )
  ) {
    throw new SessionDeletionTransitionError()
  }

  const deletedSessionRows = await executeDatabaseRows(
    () => transaction`
      DELETE FROM app_private.sessions
      WHERE id = ${parsedInput.data.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle_status = 'ended'
      RETURNING id::text AS "sessionId"
    `,
  )
  const parsedDeletedSessions = z
    .array(ReturnedSessionRowSchema)
    .safeParse(deletedSessionRows)
  if (
    !parsedDeletedSessions.success ||
    !hasSameIdentifiers(
      parsedDeletedSessions.data.map((row) => row.sessionId),
      [parsedInput.data.sessionId],
    )
  ) {
    throw new SessionDeletionTransitionError()
  }

  const invalidatedRuns = parsedRuns.data
    .map(({ agentRunId, runtime }) => ({ agentRunId, runtime }))
    .sort((left, right) =>
      left.agentRunId < right.agentRunId
        ? -1
        : left.agentRunId > right.agentRunId
          ? 1
          : 0,
    )
  return deepFreeze({
    sessionId: parsedInput.data.sessionId,
    invalidatedRuns,
  })
}

export async function clearOwnerSessionData(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: ClearOwnerSessionDataInput,
): Promise<ClearOwnerSessionDataResult> {
  const parsedInput = ClearOwnerSessionDataInputSchema.safeParse(input)
  if (
    typeof transaction !== 'function' ||
    !isResolvedOwnerScope(owner) ||
    !parsedInput.success
  ) {
    throw new RepositoryInputValidationError()
  }

  const ownerRows = await executeDatabaseRows(
    () => transaction`
      SELECT id::text AS "databaseOwnerId"
      FROM app_private.owners
      WHERE id = ${owner.databaseOwnerId}::uuid
      FOR UPDATE
    `,
  )
  const parsedOwners = z.array(LockedOwnerRowSchema).safeParse(ownerRows)
  if (
    !parsedOwners.success ||
    parsedOwners.data.length !== 1 ||
    parsedOwners.data[0]?.databaseOwnerId !== owner.databaseOwnerId
  ) {
    throw new OwnerScopeResolutionError()
  }

  const sessionRows = await executeDatabaseRows(
    () => transaction`
      SELECT id::text AS "sessionId"
      FROM app_private.sessions
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
      ORDER BY id ASC
      FOR UPDATE
    `,
  )
  const parsedSessions = z
    .array(ReturnedSessionRowSchema)
    .safeParse(sessionRows)
  if (!parsedSessions.success) {
    throw new DatabaseOperationError()
  }
  const lockedSessionIds = parsedSessions.data.map((row) => row.sessionId)
  if (new Set(lockedSessionIds).size !== lockedSessionIds.length) {
    throw new DatabaseOperationError()
  }
  if (lockedSessionIds.length === 0) {
    return deepFreeze({ deletedSessionCount: 0, invalidatedRuns: [] })
  }

  const runRows = await executeDatabaseRows(
    () => transaction`
      SELECT
        id::text AS "agentRunId",
        runtime
      FROM app_private.agent_runs
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle IN ('queued', 'leased', 'running')
      ORDER BY id ASC
      FOR UPDATE
    `,
  )
  const parsedRuns = z.array(LockedRunRowSchema).safeParse(runRows)
  if (!parsedRuns.success) {
    throw new DatabaseOperationError()
  }
  const lockedRunIds = parsedRuns.data.map((row) => row.agentRunId)
  if (new Set(lockedRunIds).size !== lockedRunIds.length) {
    throw new DatabaseOperationError()
  }

  const cancelledRows = await executeDatabaseRows(
    () => transaction`
      UPDATE app_private.agent_runs
      SET lifecycle = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          termination_reason = 'session_data_deleted',
          completed_at = ${parsedInput.data.deletedAt}::timestamptz,
          updated_at = ${parsedInput.data.deletedAt}::timestamptz
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle IN ('queued', 'leased', 'running')
      RETURNING id::text AS "agentRunId"
    `,
  )
  const parsedCancelledRows = z
    .array(ReturnedRunRowSchema)
    .safeParse(cancelledRows)
  if (
    !parsedCancelledRows.success ||
    !hasSameIdentifiers(
      parsedCancelledRows.data.map((row) => row.agentRunId),
      lockedRunIds,
    )
  ) {
    throw new SessionDeletionTransitionError()
  }

  const updatedSessionRows = await executeDatabaseRows(
    () => transaction`
      UPDATE app_private.sessions
      SET agent_run_state = 'idle',
          active_player_run_id = NULL,
          active_decision_request_id = NULL
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
      RETURNING id::text AS "sessionId"
    `,
  )
  const parsedUpdatedSessions = z
    .array(ReturnedSessionRowSchema)
    .safeParse(updatedSessionRows)
  if (
    !parsedUpdatedSessions.success ||
    !hasSameIdentifiers(
      parsedUpdatedSessions.data.map((row) => row.sessionId),
      lockedSessionIds,
    )
  ) {
    throw new SessionDeletionTransitionError()
  }

  const deletedSessionRows = await executeDatabaseRows(
    () => transaction`
      DELETE FROM app_private.sessions
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
      RETURNING id::text AS "sessionId"
    `,
  )
  const parsedDeletedSessions = z
    .array(ReturnedSessionRowSchema)
    .safeParse(deletedSessionRows)
  if (
    !parsedDeletedSessions.success ||
    !hasSameIdentifiers(
      parsedDeletedSessions.data.map((row) => row.sessionId),
      lockedSessionIds,
    )
  ) {
    throw new SessionDeletionTransitionError()
  }

  const invalidatedRuns = parsedRuns.data
    .map(({ agentRunId, runtime }) => ({ agentRunId, runtime }))
    .sort((left, right) =>
      left.agentRunId < right.agentRunId
        ? -1
        : left.agentRunId > right.agentRunId
          ? 1
          : 0,
    )
  return deepFreeze({
    deletedSessionCount: lockedSessionIds.length,
    invalidatedRuns,
  })
}
