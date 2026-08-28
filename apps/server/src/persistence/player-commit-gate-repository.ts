import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { CommandResponse } from '@tx-holdem-coach/contracts'
import { readCurrentAttemptAudit } from '../agents/audit/attempt-audit-codec.js'
import { currentRunConfigurationAuditReader } from '../agents/audit/run-configuration-audit-codec.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import { currentHandStartCheckpointReader } from '../sessions/hand-audit/hand-start-checkpoint-codec.js'
import type { ReadySessionRecovery } from './session-recovery-repository.js'
import type {
  AcquiredCommandRegistration,
  PreparedCommandRegistration,
} from './command-ledger-repository.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'

export type PlayerCommitFailureCode =
  | 'player_commit_input_rejected'
  | 'player_commit_selected_decision_invalid'
  | 'player_commit_resource_missing'
  | 'player_commit_authority_lost'
  | 'player_commit_decision_stale'
  | 'player_commit_command_conflict'
  | 'player_commit_persistence_rejected'
  | 'player_commit_replay_inconsistent'

export class PlayerCommitGateError extends Error {
  public constructor(public readonly code: PlayerCommitFailureCode) {
    super('Player Commit Gate 被拒绝。')
    this.name = 'PlayerCommitGateError'
  }
}

declare const playerCommitCapabilityBrand: unique symbol

export interface PlayerCommitCapability {
  readonly [playerCommitCapabilityBrand]: never
}

const PlayerCommitClaimSchema = z.strictObject({
  decisionRecordId: z.uuid(),
  agentRunId: z.uuid(),
  commandId: z.uuid(),
  acceptedAttemptId: z.uuid(),
  binding: z.strictObject({
    sessionId: z.uuid(),
    handId: z.uuid(),
    stateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    decisionRequestId: z.uuid(),
    actorParticipantId: z.uuid(),
    actorSeat: z.number().int().min(1).max(8),
    pokerRuleSetVersion: z.string().min(1),
  }),
})

export type PlayerCommitClaim = Readonly<
  z.infer<typeof PlayerCommitClaimSchema>
>

const PlayerCommitRunConfigurationSchema = z.object({
  runtime: z.literal('player'),
  runtimeDefinitionVersion: z.number().int().positive(),
  outputSchema: z.strictObject({
    id: z.string().min(1),
    version: z.number().int().positive(),
  }),
  validator: z.strictObject({
    id: z.string().min(1),
    version: z.number().int().positive(),
  }),
  commitGate: z.strictObject({
    id: z.string().min(1),
    version: z.number().int().positive(),
  }),
})

export type PlayerCommitRunConfiguration = Readonly<
  z.infer<typeof PlayerCommitRunConfigurationSchema>
>

declare const playerCommitLiveFactsBrand: unique symbol

export interface PlayerCommitLiveFacts {
  readonly pokerRuleSetVersion: string
  readonly runRuntimeDefinitionVersion: number
  readonly runConfiguration: PlayerCommitRunConfiguration
  readonly [playerCommitLiveFactsBrand]: never
}

interface CommitCapabilityMetadata {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly claim: PlayerCommitClaim
  readonly registration: AcquiredCommandRegistration
  consumed: boolean
}

const capabilities = new WeakMap<object, CommitCapabilityMetadata>()
const liveFacts = new WeakMap<
  PlayerCommitLiveFacts,
  Omit<CommitCapabilityMetadata, 'consumed'> & { capabilityIssued: boolean }
>()

