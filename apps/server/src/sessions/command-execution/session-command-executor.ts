import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import {
  CommandResponseSchema,
  ErrorResponseSchema,
  PublicSessionSnapshotSchema,
  SseEventSchema,
  type CommandResponse,
  type ErrorResponse,
  type SseEvent,
} from '@tx-holdem-coach/contracts'
import {
  completeCommand,
  failCommand,
  preparePrivateAiActionCommandRegistration,
  prepareCommandRegistration,
  readExistingCommandResult,
  registerCommand,
  type AcquiredCommandRegistration,
  type AiActionLedgerCommand,
  type ExistingCommandResult,
  type LedgerCommand,
  type PreparedCommandRegistration,
} from '../../persistence/command-ledger-repository.js'
import {
  CommandPayloadConflictError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  PlayerDecisionIntegrityError,
  ResourceNotFoundError,
} from '../../persistence/errors.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { SessionMutationRepository } from '../../persistence/session-mutation-repository.js'
import type {
  ReadySessionRecovery,
  SessionRecoveryRepository,
  SessionRecoveryTransactionResult,
} from '../../persistence/session-recovery-repository.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import {
  createPrivateTableState,
  createPrivateTableStateContent,
} from '../authoritative-state/private-table-state.js'
import { encodeSnapshot } from '../authoritative-state/snapshot-codec.js'
import { getPrivateEventHandId } from '../authoritative-state/private-event.js'
import { isCommandMutationConsistent } from './command-event-policy.js'
import {
  consumePreparedMutationCapability,
  createGuardedPort,
  createPreparedMutationCapability,
  type PortLifetime,
} from './command-handler.js'
import {
  SessionCommandCompositionError,
  createSessionCommandHandlerMap,
  type SessionCommandHandlerMap,
} from './command-handler-map.js'
import { createPerSessionScheduler } from './per-session-scheduler.js'
import type { PlayerTurnHintPort } from '../../agents/player/player-turn-dispatcher.js'
import {
  mapCommandRejectionToErrorResponse,
  parseStableCommandRejection,
  type StableCommandRejectionCode,
} from './command-rejection.js'
import type {
  SnapshotProjectionInput,
  SnapshotProjectorBinding,
} from './snapshot-projector.js'
import type { CommittedSessionEventPublisher } from '../public-projection/committed-session-event-hub.js'
import {
  type PlayerCommitGate,
  type PlayerCommitReceiptV1,
} from '../../agents/player/player-commit-gate.js'
import { createAiActionHandlerBinding } from './player-action-handler.js'
import {
  isRuntimeCommitAuthority,
  type AgentRunEventPort,
  type RuntimeCommitAuthority,
} from '../../agents/foundation/runtime-ports.js'
import {
  playerRuntimeDefinition,
  type PlayerRuntimeDefinition,
} from '../../agents/player/foundation-definition.js'
import {
  isPlayerRuntimeCandidateResultV1,
  type PlayerRuntimeCandidateResultV1,
} from '../../agents/player/player-runtime-result-port.js'
import {
  validatePlayerDecisionV1,
  type PlayerValidatedDecisionV1,
} from '../../agents/player/player-decision-validator.js'
import {
  createPlayerCommitGateRepository,
  PlayerCommitGateError,
  type PlayerCommitClaim,
  type PlayerCommitLiveFacts,
} from '../../persistence/player-commit-gate-repository.js'
import {
  createPlayerDecisionRepository,
  type DecodedPlayerDecisionRecordV1,
} from '../../persistence/player-decision-repository.js'
import { createAgentRunLifecycleRepository } from '../../persistence/agent-run-lifecycle-repository.js'

export type StableSessionCommandErrorCode =
  | StableCommandRejectionCode
  | 'SESSION_NOT_FOUND'
  | 'STATE_VERSION_CONFLICT'
  | 'COMMAND_ID_CONFLICT'
  | 'SESSION_ENDED'
  | 'SESSION_READONLY_DIAGNOSTIC'

type StableSessionCommandErrorResponse = ErrorResponse & {
  readonly code: StableSessionCommandErrorCode
}

export type SessionCommandExecutionResult =
  | {
      readonly kind: 'completed'
      readonly origin: 'newCommit'
      readonly response: CommandResponse
      readonly newlyPersistedEvents: readonly [SseEvent, ...SseEvent[]]
    }
  | {
      readonly kind: 'completed'
      readonly origin: 'replay'
      readonly response: CommandResponse
    }
  | {
      readonly kind: 'rejected'
      readonly origin: 'ledgerCommit' | 'replay' | 'unregistered'
      readonly response: StableSessionCommandErrorResponse
    }

interface CommandLedgerRepositoryPort {
  registerCommand: typeof registerCommand
  readExistingCommandResult: typeof readExistingCommandResult
  completeCommand: typeof completeCommand
  failCommand: typeof failCommand
}

const CanonicalUtcTimestampSchema = z.iso.datetime({ precision: 3 })
const PreparedCandidateSchema = z.strictObject({
  stateEffect: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('stateChanged'),
      stateContent: z.unknown(),
    }),
    z.strictObject({ kind: z.literal('stateUnchanged') }),
  ]),
  lifecycleAfter: z.enum(['active', 'ended']),
  currentHandIdAfter: z.uuid().nullable(),
  playerCoordinationAfter: z.strictObject({
    agentRunState: z.enum(['idle', 'thinking', 'paused']),
    activePlayerRunId: z.uuid().nullable(),
    activeDecisionRequestId: z.uuid().nullable(),
  }),
  privateEventDrafts: z.array(z.unknown()).min(1),
  relationPlan: z.unknown(),
})

export interface SessionCommandExecutor {
  execute(command: unknown): Promise<SessionCommandExecutionResult>
}

