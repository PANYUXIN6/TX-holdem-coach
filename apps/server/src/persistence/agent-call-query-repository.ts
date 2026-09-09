import {
  PUBLIC_AGENT_AUDIT_CODES,
  CommandResponseSchema,
  type AgentCallHandSummary,
  type AgentAttemptSummary,
  type AgentCapabilityInvocationSummary,
  type AgentRunDecision,
  type AgentRunDetailResponse,
  type AgentRunSummary,
  type PokerAction,
} from '@tx-holdem-coach/contracts'
import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { readCurrentAttemptAudit } from '../agents/audit/attempt-audit-codec.js'
import type { AgentCallQueryReader } from '../agents/audit/agent-call-query-service.js'
import type { NormalizedAgentCallListQuery } from '../agents/audit/agent-call-query.js'
import { projectNormalizedActionVisibility } from '../agents/audit/agent-call-visibility.js'
import {
  AgentRunQueryNotFoundError,
  HandQueryNotFoundError,
} from '../agents/audit/query-errors.js'
import {
  playerCandidateSetSnapshotCodec,
  playerModelChoiceCodec,
  playerValidatorResultCodec,
} from '../agents/player/player-decision-audit-codec.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  canonicalJson,
  type JsonValue,
  type PersistedJsonReadResult,
} from '../persisted-json.js'
import { COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION } from './command-ledger-repository.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

const TimestampSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/)
const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const NullableTimestampSchema = TimestampSchema.nullable()
const DigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
const IdSchema = z.uuid().refine((value) => value === value.toLowerCase())
const HandRowSchema = z.strictObject({
  handId: z.uuid(),
  sessionId: z.uuid(),
  handNumber: SafeIntegerSchema.positive(),
  status: z.enum(['inProgress', 'completed', 'aborted']),
  abortedAt: NullableTimestampSchema,
  abortReason: z.string().nullable(),
  abortedByAgentRunId: z.uuid().nullable(),
})
const RunRowSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  runtime: z.enum(['player', 'coach']),
  executionMode: z.enum(['live', 'historicalReexecution']),
  lifecycle: z.enum([
    'queued',
    'leased',
    'running',
    'completed',
    'failed',
    'cancelled',
    'stale',
  ]),
  participantId: z.uuid().nullable(),
  seatNumber: z.number().int().min(1).max(8).nullable(),
  sourceStateVersion: SafeIntegerSchema.nullable(),
  decisionRequestId: z.uuid().nullable(),
  createdAt: TimestampSchema,
  startedAt: NullableTimestampSchema,
  completedAt: NullableTimestampSchema,
  terminationReason: z.string().nullable(),
})
const RunDetailRowSchema = RunRowSchema.extend({
  parentRunId: z.uuid().nullable(),
  replacementRunId: z.uuid().nullable(),
  reexecutionSourceRunId: z.uuid().nullable(),
  handStatus: z.enum(['inProgress', 'completed', 'aborted']),
  decisionId: z.uuid().nullable(),
  decisionStatus: z
    .enum(['auditPrepared', 'modelPrepared', 'selected', 'committed'])
    .nullable(),
  terminalOutcome: z.enum(['failed', 'stale', 'cancelled']).nullable(),
  terminalReason: z.string().nullable(),
  acceptedAttemptId: z.uuid().nullable(),
  commandLedgerId: z.uuid().nullable(),
  sourceDecisionId: z.uuid().nullable(),
  candidatePayloadVersion: z.unknown(),
  candidatePayload: z.unknown(),
  choicePayloadVersion: z.unknown(),
  choicePayload: z.unknown(),
  validatorPayloadVersion: z.unknown(),
  validatorPayload: z.unknown(),
  ledgerId: z.uuid().nullable(),
  ledgerStatus: z.enum(['processing', 'completed', 'failed']).nullable(),
  ledgerFinalStateVersion: SafeIntegerSchema.nullable(),
  firstEventSeq: SafeIntegerSchema.nullable(),
  lastEventSeq: SafeIntegerSchema.nullable(),
  ledgerResponsePayloadVersion: z.number().int().positive().nullable(),
  ledgerResponsePayload: z.unknown().nullable(),
})
const AttemptRowSchema = z.strictObject({
  attemptId: z.uuid(),
  attemptNumber: z.number().int().nonnegative().max(2_147_483_647),
  stage: z.string().min(1),
  lifecycle: z.enum(['started', 'completed', 'failed', 'cancelled', 'stale']),
  provider: z.string().min(1),
  model: z.string().min(1),
  attemptType: z.string().min(1),
  routingReason: z.string().nullable(),
  startedAt: TimestampSchema,
  completedAt: NullableTimestampSchema,
  durationMs: SafeIntegerSchema.nullable(),
  accepted: z.boolean(),
  stale: z.boolean(),
  interrupted: z.boolean(),
  inputTokens: SafeIntegerSchema,
  outputTokens: SafeIntegerSchema,
  errorCategory: z.string().nullable(),
  payloadVersion: z.unknown(),
  payload: z.unknown(),
})
const CapabilityRowSchema = z.strictObject({
  invocationId: z.uuid(),
  invocationNumber: z.number().int().nonnegative().max(2_147_483_647),
  capabilityName: z.string().min(1),
  capabilityVersion: z.number().int().positive().max(2_147_483_647),
  authorized: z.boolean(),
  startedAt: TimestampSchema,
  completedAt: NullableTimestampSchema,
  durationMs: SafeIntegerSchema.nullable(),
  inputSchemaVersion: z.number().int().positive().max(2_147_483_647),
  outputSchemaVersion: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .nullable(),
  inputHash: DigestSchema,
  outputHash: DigestSchema.nullable(),
  errorCategory: z.string().nullable(),
})
const AbortedRunRowSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  lifecycle: z.enum([
    'queued',
    'leased',
    'running',
    'completed',
    'failed',
    'cancelled',
    'stale',
  ]),
})
const VisibleRunRowSchema = AbortedRunRowSchema.extend({
  handStatus: z.enum(['inProgress', 'completed', 'aborted']),
  abortedByAgentRunId: z.uuid().nullable(),
})
const publicAgentAuditCodes = new Set<string>(PUBLIC_AGENT_AUDIT_CODES)
type PublicAgentAuditCode = (typeof PUBLIC_AGENT_AUDIT_CODES)[number]

