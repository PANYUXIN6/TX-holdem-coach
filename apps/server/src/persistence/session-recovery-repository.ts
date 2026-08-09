import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  decideSessionRecovery,
  type RecoveryRegistries,
  type SessionDiagnosticCode,
  type SessionRecoveryFacts,
} from '../sessions/authoritative-state/recovery-decision.js'
import type { PrivateTableState } from '../sessions/authoritative-state/private-table-state.js'
import {
  ActiveSessionConflictError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  SessionRecoveryTransitionError,
} from './errors.js'
import {
  productionSessionMutationRepository,
  type LockedSessionMutation,
  type LockedSessionView,
  type SessionMutationRepository,
} from './session-mutation-repository.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
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

const SnapshotRowSchema = z.strictObject({
  rowPayloadVersion: z.number(),
  payload: z.unknown(),
})
const InProgressHandRowSchema = z.strictObject({ handId: z.uuid() })
const EventRowSchema = z.strictObject({
  eventSeq: SafeNonnegativeIntegerSchema,
  handId: z.uuid().nullable(),
  stateVersionBefore: z.number(),
  stateVersionAfter: z.number(),
  rowPayloadVersion: z.number(),
  payload: z.unknown(),
})

export interface PointerRepair {
  readonly from: string | null
  readonly to: string | null
}

export type SessionRecoveryTransactionResult =
  | {
      readonly kind: 'ready'
      readonly lifecycleStatus: 'active'
      readonly state: PrivateTableState
      readonly locked: LockedSessionMutation
      readonly session: LockedSessionView
      readonly pointerRepair: PointerRepair | null
    }
  | {
      readonly kind: 'ended'
      readonly state: PrivateTableState
      readonly session: LockedSessionView
      readonly pointerRepair: PointerRepair | null
    }
  | {
      readonly kind: 'readonlyDiagnostic'
      readonly code: SessionDiagnosticCode
      readonly diagnosedAt: string
    }

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

function createLockedSessionView(
  locked: LockedSessionMutation,
): LockedSessionView {
  return deepFreeze({
    sessionId: locked.sessionId,
    lifecycleStatus: locked.lifecycleStatus,
    endedAt: locked.endedAt,
    stateVersion: locked.stateVersion,
    nextEventSeq: locked.nextEventSeq,
    currentHandId: locked.currentHandId,
    diagnosticCode: locked.diagnosticCode,
    diagnosedAt: locked.diagnosedAt,
    agentRunState: locked.agentRunState,
    activePlayerRunId: locked.activePlayerRunId,
    activeDecisionRequestId: locked.activeDecisionRequestId,
  })
}

function getPostgresConstraint(error: unknown): string | undefined {
  if (
    typeof error === 'object' &&
    error !== null &&
    'constraint_name' in error &&
    typeof error.constraint_name === 'string'
  ) {
    return error.constraint_name
  }
  return undefined
}

function validateInputs(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  recoveryAt: string,
  registries: RecoveryRegistries,
): void {
  if (
    typeof transaction !== 'function' ||
    !isResolvedOwnerScope(owner) ||
    !z.uuid().safeParse(sessionId).success ||
    !CanonicalUtcTimestampSchema.safeParse(recoveryAt).success ||
    typeof registries !== 'object' ||
    registries === null ||
    typeof registries.snapshot?.read !== 'function' ||
    typeof registries.privateEvent?.read !== 'function'
  ) {
    throw new RepositoryInputValidationError()
  }
}