interface InternalAiActionCommitHooks {
  prepareAfterSessionLock(input: {
    readonly transaction: TransactionSql
    readonly recovery: Exclude<
      SessionRecoveryTransactionResult,
      { readonly kind: 'readonlyDiagnostic' }
    >
  }): Promise<PreparedCommandRegistration>
  sessionFailure(
    reason: 'resourceMissing' | 'stale' | 'persistenceRejected',
  ): Error
  verifyBeforeAction(input: {
    readonly transaction: TransactionSql
    readonly recovery: ReadySessionRecovery
    readonly prepared: PreparedCommandRegistration
    readonly registration: AcquiredCommandRegistration
  }): Promise<unknown>
  completeAfterLedger(input: {
    readonly transaction: TransactionSql
    readonly recovery: ReadySessionRecovery
    readonly prepared: PreparedCommandRegistration
    readonly registration: AcquiredCommandRegistration
    readonly commitCapability: unknown
    readonly response: CommandResponse
  }): Promise<void>
  verifyReplay(input: {
    readonly transaction: TransactionSql
    readonly prepared: PreparedCommandRegistration
    readonly response: CommandResponse
  }): Promise<void>
}

interface InternalAiActionExecutionInput {
  readonly sessionId: string
  readonly hooks: InternalAiActionCommitHooks
}

/**
 * 仅由 Player Commit Gate 在组合根持有的私有事务端口。
 *
 * 它不属于 `SessionCommandExecutor`：普通服务只拿到公开命令入口，
 * 即使其 handler map 中意外包含 aiAction，也不能自行替换 Gate hooks。
 */
interface InternalAiActionCommitExecutor {
  execute(
    input: InternalAiActionExecutionInput,
  ): Promise<SessionCommandExecutionResult>
}

interface SessionCommandExecutorWithInternalAiAction {
  readonly commands: SessionCommandExecutor
  readonly aiActionCommitExecutor: InternalAiActionCommitExecutor
}