const HandRowSchema = z.strictObject({
  handId: z.uuid(),
  status: z.enum(['inProgress', 'completed', 'aborted']),
  checkpointPayloadVersion: z.unknown(),
  checkpointPayload: z.unknown(),
})
const RunRowSchema = z.strictObject({
  runId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  participantId: z.uuid(),
  sourceStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  decisionRequestId: z.uuid(),
  runtimeDefinitionVersion: z.number().int().positive(),
  // Gate 要先识别一个结构合法的 Run；非 running 是 authority 失效，
  // 不是持久化损坏。否则迟到提交会被错误分到 persistence_rejected。
  lifecycle: z.enum([
    'queued',
    'leased',
    'running',
    'completed',
    'failed',
    'cancelled',
    'stale',
  ]),
  // terminal Run 按 lifecycle 约束清空租约；先解码其合法行形态，
  // 再按 lifecycle 归类为 authority lost，不能把 null 当作数据损坏。
  leaseOwner: z.string().min(1).nullable(),
  fencingToken: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  leaseValid: z.boolean().nullable(),
  deadlineValid: z.boolean(),
  runConfigPayloadVersion: z.unknown(),
  runConfigPayload: z.unknown(),
})
const AttemptRowSchema = z.strictObject({
  attemptId: z.uuid(),
  lifecycle: z.literal('completed'),
  accepted: z.literal(true),
  stale: z.literal(false),
  interrupted: z.literal(false),
  stage: z.literal('player.bounded-choice'),
  payloadVersion: z.unknown(),
  payload: z.unknown(),
})
const ParticipantRowSchema = z.strictObject({
  participantId: z.uuid(),
  seatNumber: z.number().int().min(1).max(8),
  participantType: z.literal('agent'),
  agentParticipantId: z.uuid(),
})
const DecisionRowSchema = z.strictObject({
  decisionRecordId: z.uuid(),
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  participantId: z.uuid(),
  sourceStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  decisionRequestId: z.uuid(),
  status: z.enum(['auditPrepared', 'modelPrepared', 'selected', 'committed']),
  acceptedAttemptId: z.uuid().nullable(),
  terminalOutcome: z.enum(['failed', 'stale']).nullable(),
})
const ReplayRowSchema = z.strictObject({
  ledgerId: z.uuid(),
  status: z.literal('committed'),
  commandLedgerId: z.uuid(),
  processingStatus: z.literal('completed'),
  canonicalPayloadDigest: z.string().regex(/^[0-9a-f]{64}$/),
  finalStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  firstEventSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastEventSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
})
const CommittedAtRowSchema = z.strictObject({
  ledgerId: z.uuid(),
  committedAt: z.string().datetime(),
})

function uuidEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

async function queryRows(
  query: Promise<readonly unknown[]>,
): Promise<readonly unknown[]> {
  try {
    return await query
  } catch {
    throw new PlayerCommitGateError('player_commit_persistence_rejected')
  }
}

function requireOne<T>(
  rows: readonly unknown[],
  schema: z.ZodType<T>,
  failure: PlayerCommitFailureCode,
): T {
  if (rows.length === 0) throw new PlayerCommitGateError(failure)
  const parsed = z.array(schema).safeParse(rows)
  if (!parsed.success || parsed.data.length !== 1) {
    throw new PlayerCommitGateError('player_commit_persistence_rejected')
  }
  return parsed.data[0]!
}

function parseClaim(input: unknown): PlayerCommitClaim {
  const parsed = PlayerCommitClaimSchema.safeParse(input)
  if (!parsed.success) {
    throw new PlayerCommitGateError('player_commit_input_rejected')
  }
  return parsed.data
}

function assertPreparedClaim(input: {
  readonly claim: PlayerCommitClaim
  readonly prepared: PreparedCommandRegistration
}): void {
  if (
    input.prepared.command.type !== 'aiAction' ||
    !uuidEquals(input.prepared.command.commandId, input.claim.commandId) ||
    input.prepared.command.expectedStateVersion !==
      input.claim.binding.stateVersion ||
    !uuidEquals(
      input.prepared.command.payload.decisionRequestId,
      input.claim.binding.decisionRequestId,
    ) ||
    !uuidEquals(
      input.prepared.command.payload.handId,
      input.claim.binding.handId,
    ) ||
    input.prepared.command.payload.actorSeatNumber !==
      input.claim.binding.actorSeat
  ) {
    throw new PlayerCommitGateError('player_commit_input_rejected')
  }
}

function assertAcquiredRegistration(input: {
  readonly registration: AcquiredCommandRegistration
  readonly claim: PlayerCommitClaim
  readonly prepared: PreparedCommandRegistration
}): void {
  if (
    !uuidEquals(input.registration.commandId, input.claim.commandId) ||
    !uuidEquals(input.registration.sessionId, input.claim.binding.sessionId) ||
    input.registration.canonicalPayloadDigest !==
      input.prepared.canonicalPayloadDigest
  ) {
    throw new PlayerCommitGateError('player_commit_input_rejected')
  }
}

