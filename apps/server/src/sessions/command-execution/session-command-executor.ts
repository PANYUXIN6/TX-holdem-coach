import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
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
  prepareCommandRegistration,
  readExistingCommandResult,
  registerCommand,
  type AcquiredCommandRegistration,
  type ExistingCommandResult,
  type PreparedCommandRegistration,
} from '../../persistence/command-ledger-repository.js'
import { ResourceNotFoundError } from '../../persistence/errors.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { SessionMutationRepository } from '../../persistence/session-mutation-repository.js'
import type { SessionRecoveryRepository } from '../../persistence/session-recovery-repository.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import type { RecoveryRegistries } from '../authoritative-state/recovery-decision.js'
import {
  createPrivateTableState,
  createPrivateTableStateContent,
} from '../authoritative-state/private-table-state.js'
import { encodeSnapshotV1 } from '../authoritative-state/snapshot-codec-v1.js'
import { getPrivateEventHandId } from '../authoritative-state/private-event-v2.js'
import { isCommandMutationConsistent } from './command-event-policy.js'
import {
  consumePreparedMutationCapability,
  createGuardedPort,
  createPreparedMutationCapability,
  type PortLifetime,
} from './command-handler.js'
import {
  SessionCommandCompositionError,
  type SessionCommandHandlerMap,
} from './command-handler-map.js'
import { createPerSessionScheduler } from './per-session-scheduler.js'
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

export type StableSessionCommandErrorCode =
  | StableCommandRejectionCode
  | 'SESSION_NOT_FOUND'
  | 'STATE_VERSION_CONFLICT'
  | 'COMMAND_ID_CONFLICT'
  | 'SESSION_ENDED'
  | 'SESSION_READONLY_DIAGNOSTIC'

export type StableSessionCommandErrorResponse = ErrorResponse & {
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
  | { readonly kind: 'processing' }

interface CommandLedgerRepositoryPort {
  registerCommand: typeof registerCommand
  readExistingCommandResult: typeof readExistingCommandResult
  completeCommand: typeof completeCommand
  failCommand: typeof failCommand
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
    case 'processing':
      return Object.freeze({ kind: 'processing' })
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
      protocolVersion: 1,
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

export function createSessionCommandExecutor(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly handlers: SessionCommandHandlerMap
  readonly mutationRepository: SessionMutationRepository
  readonly recoveryRepository: SessionRecoveryRepository
  readonly recoveryRegistries: RecoveryRegistries
  readonly commandLedgerRepository?: CommandLedgerRepositoryPort
  readonly snapshotProjectorBinding: SnapshotProjectorBinding
  readonly now: () => string
  readonly nextEventId: () => string
  readonly logPointerRepair?: (repair: unknown) => void
  readonly committedEventPublisher?: CommittedSessionEventPublisher
  readonly logPublishFailure?: (input: {
    readonly eventCount: number
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  }) => void
}): SessionCommandExecutor {
  const {
    sql,
    owner,
    handlers,
    mutationRepository,
    recoveryRepository,
    recoveryRegistries,
    commandLedgerRepository,
    snapshotProjectorBinding,
    now,
    nextEventId,
    logPointerRepair,
    committedEventPublisher,
    logPublishFailure,
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

  return Object.freeze({
    async execute(commandInput: unknown) {
      const prepared = prepareCommandRegistration(commandInput)
      if (!handlers.has(prepared.command.type)) {
        throw new SessionCommandCompositionError()
      }
      return scheduler.run(prepared.command.sessionId, async () => {
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
                prepared.command.sessionId,
                commandAt,
                recoveryRegistries,
              )
            } catch (error) {
              if (error instanceof ResourceNotFoundError) {
                return unregisteredError('SESSION_NOT_FOUND', '场次不存在。')
              }
              throw error
            }
            pointerRepair =
              'pointerRepair' in recovery ? recovery.pointerRepair : null
            if (recovery.kind === 'readonlyDiagnostic') {
              return unregisteredError(
                'SESSION_READONLY_DIAGNOSTIC',
                '场次当前仅可只读访问。',
              )
            }
            if (recovery.kind === 'ended') {
              if (recovery.session.nextEventSeq === 0) {
                throw new SessionCommandInvariantError()
              }
              return replayResult(
                await ledger.readExistingCommandResult(
                  transaction,
                  owner,
                  prepared,
                ),
              )
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
              return replayResult(registration)
            }
            if (
              prepared.command.expectedStateVersion !==
              recovery.locked.stateVersion
            ) {
              const latestSnapshot = await projectLatestSnapshot(
                transaction,
                snapshotProjectorBinding,
                prepared,
                recovery.state,
                recovery.session,
                lastCommittedEventSeq,
              )
              const response = parseStableSessionCommandErrorResponse({
                protocolVersion: 1,
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

            const privateEventDrafts = candidate.privateEventDrafts.map(
              (draft) =>
                mutationRepository.currentPrivateEventProtocol.parseDraft(
                  draft,
                ),
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
                protocolVersion: 1,
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
              protocolVersion: 1,
              snapshot: finalSnapshot,
            })
            const mutationBatch = deepFreeze({
              finalStateVersion,
              lifecycleStatus: candidate.lifecycleAfter,
              currentHandId: candidate.currentHandIdAfter,
              ...candidate.playerCoordinationAfter,
              snapshot:
                candidate.stateEffect.kind === 'stateChanged'
                  ? encodeSnapshotV1(finalState)
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
          executionResult.origin === 'newCommit' &&
          committedEventPublisher !== undefined
        ) {
          try {
            committedEventPublisher.publish(
              executionResult.newlyPersistedEvents,
            )
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
        }
        return deepFreeze(executionResult)
      })
    },
  })
}