export class SessionCommandInvariantError extends Error {
  public constructor() {
    super('Session 命令执行不变量被破坏。')
    this.name = 'SessionCommandInvariantError'
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

interface PlayerCommitGateDependencies {
  readonly owner: ResolvedOwnerScope
  readonly aiActionCommitExecutor: InternalAiActionCommitExecutor
  readonly runEventPort: AgentRunEventPort
  readonly logPublishFailure?: (input: {
    readonly kind: 'agentRunCompleted'
    readonly runId: string
  }) => void
}

function playerCommitSessionFailure(
  reason: 'resourceMissing' | 'stale' | 'persistenceRejected',
): PlayerCommitGateError {
  switch (reason) {
    case 'resourceMissing':
      return new PlayerCommitGateError('player_commit_resource_missing')
    case 'stale':
      return new PlayerCommitGateError('player_commit_decision_stale')
    case 'persistenceRejected':
      return new PlayerCommitGateError('player_commit_persistence_rejected')
  }
}

function uuidEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function validatedDecisionsMatch(
  left: PlayerValidatedDecisionV1,
  right: PlayerValidatedDecisionV1,
): boolean {
  return (
    left.commandId === right.commandId &&
    left.decisionRecordId === right.decisionRecordId &&
    left.agentRunId === right.agentRunId &&
    left.candidateSetSha256 === right.candidateSetSha256 &&
    left.selectedCandidateActionId === right.selectedCandidateActionId &&
    left.choiceSha256 === right.choiceSha256 &&
    left.acceptedAttemptId === right.acceptedAttemptId &&
    canonicalJson(left.binding as JsonValue) ===
      canonicalJson(right.binding as JsonValue) &&
    canonicalJson(left.selectedAction as JsonValue) ===
      canonicalJson(right.selectedAction as JsonValue)
  )
}

function createCommitClaim(
  validated: PlayerValidatedDecisionV1,
): PlayerCommitClaim {
  return {
    decisionRecordId: validated.decisionRecordId,
    agentRunId: validated.agentRunId,
    commandId: validated.commandId,
    acceptedAttemptId: validated.acceptedAttemptId,
    binding: validated.binding,
  }
}

function preparePlayerAiActionCommandRegistration(
  validated: PlayerValidatedDecisionV1,
): PreparedCommandRegistration {
  const command: AiActionLedgerCommand = {
    sessionId: validated.binding.sessionId,
    commandId: validated.commandId,
    expectedStateVersion: validated.binding.stateVersion,
    type: 'aiAction',
    payload: {
      decisionRequestId: validated.binding.decisionRequestId,
      handId: validated.binding.handId,
      actorSeatNumber: validated.binding.actorSeat,
      candidateActionId: validated.selectedCandidateActionId,
      action: validated.selectedAction,
    },
  }
  return preparePrivateAiActionCommandRegistration(command)
}

function assertPreparedValidated(input: {
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly result: PlayerRuntimeCandidateResultV1
  readonly validated: PlayerValidatedDecisionV1
  readonly prepared: PreparedCommandRegistration
}): void {
  if (
    input.prepared.command.type !== 'aiAction' ||
    !uuidEquals(input.prepared.command.commandId, input.validated.commandId) ||
    !uuidEquals(input.validated.agentRunId, input.authority.runId) ||
    !uuidEquals(
      input.validated.decisionRecordId,
      input.result.decisionRecordId,
    ) ||
    input.prepared.command.expectedStateVersion !==
      input.validated.binding.stateVersion ||
    !uuidEquals(
      input.prepared.command.payload.decisionRequestId,
      input.validated.binding.decisionRequestId,
    ) ||
    !uuidEquals(
      input.prepared.command.payload.handId,
      input.validated.binding.handId,
    ) ||
    input.prepared.command.payload.actorSeatNumber !==
      input.validated.binding.actorSeat ||
    input.prepared.command.payload.candidateActionId !==
      input.validated.selectedCandidateActionId ||
    canonicalJson(input.prepared.command.payload.action as JsonValue) !==
      canonicalJson(input.validated.selectedAction as JsonValue)
  ) {
    throw new PlayerCommitGateError('player_commit_input_rejected')
  }
}

function assertLivePlayerFacts(input: {
  readonly facts: PlayerCommitLiveFacts
  readonly validated: PlayerValidatedDecisionV1
  readonly runtimeDefinition: PlayerRuntimeDefinition
}): void {
  const { facts, runtimeDefinition, validated } = input
  if (
    facts.pokerRuleSetVersion !== validated.binding.pokerRuleSetVersion ||
    facts.runRuntimeDefinitionVersion !==
      runtimeDefinition.runtimeDefinitionVersion ||
    facts.runConfiguration.runtime !== runtimeDefinition.runtimeType ||
    facts.runConfiguration.runtimeDefinitionVersion !==
      runtimeDefinition.runtimeDefinitionVersion ||
    facts.runConfiguration.outputSchema.id !==
      runtimeDefinition.outputSchema.id ||
    facts.runConfiguration.outputSchema.version !==
      runtimeDefinition.outputSchema.version ||
    facts.runConfiguration.validator.id !== runtimeDefinition.validator.id ||
    facts.runConfiguration.validator.version !==
      runtimeDefinition.validator.version ||
    facts.runConfiguration.commitGate.id !== runtimeDefinition.commitGate.id ||
    facts.runConfiguration.commitGate.version !==
      runtimeDefinition.commitGate.version
  ) {
    throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
  }
}

function assertCurrentValidatedDecision(input: {
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly result: PlayerRuntimeCandidateResultV1
  readonly persisted: DecodedPlayerDecisionRecordV1
  readonly runtimeDefinition: PlayerRuntimeDefinition
  readonly validated: PlayerValidatedDecisionV1
}): void {
  const currentValidated = validatePlayerDecisionV1({
    authority: input.authority,
    result: input.result,
    persisted: input.persisted,
    runtimeDefinition: input.runtimeDefinition,
  })
  if (!validatedDecisionsMatch(currentValidated, input.validated)) {
    throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
  }
}

async function readCurrentPlayerDecisionForCommit(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly validated: PlayerValidatedDecisionV1
}) {
  try {
    return await createPlayerDecisionRepository().readForCommitValidation(
      input.transaction,
      input.owner,
      {
        decisionRecordId: input.validated.decisionRecordId,
        agentRunId: input.validated.agentRunId,
        sessionId: input.validated.binding.sessionId,
      },
    )
  } catch (error) {
    if (error instanceof PlayerDecisionIntegrityError) {
      throw new PlayerCommitGateError('player_commit_selected_decision_invalid')
    }
    throw error
  }
}

function createPlayerCommitGate(
  dependencies: PlayerCommitGateDependencies,
): PlayerCommitGate {
  const runtimeDefinition = playerRuntimeDefinition
  const decisions = createPlayerDecisionRepository()
  const commits = createPlayerCommitGateRepository()
  const runs = createAgentRunLifecycleRepository()

  const gate: PlayerCommitGate = {
    async commit(input: Parameters<PlayerCommitGate['commit']>[0]) {
      if (
        !isRuntimeCommitAuthority(input.authority, 'player') ||
        !isPlayerRuntimeCandidateResultV1(input.result)
      ) {
        throw new PlayerCommitGateError('player_commit_input_rejected')
      }

      let validated: PlayerValidatedDecisionV1 | null = null
      let committedLedgerId: string | null = null
      let committedAt: string | null = null
      let replayLedgerId: string | null = null
      let replayEventRange: {
        readonly firstEventSeq: number
        readonly lastEventSeq: number
      } | null = null
      let terminalRunCommitted = false
      let execution: SessionCommandExecutionResult
      try {
        execution = await dependencies.aiActionCommitExecutor.execute({
          sessionId: input.result.binding.sessionId,
          hooks: {
            prepareAfterSessionLock: async ({ transaction }) => {
              try {
                const persisted = await decisions.readForCommitValidation(
                  transaction,
                  dependencies.owner,
                  {
                    decisionRecordId: input.result.decisionRecordId,
                    agentRunId: input.authority.runId,
                    sessionId: input.result.binding.sessionId,
                  },
                )
                validated = validatePlayerDecisionV1({
                  authority: input.authority,
                  result: input.result,
                  persisted,
                  runtimeDefinition,
                })
                return preparePlayerAiActionCommandRegistration(validated)
              } catch (error) {
                if (error instanceof ResourceNotFoundError) {
                  throw new PlayerCommitGateError(
                    'player_commit_resource_missing',
                  )
                }
                if (error instanceof PlayerDecisionIntegrityError) {
                  throw new PlayerCommitGateError(
                    'player_commit_selected_decision_invalid',
                  )
                }
                if (
                  error instanceof DatabaseOperationError ||
                  error instanceof PersistenceDataCorruptionError
                ) {
                  throw new PlayerCommitGateError(
                    'player_commit_persistence_rejected',
                  )
                }
                if (error instanceof PlayerCommitGateError) throw error
                throw new PlayerCommitGateError(
                  'player_commit_selected_decision_invalid',
                )
              }
            },
            sessionFailure: playerCommitSessionFailure,
            verifyBeforeAction: (hookInput) => {
              if (validated === null) {
                throw new PlayerCommitGateError('player_commit_input_rejected')
              }
              const currentValidated = validated
              const claim = createCommitClaim(currentValidated)
              assertPreparedValidated({
                authority: input.authority,
                result: input.result,
                validated: currentValidated,
                prepared: hookInput.prepared,
              })
              return commits
                .lockForCommit({
                  ...hookInput,
                  owner: dependencies.owner,
                  authority: input.authority,
                  claim,
                })
                .then((facts) => {
                  assertLivePlayerFacts({
                    facts,
                    validated: currentValidated,
                    runtimeDefinition,
                  })
                  return readCurrentPlayerDecisionForCommit({
                    transaction: hookInput.transaction,
                    owner: dependencies.owner,
                    validated: currentValidated,
                  }).then((persisted) => {
                    assertCurrentValidatedDecision({
                      authority: input.authority,
                      result: input.result,
                      persisted,
                      runtimeDefinition,
                      validated: currentValidated,
                    })
                    return commits.issueCommitCapability({
                      transaction: hookInput.transaction,
                      owner: dependencies.owner,
                      liveFacts: facts,
                    })
                  })
                })
            },
            completeAfterLedger: async (hookInput) => {
              const committed = await commits.markCommitted({
                transaction: hookInput.transaction,
                owner: dependencies.owner,
                capability: hookInput.commitCapability as never,
              })
              const finalized = await runs.finalize(
                hookInput.transaction,
                dependencies.owner,
                {
                  runId: input.authority.runId,
                  authority: input.authority,
                  lifecycle: 'completed',
                  terminationReason: null,
                  completedAt: committed.committedAt,
                },
              )
              if (
                !finalized.changed ||
                finalized.run.lifecycle !== 'completed'
              ) {
                throw new PlayerCommitGateError(
                  'player_commit_persistence_rejected',
                )
              }
              committedLedgerId = committed.ledgerId
              committedAt = committed.committedAt
              terminalRunCommitted = true
            },
            verifyReplay: async (hookInput) => {
              if (validated === null) {
                throw new PlayerCommitGateError('player_commit_input_rejected')
              }
              const claim = createCommitClaim(validated)
              assertPreparedValidated({
                authority: input.authority,
                result: input.result,
                validated,
                prepared: hookInput.prepared,
              })
              const replay = await commits.verifyReplay({
                transaction: hookInput.transaction,
                owner: dependencies.owner,
                authority: input.authority,
                claim,
                prepared: hookInput.prepared,
                response: hookInput.response,
              })
              const persisted = await readCurrentPlayerDecisionForCommit({
                transaction: hookInput.transaction,
                owner: dependencies.owner,
                validated,
              })
              assertCurrentValidatedDecision({
                authority: input.authority,
                result: input.result,
                persisted,
                runtimeDefinition,
                validated,
              })
              replayLedgerId = replay.ledgerId
              replayEventRange = replay
            },
          },
        })
      } catch (error) {
        if (error instanceof PlayerCommitGateError) throw error
        if (error instanceof CommandPayloadConflictError) {
          throw new PlayerCommitGateError('player_commit_command_conflict')
        }
        throw new PlayerCommitGateError('player_commit_persistence_rejected')
      }

      if (execution.kind !== 'completed' || validated === null) {
        throw new PlayerCommitGateError('player_commit_persistence_rejected')
      }
      const committedValidated = validated as PlayerValidatedDecisionV1
      const replayRange = replayEventRange as {
        readonly firstEventSeq: number
        readonly lastEventSeq: number
      } | null
      const ledgerId =
        execution.origin === 'newCommit' ? committedLedgerId : replayLedgerId
      if (ledgerId === null) {
        throw new PlayerCommitGateError('player_commit_replay_inconsistent')
      }
      if (execution.origin === 'newCommit') {
        if (!terminalRunCommitted || committedAt === null) {
          throw new PlayerCommitGateError('player_commit_persistence_rejected')
        }
        try {
          await dependencies.runEventPort.publish([
            {
              runtimeType: 'player',
              kind: 'completed',
              runId: input.authority.runId,
            },
          ])
        } catch {
          try {
            dependencies.logPublishFailure?.({
              kind: 'agentRunCompleted',
              runId: input.authority.runId,
            })
          } catch {
            // 提交后发布失败不影响已提交动作。
          }
        }
      }
      return deepFreeze({
        decisionRecordId: committedValidated.decisionRecordId,
        commandLedgerId: ledgerId,
        agentRunId: committedValidated.agentRunId,
        finalStateVersion: execution.response.snapshot.stateVersion,
        firstEventSeq:
          execution.origin === 'newCommit'
            ? execution.newlyPersistedEvents[0].eventSeq
            : (replayRange?.firstEventSeq ??
              execution.response.snapshot.eventSeq),
        lastEventSeq:
          execution.origin === 'newCommit'
            ? execution.response.snapshot.eventSeq
            : (replayRange?.lastEventSeq ??
              execution.response.snapshot.eventSeq),
        origin: execution.origin,
      }) as PlayerCommitReceiptV1
    },
  }
  return Object.freeze(gate)
}

function isDeepFrozen(
  value: unknown,
  visited: WeakSet<object> = new WeakSet(),
): boolean {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function')
  ) {
    return true
  }
  if (visited.has(value)) return true
  if (!Object.isFrozen(value)) return false
  visited.add(value)
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return (
      descriptor === undefined ||
      !('value' in descriptor) ||
      isDeepFrozen(descriptor.value, visited)
    )
  })
}

