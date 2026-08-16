import type { TransactionSql } from 'postgres'
import { SseEventSchema, type SseEvent } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { type StoredPrivateEvent } from '../sessions/authoritative-state/private-event-codec.js'
import type { CurrentPrivateEventProtocol } from '../sessions/authoritative-state/current-private-event-protocol.js'
import { currentPrivateEventProtocol as productionCurrentPrivateEventProtocol } from '../sessions/authoritative-state/current-private-event-protocol.js'
import {
  getPrivateEventHandId,
  type PrivateEvent,
} from '../sessions/authoritative-state/private-event.js'
import {
  decodeCurrentSnapshotV1,
  type StoredTableSnapshotV1,
} from '../sessions/authoritative-state/snapshot-codec-v1.js'
import {
  SESSION_DIAGNOSTIC_CODES,
  type SessionDiagnosticCode,
} from '../sessions/authoritative-state/recovery-decision.js'
import { canonicalJson, type JsonValue } from '../personas/config.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  SessionMutationTransitionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const POSTGRES_TEXT_OID = 25
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
const DatabaseUtcTimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)

const LockedSessionRowSchema = z.strictObject({
  sessionId: z.uuid(),
  lifecycleStatus: z.enum(['active', 'ended', 'readonlyDiagnostic']),
  endedAt: DatabaseUtcTimestampSchema.nullable(),
  stateVersion: SafeNonnegativeIntegerSchema,
  nextEventSeq: SafeNonnegativeIntegerSchema,
  currentHandId: z.uuid().nullable(),
  diagnosticCode: z.enum(SESSION_DIAGNOSTIC_CODES).nullable(),
  diagnosedAt: DatabaseUtcTimestampSchema.nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: z.uuid().nullable(),
  activeDecisionRequestId: z.uuid().nullable(),
})

declare const lockedSessionMutationBrand: unique symbol

export interface LockedSessionView {
  readonly sessionId: string
  readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
  readonly endedAt: string | null
  readonly stateVersion: number
  readonly nextEventSeq: number
  readonly currentHandId: string | null
  readonly diagnosticCode: SessionDiagnosticCode | null
  readonly diagnosedAt: string | null
  readonly agentRunState: 'idle' | 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
}

export interface LockedSessionMutation extends LockedSessionView {
  readonly [lockedSessionMutationBrand]: never
}

export interface SessionMutationEventInput {
  readonly eventId: string
  readonly eventSeq: number
  readonly handId: string | null
  readonly commandLedgerId: string | null
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly privateEvent: StoredPrivateEvent
  readonly publicEvent: SseEvent
  readonly createdAt: string
}

export interface SessionMutationBatch {
  readonly finalStateVersion: number
  readonly lifecycleStatus: 'active' | 'ended'
  readonly currentHandId: string | null
  readonly agentRunState: 'idle' | 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
  readonly snapshot: StoredTableSnapshotV1 | null
  readonly events: readonly SessionMutationEventInput[]
  readonly mutationAt: string
}

export interface PersistedSessionMutation {
  readonly sessionId: string
  readonly finalStateVersion: number
  readonly nextEventSeq: number
  readonly firstEventSeq: number
  readonly lastEventSeq: number
  readonly events: readonly SseEvent[]
}

const SessionMutationBatchSchema = z.strictObject({
  finalStateVersion: SafeNonnegativeIntegerSchema,
  lifecycleStatus: z.enum(['active', 'ended']),
  currentHandId: z.uuid().nullable(),
  agentRunState: z.enum(['idle', 'thinking', 'paused']),
  activePlayerRunId: z.uuid().nullable(),
  activeDecisionRequestId: z.uuid().nullable(),
  snapshot: z.unknown().nullable(),
  events: z
    .array(
      z.strictObject({
        eventId: z.uuid(),
        eventSeq: SafeNonnegativeIntegerSchema,
        handId: z.uuid().nullable(),
        commandLedgerId: z.uuid().nullable(),
        stateVersionBefore: SafeNonnegativeIntegerSchema,
        stateVersionAfter: SafeNonnegativeIntegerSchema,
        privateEvent: z.unknown(),
        publicEvent: z.unknown(),
        createdAt: CanonicalUtcTimestampSchema,
      }),
    )
    .min(1),
  mutationAt: CanonicalUtcTimestampSchema,
})

