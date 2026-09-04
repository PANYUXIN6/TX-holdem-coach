import type { JSONValue, TransactionSql } from 'postgres'
import { z } from 'zod'
import type { CompletedHandResult } from '../poker/hand-result.js'
import {
  encodeCompletedHandResult,
  type StoredCompletedHandResult,
} from '../sessions/hand-audit/completed-hand-result-codec.js'
import { currentCompletedHandResultReader } from '../sessions/hand-audit/completed-hand-result-codec.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import {
  HandAuditPayloadValidationError,
  HandAuditPayloadVersionError,
} from '../sessions/hand-audit/errors.js'
import {
  encodeCurrentHandStartCheckpoint,
  type StoredHandStartCheckpoint,
} from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import type { HandStartCheckpoint } from '../sessions/hand-audit/hand-start-checkpoint.js'
import { completedHandResultMirrorsCheckpoint } from '../sessions/hand-audit/completed-hand-mirrors.js'
import {
  DatabaseOperationError,
  HandAuditTransitionError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const CanonicalUtcTimestampSchema = z.iso.datetime({ precision: 3 })
const StableAuditCodeSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
const InsertInProgressHandAuditInputSchema = z.strictObject({
  sessionId: z.uuid(),
  checkpoint: z.unknown(),
  startedAt: CanonicalUtcTimestampSchema,
})
const CompleteHandAuditInputSchema = z.strictObject({
  sessionId: z.uuid(),
  handId: z.uuid(),
  result: z.unknown(),
  completedAt: CanonicalUtcTimestampSchema,
})
const AbortHandAuditInputSchema = z.strictObject({
  sessionId: z.uuid(),
  handId: z.uuid(),
  failedAgentRunId: z.uuid(),
  reasonCode: StableAuditCodeSchema,
  abortedAt: CanonicalUtcTimestampSchema,
})
const AbortingAgentRunRowSchema = z.strictObject({
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  runtime: z.enum(['player', 'coach']),
})
const InsertedHandRowSchema = z.strictObject({
  handId: z.uuid(),
  handNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
})
const DatabaseUtcTimestampSchema = z.iso.datetime({ precision: 6 })
const HandAuditRowSchema = z.strictObject({
  handId: z.uuid(),
  sessionId: z.uuid(),
  handNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['inProgress', 'completed', 'aborted']),
  checkpointPayloadVersion: z.unknown(),
  checkpointPayload: z.unknown(),
  completedResultPayloadVersion: z.unknown().nullable(),
  completedResultPayload: z.unknown().nullable(),
  abortReasonCode: StableAuditCodeSchema.nullable(),
  failedAgentRunId: z.uuid().nullable(),
  buttonSeatNumber: z.number().int().min(0).max(8),
  participantSeatNumbers: z.array(z.number().int().min(0).max(8)).min(6).max(9),
  startedAt: DatabaseUtcTimestampSchema,
  completedAt: DatabaseUtcTimestampSchema.nullable(),
  abortedAt: DatabaseUtcTimestampSchema.nullable(),
  updatedAt: DatabaseUtcTimestampSchema,
  abortedRunRuntime: z.enum(['player', 'coach']).nullable(),
  abortedRunOwnerId: z.uuid().nullable(),
  abortedRunSessionId: z.uuid().nullable(),
  abortedRunHandId: z.uuid().nullable(),
})

export interface InsertInProgressHandAuditInput {
  readonly sessionId: string
  readonly checkpoint: HandStartCheckpoint
  readonly startedAt: string
}

export interface CompleteHandAuditInput {
  readonly sessionId: string
  readonly handId: string
  readonly result: CompletedHandResult
  readonly completedAt: string
}

export interface AbortHandAuditInput {
  readonly sessionId: string
  readonly handId: string
  readonly failedAgentRunId: string
  readonly reasonCode: string
  readonly abortedAt: string
}

interface HandAuditBase {
  readonly ownerId: ResolvedOwnerScope['ownerId']
  readonly sessionId: string
  readonly handId: string
  readonly handNumber: number
  readonly buttonSeatNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly startedAt: string
  readonly updatedAt: string
  readonly checkpoint: HandStartCheckpoint
}