async function lockHand(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly claim: PlayerCommitClaim
}): Promise<string> {
  const rows = await queryRows(input.transaction`
    SELECT
      id::text AS "handId",
      status,
      hand_start_checkpoint_payload_version AS "checkpointPayloadVersion",
      hand_start_checkpoint_payload AS "checkpointPayload"
    FROM app_private.hands
    WHERE id = ${input.claim.binding.handId}::uuid
      AND session_id = ${input.claim.binding.sessionId}::uuid
      AND owner_id = ${input.owner.databaseOwnerId}::uuid
    FOR UPDATE
  `)
  const hand = requireOne(rows, HandRowSchema, 'player_commit_resource_missing')
  if (hand.status !== 'inProgress') {
    throw new PlayerCommitGateError('player_commit_decision_stale')
  }
  const checkpoint = currentHandStartCheckpointReader.read(
    hand.checkpointPayloadVersion,
    hand.checkpointPayload,
  )
  if (checkpoint.kind !== 'decoded') {
    throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
  }
  return checkpoint.value.pokerRuleSetVersion
}

async function lockRun(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly claim: PlayerCommitClaim
}): Promise<{
  readonly runtimeDefinitionVersion: number
  readonly configuration: PlayerCommitRunConfiguration
}> {
  const rows = await queryRows(input.transaction`
    SELECT
      id::text AS "runId",
      session_id::text AS "sessionId",
      hand_id::text AS "handId",
      participant_id::text AS "participantId",
      source_state_version::float8 AS "sourceStateVersion",
      decision_request_id::text AS "decisionRequestId",
      runtime_definition_version AS "runtimeDefinitionVersion",
      lifecycle,
      lease_owner AS "leaseOwner",
      fencing_token::float8 AS "fencingToken",
      lease_expires_at > clock_timestamp() AS "leaseValid",
      deadline_at > clock_timestamp() AS "deadlineValid",
      run_config_payload_version AS "runConfigPayloadVersion",
      run_config_payload AS "runConfigPayload"
    FROM app_private.agent_runs
    WHERE id = ${input.authority.runId}::uuid
      AND owner_id = ${input.owner.databaseOwnerId}::uuid
      AND runtime = 'player'
    FOR UPDATE
  `)
  const run = requireOne(rows, RunRowSchema, 'player_commit_resource_missing')
  if (run.lifecycle !== 'running') {
    throw new PlayerCommitGateError('player_commit_authority_lost')
  }
  const config = currentRunConfigurationAuditReader.read(
    run.runConfigPayloadVersion,
    run.runConfigPayload,
  )
  const parsedConfiguration =
    config.kind === 'decoded'
      ? PlayerCommitRunConfigurationSchema.safeParse(config.value)
      : null
  if (
    parsedConfiguration === null ||
    !parsedConfiguration.success ||
    !uuidEquals(run.sessionId, input.claim.binding.sessionId) ||
    !uuidEquals(run.handId, input.claim.binding.handId) ||
    !uuidEquals(run.participantId, input.claim.binding.actorParticipantId) ||
    run.sourceStateVersion !== input.claim.binding.stateVersion ||
    !uuidEquals(run.decisionRequestId, input.claim.binding.decisionRequestId)
  ) {
    throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
  }
  if (
    run.leaseOwner !== input.authority.leaseOwner ||
    run.fencingToken !== input.authority.fencingToken ||
    !run.leaseValid ||
    !run.deadlineValid
  ) {
    throw new PlayerCommitGateError('player_commit_authority_lost')
  }
  return Object.freeze({
    runtimeDefinitionVersion: run.runtimeDefinitionVersion,
    configuration: parsedConfiguration.data,
  })
}