async function readRecoveryFacts(
  transaction: TransactionSql,
  locked: LockedSessionMutation,
  owner: ResolvedOwnerScope,
): Promise<SessionRecoveryFacts> {
  let snapshotRows: readonly unknown[]
  try {
    snapshotRows = await transaction`
      SELECT
        private_table_state_payload_version::float8 AS "rowPayloadVersion",
        private_table_state_payload AS "payload"
      FROM app_private.session_snapshots
      WHERE session_id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsedSnapshots = z
    .array(SnapshotRowSchema)
    .max(1)
    .safeParse(snapshotRows)
  if (!parsedSnapshots.success) {
    throw new PersistenceDataCorruptionError('invalidSessionMutationState')
  }

  let handRows: readonly unknown[]
  try {
    handRows = await transaction`
      SELECT id::text AS "handId"
      FROM app_private.hands
      WHERE session_id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND status = 'inProgress'
      ORDER BY id
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsedHands = z.array(InProgressHandRowSchema).safeParse(handRows)
  if (!parsedHands.success) {
    throw new PersistenceDataCorruptionError('invalidSessionMutationState')
  }

  let eventRows: readonly unknown[]
  try {
    eventRows = await transaction`
      SELECT
        event_seq::float8 AS "eventSeq",
        hand_id::text AS "handId",
        state_version_before::float8 AS "stateVersionBefore",
        state_version_after::float8 AS "stateVersionAfter",
        private_event_payload_version::float8 AS "rowPayloadVersion",
        private_event_payload AS "payload"
      FROM app_private.session_events
      WHERE session_id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
      ORDER BY event_seq
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsedEvents = z.array(EventRowSchema).safeParse(eventRows)
  if (!parsedEvents.success) {
    throw new PersistenceDataCorruptionError('invalidSessionMutationState')
  }

  return {
    session: {
      lifecycleStatus: locked.lifecycleStatus,
      endedAt: locked.endedAt,
      stateVersion: locked.stateVersion,
      nextEventSeq: locked.nextEventSeq,
      currentHandId: locked.currentHandId,
      diagnosticCode: locked.diagnosticCode,
      diagnosedAt: locked.diagnosedAt,
    },
    snapshotRow: parsedSnapshots.data[0] ?? null,
    inProgressHandIds: parsedHands.data.map((row) => row.handId),
    eventRows: parsedEvents.data,
  }
}

async function repairCurrentHandPointer(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  locked: LockedSessionMutation,
  currentHandId: string | null,
  recoveryAt: string,
): Promise<void> {
  let rows: readonly { readonly sessionId: string }[]
  try {
    rows = await transaction<{ readonly sessionId: string }[]>`
      UPDATE app_private.sessions
      SET current_hand_id = ${currentHandId}::uuid,
          updated_at = ${recoveryAt}::timestamptz
      WHERE id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle_status = ${locked.lifecycleStatus}
        AND state_version = ${locked.stateVersion}::bigint
        AND next_event_seq = ${locked.nextEventSeq}::bigint
        AND current_hand_id IS NOT DISTINCT FROM ${locked.currentHandId}::uuid
      RETURNING id::text AS "sessionId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (rows.length !== 1 || rows[0]?.sessionId !== locked.sessionId) {
    throw new SessionRecoveryTransitionError()
  }
}

async function enterReadonlyDiagnostic(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  locked: LockedSessionMutation,
  code: SessionDiagnosticCode,
  recoveryAt: string,
): Promise<void> {
  let rows: readonly { readonly sessionId: string }[]
  try {
    rows = await transaction<{ readonly sessionId: string }[]>`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          diagnostic_code = ${code},
          diagnosed_at = ${recoveryAt}::timestamptz,
          updated_at = ${recoveryAt}::timestamptz
      WHERE id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle_status = ${locked.lifecycleStatus}
        AND state_version = ${locked.stateVersion}::bigint
        AND next_event_seq = ${locked.nextEventSeq}::bigint
        AND current_hand_id IS NOT DISTINCT FROM ${locked.currentHandId}::uuid
        AND diagnostic_code IS NULL
        AND diagnosed_at IS NULL
      RETURNING id::text AS "sessionId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (rows.length !== 1 || rows[0]?.sessionId !== locked.sessionId) {
    throw new SessionRecoveryTransitionError()
  }
}

async function replaceLegacyDiagnosticCode(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  locked: LockedSessionMutation,
  code: SessionDiagnosticCode,
  recoveryAt: string,
): Promise<void> {
  let rows: readonly { readonly sessionId: string }[]
  try {
    rows = await transaction<{ readonly sessionId: string }[]>`
      UPDATE app_private.sessions
      SET diagnostic_code = ${code},
          updated_at = ${recoveryAt}::timestamptz
      WHERE id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle_status = 'readonlyDiagnostic'
        AND state_version = ${locked.stateVersion}::bigint
        AND next_event_seq = ${locked.nextEventSeq}::bigint
        AND current_hand_id IS NOT DISTINCT FROM ${locked.currentHandId}::uuid
        AND diagnostic_code = 'legacyDiagnosticState'
        AND diagnosed_at IS NOT DISTINCT FROM ${locked.diagnosedAt}::timestamptz
      RETURNING id::text AS "sessionId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (rows.length !== 1 || rows[0]?.sessionId !== locked.sessionId) {
    throw new SessionRecoveryTransitionError()
  }
}

async function exitReadonlyDiagnostic(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  locked: LockedSessionMutation,
  currentHandId: string | null,
  recoveryAt: string,
): Promise<void> {
  const lifecycleStatus = locked.endedAt === null ? 'active' : 'ended'
  try {
    const rows = await transaction<{ readonly sessionId: string }[]>`
      UPDATE app_private.sessions
      SET lifecycle_status = ${lifecycleStatus},
          diagnostic_code = NULL,
          diagnosed_at = NULL,
          updated_at = ${recoveryAt}::timestamptz
      WHERE id = ${locked.sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
        AND lifecycle_status = 'readonlyDiagnostic'
        AND state_version = ${locked.stateVersion}::bigint
        AND next_event_seq = ${locked.nextEventSeq}::bigint
        AND current_hand_id IS NOT DISTINCT FROM ${currentHandId}::uuid
        AND diagnostic_code = ${locked.diagnosticCode}
        AND diagnosed_at IS NOT DISTINCT FROM ${locked.diagnosedAt}::timestamptz
      RETURNING id::text AS "sessionId"
    `
    if (rows.length !== 1 || rows[0]?.sessionId !== locked.sessionId) {
      throw new SessionRecoveryTransitionError()
    }
  } catch (error) {
    if (error instanceof SessionRecoveryTransitionError) {
      throw error
    }
    if (getPostgresConstraint(error) === 'sessions_one_active_per_owner') {
      throw new ActiveSessionConflictError()
    }
    throw new DatabaseOperationError()
  }
}

function readyResult(
  locked: LockedSessionMutation,
  state: PrivateTableState,
  pointerRepair: PointerRepair | null,
): SessionRecoveryTransactionResult {
  return locked.lifecycleStatus === 'active'
    ? deepFreeze({
        kind: 'ready',
        lifecycleStatus: 'active',
        state,
        locked,
        session: createLockedSessionView(locked),
        pointerRepair,
      })
    : deepFreeze({
        kind: 'ended',
        state,
        session: createLockedSessionView(locked),
        pointerRepair,
      })
}

async function recover(
  mode: 'ordinary' | 'retry',
  sessionMutationRepository: SessionMutationRepository,
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  recoveryAt: string,
  registries: RecoveryRegistries,
): Promise<SessionRecoveryTransactionResult> {
  validateInputs(transaction, owner, sessionId, recoveryAt, registries)
  const locked = await sessionMutationRepository.lockSessionForMutation(
    transaction,
    owner,
    sessionId,
  )

  if (mode === 'ordinary' && locked.lifecycleStatus === 'readonlyDiagnostic') {
    return deepFreeze({
      kind: 'readonlyDiagnostic',
      code: locked.diagnosticCode!,
      diagnosedAt: locked.diagnosedAt!,
    })
  }
  if (mode === 'retry' && locked.lifecycleStatus !== 'readonlyDiagnostic') {
    throw new SessionRecoveryTransitionError()
  }

  const facts = await readRecoveryFacts(transaction, locked, owner)
  const decision = decideSessionRecovery(facts, registries)
  if (decision.kind === 'readonlyDiagnostic') {
    if (mode === 'ordinary') {
      await enterReadonlyDiagnostic(
        transaction,
        owner,
        locked,
        decision.code,
        recoveryAt,
      )
      return deepFreeze({
        kind: 'readonlyDiagnostic',
        code: decision.code,
        diagnosedAt: recoveryAt,
      })
    }
    if (locked.diagnosticCode === 'legacyDiagnosticState') {
      await replaceLegacyDiagnosticCode(
        transaction,
        owner,
        locked,
        decision.code,
        recoveryAt,
      )
      return deepFreeze({
        kind: 'readonlyDiagnostic',
        code: decision.code,
        diagnosedAt: locked.diagnosedAt!,
      })
    }
    return deepFreeze({
      kind: 'readonlyDiagnostic',
      code: locked.diagnosticCode!,
      diagnosedAt: locked.diagnosedAt!,
    })
  }

  let pointerRepair: PointerRepair | null = null
  let currentHandId = locked.currentHandId
  if (decision.kind === 'repairCurrentHandPointer') {
    pointerRepair = Object.freeze({
      from: locked.currentHandId,
      to: decision.currentHandId,
    })
    await repairCurrentHandPointer(
      transaction,
      owner,
      locked,
      decision.currentHandId,
      recoveryAt,
    )
    currentHandId = decision.currentHandId
  }

  if (mode === 'retry') {
    await exitReadonlyDiagnostic(
      transaction,
      owner,
      locked,
      currentHandId,
      recoveryAt,
    )
  }

  if (decision.kind === 'repairCurrentHandPointer' || mode === 'retry') {
    const relocked = await sessionMutationRepository.lockSessionForMutation(
      transaction,
      owner,
      sessionId,
    )
    return readyResult(relocked, decision.state, pointerRepair)
  }
  return readyResult(locked, decision.state, null)
}

export interface SessionRecoveryRepository {
  readonly sessionMutationRepository: SessionMutationRepository
  recoverSessionForMutation(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    sessionId: string,
    recoveryAt: string,
    registries: RecoveryRegistries,
  ): Promise<SessionRecoveryTransactionResult>
  retryReadonlySessionRecovery(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    sessionId: string,
    recoveryAt: string,
    registries: RecoveryRegistries,
  ): Promise<SessionRecoveryTransactionResult>
}

export function createSessionRecoveryRepository(input: {
  readonly sessionMutationRepository: SessionMutationRepository
}): SessionRecoveryRepository {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.sessionMutationRepository?.lockSessionForMutation !==
      'function'
  ) {
    throw new RepositoryInputValidationError()
  }
  const sessionMutationRepository = input.sessionMutationRepository
  return Object.freeze({
    sessionMutationRepository,
    recoverSessionForMutation: (
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      sessionId: string,
      recoveryAt: string,
      registries: RecoveryRegistries,
    ) =>
      recover(
        'ordinary',
        sessionMutationRepository,
        transaction,
        owner,
        sessionId,
        recoveryAt,
        registries,
      ),
    retryReadonlySessionRecovery: (
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      sessionId: string,
      recoveryAt: string,
      registries: RecoveryRegistries,
    ) =>
      recover(
        'retry',
        sessionMutationRepository,
        transaction,
        owner,
        sessionId,
        recoveryAt,
        registries,
      ),
  })
}

export const productionSessionRecoveryRepository =
  createSessionRecoveryRepository({
    sessionMutationRepository: productionSessionMutationRepository,
  })

export const recoverSessionForMutation =
  productionSessionRecoveryRepository.recoverSessionForMutation
export const retryReadonlySessionRecovery =
  productionSessionRecoveryRepository.retryReadonlySessionRecovery