const STABLE_SESSION_COMMAND_ERROR_CODES: ReadonlySet<string> =
  new Set<StableSessionCommandErrorCode>([
    'SESSION_NOT_FOUND',
    'STATE_VERSION_CONFLICT',
    'COMMAND_ID_CONFLICT',
    'COMMAND_NOT_ALLOWED_IN_PHASE',
    'PLAYER_NOT_CURRENT_ACTOR',
    'POKER_ACTION_NOT_LEGAL',
    'POKER_ACTION_TARGET_OUT_OF_RANGE',
    'REBUY_AMOUNT_NOT_ALLOWED',
    'USER_REBUY_REQUIRED',
    'AGENT_RETRY_NOT_ALLOWED',
    'PAUSED_RUN_CONFLICT',
    'SESSION_ENDED',
    'SESSION_READONLY_DIAGNOSTIC',
  ])

function parseStableSessionCommandErrorResponse(
  response: unknown,
): StableSessionCommandErrorResponse {
  const parsed = ErrorResponseSchema.parse(response)
  if (!STABLE_SESSION_COMMAND_ERROR_CODES.has(parsed.code)) {
    throw new SessionCommandInvariantError()
  }
  return parsed as StableSessionCommandErrorResponse
}

function replayResult(
  result:
    | ExistingCommandResult
    | Exclude<
        Awaited<ReturnType<typeof registerCommand>>,
        AcquiredCommandRegistration
      >,
): SessionCommandExecutionResult {
  switch (result.status) {
    case 'completed':
      return deepFreeze({
        kind: 'completed',
        origin: 'replay',
        response: CommandResponseSchema.parse(result.response),
      })
    case 'failed':
      return deepFreeze({
        kind: 'rejected',
        origin: 'replay',
        response: parseStableSessionCommandErrorResponse(result.response),
      })
    case 'notFound':
      return unregisteredError(
        'SESSION_ENDED',
        '场次已结束，无法执行新的命令。',
      )
  }
}