function corruption(): never {
  throw new PersistenceDataCorruptionError('invalidAgentCallQuery')
}

function validateId(value: string): void {
  if (!IdSchema.safeParse(value).success) {
    throw new RepositoryInputValidationError()
  }
}

function validateQuery(
  query: NormalizedAgentCallListQuery,
  order: 'createdAt' | 'sequence',
): void {
  const afterSchema =
    order === 'createdAt'
      ? z.strictObject({ createdAt: TimestampSchema, id: IdSchema })
      : z.strictObject({
          sequence: z.number().int().nonnegative().max(2_147_483_647),
        })
  const parsed = z
    .strictObject({
      limit: z.number().int().min(1).max(100),
      after: afterSchema.nullable(),
    })
    .safeParse(query)
  if (!parsed.success) throw new RepositoryInputValidationError()
}

function publicCode(value: string | null): PublicAgentAuditCode | null {
  if (value === null) return null
  return publicAgentAuditCodes.has(value)
    ? (value as PublicAgentAuditCode)
    : 'technical_error'
}

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function mapHand(raw: unknown): AgentCallHandSummary {
  const parsed = HandRowSchema.safeParse(raw)
  if (!parsed.success) return corruption()
  const hand = parsed.data
  if (hand.status !== 'aborted') {
    if (
      hand.abortedAt !== null ||
      hand.abortReason !== null ||
      hand.abortedByAgentRunId !== null
    ) {
      return corruption()
    }
    return Object.freeze({
      handId: hand.handId,
      sessionId: hand.sessionId,
      handNumber: hand.handNumber,
      status: hand.status,
    })
  }
  if (
    hand.abortedAt === null ||
    hand.abortReason === null ||
    hand.abortedByAgentRunId === null
  ) {
    return corruption()
  }
  return Object.freeze({
    handId: hand.handId,
    sessionId: hand.sessionId,
    handNumber: hand.handNumber,
    status: 'aborted',
    abortedAt: hand.abortedAt,
    abortReasonCode: publicCode(hand.abortReason)!,
    abortedByAgentRunId: hand.abortedByAgentRunId,
  })
}

