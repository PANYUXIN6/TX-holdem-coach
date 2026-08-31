import type { DatabaseClient } from '../../db/client.js'
import { playerDecisionAuditSnapshotCodec } from './player-decision-audit-codec.js'
import {
  decodePlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
  type AgentMemoryPayloadV1,
} from './player-session-memory.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import {
  PersistenceDataCorruptionError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from '../../persistence/errors.js'
import { z } from 'zod'

const UuidSchema = z.string().uuid()
const DigestSchema = z.string().regex(/^[0-9a-f]{64}$/)
const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const DecisionRowSchema = z.strictObject({
  decisionId: UuidSchema,
  runId: UuidSchema,
  sessionId: UuidSchema,
  participantId: UuidSchema,
  executionMode: z.enum(['live', 'historicalReexecution']),
  decisionExecutionMode: z.enum(['live', 'historicalReexecution']),
  sourceDecisionId: UuidSchema.nullable(),
  sourceSnapshotSha256: DigestSchema.nullable(),
  sourceCandidateSetSha256: DigestSchema.nullable(),
  sourceProjectionSha256: DigestSchema.nullable(),
  sourceModelInputSha256: DigestSchema.nullable(),
  lifecycle: z.string(),
  auditPayloadVersion: z.unknown(),
  auditPayload: z.unknown(),
  memoryRevision: SafeIntegerSchema,
  memoryPayloadVersion: z.literal(1),
  memorySha256: DigestSchema,
  status: z.enum(['auditPrepared', 'modelPrepared', 'selected', 'committed']),
  terminalOutcome: z.enum(['failed', 'stale']).nullable(),
  terminalReason: z.string().nullable(),
})
const MemoryRowSchema = z.strictObject({
  revision: SafeIntegerSchema,
  payloadVersion: z.literal(1),
  payload: z.unknown(),
  sha256: DigestSchema,
  sourceAgentRunId: UuidSchema.nullable(),
  sourceHandId: UuidSchema.nullable(),
  sourceStateVersion: SafeIntegerSchema.nullable(),
  decisionRequestId: UuidSchema.nullable(),
  asOfEventSeq: SafeIntegerSchema.nullable(),
})
const AttemptRowSchema = z.strictObject({
  attemptId: UuidSchema,
  attemptNumber: z.number().int().nonnegative(),
  lifecycle: z.string(),
  accepted: z.boolean(),
  stale: z.boolean(),
  interrupted: z.boolean(),
  requestProjectionHash: DigestSchema.nullable(),
  responseProjectionHash: DigestSchema.nullable(),
  errorCategory: z.string().nullable(),
})
const CapabilityRowSchema = z.strictObject({
  invocationId: UuidSchema,
  invocationNumber: z.number().int().nonnegative(),
  capabilityName: z.string().min(1),
  capabilityVersion: z.number().int().positive(),
  authorized: z.boolean(),
  inputHash: DigestSchema,
  outputHash: DigestSchema.nullable(),
  errorCode: z.string().nullable(),
})

export class PlayerAuditReplayError extends Error {
  public constructor(
    public readonly code:
      | 'invalidInput'
      | 'unsupportedPayloadVersion'
      | 'invalidPayload'
      | 'integrityViolation',
  ) {
    super(`Player 审计 Replay 失败：${code}`)
    this.name = 'PlayerAuditReplayError'
  }
}

export interface PlayerAuditReplayV1 {
  readonly replaySchemaVersion: 1
  readonly decision: {
    readonly decisionId: string
    readonly runId: string
    readonly sessionId: string
    readonly participantId: string
    readonly executionMode: 'live' | 'historicalReexecution'
    readonly lifecycle: string
    readonly status: string
    readonly terminalOutcome: string | null
    readonly terminalReason: string | null
    readonly snapshotSha256: string
    readonly sourceDecisionId: string | null
  }
  readonly memory: {
    readonly revision: number
    readonly payloadVersion: 1
    readonly payload: AgentMemoryPayloadV1
    readonly sha256: string
    readonly sourceAgentRunId: string | null
    readonly sourceHandId: string | null
    readonly sourceStateVersion: number | null
    readonly decisionRequestId: string | null
    readonly asOfEventSeq: number | null
  }
  readonly attempts: readonly z.infer<typeof AttemptRowSchema>[]
  readonly capabilityInvocations: readonly z.infer<typeof CapabilityRowSchema>[]
}