function unregisteredError(
  code: StableSessionCommandErrorCode,
  message: string,
): SessionCommandExecutionResult {
  return deepFreeze({
    kind: 'rejected',
    origin: 'unregistered',
    response: parseStableSessionCommandErrorResponse({
      code,
      message,
    }),
  })
}

async function projectLatestSnapshot(
  transaction: TransactionSql,
  binding: SnapshotProjectorBinding,
  prepared: PreparedCommandRegistration,
  state: SnapshotProjectionInput['state'],
  session: SnapshotProjectionInput['session'],
  eventSeq: number,
) {
  const lifetime: PortLifetime = { active: true }
  const reads = createGuardedPort(binding.bindReadPort(transaction), lifetime)
  try {
    return PublicSessionSnapshotSchema.parse(
      await binding.projector.project({
        command: prepared.command,
        state,
        session,
        eventSeq,
        newPrivateEvents: [],
        reads,
      }),
    )
  } finally {
    lifetime.active = false
  }
}

export interface SessionCommandExecutorDependencies {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly handlers: SessionCommandHandlerMap
  readonly mutationRepository: SessionMutationRepository
  readonly recoveryRepository: SessionRecoveryRepository
  readonly commandLedgerRepository?: CommandLedgerRepositoryPort
  readonly snapshotProjectorBinding: SnapshotProjectorBinding
  readonly now: () => string
  readonly nextEventId: () => string
  readonly logPointerRepair?: (repair: unknown) => void
  readonly committedEventPublisher: CommittedSessionEventPublisher
  readonly logPublishFailure?: (input: {
    readonly eventCount: number
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  }) => void
  readonly playerTurnHintPort?: PlayerTurnHintPort
}