export type HandAudit =
  | (HandAuditBase & {
      readonly status: 'inProgress'
      readonly result: null
      readonly completedAt: null
      readonly abortReasonCode: null
      readonly failedAgentRunId: null
      readonly abortedAt: null
    })
  | (HandAuditBase & {
      readonly status: 'completed'
      readonly result: CompletedHandResult
      readonly completedAt: string
      readonly abortReasonCode: null
      readonly failedAgentRunId: null
      readonly abortedAt: null
    })
  | (HandAuditBase & {
      readonly status: 'aborted'
      readonly result: null
      readonly completedAt: null
      readonly abortReasonCode: string
      readonly failedAgentRunId: string
      readonly abortedAt: string
    })

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function equalValues(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function parseHandAuditRow(row: unknown, owner: ResolvedOwnerScope): HandAudit {
  const parsed = HandAuditRowSchema.safeParse(row)
  if (!parsed.success) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  const value = parsed.data
  const checkpointRead = currentHandStartCheckpointReader.read(
    value.checkpointPayloadVersion,
    value.checkpointPayload,
  )
  if (checkpointRead.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('handStartCheckpoint')
  }
  if (checkpointRead.kind === 'invalidPayload') {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  const checkpoint = checkpointRead.value
  const startedHand = checkpoint.startedHand
  if (
    value.handId !== startedHand.handId ||
    value.handNumber !== startedHand.handNumber ||
    value.buttonSeatNumber !== startedHand.buttonSeatNumber ||
    !equalValues(
      value.participantSeatNumbers,
      startedHand.participantSeatNumbers,
    )
  ) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  const base: HandAuditBase = {
    ownerId: owner.ownerId,
    sessionId: value.sessionId,
    handId: value.handId,
    handNumber: value.handNumber,
    buttonSeatNumber: value.buttonSeatNumber,
    participantSeatNumbers: value.participantSeatNumbers,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    checkpoint,
  }
  if (value.status === 'inProgress') {
    if (
      value.completedResultPayloadVersion !== null ||
      value.completedResultPayload !== null ||
      value.completedAt !== null ||
      value.abortReasonCode !== null ||
      value.failedAgentRunId !== null ||
      value.abortedAt !== null ||
      value.abortedRunRuntime !== null ||
      value.abortedRunOwnerId !== null ||
      value.abortedRunSessionId !== null ||
      value.abortedRunHandId !== null
    ) {
      throw new PersistenceDataCorruptionError('invalidHandAudit')
    }
    return deepFreeze({
      ...base,
      status: 'inProgress',
      result: null,
      completedAt: null,
      abortReasonCode: null,
      failedAgentRunId: null,
      abortedAt: null,
    })
  }
  if (value.status === 'completed') {
    if (
      value.completedResultPayloadVersion === null ||
      value.completedResultPayload === null ||
      value.completedAt === null ||
      value.abortReasonCode !== null ||
      value.failedAgentRunId !== null ||
      value.abortedAt !== null ||
      value.abortedRunRuntime !== null ||
      value.abortedRunOwnerId !== null ||
      value.abortedRunSessionId !== null ||
      value.abortedRunHandId !== null
    ) {
      throw new PersistenceDataCorruptionError('invalidHandAudit')
    }
    const resultRead = currentCompletedHandResultReader.read(
      value.completedResultPayloadVersion,
      value.completedResultPayload,
    )
    if (resultRead.kind === 'unknownVersion') {
      throw new UnknownPayloadVersionError('completedHandResult')
    }
    if (resultRead.kind === 'invalidPayload') {
      throw new PersistenceDataCorruptionError('invalidHandAudit')
    }
    if (!completedHandResultMirrorsCheckpoint(checkpoint, resultRead.value)) {
      throw new PersistenceDataCorruptionError('invalidHandAudit')
    }
    return deepFreeze({
      ...base,
      status: 'completed',
      result: resultRead.value,
      completedAt: value.completedAt,
      abortReasonCode: null,
      failedAgentRunId: null,
      abortedAt: null,
    })
  }
  if (
    value.completedResultPayloadVersion !== null ||
    value.completedResultPayload !== null ||
    value.completedAt !== null ||
    value.abortReasonCode === null ||
    value.failedAgentRunId === null ||
    value.abortedAt === null ||
    value.abortedRunRuntime !== 'player' ||
    value.abortedRunOwnerId !== owner.databaseOwnerId ||
    value.abortedRunSessionId !== value.sessionId ||
    value.abortedRunHandId !== value.handId
  ) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  return deepFreeze({
    ...base,
    status: 'aborted',
    result: null,
    completedAt: null,
    abortReasonCode: value.abortReasonCode,
    failedAgentRunId: value.failedAgentRunId,
    abortedAt: value.abortedAt,
  })
}

function decodeCheckpointForWrite(input: unknown): StoredHandStartCheckpoint {
  try {
    return encodeCurrentHandStartCheckpoint(input)
  } catch (error) {
    if (
      error instanceof HandAuditPayloadValidationError ||
      error instanceof HandAuditPayloadVersionError
    ) {
      throw new RepositoryInputValidationError()
    }
    throw error
  }
}

function decodeCompletedResultForWrite(
  input: unknown,
): StoredCompletedHandResult {
  try {
    return encodeCompletedHandResult(input)
  } catch (error) {
    if (
      error instanceof HandAuditPayloadValidationError ||
      error instanceof HandAuditPayloadVersionError
    ) {
      throw new RepositoryInputValidationError()
    }
    throw error
  }
}

function toDatabaseTimestamp(value: string): string {
  return value.replace(/(\.\d{3})Z$/, '$1000Z')
}

async function lockInProgressHandAudit(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  handId: string,
): Promise<Extract<HandAudit, { readonly status: 'inProgress' }>> {
  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        h.id::text AS "handId",
        h.session_id::text AS "sessionId",
        h.hand_number::float8 AS "handNumber",
        h.status,
        h.hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
        h.hand_start_checkpoint_payload AS "checkpointPayload",
        h.completed_result_payload_version AS "completedResultPayloadVersion",
        h.completed_result_payload AS "completedResultPayload",
        h.abort_reason AS "abortReasonCode",
        h.aborted_by_agent_run_id::text AS "failedAgentRunId",
        h.button_seat AS "buttonSeatNumber",
        h.participant_seats AS "participantSeatNumbers",
        to_char(h.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt",
        CASE WHEN h.completed_at IS NULL THEN NULL ELSE
          to_char(h.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        END AS "completedAt",
        CASE WHEN h.aborted_at IS NULL THEN NULL ELSE
          to_char(h.aborted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        END AS "abortedAt",
        to_char(h.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
        ar.runtime AS "abortedRunRuntime",
        ar.owner_id::text AS "abortedRunOwnerId",
        ar.session_id::text AS "abortedRunSessionId",
        ar.hand_id::text AS "abortedRunHandId"
      FROM app_private.hands AS h
      LEFT JOIN app_private.agent_runs AS ar
        ON ar.id = h.aborted_by_agent_run_id
      WHERE h.id = ${handId}::uuid
        AND h.session_id = ${sessionId}::uuid
        AND h.owner_id = ${owner.databaseOwnerId}::uuid
      FOR UPDATE OF h
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (rows.length === 0) throw new ResourceNotFoundError()
  if (rows.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  const audit = parseHandAuditRow(rows[0], owner)
  if (audit.status !== 'inProgress') throw new HandAuditTransitionError()
  return audit
}

export async function insertInProgressHandAudit(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: InsertInProgressHandAuditInput,
): Promise<{ readonly handId: string; readonly handNumber: number }> {
  const parsed = InsertInProgressHandAuditInputSchema.safeParse(input)
  if (!isResolvedOwnerScope(owner) || !parsed.success) {
    throw new RepositoryInputValidationError()
  }
  const checkpoint = decodeCheckpointForWrite(parsed.data.checkpoint)
  const facts = checkpoint.payload.checkpoint.startedHand
  const payload = transaction.json(checkpoint.payload as unknown as JSONValue)

  let rows: readonly unknown[]
  try {
    rows = await transaction`
      INSERT INTO app_private.hands (
        id,
        session_id,
        owner_id,
        hand_number,
        status,
        hand_start_checkpoint_payload_version,
        hand_start_checkpoint_payload,
        button_seat,
        participant_seats,
        started_at,
        updated_at
      )
      SELECT
        ${facts.handId}::uuid,
        session.id,
        session.owner_id,
        ${facts.handNumber}::bigint,
        'inProgress',
        ${checkpoint.payloadVersion},
        ${payload},
        ${facts.buttonSeatNumber},
        ${facts.participantSeatNumbers}::integer[],
        ${parsed.data.startedAt}::timestamptz,
        ${parsed.data.startedAt}::timestamptz
      FROM app_private.sessions AS session
      WHERE session.id = ${parsed.data.sessionId}::uuid
        AND session.owner_id = ${owner.databaseOwnerId}::uuid
      RETURNING id::text AS "handId", hand_number::float8 AS "handNumber"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const inserted = z.array(InsertedHandRowSchema).safeParse(rows)
  if (inserted.success && inserted.data.length === 0) {
    throw new ResourceNotFoundError()
  }
  if (
    !inserted.success ||
    inserted.data.length !== 1 ||
    inserted.data[0]?.handId !== facts.handId ||
    inserted.data[0]?.handNumber !== facts.handNumber
  ) {
    throw new HandAuditTransitionError()
  }
  return Object.freeze(inserted.data[0])
}

export async function completeHandAudit(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: CompleteHandAuditInput,
): Promise<Extract<HandAudit, { readonly status: 'completed' }>> {
  const parsed = CompleteHandAuditInputSchema.safeParse(input)
  if (!isResolvedOwnerScope(owner) || !parsed.success) {
    throw new RepositoryInputValidationError()
  }
  const completedResult = decodeCompletedResultForWrite(parsed.data.result)
  const result = completedResult.payload.result
  if (result.handId !== parsed.data.handId) {
    throw new RepositoryInputValidationError()
  }
  const locked = await lockInProgressHandAudit(
    transaction,
    owner,
    parsed.data.sessionId,
    parsed.data.handId,
  )
  if (!completedHandResultMirrorsCheckpoint(locked.checkpoint, result)) {
    throw new RepositoryInputValidationError()
  }
  const payload = transaction.json(
    completedResult.payload as unknown as JSONValue,
  )

  let rows: readonly unknown[]
  try {
    rows = await transaction`
      UPDATE app_private.hands
      SET status = 'completed',
          completed_result_payload_version = ${completedResult.payloadVersion},
          completed_result_payload = ${payload},
          completed_at = ${parsed.data.completedAt}::timestamptz,
          updated_at = ${parsed.data.completedAt}::timestamptz
      WHERE id = ${parsed.data.handId}::uuid
        AND session_id = ${parsed.data.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND status = 'inProgress'
      RETURNING id::text AS "handId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const updated = z.array(z.strictObject({ handId: z.uuid() })).safeParse(rows)
  if (
    !updated.success ||
    updated.data.length !== 1 ||
    updated.data[0]?.handId !== locked.handId
  ) {
    throw new HandAuditTransitionError()
  }
  return deepFreeze({
    ...locked,
    status: 'completed',
    result,
    completedAt: toDatabaseTimestamp(parsed.data.completedAt),
    updatedAt: toDatabaseTimestamp(parsed.data.completedAt),
    abortReasonCode: null,
    failedAgentRunId: null,
    abortedAt: null,
  })
}

export async function abortHandAudit(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: AbortHandAuditInput,
): Promise<Extract<HandAudit, { readonly status: 'aborted' }>> {
  const parsed = AbortHandAuditInputSchema.safeParse(input)
  if (!isResolvedOwnerScope(owner) || !parsed.success) {
    throw new RepositoryInputValidationError()
  }
  const locked = await lockInProgressHandAudit(
    transaction,
    owner,
    parsed.data.sessionId,
    parsed.data.handId,
  )

  let runRows: readonly unknown[]
  try {
    runRows = await transaction`
      SELECT
        id::text AS "agentRunId",
        session_id::text AS "sessionId",
        hand_id::text AS "handId",
        runtime
      FROM app_private.agent_runs
      WHERE id = ${parsed.data.failedAgentRunId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND session_id = ${parsed.data.sessionId}::uuid
        AND hand_id = ${parsed.data.handId}::uuid
      FOR UPDATE
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (runRows.length === 0) throw new ResourceNotFoundError()
  const run = z.array(AbortingAgentRunRowSchema).safeParse(runRows)
  if (!run.success || run.data.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  if (
    run.data[0]?.runtime !== 'player' ||
    run.data[0]?.agentRunId !== parsed.data.failedAgentRunId ||
    run.data[0]?.sessionId !== parsed.data.sessionId ||
    run.data[0]?.handId !== parsed.data.handId
  ) {
    throw new HandAuditTransitionError()
  }

  let updatedRows: readonly unknown[]
  try {
    updatedRows = await transaction`
      UPDATE app_private.hands
      SET status = 'aborted',
          abort_reason = ${parsed.data.reasonCode},
          aborted_by_agent_run_id = ${parsed.data.failedAgentRunId}::uuid,
          aborted_at = ${parsed.data.abortedAt}::timestamptz,
          updated_at = ${parsed.data.abortedAt}::timestamptz
      WHERE id = ${parsed.data.handId}::uuid
        AND session_id = ${parsed.data.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND status = 'inProgress'
      RETURNING id::text AS "handId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const updated = z
    .array(z.strictObject({ handId: z.uuid() }))
    .safeParse(updatedRows)
  if (
    !updated.success ||
    updated.data.length !== 1 ||
    updated.data[0]?.handId !== locked.handId
  ) {
    throw new HandAuditTransitionError()
  }
  return deepFreeze({
    ...locked,
    status: 'aborted',
    result: null,
    completedAt: null,
    abortReasonCode: parsed.data.reasonCode,
    failedAgentRunId: parsed.data.failedAgentRunId,
    abortedAt: toDatabaseTimestamp(parsed.data.abortedAt),
    updatedAt: toDatabaseTimestamp(parsed.data.abortedAt),
  })
}

export async function readHandAudit(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  handId: string,
): Promise<HandAudit> {
  const parsedIds = z
    .strictObject({ sessionId: z.uuid(), handId: z.uuid() })
    .safeParse({ sessionId, handId })
  if (!isResolvedOwnerScope(owner) || !parsedIds.success) {
    throw new RepositoryInputValidationError()
  }

  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        h.id::text AS "handId",
        h.session_id::text AS "sessionId",
        h.hand_number::float8 AS "handNumber",
        h.status,
        h.hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
        h.hand_start_checkpoint_payload AS "checkpointPayload",
        h.completed_result_payload_version AS "completedResultPayloadVersion",
        h.completed_result_payload AS "completedResultPayload",
        h.abort_reason AS "abortReasonCode",
        h.aborted_by_agent_run_id::text AS "failedAgentRunId",
        h.button_seat AS "buttonSeatNumber",
        h.participant_seats AS "participantSeatNumbers",
        to_char(h.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt",
        CASE WHEN h.completed_at IS NULL THEN NULL ELSE
          to_char(h.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        END AS "completedAt",
        CASE WHEN h.aborted_at IS NULL THEN NULL ELSE
          to_char(h.aborted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        END AS "abortedAt",
        to_char(h.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt",
        ar.runtime AS "abortedRunRuntime",
        ar.owner_id::text AS "abortedRunOwnerId",
        ar.session_id::text AS "abortedRunSessionId",
        ar.hand_id::text AS "abortedRunHandId"
      FROM app_private.hands AS h
      LEFT JOIN app_private.agent_runs AS ar
        ON ar.id = h.aborted_by_agent_run_id
      WHERE h.id = ${parsedIds.data.handId}::uuid
        AND h.session_id = ${parsedIds.data.sessionId}::uuid
        AND h.owner_id = ${owner.databaseOwnerId}::uuid
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (rows.length === 0) throw new ResourceNotFoundError()
  if (rows.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidHandAudit')
  }
  return parseHandAuditRow(rows[0], owner)
}