async function verifyParticipant(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly claim: PlayerCommitClaim
}) {
  const rows = await queryRows(input.transaction`
    SELECT
      participant.id::text AS "participantId",
      participant.seat_number AS "seatNumber",
      participant.participant_type AS "participantType",
      agent.participant_id::text AS "agentParticipantId"
    FROM app_private.session_participants AS participant
    JOIN app_private.session_agents AS agent
      ON agent.participant_id = participant.id
      AND agent.session_id = participant.session_id
      AND agent.owner_id = participant.owner_id
    WHERE participant.id = ${input.claim.binding.actorParticipantId}::uuid
      AND participant.session_id = ${input.claim.binding.sessionId}::uuid
      AND participant.owner_id = ${input.owner.databaseOwnerId}::uuid
    LIMIT 2
  `)
  const participant = requireOne(
    rows,
    ParticipantRowSchema,
    'player_commit_resource_missing',
  )
  if (
    participant.seatNumber !== input.claim.binding.actorSeat ||
    !uuidEquals(participant.participantId, participant.agentParticipantId)
  ) {
    throw new PlayerCommitGateError('player_commit_decision_stale')
  }
}

async function lockDecision(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly claim: PlayerCommitClaim
}) {
  const rows = await queryRows(input.transaction`
    SELECT
      id::text AS "decisionRecordId",
      agent_run_id::text AS "agentRunId",
      session_id::text AS "sessionId",
      hand_id::text AS "handId",
      participant_id::text AS "participantId",
      source_state_version::float8 AS "sourceStateVersion",
      decision_request_id::text AS "decisionRequestId",
      status,
      accepted_attempt_id::text AS "acceptedAttemptId",
      terminal_outcome AS "terminalOutcome"
    FROM app_private.player_decisions
    WHERE id = ${input.claim.decisionRecordId}::uuid
      AND agent_run_id = ${input.claim.agentRunId}::uuid
      AND owner_id = ${input.owner.databaseOwnerId}::uuid
      AND session_id = ${input.claim.binding.sessionId}::uuid
    FOR UPDATE
  `)
  const decision = requireOne(
    rows,
    DecisionRowSchema,
    'player_commit_resource_missing',
  )
  if (
    !uuidEquals(decision.handId, input.claim.binding.handId) ||
    !uuidEquals(
      decision.participantId,
      input.claim.binding.actorParticipantId,
    ) ||
    decision.sourceStateVersion !== input.claim.binding.stateVersion ||
    !uuidEquals(
      decision.decisionRequestId,
      input.claim.binding.decisionRequestId,
    )
  ) {
    throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
  }
  return decision
}

async function lockAcceptedAttempt(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly claim: PlayerCommitClaim
  readonly decision: z.infer<typeof DecisionRowSchema>
}) {
  const rows = await queryRows(input.transaction`
    SELECT
      id::text AS "attemptId",
      lifecycle,
      accepted,
      stale,
      interrupted,
      stage,
      attempt_payload_version AS "payloadVersion",
      attempt_payload AS "payload"
    FROM app_private.agent_attempts
    WHERE id = ${input.claim.acceptedAttemptId}::uuid
      AND agent_run_id = ${input.authority.runId}::uuid
      AND owner_id = ${input.owner.databaseOwnerId}::uuid
      AND session_id = ${input.claim.binding.sessionId}::uuid
    FOR UPDATE
  `)
  const attempt = requireOne(
    rows,
    AttemptRowSchema,
    'player_commit_resource_missing',
  )
  const audit = readCurrentAttemptAudit(
    attempt.lifecycle,
    attempt.payloadVersion,
    attempt.payload,
  )
  if (
    audit.kind !== 'decoded' ||
    audit.value.lifecycle !== 'completed' ||
    audit.value.validationStatus !== 'valid' ||
    input.decision.status !== 'selected' ||
    input.decision.terminalOutcome !== null ||
    !uuidEquals(input.decision.acceptedAttemptId ?? '', attempt.attemptId)
  ) {
    throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
  }
}

export interface PlayerCommitGateRepository {
  lockForCommit(input: {
    readonly transaction: TransactionSql
    readonly owner: ResolvedOwnerScope
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly claim: PlayerCommitClaim
    readonly recovery: ReadySessionRecovery
    readonly prepared: PreparedCommandRegistration
    readonly registration: AcquiredCommandRegistration
  }): Promise<PlayerCommitLiveFacts>
  issueCommitCapability(input: {
    readonly transaction: TransactionSql
    readonly owner: ResolvedOwnerScope
    readonly liveFacts: PlayerCommitLiveFacts
  }): PlayerCommitCapability
  markCommitted(input: {
    readonly transaction: TransactionSql
    readonly owner: ResolvedOwnerScope
    readonly capability: PlayerCommitCapability
  }): Promise<{ readonly ledgerId: string; readonly committedAt: string }>
  verifyReplay(input: {
    readonly transaction: TransactionSql
    readonly owner: ResolvedOwnerScope
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly claim: PlayerCommitClaim
    readonly prepared: PreparedCommandRegistration
    readonly response: CommandResponse
  }): Promise<{
    readonly ledgerId: string
    readonly finalStateVersion: number
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  }>
}