interface LockedSessionMetadata {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly repositoryIdentity: object
}

const lockedSessionMetadata = new WeakMap<
  LockedSessionMutation,
  LockedSessionMetadata
>()
const consumedLockedSessions = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

function normalizeUuid(value: string): string {
  return value.toLowerCase()
}

function nullableUuidEquals(
  left: string | null,
  right: string | null,
): boolean {
  return left === null || right === null
    ? left === right
    : normalizeUuid(left) === normalizeUuid(right)
}

function canonicalPublicState(event: SseEvent): string {
  const snapshot = structuredClone(event.payload.snapshot) as unknown as Record<
    string,
    unknown
  >
  delete snapshot.eventSeq
  return canonicalJson(snapshot as JsonValue)
}

function assertAvailableLockedSession(
  repositoryIdentity: object,
  transaction: TransactionSql,
  locked: LockedSessionMutation,
): LockedSessionMetadata {
  if (
    typeof locked !== 'object' ||
    locked === null ||
    !lockedSessionMetadata.has(locked)
  ) {
    throw new RepositoryInputValidationError()
  }
  if (consumedLockedSessions.has(locked)) {
    throw new SessionMutationTransitionError()
  }
  const metadata = lockedSessionMetadata.get(locked) as LockedSessionMetadata
  if (
    metadata.repositoryIdentity !== repositoryIdentity ||
    metadata.transaction !== transaction ||
    locked.lifecycleStatus !== 'active'
  ) {
    throw new SessionMutationTransitionError()
  }
  return metadata
}

