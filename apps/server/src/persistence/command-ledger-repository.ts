import { createHash, randomUUID } from 'node:crypto'
import type { TransactionSql } from 'postgres'
import {
  AiSeatNumberSchema,
  CommandResponseSchema,
  CommandIdSchema,
  DecisionRequestIdSchema,
  ErrorResponseSchema,
  HandIdSchema,
  PokerActionSchema,
  SessionCommandSchema,
  SessionIdSchema,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import {
  canonicalJson,
  deepFreeze,
  type DeepReadonly,
  type JsonValue,
} from '../personas/config.js'
import {
  CommandLedgerTransitionError,
  CommandPayloadConflictError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const PublicLedgerCommandSchema = SessionCommandSchema.refine(
  (command) => command.expectedStateVersion <= Number.MAX_SAFE_INTEGER,
)

const AiActionLedgerCommandSchema = z.strictObject({
  sessionId: SessionIdSchema,
  commandId: CommandIdSchema,
  expectedStateVersion: SafeIntegerSchema,
  type: z.literal('aiAction'),
  payload: z.strictObject({
    decisionRequestId: DecisionRequestIdSchema,
    handId: HandIdSchema,
    actorSeatNumber: AiSeatNumberSchema,
    candidateActionId: z.string().trim().min(1).max(128),
    action: PokerActionSchema,
  }),
})

export const LedgerCommandSchema = z.union([
  PublicLedgerCommandSchema,
  AiActionLedgerCommandSchema,
])

export type LedgerCommand = z.infer<typeof LedgerCommandSchema>

export const COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION = 1 as const

const LedgerRowSchema = z.strictObject({
  ledgerId: z.string().uuid(),
  sessionId: SessionIdSchema,
  commandId: CommandIdSchema,
  canonicalPayloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  processingStatus: z.enum(['processing', 'completed', 'failed']),
  finalStateVersion: SafeIntegerSchema.nullable(),
  firstEventSeq: SafeIntegerSchema.nullable(),
  lastEventSeq: SafeIntegerSchema.nullable(),
  responsePayloadVersion: z.number().int().positive().nullable(),
  responsePayload: z.unknown().nullable(),
  hasCompletedAt: z.boolean(),
})

type LedgerRow = z.infer<typeof LedgerRowSchema>

declare const preparedCommandRegistrationBrand: unique symbol

export interface PreparedCommandRegistration {
  readonly command: DeepReadonly<LedgerCommand>
  readonly ledgerId: string
  readonly canonicalPayloadDigest: string
  readonly [preparedCommandRegistrationBrand]: never
}

declare const acquiredCommandRegistrationBrand: unique symbol

export interface AcquiredCommandRegistration {
  readonly status: 'acquired'
  readonly ledgerId: string
  readonly sessionId: string
  readonly commandId: string
  readonly canonicalPayloadDigest: string
  readonly owner: ResolvedOwnerScope
  readonly [acquiredCommandRegistrationBrand]: never
}

export type CommandRegistrationResult =
  | AcquiredCommandRegistration
  | { readonly status: 'processing' }
  | {
      readonly status: 'completed'
      readonly response: DeepReadonly<z.infer<typeof CommandResponseSchema>>
    }
  | {
      readonly status: 'failed'
      readonly response: DeepReadonly<z.infer<typeof ErrorResponseSchema>>
    }

const preparedRegistrations = new WeakSet<object>()
const acquiredTransactions = new WeakMap<
  AcquiredCommandRegistration,
  TransactionSql
>()
const consumedAcquiredRegistrations = new WeakSet<object>()

export const CommandEventRangeSchema = z
  .strictObject({
    firstEventSeq: SafeIntegerSchema,
    lastEventSeq: SafeIntegerSchema,
  })
  .refine((range) => range.firstEventSeq <= range.lastEventSeq)

export type CommandEventRange = Readonly<
  z.infer<typeof CommandEventRangeSchema>
>

function invalidLedger(): PersistenceDataCorruptionError {
  return new PersistenceDataCorruptionError('invalidCommandLedger')
}

function normalizeUuid(value: string): string {
  return value.toLowerCase()
}

function uuidEquals(left: string, right: string): boolean {
  return normalizeUuid(left) === normalizeUuid(right)
}

function normalizeLedgerCommand(command: LedgerCommand): LedgerCommand {
  if (command.type !== 'aiAction') {
    return {
      ...command,
      sessionId: normalizeUuid(command.sessionId),
      commandId: normalizeUuid(command.commandId),
    }
  }
  return {
    ...command,
    sessionId: normalizeUuid(command.sessionId),
    commandId: normalizeUuid(command.commandId),
    payload: {
      ...command.payload,
      decisionRequestId: normalizeUuid(command.payload.decisionRequestId),
      handId: normalizeUuid(command.payload.handId),
    },
  }
}

function parseLedgerRow(row: unknown): LedgerRow {
  const parsed = LedgerRowSchema.safeParse(row)
  if (!parsed.success) {
    throw invalidLedger()
  }
  return parsed.data
}

function assertTerminalPayloadVersion(row: LedgerRow): void {
  if (row.responsePayloadVersion === null || row.responsePayload === null) {
    throw invalidLedger()
  }
  if (row.responsePayloadVersion !== COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION) {
    throw new UnknownPayloadVersionError('commandResponse')
  }
}

function parseExistingRegistration(
  rowInput: unknown,
  prepared: PreparedCommandRegistration,
): Exclude<CommandRegistrationResult, AcquiredCommandRegistration> {
  const row = parseLedgerRow(rowInput)
  if (
    !uuidEquals(row.sessionId, prepared.command.sessionId) ||
    !uuidEquals(row.commandId, prepared.command.commandId)
  ) {
    throw invalidLedger()
  }
  if (row.canonicalPayloadDigest !== prepared.canonicalPayloadDigest) {
    throw new CommandPayloadConflictError()
  }

  if (row.processingStatus === 'processing') {
    if (
      row.finalStateVersion !== null ||
      row.firstEventSeq !== null ||
      row.lastEventSeq !== null ||
      row.responsePayloadVersion !== null ||
      row.responsePayload !== null ||
      row.hasCompletedAt
    ) {
      throw invalidLedger()
    }
    return Object.freeze({ status: 'processing' })
  }

  if (
    !row.hasCompletedAt ||
    row.responsePayloadVersion === null ||
    row.responsePayload === null
  ) {
    throw invalidLedger()
  }
  assertTerminalPayloadVersion(row)

  if (row.processingStatus === 'completed') {
    if (row.finalStateVersion === null) {
      throw invalidLedger()
    }
    const response = CommandResponseSchema.safeParse(row.responsePayload)
    if (
      !response.success ||
      !SafeIntegerSchema.safeParse(response.data.snapshot.stateVersion)
        .success ||
      !uuidEquals(response.data.snapshot.sessionId, row.sessionId) ||
      response.data.snapshot.stateVersion !== row.finalStateVersion ||
      (row.firstEventSeq === null) !== (row.lastEventSeq === null) ||
      (row.firstEventSeq !== null &&
        row.lastEventSeq !== null &&
        (row.firstEventSeq > row.lastEventSeq ||
          row.lastEventSeq !== response.data.snapshot.eventSeq))
    ) {
      throw invalidLedger()
    }
    return deepFreeze({ status: 'completed', response: response.data })
  }

  if (row.firstEventSeq !== null || row.lastEventSeq !== null) {
    throw invalidLedger()
  }
  const response = ErrorResponseSchema.safeParse(row.responsePayload)
  if (!response.success) {
    throw invalidLedger()
  }
  const latestSnapshot = response.data.latestSnapshot
  if (
    (latestSnapshot === undefined && row.finalStateVersion !== null) ||
    (latestSnapshot !== undefined &&
      (!SafeIntegerSchema.safeParse(latestSnapshot.stateVersion).success ||
        !uuidEquals(latestSnapshot.sessionId, row.sessionId) ||
        latestSnapshot.stateVersion !== row.finalStateVersion))
  ) {
    throw invalidLedger()
  }
  return deepFreeze({ status: 'failed', response: response.data })
}

function assertAvailableAcquired(
  acquired: AcquiredCommandRegistration,
  transaction: TransactionSql,
): void {
  if (
    typeof acquired !== 'object' ||
    acquired === null ||
    !acquiredTransactions.has(acquired)
  ) {
    throw new RepositoryInputValidationError()
  }
  if (consumedAcquiredRegistrations.has(acquired)) {
    throw new CommandLedgerTransitionError()
  }
  if (acquiredTransactions.get(acquired) !== transaction) {
    throw new CommandLedgerTransitionError()
  }
}

function consumeAcquired(acquired: AcquiredCommandRegistration): void {
  consumedAcquiredRegistrations.add(acquired)
}

function assertTerminalUpdate(
  rows: readonly { readonly ledgerId: string }[],
  acquired: AcquiredCommandRegistration,
): void {
  if (rows.length !== 1 || rows[0]?.ledgerId !== acquired.ledgerId) {
    throw new CommandLedgerTransitionError()
  }
}

export function prepareCommandRegistration(
  input: unknown,
): PreparedCommandRegistration {
  const parsed = LedgerCommandSchema.safeParse(input)
  if (!parsed.success) {
    throw new RepositoryInputValidationError()
  }

  const command = deepFreeze(normalizeLedgerCommand(parsed.data))
  const canonicalPayload = canonicalJson({
    type: command.type,
    expectedStateVersion: command.expectedStateVersion,
    payload: command.payload,
  } as JsonValue)
  const prepared = Object.freeze({
    command,
    ledgerId: randomUUID(),
    canonicalPayloadDigest: createHash('sha256')
      .update(canonicalPayload, 'utf8')
      .digest('hex'),
  }) as PreparedCommandRegistration
  preparedRegistrations.add(prepared)
  return prepared
}

export async function registerCommand(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  prepared: PreparedCommandRegistration,
): Promise<CommandRegistrationResult> {
  if (
    typeof prepared !== 'object' ||
    prepared === null ||
    !preparedRegistrations.delete(prepared)
  ) {
    throw new RepositoryInputValidationError()
  }
  if (!isResolvedOwnerScope(owner)) {
    throw new RepositoryInputValidationError()
  }

  let insertedRows: readonly { readonly ledgerId: string }[]
  try {
    insertedRows = await transaction<{ readonly ledgerId: string }[]>`
      INSERT INTO app_private.command_ledger (
        id,
        session_id,
        owner_id,
        command_id,
        canonical_payload_digest,
        processing_status
      )
      SELECT
        ${prepared.ledgerId}::uuid,
        session.id,
        session.owner_id,
        ${prepared.command.commandId}::uuid,
        ${prepared.canonicalPayloadDigest},
        'processing'
      FROM app_private.sessions AS session
      WHERE session.id = ${prepared.command.sessionId}::uuid
        AND session.owner_id = ${owner.databaseOwnerId}::uuid
      ON CONFLICT (session_id, command_id) DO NOTHING
      RETURNING id::text AS "ledgerId"
    `
  } catch {
    throw new DatabaseOperationError()
  }

  if (insertedRows.length === 1) {
    if (insertedRows[0]?.ledgerId !== prepared.ledgerId) {
      throw invalidLedger()
    }
    const acquired = Object.freeze({
      status: 'acquired',
      ledgerId: prepared.ledgerId,
      sessionId: prepared.command.sessionId,
      commandId: prepared.command.commandId,
      canonicalPayloadDigest: prepared.canonicalPayloadDigest,
      owner,
    }) as AcquiredCommandRegistration
    acquiredTransactions.set(acquired, transaction)
    return acquired
  }

  if (insertedRows.length !== 0) {
    throw invalidLedger()
  }

  let existingRows: readonly unknown[]
  try {
    existingRows = await transaction<LedgerRow[]>`
      SELECT
        ledger.id::text AS "ledgerId",
        ledger.session_id::text AS "sessionId",
        ledger.command_id::text AS "commandId",
        ledger.canonical_payload_digest AS "canonicalPayloadDigest",
        ledger.processing_status AS "processingStatus",
        ledger.final_state_version::float8 AS "finalStateVersion",
        ledger.first_event_seq::float8 AS "firstEventSeq",
        ledger.last_event_seq::float8 AS "lastEventSeq",
        ledger.response_payload_version AS "responsePayloadVersion",
        ledger.response_payload AS "responsePayload",
        ledger.completed_at IS NOT NULL AS "hasCompletedAt"
      FROM app_private.command_ledger AS ledger
      JOIN app_private.sessions AS session
        ON session.id = ledger.session_id
        AND session.owner_id = ledger.owner_id
      WHERE ledger.session_id = ${prepared.command.sessionId}::uuid
        AND ledger.command_id = ${prepared.command.commandId}::uuid
        AND ledger.owner_id = ${owner.databaseOwnerId}::uuid
      LIMIT 2
    `
  } catch {
    throw new DatabaseOperationError()
  }

  if (existingRows.length === 0) {
    throw new ResourceNotFoundError()
  }
  if (existingRows.length !== 1) {
    throw invalidLedger()
  }
  return parseExistingRegistration(existingRows[0], prepared)
}

export async function completeCommand(
  transaction: TransactionSql,
  acquired: AcquiredCommandRegistration,
  responseInput: unknown,
  eventRangeInput: CommandEventRange | null,
): Promise<void> {
  assertAvailableAcquired(acquired, transaction)

  const response = CommandResponseSchema.safeParse(responseInput)
  const eventRange = z
    .union([z.null(), CommandEventRangeSchema])
    .safeParse(eventRangeInput)
  if (
    !response.success ||
    !eventRange.success ||
    !SafeIntegerSchema.safeParse(response.data.snapshot.stateVersion).success ||
    !uuidEquals(response.data.snapshot.sessionId, acquired.sessionId) ||
    (eventRange.data !== null &&
      eventRange.data.lastEventSeq !== response.data.snapshot.eventSeq)
  ) {
    throw new RepositoryInputValidationError()
  }

  consumeAcquired(acquired)
  let rows: readonly { readonly ledgerId: string }[]
  try {
    rows = await transaction<{ readonly ledgerId: string }[]>`
      UPDATE app_private.command_ledger
      SET processing_status = 'completed',
          final_state_version = ${response.data.snapshot.stateVersion}::bigint,
          first_event_seq = ${eventRange.data?.firstEventSeq ?? null}::bigint,
          last_event_seq = ${eventRange.data?.lastEventSeq ?? null}::bigint,
          response_payload_version = ${COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION},
          response_payload = ${JSON.stringify(response.data)}::jsonb,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE owner_id = ${acquired.owner.databaseOwnerId}::uuid
        AND session_id = ${acquired.sessionId}::uuid
        AND id = ${acquired.ledgerId}::uuid
        AND canonical_payload_digest = ${acquired.canonicalPayloadDigest}
        AND processing_status = 'processing'
      RETURNING id::text AS "ledgerId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  assertTerminalUpdate(rows, acquired)
}

export async function failCommand(
  transaction: TransactionSql,
  acquired: AcquiredCommandRegistration,
  responseInput: unknown,
): Promise<void> {
  assertAvailableAcquired(acquired, transaction)

  const response = ErrorResponseSchema.safeParse(responseInput)
  const latestSnapshot = response.success
    ? response.data.latestSnapshot
    : undefined
  if (
    !response.success ||
    (latestSnapshot !== undefined &&
      (!SafeIntegerSchema.safeParse(latestSnapshot.stateVersion).success ||
        !uuidEquals(latestSnapshot.sessionId, acquired.sessionId)))
  ) {
    throw new RepositoryInputValidationError()
  }

  consumeAcquired(acquired)
  let rows: readonly { readonly ledgerId: string }[]
  try {
    rows = await transaction<{ readonly ledgerId: string }[]>`
      UPDATE app_private.command_ledger
      SET processing_status = 'failed',
          final_state_version = ${latestSnapshot?.stateVersion ?? null}::bigint,
          first_event_seq = NULL,
          last_event_seq = NULL,
          response_payload_version = ${COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION},
          response_payload = ${JSON.stringify(response.data)}::jsonb,
          completed_at = clock_timestamp(),
          updated_at = clock_timestamp()
      WHERE owner_id = ${acquired.owner.databaseOwnerId}::uuid
        AND session_id = ${acquired.sessionId}::uuid
        AND id = ${acquired.ledgerId}::uuid
        AND canonical_payload_digest = ${acquired.canonicalPayloadDigest}
        AND processing_status = 'processing'
      RETURNING id::text AS "ledgerId"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  assertTerminalUpdate(rows, acquired)
}