function createSessionCommandExecutorWithInternalAiAction(
  input: SessionCommandExecutorDependencies,
): SessionCommandExecutorWithInternalAiAction {
  const {
    sql,
    owner,
    handlers,
    mutationRepository,
    recoveryRepository,
    commandLedgerRepository,
    snapshotProjectorBinding,
    now,
    nextEventId,
    logPointerRepair,
    committedEventPublisher,
    logPublishFailure,
    playerTurnHintPort,
  } = input
  if (recoveryRepository.sessionMutationRepository !== mutationRepository) {
    throw new SessionCommandCompositionError()
  }
  const ledger = commandLedgerRepository ?? {
    registerCommand,
    readExistingCommandResult,
    completeCommand,
    failCommand,
  }
  const scheduler = createPerSessionScheduler()

  const executePrepared = async (
    sessionId: string,
    prepareAfterSessionLock: (input: {
      readonly transaction: TransactionSql
      readonly recovery: Exclude<
        SessionRecoveryTransactionResult,
        { readonly kind: 'readonlyDiagnostic' }
      >
    }) => Promise<PreparedCommandRegistration>,
    internalAiHooks?: InternalAiActionCommitHooks,
  ): Promise<SessionCommandExecutionResult> => {
    return scheduler.run(sessionId, async () => {
      let pointerRepair: unknown = null
      let executionResult: SessionCommandExecutionResult
      const transactionResult = await runDatabaseTransaction(
        sql,
        async (transaction: TransactionSql) => {
          const commandAt = now()
          if (!CanonicalUtcTimestampSchema.safeParse(commandAt).success) {
            throw new SessionCommandInvariantError()
          }
          let recovery
          try {
            recovery = await recoveryRepository.recoverSessionForMutation(
              transaction,
              owner,
              sessionId,
              commandAt,
            )
          } catch (error) {
            if (error instanceof ResourceNotFoundError) {
              if (internalAiHooks !== undefined) {
                throw internalAiHooks.sessionFailure('resourceMissing')
              }
              return unregisteredError('SESSION_NOT_FOUND', '场次不存在。')
            }
            throw error
          }
          pointerRepair =
            'pointerRepair' in recovery ? recovery.pointerRepair : null
          if (recovery.kind === 'readonlyDiagnostic') {
            if (internalAiHooks !== undefined) {
              throw internalAiHooks.sessionFailure('stale')
            }
            return unregisteredError(
              'SESSION_READONLY_DIAGNOSTIC',
              '场次当前仅可只读访问。',
            )
          }
          const prepared = await prepareAfterSessionLock({
            transaction,
            recovery,
          })
          if (
            prepared.command.sessionId !== sessionId ||
            !handlers.has(prepared.command.type) ||
            (internalAiHooks === undefined &&
              prepared.command.type === 'aiAction') ||
            (internalAiHooks !== undefined &&
              prepared.command.type !== 'aiAction')
          ) {
            throw new SessionCommandCompositionError()
          }
          if (recovery.kind === 'ended') {
            if (recovery.session.nextEventSeq === 0) {
              throw new SessionCommandInvariantError()
            }
            const replay = replayResult(
              await ledger.readExistingCommandResult(
                transaction,
                owner,
                prepared,
              ),
            )
            if (internalAiHooks !== undefined) {
              if (replay.kind !== 'completed') {
                throw internalAiHooks.sessionFailure('stale')
              }
              await internalAiHooks.verifyReplay({
                transaction,
                prepared,
                response: replay.response,
              })
            }
            return replay
          }
          const lastCommittedEventSeq = recovery.locked.nextEventSeq - 1
          if (lastCommittedEventSeq < 0) {
            throw new SessionCommandInvariantError()
          }
          const registration = await ledger.registerCommand(
            transaction,
            owner,
            prepared,
          )
          if (registration.status !== 'acquired') {
            const replay = replayResult(registration)
            if (internalAiHooks !== undefined) {
              if (replay.kind !== 'completed') {
                throw internalAiHooks.sessionFailure('stale')
              }
              await internalAiHooks.verifyReplay({
                transaction,
                prepared,
                response: replay.response,
              })
            }
            return replay
          }
          const commitCapability =
            internalAiHooks === undefined
              ? null
              : await internalAiHooks.verifyBeforeAction({
                  transaction,
                  recovery,
                  prepared,
                  registration,
                })
          if (
            prepared.command.expectedStateVersion !==
            recovery.locked.stateVersion
          ) {
            if (internalAiHooks !== undefined) {
              throw internalAiHooks.sessionFailure('stale')
            }
            const latestSnapshot = await projectLatestSnapshot(
              transaction,
              snapshotProjectorBinding,
              prepared,
              recovery.state,
              recovery.session,
              lastCommittedEventSeq,
            )
            const response = parseStableSessionCommandErrorResponse({
              code: 'STATE_VERSION_CONFLICT',
              message: '场次状态已变化。',
              latestSnapshot,
            })
            await ledger.failCommand(transaction, registration, response)
            return deepFreeze({
              kind: 'rejected',
              origin: 'ledgerCommit',
              response,
            })
          }

          const binding = handlers.get(prepared.command.type)
          const readLifetime: PortLifetime = { active: true }
          const reads = createGuardedPort(
            binding.bindReadPort(transaction),
            readLifetime,
          )
          let preparedResult
          try {
            preparedResult = await binding.handler.prepare({
              command: prepared.command,
              state: recovery.state,
              session: recovery.session,
              reads,
            })
          } finally {
            readLifetime.active = false
          }
          if (preparedResult.kind === 'rejected') {
            if (internalAiHooks !== undefined) {
              throw internalAiHooks.sessionFailure('persistenceRejected')
            }
            const rejection = parseStableCommandRejection(
              preparedResult.rejection,
              { command: prepared.command, state: recovery.state },
            )
            if (rejection === null) {
              throw new SessionCommandInvariantError()
            }
            const latestSnapshot = await projectLatestSnapshot(
              transaction,
              snapshotProjectorBinding,
              prepared,
              recovery.state,
              recovery.session,
              lastCommittedEventSeq,
            )
            const response = parseStableSessionCommandErrorResponse(
              mapCommandRejectionToErrorResponse(rejection, latestSnapshot),
            )
            await ledger.failCommand(transaction, registration, response)
            return deepFreeze({
              kind: 'rejected',
              origin: 'ledgerCommit',
              response,
            })
          }

          if (
            typeof preparedResult.mutation !== 'object' ||
            preparedResult.mutation === null ||
            !('relationPlan' in preparedResult.mutation)
          ) {
            throw new SessionCommandInvariantError()
          }
          const parsedCandidate = PreparedCandidateSchema.safeParse(
            preparedResult.mutation,
          )
          if (!parsedCandidate.success) {
            throw new SessionCommandInvariantError()
          }
          const candidate = parsedCandidate.data
          const finalStateVersion =
            candidate.stateEffect.kind === 'stateChanged'
              ? Number(BigInt(recovery.locked.stateVersion) + 1n)
              : recovery.locked.stateVersion
          if (!Number.isSafeInteger(finalStateVersion)) {
            throw new SessionCommandInvariantError()
          }
          const finalState =
            candidate.stateEffect.kind === 'stateChanged'
              ? createPrivateTableState({
                  stateVersion: finalStateVersion,
                  ...createPrivateTableStateContent(
                    candidate.stateEffect.stateContent,
                  ),
                })
              : recovery.state
          const hasBothPointers =
            candidate.playerCoordinationAfter.activePlayerRunId !== null &&
            candidate.playerCoordinationAfter.activeDecisionRequestId !== null
          const hasNeitherPointer =
            candidate.playerCoordinationAfter.activePlayerRunId === null &&
            candidate.playerCoordinationAfter.activeDecisionRequestId === null
          const validCoordination =
            candidate.playerCoordinationAfter.agentRunState === 'thinking'
              ? hasBothPointers
              : hasNeitherPointer
          const expectedHandId =
            finalState.poker.pokerPhase === 'inHand'
              ? (finalState.poker.hand?.handId ?? null)
              : null
          if (
            !Array.isArray(candidate.privateEventDrafts) ||
            candidate.privateEventDrafts.length === 0 ||
            !isDeepFrozen(candidate.relationPlan) ||
            !validCoordination ||
            candidate.currentHandIdAfter?.toLowerCase() !==
              expectedHandId?.toLowerCase() ||
            (candidate.stateEffect.kind === 'stateUnchanged' &&
              candidate.currentHandIdAfter?.toLowerCase() !==
                recovery.locked.currentHandId?.toLowerCase()) ||
            (candidate.lifecycleAfter === 'ended' &&
              (candidate.currentHandIdAfter !== null ||
                candidate.playerCoordinationAfter.agentRunState !== 'idle' ||
                !hasNeitherPointer))
          ) {
            throw new SessionCommandInvariantError()
          }

          const privateEventDrafts = candidate.privateEventDrafts.map((draft) =>
            mutationRepository.currentPrivateEventProtocol.parseDraft(draft),
          )
          if (
            !isCommandMutationConsistent({
              command: prepared.command,
              sessionBefore: {
                lifecycleStatus: 'active',
                currentHandId: recovery.session.currentHandId,
                agentRunState: recovery.session.agentRunState,
                activePlayerRunId: recovery.session.activePlayerRunId,
                activeDecisionRequestId:
                  recovery.session.activeDecisionRequestId,
              },
              stateEffectKind: candidate.stateEffect.kind,
              stateBefore: recovery.state,
              stateAfter: finalState,
              lifecycleAfter: candidate.lifecycleAfter,
              currentHandIdAfter: candidate.currentHandIdAfter,
              playerCoordinationAfter: candidate.playerCoordinationAfter,
              events: privateEventDrafts,
              relationPlan: candidate.relationPlan,
            })
          ) {
            throw new SessionCommandInvariantError()
          }
          const nextEventSeq =
            BigInt(recovery.locked.nextEventSeq) +
            BigInt(privateEventDrafts.length)
          if (nextEventSeq > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new SessionCommandInvariantError()
          }
          const finalEventSeq = Number(nextEventSeq - 1n)
          const projectedSession = {
            ...recovery.session,
            lifecycleStatus: candidate.lifecycleAfter,
            stateVersion: finalStateVersion,
            nextEventSeq: Number(nextEventSeq),
            currentHandId: candidate.currentHandIdAfter,
            ...candidate.playerCoordinationAfter,
          }
          const projectorLifetime: PortLifetime = { active: true }
          const projectionReads = createGuardedPort(
            snapshotProjectorBinding.bindReadPort(transaction),
            projectorLifetime,
          )
          let finalSnapshot
          try {
            finalSnapshot = PublicSessionSnapshotSchema.parse(
              await snapshotProjectorBinding.projector.project({
                command: prepared.command,
                state: finalState,
                session: projectedSession,
                eventSeq: finalEventSeq,
                newPrivateEvents: privateEventDrafts,
                reads: projectionReads,
              }),
            )
          } finally {
            projectorLifetime.active = false
          }
          if (
            finalSnapshot.stateVersion !== finalStateVersion ||
            finalSnapshot.eventSeq !== finalEventSeq ||
            finalSnapshot.lifecycleStatus !== candidate.lifecycleAfter ||
            finalSnapshot.agentRunState !==
              candidate.playerCoordinationAfter.agentRunState
          ) {
            throw new SessionCommandInvariantError()
          }

          const eventIds = new Set<string>()
          const mutationEvents = privateEventDrafts.map((draft, index) => {
            const eventId = nextEventId().toLowerCase()
            if (eventIds.has(eventId)) {
              throw new SessionCommandInvariantError()
            }
            eventIds.add(eventId)
            const eventSeq = recovery.locked.nextEventSeq + index
            const publicSnapshot = PublicSessionSnapshotSchema.safeParse({
              ...finalSnapshot,
              eventSeq,
            })
            if (!publicSnapshot.success) {
              throw new SessionCommandInvariantError()
            }
            const publicEvent = SseEventSchema.safeParse({
              eventId,
              sessionId: recovery.locked.sessionId,
              eventSeq,
              stateVersion: finalStateVersion,
              type: draft.type,
              payload: { snapshot: publicSnapshot.data },
            })
            if (!publicEvent.success) {
              throw new SessionCommandInvariantError()
            }
            return deepFreeze({
              eventId,
              eventSeq,
              handId: getPrivateEventHandId(draft),
              commandLedgerId: registration.ledgerId,
              stateVersionBefore: recovery.locked.stateVersion,
              stateVersionAfter: finalStateVersion,
              privateEvent:
                mutationRepository.currentPrivateEventProtocol.encodeCurrent(
                  draft,
                ),
              publicEvent: publicEvent.data,
              createdAt: commandAt,
            })
          })
          const response = CommandResponseSchema.parse({
            snapshot: finalSnapshot,
          })
          const mutationBatch = deepFreeze({
            finalStateVersion,
            lifecycleStatus: candidate.lifecycleAfter,
            currentHandId: candidate.currentHandIdAfter,
            ...candidate.playerCoordinationAfter,
            snapshot:
              candidate.stateEffect.kind === 'stateChanged'
                ? encodeSnapshot(finalState)
                : null,
            events: mutationEvents,
            mutationAt: commandAt,
          })

          mutationRepository.validateSessionMutation(
            transaction,
            recovery.locked,
            mutationBatch,
          )

          const writeLifetime: PortLifetime = { active: true }
          const writes = createGuardedPort(
            binding.bindWritePort(transaction),
            writeLifetime,
          )
          const capability = createPreparedMutationCapability(
            transaction,
            prepared.command,
            binding.handler,
            candidate.relationPlan,
          )
          consumePreparedMutationCapability(
            transaction,
            prepared.command,
            binding.handler,
            capability,
          )
          try {
            await binding.handler.applyRelations(
              { writes, commandAt },
              capability,
            )
          } finally {
            writeLifetime.active = false
          }
          const persisted = await mutationRepository.persistSessionMutation(
            transaction,
            recovery.locked,
            mutationBatch,
          )
          await ledger.completeCommand(transaction, registration, response, {
            firstEventSeq: persisted.firstEventSeq,
            lastEventSeq: persisted.lastEventSeq,
          })
          if (internalAiHooks !== undefined) {
            await internalAiHooks.completeAfterLedger({
              transaction,
              recovery,
              prepared,
              registration,
              commitCapability,
              response,
            })
          }
          const newlyPersistedEvents = persisted.events.map((event) =>
            SseEventSchema.parse(event),
          )
          if (newlyPersistedEvents.length === 0) {
            throw new SessionCommandInvariantError()
          }
          return deepFreeze({
            kind: 'completed',
            origin: 'newCommit',
            response,
            newlyPersistedEvents: newlyPersistedEvents as [
              SseEvent,
              ...SseEvent[],
            ],
          })
        },
      )
      executionResult = transactionResult as SessionCommandExecutionResult
      if (pointerRepair !== null && logPointerRepair !== undefined) {
        try {
          logPointerRepair(pointerRepair)
        } catch {
          // 提交后诊断日志不改变命令结果。
        }
      }
      if (
        executionResult.kind === 'completed' &&
        executionResult.origin === 'newCommit'
      ) {
        try {
          committedEventPublisher.publish(executionResult.newlyPersistedEvents)
        } catch {
          try {
            logPublishFailure?.({
              eventCount: executionResult.newlyPersistedEvents.length,
              firstEventSeq: executionResult.newlyPersistedEvents[0].eventSeq,
              lastEventSeq:
                executionResult.newlyPersistedEvents.at(-1)!.eventSeq,
            })
          } catch {
            // 提交后诊断日志不改变命令结果。
          }
        }
        try {
          playerTurnHintPort?.notify(
            executionResult.newlyPersistedEvents[0].sessionId,
          )
        } catch {
          // The committed Session state is the scheduling source of truth.
        }
      }
      return deepFreeze(executionResult)
    })
  }

  const commands: SessionCommandExecutor = Object.freeze({
    async execute(commandInput: unknown) {
      const prepared = prepareCommandRegistration(commandInput)
      return executePrepared(prepared.command.sessionId, async () => prepared)
    },
  })
  const aiActionCommitExecutor: InternalAiActionCommitExecutor = Object.freeze({
    async execute(input: InternalAiActionExecutionInput) {
      if (
        typeof input !== 'object' ||
        input === null ||
        typeof input.sessionId !== 'string' ||
        typeof input.hooks?.prepareAfterSessionLock !== 'function' ||
        typeof input.hooks?.sessionFailure !== 'function' ||
        typeof input.hooks?.verifyBeforeAction !== 'function' ||
        typeof input.hooks.completeAfterLedger !== 'function' ||
        typeof input.hooks.verifyReplay !== 'function'
      ) {
        throw new SessionCommandCompositionError()
      }
      return executePrepared(
        input.sessionId,
        input.hooks.prepareAfterSessionLock,
        input.hooks,
      )
    },
  })
  return Object.freeze({ commands, aiActionCommitExecutor })
}