async function lockSessionForMutationFor(
  repositoryIdentity: object,
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
): Promise<LockedSessionMutation> {
  const parsedSessionId = z.uuid().safeParse(sessionId)
  if (!isResolvedOwnerScope(owner) || !parsedSessionId.success) {
    throw new RepositoryInputValidationError()
  }

  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        id::text AS "sessionId",
        lifecycle_status AS "lifecycleStatus",
        CASE WHEN ended_at IS NULL THEN NULL ELSE
          to_char(ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        END AS "endedAt",
        state_version::float8 AS "stateVersion",
        next_event_seq::float8 AS "nextEventSeq",
        current_hand_id::text AS "currentHandId",
        diagnostic_code AS "diagnosticCode",
        CASE WHEN diagnosed_at IS NULL THEN NULL ELSE
          to_char(diagnosed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
        END AS "diagnosedAt",
        agent_run_state AS "agentRunState",
        active_player_run_id::text AS "activePlayerRunId",
        active_decision_request_id::text AS "activeDecisionRequestId"
      FROM app_private.sessions
      WHERE id = ${parsedSessionId.data}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
      FOR UPDATE
    `
  } catch {
    throw new DatabaseOperationError()
  }

  if (rows.length === 0) {
    throw new ResourceNotFoundError()
  }
  const parsedRow = LockedSessionRowSchema.safeParse(rows[0])
  if (rows.length !== 1 || !parsedRow.success) {
    throw new PersistenceDataCorruptionError('invalidSessionMutationState')
  }
  const row = parsedRow.data
  const hasBothPlayerPointers =
    row.activePlayerRunId !== null && row.activeDecisionRequestId !== null
  const hasNeitherPlayerPointer =
    row.activePlayerRunId === null && row.activeDecisionRequestId === null
  const hasBothDiagnosticFields =
    row.diagnosticCode !== null && row.diagnosedAt !== null
  const hasNeitherDiagnosticField =
    row.diagnosticCode === null && row.diagnosedAt === null
  if (
    (row.lifecycleStatus === 'active' && row.endedAt !== null) ||
    (row.lifecycleStatus === 'ended' && row.endedAt === null) ||
    (row.lifecycleStatus === 'readonlyDiagnostic'
      ? !hasBothDiagnosticFields
      : !hasNeitherDiagnosticField) ||
    (row.agentRunState === 'thinking'
      ? !hasBothPlayerPointers
      : !hasNeitherPlayerPointer)
  ) {
    throw new PersistenceDataCorruptionError('invalidSessionMutationState')
  }

  const locked = Object.freeze(row) as LockedSessionMutation
  lockedSessionMetadata.set(locked, { transaction, owner, repositoryIdentity })
  return locked
}

function validateSessionMutationFor(
  repositoryIdentity: object,
  currentPrivateEventProtocol: CurrentPrivateEventProtocol<
    PrivateEvent,
    StoredPrivateEvent
  >,
  transaction: TransactionSql,
  locked: LockedSessionMutation,
  batch: SessionMutationBatch,
): {
  readonly metadata: LockedSessionMetadata
  readonly parsedBatch: {
    readonly success: true
    readonly data: z.infer<typeof SessionMutationBatchSchema>
  }
  readonly snapshot: StoredTableSnapshotV1 | null
  readonly events: readonly {
    readonly input: z.infer<typeof SessionMutationBatchSchema>['events'][number]
    readonly privateEvent: StoredPrivateEvent
    readonly privateEventDraft: PrivateEvent
    readonly publicEvent: SseEvent
  }[]
} {
  const metadata = assertAvailableLockedSession(
    repositoryIdentity,
    transaction,
    locked,
  )
  const parsedBatch = SessionMutationBatchSchema.safeParse(batch)
  if (!parsedBatch.success) {
    throw new RepositoryInputValidationError()
  }

  let snapshot: StoredTableSnapshotV1 | null = null
  const events: Array<{
    readonly input: z.infer<typeof SessionMutationBatchSchema>['events'][number]
    readonly privateEvent: StoredPrivateEvent
    readonly privateEventDraft: PrivateEvent
    readonly publicEvent: SseEvent
  }> = []
  try {
    snapshot =
      parsedBatch.data.snapshot === null
        ? null
        : decodeCurrentSnapshotV1(parsedBatch.data.snapshot)
    for (const event of parsedBatch.data.events) {
      const publicEvent = SseEventSchema.parse(event.publicEvent)
      events.push({
        input: event,
        privateEvent: event.privateEvent as StoredPrivateEvent,
        privateEventDraft: currentPrivateEventProtocol.decodeStoredCurrent(
          event.privateEvent,
        ),
        publicEvent,
      })
    }
  } catch {
    throw new RepositoryInputValidationError()
  }

  const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
  const hasValidStateTransition =
    snapshot === null
      ? parsedBatch.data.finalStateVersion === locked.stateVersion &&
        parsedBatch.data.currentHandId === locked.currentHandId
      : BigInt(locked.stateVersion) < maximumSafeInteger &&
        BigInt(parsedBatch.data.finalStateVersion) ===
          BigInt(locked.stateVersion) + 1n &&
        snapshot.payload.state.stateVersion ===
          parsedBatch.data.finalStateVersion
  const hasValidSnapshotPointer =
    snapshot === null ||
    (snapshot.payload.state.poker.pokerPhase === 'inHand'
      ? snapshot.payload.state.poker.hand?.handId ===
        parsedBatch.data.currentHandId
      : parsedBatch.data.currentHandId === null)
  const nextEventSeqBigInt = BigInt(locked.nextEventSeq) + BigInt(events.length)
  const eventIds = new Set(
    events.map(({ input }) => normalizeUuid(input.eventId)),
  )
  const commandLedgerIds = events.map(({ input }) =>
    input.commandLedgerId === null
      ? null
      : normalizeUuid(input.commandLedgerId),
  )
  const firstCommandLedgerId = commandLedgerIds[0]
  const firstPublicState = canonicalPublicState(events[0]!.publicEvent)
  const hasBothPlayerPointers =
    parsedBatch.data.activePlayerRunId !== null &&
    parsedBatch.data.activeDecisionRequestId !== null
  const hasNeitherPlayerPointer =
    parsedBatch.data.activePlayerRunId === null &&
    parsedBatch.data.activeDecisionRequestId === null
  const hasValidPlayerCoordination =
    parsedBatch.data.agentRunState === 'thinking'
      ? hasBothPlayerPointers
      : hasNeitherPlayerPointer
  const hasValidEndedState =
    parsedBatch.data.lifecycleStatus !== 'ended' ||
    (parsedBatch.data.currentHandId === null &&
      parsedBatch.data.agentRunState === 'idle' &&
      hasNeitherPlayerPointer)
  const hasValidPublicCoordination = (publicEvent: SseEvent) => {
    const publicSnapshot = publicEvent.payload.snapshot
    if (
      normalizeUuid(publicSnapshot.sessionId) !==
        normalizeUuid(locked.sessionId) ||
      publicSnapshot.lifecycleStatus !== parsedBatch.data.lifecycleStatus ||
      publicSnapshot.agentRunState !== parsedBatch.data.agentRunState
    ) {
      return false
    }
    return parsedBatch.data.agentRunState === 'thinking'
      ? publicSnapshot.activeDecision !== null &&
          parsedBatch.data.activeDecisionRequestId !== null &&
          normalizeUuid(publicSnapshot.activeDecision.decisionRequestId) ===
            normalizeUuid(parsedBatch.data.activeDecisionRequestId)
      : publicSnapshot.activeDecision === null
  }
  if (
    !hasValidStateTransition ||
    !hasValidSnapshotPointer ||
    !hasValidPlayerCoordination ||
    !hasValidEndedState ||
    nextEventSeqBigInt > maximumSafeInteger ||
    eventIds.size !== events.length ||
    commandLedgerIds.some((ledgerId) => ledgerId !== firstCommandLedgerId) ||
    events.some(
      ({ input, privateEventDraft, publicEvent }, index) =>
        input.stateVersionBefore !== locked.stateVersion ||
        input.stateVersionAfter !== parsedBatch.data.finalStateVersion ||
        BigInt(input.eventSeq) !==
          BigInt(locked.nextEventSeq) + BigInt(index) ||
        normalizeUuid(input.eventId) !== normalizeUuid(publicEvent.eventId) ||
        normalizeUuid(publicEvent.sessionId) !==
          normalizeUuid(locked.sessionId) ||
        input.eventSeq !== publicEvent.eventSeq ||
        publicEvent.stateVersion !== parsedBatch.data.finalStateVersion ||
        publicEvent.payload.snapshot.stateVersion !==
          parsedBatch.data.finalStateVersion ||
        !hasValidPublicCoordination(publicEvent) ||
        privateEventDraft.type !== publicEvent.type ||
        !nullableUuidEquals(
          input.handId,
          getPrivateEventHandId(privateEventDraft),
        ) ||
        canonicalPublicState(publicEvent) !== firstPublicState,
    )
  ) {
    throw new RepositoryInputValidationError()
  }

  return { metadata, parsedBatch, snapshot, events }
}

async function persistSessionMutationFor(
  repositoryIdentity: object,
  currentPrivateEventProtocol: CurrentPrivateEventProtocol<
    PrivateEvent,
    StoredPrivateEvent
  >,
  transaction: TransactionSql,
  locked: LockedSessionMutation,
  batch: SessionMutationBatch,
): Promise<PersistedSessionMutation> {
  const { metadata, parsedBatch, snapshot, events } =
    validateSessionMutationFor(
      repositoryIdentity,
      currentPrivateEventProtocol,
      transaction,
      locked,
      batch,
    )

  const nextEventSeq = Number(
    BigInt(locked.nextEventSeq) + BigInt(events.length),
  )
  consumedLockedSessions.add(locked)

  let updatedRows: readonly { readonly sessionId: string }[]
  try {
    updatedRows = await transaction<{ readonly sessionId: string }[]>`
      UPDATE app_private.sessions
      SET lifecycle_status = ${parsedBatch.data.lifecycleStatus},
          state_version = ${parsedBatch.data.finalStateVersion}::bigint,
          next_event_seq = ${nextEventSeq}::bigint,
          current_hand_id = ${parsedBatch.data.currentHandId}::uuid,
          agent_run_state = ${parsedBatch.data.agentRunState},
          active_player_run_id = ${parsedBatch.data.activePlayerRunId}::uuid,
          active_decision_request_id = ${parsedBatch.data.activeDecisionRequestId}::uuid,
          ended_at = ${parsedBatch.data.lifecycleStatus === 'ended' ? parsedBatch.data.mutationAt : null}::timestamptz,
          updated_at = ${parsedBatch.data.mutationAt}::timestamptz
      WHERE id = ${locked.sessionId}::uuid
        AND owner_id = ${metadata.owner.databaseOwnerId}::uuid
        AND lifecycle_status = 'active'
        AND ended_at IS NULL
        AND diagnostic_code IS NULL
        AND diagnosed_at IS NULL
        AND state_version = ${locked.stateVersion}::bigint
        AND next_event_seq = ${locked.nextEventSeq}::bigint
      RETURNING id::text AS "sessionId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (
    updatedRows.length !== 1 ||
    updatedRows[0]?.sessionId !== locked.sessionId
  ) {
    throw new SessionMutationTransitionError()
  }

  if (snapshot !== null) {
    const snapshotPayload = transaction.typed(
      JSON.stringify(snapshot.payload),
      POSTGRES_TEXT_OID,
    )
    let snapshotRows: readonly { readonly sessionId: string }[]
    try {
      snapshotRows = await transaction<{ readonly sessionId: string }[]>`
        INSERT INTO app_private.session_snapshots (
          session_id,
          owner_id,
          private_table_state_payload_version,
          private_table_state_payload,
          updated_at
        ) VALUES (
          ${locked.sessionId}::uuid,
          ${metadata.owner.databaseOwnerId}::uuid,
          ${snapshot.payloadVersion},
          ${snapshotPayload}::jsonb,
          ${parsedBatch.data.mutationAt}::timestamptz
        )
        ON CONFLICT (session_id) DO UPDATE
        SET owner_id = EXCLUDED.owner_id,
            private_table_state_payload_version = EXCLUDED.private_table_state_payload_version,
            private_table_state_payload = EXCLUDED.private_table_state_payload,
            updated_at = EXCLUDED.updated_at
        WHERE app_private.session_snapshots.owner_id = EXCLUDED.owner_id
        RETURNING session_id::text AS "sessionId"
      `
    } catch {
      throw new DatabaseOperationError()
    }
    if (
      snapshotRows.length !== 1 ||
      snapshotRows[0]?.sessionId !== locked.sessionId
    ) {
      throw new SessionMutationTransitionError()
    }
  }

  const eventRows = events.map(({ input, privateEvent, publicEvent }) => ({
    id: input.eventId,
    session_id: locked.sessionId,
    owner_id: metadata.owner.databaseOwnerId,
    hand_id: input.handId,
    command_ledger_id: input.commandLedgerId,
    event_seq: input.eventSeq,
    state_version_before: input.stateVersionBefore,
    state_version_after: input.stateVersionAfter,
    private_event_payload_version: privateEvent.payloadVersion,
    private_event_payload: privateEvent.payload,
    public_event_payload: publicEvent,
    created_at: input.createdAt,
  }))
  const eventRowsJson = transaction.typed(
    JSON.stringify(eventRows),
    POSTGRES_TEXT_OID,
  )
  let insertedRows: readonly unknown[]
  try {
    insertedRows = await transaction`
      INSERT INTO app_private.session_events (
        id,
        session_id,
        owner_id,
        hand_id,
        command_ledger_id,
        event_seq,
        state_version_before,
        state_version_after,
        private_event_payload_version,
        private_event_payload,
        public_event_payload,
        created_at
      )
      SELECT
        id,
        session_id,
        owner_id,
        hand_id,
        command_ledger_id,
        event_seq,
        state_version_before,
        state_version_after,
        private_event_payload_version,
        private_event_payload,
        public_event_payload,
        created_at
      FROM jsonb_populate_recordset(
        NULL::app_private.session_events,
        ${eventRowsJson}::jsonb
      )
      RETURNING id::text AS "eventId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsedInsertedRows = z
    .array(z.strictObject({ eventId: z.uuid() }))
    .safeParse(insertedRows)
  if (!parsedInsertedRows.success) {
    throw new SessionMutationTransitionError()
  }
  const insertedEventIds = new Set(
    parsedInsertedRows.data.map((row) => normalizeUuid(row.eventId)),
  )
  if (
    parsedInsertedRows.data.length !== eventRows.length ||
    eventRows.some((row) => !insertedEventIds.has(normalizeUuid(row.id)))
  ) {
    throw new SessionMutationTransitionError()
  }

  return deepFreeze({
    sessionId: locked.sessionId,
    finalStateVersion: parsedBatch.data.finalStateVersion,
    nextEventSeq,
    firstEventSeq: events[0]!.input.eventSeq,
    lastEventSeq: events.at(-1)!.input.eventSeq,
    events: events.map((event) => structuredClone(event.publicEvent)),
  })
}

export interface SessionMutationRepository {
  readonly currentPrivateEventProtocol: CurrentPrivateEventProtocol<
    PrivateEvent,
    StoredPrivateEvent
  >
  lockSessionForMutation(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    sessionId: string,
  ): Promise<LockedSessionMutation>
  validateSessionMutation(
    transaction: TransactionSql,
    locked: LockedSessionMutation,
    batch: SessionMutationBatch,
  ): void
  persistSessionMutation(
    transaction: TransactionSql,
    locked: LockedSessionMutation,
    batch: SessionMutationBatch,
  ): Promise<PersistedSessionMutation>
}

export function createSessionMutationRepository(input: {
  readonly currentPrivateEventProtocol: CurrentPrivateEventProtocol<
    PrivateEvent,
    StoredPrivateEvent
  >
}): SessionMutationRepository {
  if (
    typeof input !== 'object' ||
    input === null ||
    typeof input.currentPrivateEventProtocol?.decodeStoredCurrent !== 'function'
  ) {
    throw new RepositoryInputValidationError()
  }
  const currentPrivateEventProtocol = input.currentPrivateEventProtocol
  const repositoryIdentity = Object.freeze({})
  return Object.freeze({
    currentPrivateEventProtocol,
    lockSessionForMutation: (
      transaction: TransactionSql,
      owner: ResolvedOwnerScope,
      sessionId: string,
    ) =>
      lockSessionForMutationFor(
        repositoryIdentity,
        transaction,
        owner,
        sessionId,
      ),
    validateSessionMutation: (
      transaction: TransactionSql,
      locked: LockedSessionMutation,
      batch: SessionMutationBatch,
    ) => {
      validateSessionMutationFor(
        repositoryIdentity,
        currentPrivateEventProtocol,
        transaction,
        locked,
        batch,
      )
    },
    persistSessionMutation: (
      transaction: TransactionSql,
      locked: LockedSessionMutation,
      batch: SessionMutationBatch,
    ) =>
      persistSessionMutationFor(
        repositoryIdentity,
        currentPrivateEventProtocol,
        transaction,
        locked,
        batch,
      ),
  })
}

export const productionSessionMutationRepository =
  createSessionMutationRepository({
    currentPrivateEventProtocol: productionCurrentPrivateEventProtocol,
  })

export const lockSessionForMutation =
  productionSessionMutationRepository.lockSessionForMutation
export const validateSessionMutation =
  productionSessionMutationRepository.validateSessionMutation
export const persistSessionMutation =
  productionSessionMutationRepository.persistSessionMutation