function parseExactlyOne<T>(rows: readonly unknown[], schema: z.ZodType<T>): T {
  const parsed = z.array(schema).safeParse(rows)
  if (!parsed.success) throw new PlayerAuditReplayError('invalidPayload')
  if (parsed.data.length === 0) throw new ResourceNotFoundError()
  if (parsed.data.length !== 1)
    throw new PlayerAuditReplayError('integrityViolation')
  return parsed.data[0]!
}

function decodeSnapshot(version: unknown, payload: unknown) {
  const numericVersion =
    typeof version === 'number' && Number.isSafeInteger(version)
      ? version
      : null
  const decoded = playerDecisionAuditSnapshotCodec.read(numericVersion, payload)
  if (decoded.kind === 'unknownVersion') {
    throw new UnknownPayloadVersionError('playerDecisionAuditSnapshot')
  }
  if (decoded.kind === 'invalidPayload') {
    throw new PersistenceDataCorruptionError('invalidPlayerDecision')
  }
  return decoded.value
}

export interface PlayerAuditReplayService {
  replayDecision(input: {
    readonly owner: ResolvedOwnerScope
    readonly decisionId: string
  }): Promise<PlayerAuditReplayV1>
  replayRun(input: {
    readonly owner: ResolvedOwnerScope
    readonly runId: string
  }): Promise<PlayerAuditReplayV1>
}