export function createPlayerCommitGateRepository(): PlayerCommitGateRepository {
  const repository: PlayerCommitGateRepository = {
    async lockForCommit(
      input: Parameters<PlayerCommitGateRepository['lockForCommit']>[0],
    ) {
      if (
        !isResolvedOwnerScope(input.owner) ||
        !isRuntimeCommitAuthority(input.authority, 'player')
      ) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }
      const claim = parseClaim(input.claim)
      if (!uuidEquals(input.authority.runId, claim.agentRunId)) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }
      assertPreparedClaim({ claim, prepared: input.prepared })
      assertAcquiredRegistration({
        claim,
        prepared: input.prepared,
        registration: input.registration,
      })
      const { recovery } = input
      if (
        recovery.locked.lifecycleStatus !== 'active' ||
        recovery.locked.stateVersion !== claim.binding.stateVersion ||
        !uuidEquals(recovery.locked.sessionId, claim.binding.sessionId)
      ) {
        throw new PlayerCommitGateError('player_commit_decision_stale')
      }
      const pokerRuleSetVersion = await lockHand({ ...input, claim })
      const lockedRun = await lockRun({ ...input, claim })
      const decision = await lockDecision({ ...input, claim })
      await verifyParticipant({ ...input, claim })
      await lockAcceptedAttempt({ ...input, claim, decision })
      // Run 是实时 authority 的归属方。必须在 Hand/Run/Decision/Attempt 都按
      // 固定顺序锁定后，才复验 Session 的协调指针与当前 actor；否则一个已经
      // 正常终态化并清空指针的 Run 会被过早误分为 decision_stale，而不是
      // authority_lost。
      if (
        recovery.locked.agentRunState !== 'thinking' ||
        !uuidEquals(
          recovery.locked.currentHandId ?? '',
          claim.binding.handId,
        ) ||
        !uuidEquals(
          recovery.locked.activePlayerRunId ?? '',
          input.authority.runId,
        ) ||
        !uuidEquals(
          recovery.locked.activeDecisionRequestId ?? '',
          claim.binding.decisionRequestId,
        ) ||
        recovery.state.poker.pokerPhase !== 'inHand' ||
        !uuidEquals(
          recovery.state.poker.hand?.handId ?? '',
          claim.binding.handId,
        ) ||
        recovery.state.poker.hand?.currentActorSeatNumber !==
          claim.binding.actorSeat
      ) {
        throw new PlayerCommitGateError('player_commit_decision_stale')
      }
      const facts = Object.freeze({
        pokerRuleSetVersion,
        runRuntimeDefinitionVersion: lockedRun.runtimeDefinitionVersion,
        runConfiguration: lockedRun.configuration,
      }) as PlayerCommitLiveFacts
      liveFacts.set(facts, {
        transaction: input.transaction,
        owner: input.owner,
        authority: input.authority,
        claim,
        registration: input.registration,
        capabilityIssued: false,
      })
      return facts
    },

    issueCommitCapability(
      input: Parameters<PlayerCommitGateRepository['issueCommitCapability']>[0],
    ) {
      const metadata = liveFacts.get(input.liveFacts)
      if (
        metadata === undefined ||
        metadata.capabilityIssued ||
        metadata.transaction !== input.transaction ||
        metadata.owner !== input.owner
      ) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }
      metadata.capabilityIssued = true
      const capability = Object.freeze({}) as PlayerCommitCapability
      capabilities.set(capability, {
        transaction: metadata.transaction,
        owner: metadata.owner,
        authority: metadata.authority,
        claim: metadata.claim,
        registration: metadata.registration,
        consumed: false,
      })
      return capability
    },

    async markCommitted(
      input: Parameters<PlayerCommitGateRepository['markCommitted']>[0],
    ) {
      const metadata = capabilities.get(input.capability)
      if (
        metadata === undefined ||
        metadata.consumed ||
        metadata.transaction !== input.transaction ||
        metadata.owner !== input.owner
      ) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }
      metadata.consumed = true
      const rows = await queryRows(input.transaction`
        UPDATE app_private.player_decisions AS decision
        SET status = 'committed',
            command_ledger_id = ${metadata.registration.ledgerId}::uuid,
            committed_at = clock_timestamp(),
            updated_at = clock_timestamp()
        FROM app_private.command_ledger AS ledger
        WHERE decision.id = ${metadata.claim.decisionRecordId}::uuid
          AND decision.agent_run_id = ${metadata.authority.runId}::uuid
          AND decision.owner_id = ${metadata.owner.databaseOwnerId}::uuid
          AND decision.session_id = ${metadata.claim.binding.sessionId}::uuid
          AND decision.status = 'selected'
          AND decision.terminal_outcome IS NULL
          AND decision.terminal_reason IS NULL
          AND decision.terminated_at IS NULL
          AND ledger.id = ${metadata.registration.ledgerId}::uuid
          AND ledger.session_id = decision.session_id
          AND ledger.owner_id = decision.owner_id
          AND ledger.processing_status = 'completed'
        RETURNING
          decision.command_ledger_id::text AS "ledgerId",
          to_char(decision.committed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "committedAt"
      `)
      return requireOne(
        rows,
        CommittedAtRowSchema,
        'player_commit_persistence_rejected',
      )
    },

    async verifyReplay(
      input: Parameters<PlayerCommitGateRepository['verifyReplay']>[0],
    ) {
      if (
        !isResolvedOwnerScope(input.owner) ||
        !isRuntimeCommitAuthority(input.authority, 'player')
      ) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }
      const claim = parseClaim(input.claim)
      if (!uuidEquals(input.authority.runId, claim.agentRunId)) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }
      assertPreparedClaim({ claim, prepared: input.prepared })
      try {
        await lockDecision({ ...input, claim })
      } catch {
        throw new PlayerCommitGateError('player_commit_replay_inconsistent')
      }
      const rows = await queryRows(input.transaction`
        SELECT
          ledger.id::text AS "ledgerId",
          decision.status,
          decision.command_ledger_id::text AS "commandLedgerId",
          ledger.processing_status AS "processingStatus",
          ledger.canonical_payload_digest AS "canonicalPayloadDigest",
          ledger.final_state_version::float8 AS "finalStateVersion",
          ledger.first_event_seq::float8 AS "firstEventSeq",
          ledger.last_event_seq::float8 AS "lastEventSeq"
        FROM app_private.player_decisions AS decision
        JOIN app_private.command_ledger AS ledger
          ON ledger.id = decision.command_ledger_id
          AND ledger.session_id = decision.session_id
          AND ledger.owner_id = decision.owner_id
        WHERE decision.id = ${claim.decisionRecordId}::uuid
          AND decision.agent_run_id = ${input.authority.runId}::uuid
          AND decision.owner_id = ${input.owner.databaseOwnerId}::uuid
          AND decision.session_id = ${claim.binding.sessionId}::uuid
          AND ledger.command_id = ${input.prepared.command.commandId}::uuid
        LIMIT 2
      `)
      const replay = requireOne(
        rows,
        ReplayRowSchema,
        'player_commit_replay_inconsistent',
      )
      if (
        !uuidEquals(replay.ledgerId, replay.commandLedgerId) ||
        replay.canonicalPayloadDigest !==
          input.prepared.canonicalPayloadDigest ||
        replay.finalStateVersion !== input.response.snapshot.stateVersion ||
        replay.lastEventSeq !== input.response.snapshot.eventSeq ||
        !uuidEquals(
          input.response.snapshot.sessionId,
          input.prepared.command.sessionId,
        )
      ) {
        throw new PlayerCommitGateError('player_commit_replay_inconsistent')
      }
      return Object.freeze({
        ledgerId: replay.ledgerId,
        finalStateVersion: replay.finalStateVersion,
        firstEventSeq: replay.firstEventSeq,
        lastEventSeq: replay.lastEventSeq,
      })
    },
  }
  return Object.freeze(repository)
}