function mapRun(raw: unknown): AgentRunSummary {
  const parsed = RunRowSchema.safeParse(raw)
  if (!parsed.success) return corruption()
  const run = parsed.data
  if (
    (run.runtime === 'player' &&
      (run.participantId === null ||
        run.seatNumber === null ||
        run.sourceStateVersion === null ||
        run.decisionRequestId === null)) ||
    (run.runtime === 'coach' &&
      (run.participantId !== null ||
        run.seatNumber !== null ||
        run.sourceStateVersion !== null ||
        run.decisionRequestId !== null))
  ) {
    return corruption()
  }
  return Object.freeze({
    runId: run.runId,
    sessionId: run.sessionId,
    handId: run.handId,
    runtime: run.runtime,
    executionMode: run.executionMode,
    lifecycle: run.lifecycle,
    participantId: run.participantId,
    seatNumber: run.seatNumber,
    sourceStateVersion: run.sourceStateVersion,
    decisionRequestId: run.decisionRequestId,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    terminationReasonCode: publicCode(run.terminationReason),
  })
}

function readPayload<T>(
  result: PersistedJsonReadResult<T>,
  kind:
    | 'playerDecisionCandidateSet'
    | 'playerDecisionModelChoice'
    | 'playerDecisionValidatorResult',
): T {
  if (result.kind === 'unknownVersion')
    throw new UnknownPayloadVersionError(kind)
  if (result.kind === 'invalidPayload') return corruption()
  return result.value
}

function mapDecision(row: z.infer<typeof RunDetailRowSchema>): {
  readonly decision: AgentRunDecision
  readonly commandEventRange: {
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  } | null
} {
  if (row.decisionId === null) {
    if (
      row.decisionStatus !== null ||
      row.commandLedgerId !== null ||
      row.ledgerId !== null
    ) {
      return corruption()
    }
    return {
      decision: Object.freeze({ kind: 'none' }),
      commandEventRange: null,
    }
  }
  if (row.decisionStatus === null) return corruption()
  let commandEventRange: {
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  } | null = null
  if (row.commandLedgerId !== null) {
    if (
      row.ledgerId !== row.commandLedgerId ||
      row.ledgerStatus !== 'completed' ||
      row.ledgerFinalStateVersion === null ||
      row.firstEventSeq === null ||
      row.lastEventSeq === null ||
      row.firstEventSeq > row.lastEventSeq ||
      row.ledgerResponsePayloadVersion === null ||
      row.ledgerResponsePayload === null
    ) {
      return corruption()
    }
    if (
      row.ledgerResponsePayloadVersion !==
      COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION
    ) {
      throw new UnknownPayloadVersionError('commandResponse')
    }
    const response = CommandResponseSchema.safeParse(row.ledgerResponsePayload)
    if (
      !response.success ||
      response.data.snapshot.sessionId !== row.sessionId ||
      response.data.snapshot.stateVersion !== row.ledgerFinalStateVersion ||
      response.data.snapshot.eventSeq !== row.lastEventSeq
    ) {
      return corruption()
    }
    commandEventRange = Object.freeze({
      firstEventSeq: row.firstEventSeq,
      lastEventSeq: row.lastEventSeq,
    })
  } else if (
    row.ledgerId !== null ||
    row.ledgerFinalStateVersion !== null ||
    row.firstEventSeq !== null ||
    row.lastEventSeq !== null ||
    row.ledgerResponsePayloadVersion !== null ||
    row.ledgerResponsePayload !== null ||
    row.decisionStatus === 'committed'
  ) {
    return corruption()
  }
  let action: PokerAction | null = null
  if (row.decisionStatus === 'selected' || row.decisionStatus === 'committed') {
    const candidates = readPayload(
      playerCandidateSetSnapshotCodec.read(
        typeof row.candidatePayloadVersion === 'number'
          ? row.candidatePayloadVersion
          : null,
        row.candidatePayload,
      ),
      'playerDecisionCandidateSet',
    )
    const choice = readPayload(
      playerModelChoiceCodec.read(
        typeof row.choicePayloadVersion === 'number'
          ? row.choicePayloadVersion
          : null,
        row.choicePayload,
      ),
      'playerDecisionModelChoice',
    )
    const validator = readPayload(
      playerValidatorResultCodec.read(
        typeof row.validatorPayloadVersion === 'number'
          ? row.validatorPayloadVersion
          : null,
        row.validatorPayload,
      ),
      'playerDecisionValidatorResult',
    )
    const { candidateSetSha256, ...candidateSetWithoutHash } = candidates
    if (
      candidateSetSha256 !==
        sha256(candidateSetWithoutHash as unknown as JsonValue) ||
      validator.candidateSetSha256 !== candidateSetSha256 ||
      validator.choiceSha256 !== sha256(choice as unknown as JsonValue)
    ) {
      return corruption()
    }
    const matches = candidates.candidates.filter(
      (candidate) => candidate.candidateId === choice.candidateActionId,
    )
    if (matches.length !== 1) return corruption()
    action = matches[0]!.action
  }
  return {
    decision: Object.freeze({
      kind: 'summary',
      decisionId: row.decisionId,
      status: row.decisionStatus,
      terminalOutcome: row.terminalOutcome,
      terminalReasonCode: publicCode(row.terminalReason),
      acceptedAttemptId: row.acceptedAttemptId,
      commandLedgerId: row.commandLedgerId,
      sourceDecisionId: row.sourceDecisionId,
      normalizedAction: projectNormalizedActionVisibility({
        handStatus: row.handStatus,
        executionMode: row.executionMode,
        decisionStatus: row.decisionStatus,
        action,
        commandRange: commandEventRange,
      }),
    }),
    commandEventRange,
  }
}