export function createPlayerAuditReplayService(serviceInput: {
  readonly database: DatabaseClient
}): PlayerAuditReplayService {
  async function replay(input: {
    readonly owner: ResolvedOwnerScope
    readonly lookup: 'decision' | 'run'
    readonly id: string
  }): Promise<PlayerAuditReplayV1> {
    if (!UuidSchema.safeParse(input.id).success) {
      throw new PlayerAuditReplayError('invalidInput')
    }
    return serviceInput.database.sql.begin(async (transaction) => {
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
      const decision = parseExactlyOne(
        await transaction`
            SELECT decision.id::text AS "decisionId", decision.agent_run_id::text AS "runId",
                   decision.session_id::text AS "sessionId", decision.participant_id::text AS "participantId",
                   run.execution_mode AS "executionMode", run.lifecycle,
                   decision.execution_mode AS "decisionExecutionMode",
                   decision.reexecution_source_decision_id::text AS "sourceDecisionId",
                   decision.source_snapshot_sha256 AS "sourceSnapshotSha256",
                   decision.source_candidate_set_sha256 AS "sourceCandidateSetSha256",
                   decision.source_projection_sha256 AS "sourceProjectionSha256",
                   decision.source_model_input_sha256 AS "sourceModelInputSha256",
                   COALESCE(decision.decision_audit_snapshot_payload_version,
                     source.decision_audit_snapshot_payload_version) AS "auditPayloadVersion",
                   COALESCE(decision.decision_audit_snapshot_payload,
                     source.decision_audit_snapshot_payload) AS "auditPayload",
                   decision.memory_revision::float8 AS "memoryRevision",
                   decision.memory_payload_version AS "memoryPayloadVersion",
                   decision.memory_sha256 AS "memorySha256", decision.status,
                   decision.terminal_outcome AS "terminalOutcome",
                   decision.terminal_reason AS "terminalReason"
            FROM app_private.player_decisions AS decision
            JOIN app_private.agent_runs AS run ON run.id = decision.agent_run_id
            LEFT JOIN app_private.player_decisions AS source
              ON source.id = decision.reexecution_source_decision_id
              AND source.owner_id = decision.owner_id
              AND source.session_id = decision.session_id
            WHERE (
                (${input.lookup} = 'decision' AND decision.id = ${input.id}::uuid)
                OR (${input.lookup} = 'run' AND decision.agent_run_id = ${input.id}::uuid)
              )
              AND decision.owner_id = ${input.owner.databaseOwnerId}::uuid
              AND run.owner_id = decision.owner_id
          `,
        DecisionRowSchema,
      )
      const snapshot = decodeSnapshot(
        decision.auditPayloadVersion,
        decision.auditPayload,
      )
      const memory = parseExactlyOne(
        await transaction`
            SELECT revision::float8 AS revision, memory_payload_version AS "payloadVersion",
                   memory_payload AS payload, memory_sha256 AS sha256,
                   source_agent_run_id::text AS "sourceAgentRunId",
                   source_hand_id::text AS "sourceHandId",
                   source_state_version::float8 AS "sourceStateVersion",
                   decision_request_id::text AS "decisionRequestId",
                   as_of_event_seq::float8 AS "asOfEventSeq"
            FROM app_private.agent_memory_revisions
            WHERE participant_id = ${decision.participantId}::uuid
              AND session_id = ${decision.sessionId}::uuid
              AND owner_id = ${input.owner.databaseOwnerId}::uuid
              AND revision = ${decision.memoryRevision}::bigint
          `,
        MemoryRowSchema,
      )
      let memoryPayload: AgentMemoryPayloadV1
      try {
        memoryPayload = decodePlayerSessionMemoryV1(memory.payload)
      } catch {
        throw new PlayerAuditReplayError('invalidPayload')
      }
      if (
        decision.executionMode !== decision.decisionExecutionMode ||
        memory.revision !== decision.memoryRevision ||
        memory.payloadVersion !== decision.memoryPayloadVersion ||
        memory.sha256 !== decision.memorySha256 ||
        memory.sha256 !== hashPlayerSessionMemoryV1(memoryPayload) ||
        snapshot.sessionMemory.memoryRevision !== decision.memoryRevision ||
        snapshot.sessionMemory.memorySha256 !== decision.memorySha256 ||
        (decision.executionMode === 'live' &&
          (decision.sourceDecisionId !== null ||
            decision.sourceSnapshotSha256 !== null ||
            decision.sourceCandidateSetSha256 !== null ||
            decision.sourceProjectionSha256 !== null ||
            decision.sourceModelInputSha256 !== null)) ||
        (decision.executionMode === 'historicalReexecution' &&
          (decision.sourceDecisionId === null ||
            decision.sourceSnapshotSha256 !== snapshot.snapshotSha256 ||
            decision.sourceCandidateSetSha256 === null ||
            decision.sourceProjectionSha256 === null ||
            decision.sourceModelInputSha256 === null))
      ) {
        throw new PlayerAuditReplayError('integrityViolation')
      }
      const [attemptRows, capabilityRows] = await Promise.all([
        transaction`
            SELECT id::text AS "attemptId", attempt_number AS "attemptNumber", lifecycle,
                   accepted, stale, interrupted,
                   attempt_payload->>'requestProjectionHash' AS "requestProjectionHash",
                   attempt_payload->>'responseProjectionHash' AS "responseProjectionHash",
                   error_category AS "errorCategory"
            FROM app_private.agent_attempts
            WHERE agent_run_id = ${decision.runId}::uuid
              AND owner_id = ${input.owner.databaseOwnerId}::uuid
            ORDER BY attempt_number ASC, id ASC
          `,
        transaction`
            SELECT id::text AS "invocationId", invocation_number AS "invocationNumber",
                   capability_name AS "capabilityName", capability_version AS "capabilityVersion",
                   authorized, input_hash AS "inputHash", output_hash AS "outputHash",
                   error_category AS "errorCode"
            FROM app_private.agent_capability_invocations
            WHERE agent_run_id = ${decision.runId}::uuid
              AND owner_id = ${input.owner.databaseOwnerId}::uuid
            ORDER BY invocation_number ASC, id ASC
          `,
      ])
      const attempts = z.array(AttemptRowSchema).safeParse(attemptRows)
      const capabilityInvocations = z
        .array(CapabilityRowSchema)
        .safeParse(capabilityRows)
      if (!attempts.success || !capabilityInvocations.success) {
        throw new PlayerAuditReplayError('invalidPayload')
      }
      return Object.freeze({
        replaySchemaVersion: 1 as const,
        decision: Object.freeze({
          decisionId: decision.decisionId,
          runId: decision.runId,
          sessionId: decision.sessionId,
          participantId: decision.participantId,
          executionMode: decision.executionMode,
          lifecycle: decision.lifecycle,
          status: decision.status,
          terminalOutcome: decision.terminalOutcome,
          terminalReason: decision.terminalReason,
          snapshotSha256: snapshot.snapshotSha256,
          sourceDecisionId: decision.sourceDecisionId,
        }),
        memory: Object.freeze({ ...memory, payload: memoryPayload }),
        attempts: Object.freeze(attempts.data.map(Object.freeze)),
        capabilityInvocations: Object.freeze(
          capabilityInvocations.data.map(Object.freeze),
        ),
      }) as PlayerAuditReplayV1
    })
  }
  const service: PlayerAuditReplayService = {
    replayDecision({ owner, decisionId }) {
      return replay({ owner, lookup: 'decision', id: decisionId })
    },
    replayRun({ owner, runId }) {
      return replay({ owner, lookup: 'run', id: runId })
    },
  }
  return Object.freeze(service)
}