/**
 * 创建对 HTTP/普通服务公开的命令入口。
 *
 * 私有 aiAction 只能由 `createPlayerCommitSessionComposition()` 组合成
 * Player Commit Gate；普通命令组合不拥有该内部执行能力。
 */
export function createSessionCommandExecutor(
  input: SessionCommandExecutorDependencies,
): SessionCommandExecutor {
  return createSessionCommandExecutorWithInternalAiAction(input).commands
}

/**
 * M4.7 的唯一组合入口。
 *
 * 不向调用方返回可注入 hooks 的事务端口：其产物只有公开 Session 命令入口
 * 和只接受认证 authority/result 的 Player Commit Gate。这样服务端模块即使
 * 能取得组合结果，也无法自行拼装 aiAction、跳过实时复验或省略成功终结。
 */
export interface PlayerCommitSessionCompositionDependencies {
  readonly session: SessionCommandExecutorDependencies
  readonly player: {
    readonly runEventPort: AgentRunEventPort
    readonly logPublishFailure?: (input: {
      readonly kind: 'agentRunCompleted'
      readonly runId: string
    }) => void
  }
}

export interface PlayerCommitSessionComposition {
  readonly commands: SessionCommandExecutor
  readonly playerCommitGate: PlayerCommitGate
}

export function createPlayerCommitSessionComposition(
  input: PlayerCommitSessionCompositionDependencies,
): PlayerCommitSessionComposition {
  const aiHandlers = createSessionCommandHandlerMap({
    bindings: [createAiActionHandlerBinding({ owner: input.session.owner })],
  })
  if (input.session.handlers.has('aiAction')) {
    throw new SessionCommandCompositionError()
  }
  const handlers: SessionCommandHandlerMap = Object.freeze({
    has: (commandType: LedgerCommand['type']) =>
      aiHandlers.has(commandType) || input.session.handlers.has(commandType),
    get: (commandType: LedgerCommand['type']) =>
      aiHandlers.has(commandType)
        ? aiHandlers.get(commandType)
        : input.session.handlers.get(commandType),
  })
  const internal = createSessionCommandExecutorWithInternalAiAction({
    ...input.session,
    handlers,
  })
  return Object.freeze({
    commands: internal.commands,
    playerCommitGate: createPlayerCommitGate({
      ...input.player,
      owner: input.session.owner,
      aiActionCommitExecutor: internal.aiActionCommitExecutor,
    }),
  })
}