function mapDetail(raw: unknown): AgentRunDetailResponse {
  const parsed = RunDetailRowSchema.safeParse(raw)
  if (!parsed.success) return corruption()
  const row = parsed.data
  const summary = mapRun({
    runId: row.runId,
    sessionId: row.sessionId,
    handId: row.handId,
    runtime: row.runtime,
    executionMode: row.executionMode,
    lifecycle: row.lifecycle,
    participantId: row.participantId,
    seatNumber: row.seatNumber,
    sourceStateVersion: row.sourceStateVersion,
    decisionRequestId: row.decisionRequestId,
    createdAt: row.createdAt,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    terminationReason: row.terminationReason,
  })
  const projected = mapDecision(row)
  return Object.freeze({
    ...summary,
    parentRunId: row.parentRunId,
    replacementRunId: row.replacementRunId,
    reexecutionSourceRunId: row.reexecutionSourceRunId,
    decision: projected.decision,
    commandEventRange: projected.commandEventRange,
    contentAvailability: Object.freeze({
      requestBody: 'notExposed' as const,
      rawResponse: 'notRecorded' as const,
      validationDetails: 'notRecorded' as const,
    }),
  })
}

function mapAttempt(raw: unknown): AgentAttemptSummary {
  const parsed = AttemptRowSchema.safeParse(raw)
  if (!parsed.success) return corruption()
  const row = parsed.data
  const audit = readCurrentAttemptAudit(
    row.lifecycle,
    row.payloadVersion,
    row.payload,
  )
  if (audit.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('agentAttempt')
  }
  if (
    audit.kind === 'invalidPayload' ||
    audit.value.lifecycle !== row.lifecycle
  ) {
    return corruption()
  }
  const pending = audit.value.usageAccounting === 'pending'
  if (
    audit.value.usageAccounting === 'notIncurred' &&
    (row.inputTokens !== 0 || row.outputTokens !== 0)
  ) {
    return corruption()
  }
  return Object.freeze({
    attemptId: row.attemptId,
    attemptNumber: row.attemptNumber,
    stage: row.stage,
    lifecycle: row.lifecycle,
    provider: row.provider,
    model: row.model,
    attemptType: row.attemptType,
    routingReasonCode: publicCode(row.routingReason),
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    accepted: row.accepted,
    stale: row.stale,
    interrupted: row.interrupted,
    validationStatus:
      'validationStatus' in audit.value
        ? audit.value.validationStatus
        : 'notRun',
    errorCode: publicCode(row.errorCategory),
    requestProjectionHash: audit.value.requestProjectionHash,
    responseProjectionHash:
      'responseProjectionHash' in audit.value
        ? audit.value.responseProjectionHash
        : null,
    usage: pending
      ? Object.freeze({
          inputTokens: null,
          outputTokens: null,
          accounting: 'pending' as const,
        })
      : audit.value.usageAccounting === 'notIncurred'
        ? Object.freeze({
            inputTokens: 0 as const,
            outputTokens: 0 as const,
            accounting: 'notIncurred' as const,
          })
        : Object.freeze({
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            accounting: audit.value.usageAccounting,
          }),
  })
}

function mapCapability(raw: unknown): AgentCapabilityInvocationSummary {
  const parsed = CapabilityRowSchema.safeParse(raw)
  if (!parsed.success) return corruption()
  const row = parsed.data
  return Object.freeze({
    invocationId: row.invocationId,
    invocationNumber: row.invocationNumber,
    capabilityName: row.capabilityName,
    capabilityVersion: row.capabilityVersion,
    authorized: row.authorized,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    durationMs: row.durationMs,
    inputSchemaVersion: row.inputSchemaVersion,
    outputSchemaVersion: row.outputSchemaVersion,
    inputHash: row.inputHash,
    outputHash: row.outputHash,
    errorCode: publicCode(row.errorCategory),
  })
}

async function handRow(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  handId: string,
): Promise<unknown> {
  const rows = await transaction`
    SELECT h.id::text AS "handId", h.session_id::text AS "sessionId",
      h.hand_number::float8 AS "handNumber", h.status,
      CASE WHEN h.aborted_at IS NULL THEN NULL ELSE to_char(h.aborted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "abortedAt",
      h.abort_reason AS "abortReason", h.aborted_by_agent_run_id::text AS "abortedByAgentRunId"
    FROM app_private.hands AS h
    WHERE h.id = ${handId}::uuid AND h.owner_id = ${owner.databaseOwnerId}::uuid
  `
  if (rows.length === 0) throw new HandQueryNotFoundError()
  if (rows.length !== 1) return corruption()
  return rows[0]
}

async function assertRunVisible(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  runId: string,
): Promise<void> {
  const rows = await transaction`
    SELECT r.id::text AS "runId", r.session_id::text AS "sessionId",
      r.hand_id::text AS "handId", r.lifecycle, h.status AS "handStatus",
      h.aborted_by_agent_run_id::text AS "abortedByAgentRunId"
    FROM app_private.agent_runs AS r
    JOIN app_private.hands AS h
      ON h.id = r.hand_id AND h.session_id = r.session_id AND h.owner_id = r.owner_id
    WHERE r.id = ${runId}::uuid AND r.owner_id = ${owner.databaseOwnerId}::uuid
  `
  if (rows.length === 0) throw new AgentRunQueryNotFoundError()
  if (rows.length !== 1) return corruption()
  const parsed = VisibleRunRowSchema.safeParse(rows[0])
  if (!parsed.success) return corruption()
  if (parsed.data.handStatus === 'aborted') {
    if (parsed.data.abortedByAgentRunId === null) return corruption()
    await assertAbortedRun(transaction, owner, {
      sessionId: parsed.data.sessionId,
      handId: parsed.data.handId,
      abortedByAgentRunId: parsed.data.abortedByAgentRunId,
    })
    if (parsed.data.abortedByAgentRunId !== parsed.data.runId) {
      throw new AgentRunQueryNotFoundError()
    }
  }
}

async function assertAbortedRun(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  hand: {
    readonly sessionId: string
    readonly handId: string
    readonly abortedByAgentRunId: string
  },
): Promise<void> {
  const rows = await transaction`
    SELECT r.id::text AS "runId", r.session_id::text AS "sessionId",
      r.hand_id::text AS "handId", r.lifecycle
    FROM app_private.agent_runs AS r
    WHERE r.id = ${hand.abortedByAgentRunId}::uuid
      AND r.owner_id = ${owner.databaseOwnerId}::uuid
  `
  if (rows.length !== 1) return corruption()
  const parsed = AbortedRunRowSchema.safeParse(rows[0])
  if (
    !parsed.success ||
    parsed.data.sessionId !== hand.sessionId ||
    parsed.data.handId !== hand.handId ||
    parsed.data.lifecycle !== 'failed'
  ) {
    return corruption()
  }
}

function runSelect() {
  return `r.id::text AS "runId", r.session_id::text AS "sessionId", r.hand_id::text AS "handId",
    r.runtime, r.execution_mode AS "executionMode", r.lifecycle,
    r.participant_id::text AS "participantId", participant.seat_number AS "seatNumber",
    r.source_state_version::float8 AS "sourceStateVersion", r.decision_request_id::text AS "decisionRequestId",
    to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "createdAt",
    CASE WHEN r.started_at IS NULL THEN NULL ELSE to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "startedAt",
    CASE WHEN r.completed_at IS NULL THEN NULL ELSE to_char(r.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "completedAt",
    r.termination_reason AS "terminationReason"`
}

export function createAgentCallQueryRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): AgentCallQueryReader {
  if (!isResolvedOwnerScope(input.owner))
    throw new RepositoryInputValidationError()
  const transactional = <T>(
    operation: (transaction: TransactionSql) => Promise<T>,
  ) =>
    runDatabaseTransaction(input.sql, async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`
      try {
        return await operation(transaction)
      } catch (error) {
        if (
          error instanceof HandQueryNotFoundError ||
          error instanceof AgentRunQueryNotFoundError ||
          error instanceof PersistenceDataCorruptionError ||
          error instanceof UnknownPayloadVersionError
        ) {
          throw error
        }
        throw new DatabaseOperationError()
      }
    })
  const reader: AgentCallQueryReader = {
    listRuns({ handId, query }) {
      validateId(handId)
      validateQuery(query, 'createdAt')
      return transactional(async (transaction) => {
        const hand = mapHand(await handRow(transaction, input.owner, handId))
        if (hand.status === 'aborted') {
          await assertAbortedRun(transaction, input.owner, hand)
        }
        const after =
          query.after !== null && 'createdAt' in query.after
            ? query.after
            : null
        const rows = await transaction.unsafe(
          `SELECT ${runSelect()}
           FROM app_private.agent_runs AS r
           LEFT JOIN app_private.session_participants AS participant
             ON participant.id = r.participant_id AND participant.session_id = r.session_id AND participant.owner_id = r.owner_id
           WHERE r.hand_id = $1::uuid AND r.owner_id = $2::uuid
             AND ($3::text IS NULL
               OR to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') > $3
               OR (
                 to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') = $3
                 AND r.id > $4::uuid
               ))
             AND ($5::text <> 'aborted' OR r.id = $6::uuid)
           ORDER BY to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') ASC,
             r.id ASC LIMIT $7`,
          [
            handId,
            input.owner.databaseOwnerId,
            after?.createdAt ?? null,
            after?.id ?? null,
            hand.status,
            hand.status === 'aborted' ? hand.abortedByAgentRunId : null,
            query.limit + 1,
          ],
        )
        return Object.freeze({
          hand,
          items: Object.freeze(rows.slice(0, query.limit).map(mapRun)),
          hasMore: rows.length > query.limit,
        })
      })
    },
    readRun(runId) {
      validateId(runId)
      return transactional(async (transaction) => {
        await assertRunVisible(transaction, input.owner, runId)
        const rows = await transaction.unsafe(
          `SELECT ${runSelect()}, r.parent_run_id::text AS "parentRunId",
             r.replacement_run_id::text AS "replacementRunId", r.reexecution_source_run_id::text AS "reexecutionSourceRunId",
             h.status AS "handStatus", decision.id::text AS "decisionId", decision.status AS "decisionStatus",
             decision.terminal_outcome AS "terminalOutcome", decision.terminal_reason AS "terminalReason",
             decision.accepted_attempt_id::text AS "acceptedAttemptId", decision.command_ledger_id::text AS "commandLedgerId",
             decision.reexecution_source_decision_id::text AS "sourceDecisionId",
             COALESCE(decision.candidate_set_payload_version, source.candidate_set_payload_version) AS "candidatePayloadVersion",
             COALESCE(decision.candidate_set_payload, source.candidate_set_payload) AS "candidatePayload",
             decision.model_choice_payload_version AS "choicePayloadVersion", decision.model_choice_payload AS "choicePayload",
             decision.validator_result_payload_version AS "validatorPayloadVersion", decision.validator_result_payload AS "validatorPayload",
             ledger.id::text AS "ledgerId", ledger.processing_status AS "ledgerStatus",
             ledger.final_state_version::float8 AS "ledgerFinalStateVersion",
             ledger.first_event_seq::float8 AS "firstEventSeq", ledger.last_event_seq::float8 AS "lastEventSeq",
             ledger.response_payload_version AS "ledgerResponsePayloadVersion",
             ledger.response_payload AS "ledgerResponsePayload"
           FROM app_private.agent_runs AS r
           JOIN app_private.hands AS h ON h.id = r.hand_id AND h.session_id = r.session_id AND h.owner_id = r.owner_id
           LEFT JOIN app_private.session_participants AS participant
             ON participant.id = r.participant_id AND participant.session_id = r.session_id AND participant.owner_id = r.owner_id
           LEFT JOIN app_private.player_decisions AS decision ON decision.agent_run_id = r.id AND decision.owner_id = r.owner_id
           LEFT JOIN app_private.player_decisions AS source ON source.id = decision.reexecution_source_decision_id AND source.owner_id = decision.owner_id AND source.session_id = decision.session_id
           LEFT JOIN app_private.command_ledger AS ledger ON ledger.id = decision.command_ledger_id AND ledger.session_id = decision.session_id AND ledger.owner_id = decision.owner_id
           WHERE r.id = $1::uuid AND r.owner_id = $2::uuid`,
          [runId, input.owner.databaseOwnerId],
        )
        if (rows.length !== 1) return corruption()
        return mapDetail(rows[0])
      })
    },
    listAttempts({ runId, query }) {
      validateId(runId)
      validateQuery(query, 'sequence')
      return transactional(async (transaction) => {
        await assertRunVisible(transaction, input.owner, runId)
        const after =
          query.after !== null && 'sequence' in query.after
            ? query.after.sequence
            : null
        const rows = await transaction`
          SELECT a.id::text AS "attemptId", a.attempt_number AS "attemptNumber", a.stage, a.lifecycle,
            a.provider, a.model, a.attempt_type AS "attemptType", a.routing_reason AS "routingReason",
            to_char(a.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt",
            CASE WHEN a.completed_at IS NULL THEN NULL ELSE to_char(a.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "completedAt",
            a.duration_ms::float8 AS "durationMs", a.accepted, a.stale, a.interrupted,
            a.input_tokens::float8 AS "inputTokens", a.output_tokens::float8 AS "outputTokens",
            a.error_category AS "errorCategory", a.attempt_payload_version AS "payloadVersion", a.attempt_payload AS payload
          FROM app_private.agent_attempts AS a
          WHERE a.agent_run_id = ${runId}::uuid AND a.owner_id = ${input.owner.databaseOwnerId}::uuid
            AND (${after}::integer IS NULL OR a.attempt_number > ${after}::integer)
          ORDER BY a.attempt_number ASC LIMIT ${query.limit + 1}
        `
        return Object.freeze({
          items: Object.freeze(rows.slice(0, query.limit).map(mapAttempt)),
          hasMore: rows.length > query.limit,
        })
      })
    },
    listCapabilityInvocations({ runId, query }) {
      validateId(runId)
      validateQuery(query, 'sequence')
      return transactional(async (transaction) => {
        await assertRunVisible(transaction, input.owner, runId)
        const after =
          query.after !== null && 'sequence' in query.after
            ? query.after.sequence
            : null
        const rows = await transaction`
          SELECT c.id::text AS "invocationId", c.invocation_number AS "invocationNumber",
            c.capability_name AS "capabilityName", c.capability_version AS "capabilityVersion", c.authorized,
            to_char(c.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "startedAt",
            CASE WHEN c.completed_at IS NULL THEN NULL ELSE to_char(c.completed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "completedAt",
            c.duration_ms::float8 AS "durationMs", c.input_schema_version AS "inputSchemaVersion",
            c.output_schema_version AS "outputSchemaVersion", c.input_hash AS "inputHash", c.output_hash AS "outputHash",
            c.error_category AS "errorCategory"
          FROM app_private.agent_capability_invocations AS c
          WHERE c.agent_run_id = ${runId}::uuid AND c.owner_id = ${input.owner.databaseOwnerId}::uuid
            AND (${after}::integer IS NULL OR c.invocation_number > ${after}::integer)
          ORDER BY c.invocation_number ASC LIMIT ${query.limit + 1}
        `
        return Object.freeze({
          items: Object.freeze(rows.slice(0, query.limit).map(mapCapability)),
          hasMore: rows.length > query.limit,
        })
      })
    },
  }
  return Object.freeze(reader)
}
