import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Sql, TransactionSql } from 'postgres'
import { SseEventSchema, type SseEvent } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import type { AgentRunCoordinator } from '../foundation/agent-run-coordinator.js'
import { createRunConfigurationSnapshot } from '../foundation/agent-run-coordinator.js'
import type {
  AgentRunEventPort,
  RuntimeCommitAuthority,
} from '../foundation/runtime-ports.js'
import type { RuntimeRegistry } from '../foundation/runtime-registry.js'
import type {
  PersistedAgentRun,
  PersistedAgentRunEffect,
} from '../foundation/agent-run-types.js'
import type { AuditVersionReference } from '../audit/audit-primitives.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import {
  createAgentRunLifecycleRepository,
  type AgentRunLifecycleRepository,
} from '../../persistence/agent-run-lifecycle-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import {
  createPlayerDecisionRepository,
  type PlayerDecisionRepository,
} from '../../persistence/player-decision-repository.js'
import {
  createAgentFoundationAuditRepository,
  type AgentFoundationAuditRepository,
  type BudgetedAttemptStartInput,
  type BudgetedAttemptStartResult,
} from '../../persistence/agent-foundation-audit-repository.js'
import {
  productionSessionRecoveryRepository,
  type ReadySessionRecovery,
  type SessionRecoveryRepository,
} from '../../persistence/session-recovery-repository.js'
import type { LockedSessionView } from '../../persistence/session-mutation-repository.js'
import type { SessionMutationRepository } from '../../persistence/session-mutation-repository.js'
import { createTransactionPublicProjectionReadPort } from '../../persistence/public-projection-repository.js'
import {
  createPrivateEvent,
  getPrivateEventHandId,
  type PlayerPauseReason,
  type PrivateEvent,
} from '../../sessions/authoritative-state/private-event.js'
import { projectPublicSessionSnapshot } from '../../sessions/public-projection/public-session-projector.js'
import type { CommittedSessionEventPublisher } from '../../sessions/public-projection/committed-session-event-hub.js'
import type { StrategyPackRepository } from '../../poker-strategy/strategy-pack-repository.js'
import { readPinnedStrategyPackReference } from './player-strategy-pack-audit-reference.js'
import type { PlayerStaleReason } from './player-execution-settlement.js'

const CanonicalTimestampSchema = z.iso.datetime({ precision: 3 })

export interface PlayerCoordinationEffects {
  readonly sessionEvents: readonly SseEvent[]
  readonly runEffects: readonly PersistedAgentRunEffect[]
  readonly queuedRunId: string | null
}

export type CoordinationResult =
  | { readonly kind: 'started'; readonly effects: PlayerCoordinationEffects }
  | { readonly kind: 'paused'; readonly effects: PlayerCoordinationEffects }
  | {
      readonly kind: 'replacementQueued'
      readonly effects: PlayerCoordinationEffects
    }
  | {
      readonly kind: 'alreadyPaused'
      readonly effects: PlayerCoordinationEffects
    }
  | {
      readonly kind: 'alreadyActive'
      readonly effects: PlayerCoordinationEffects
    }
  | { readonly kind: 'noTarget'; readonly effects: PlayerCoordinationEffects }
  | {
      readonly kind: 'newAuthorityActive'
      readonly effects: PlayerCoordinationEffects
    }

export interface StartPlayerDecisionInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly actorParticipantId: string
  readonly actorSeatNumber: number
  readonly idempotencyKey: string
  readonly dataDependencies: readonly AuditVersionReference[]
  readonly createdAt: string
  readonly trigger: 'initial' | 'manualRetry'
  readonly supersedesRunId: string | null
  readonly commandLedgerId: string | null
}

export interface PlayerFailureSettlementInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly reason: PlayerPauseReason
  readonly settledAt: string
}

export interface PlayerStaleSettlementInput {
  readonly sessionId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly reason: PlayerStaleReason
  readonly replacementRunId: string
  readonly replacementDecisionRequestId: string
  readonly replacementIdempotencyKey: string
  readonly settledAt: string
}

export interface PlayerCorrectionAttemptInput extends BudgetedAttemptStartInput {
  readonly decisionRequestId: string
  readonly attemptAt: string
  readonly authority: RuntimeCommitAuthority<'player'>
}

export type PlayerProcessRestartRecoveryResult =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'paused' }
  | {
      readonly kind: 'reconciledWithoutReplacement'
      readonly newlyPersistedEvents: readonly SseEvent[]
    }
  | {
      readonly kind: 'replacementQueued'
      readonly replacementRunId: string
      readonly newlyPersistedEvents: readonly [SseEvent, ...SseEvent[]]
    }

export interface PlayerProcessRestartRecoveryInput {
  readonly owner: ResolvedOwnerScope
  readonly recovery: ReadySessionRecovery
  readonly recoveryAt: string
}

export interface PlayerProcessRestartRecoveryPort {
  recoverAfterProcessRestart(
    transaction: TransactionSql,
    input: PlayerProcessRestartRecoveryInput,
  ): Promise<PlayerProcessRestartRecoveryResult>
}

/**
 * 仅供拥有外层事务的启动组合层使用。调用方必须先严格解码 `recovery` 并
 * 成功提交事务，才能发布 `runEffects`。
 */
export interface PlayerProcessRestartRecoveryTransactionResult {
  readonly recovery: PlayerProcessRestartRecoveryResult
  readonly runEffects: readonly PersistedAgentRunEffect[]
}

export interface PlayerProcessRestartRecoveryCompositionPort {
  recoverAfterProcessRestartWithEffects(
    transaction: TransactionSql,
    input: PlayerProcessRestartRecoveryInput,
  ): Promise<PlayerProcessRestartRecoveryTransactionResult>
  /** 仅能在承载重启恢复的外层事务成功提交后调用。 */
  publishCommittedRestartRunEffects(
    runEffects: readonly PersistedAgentRunEffect[],
  ): Promise<void>
}

export interface SessionAgentCoordinator {
  startIfNeeded(input: StartPlayerDecisionInput): Promise<CoordinationResult>
  pauseAfterFailure(
    input: PlayerFailureSettlementInput,
  ): Promise<CoordinationResult>
  reconcileStale(input: PlayerStaleSettlementInput): Promise<CoordinationResult>
  startCorrectionAttempt(
    input: PlayerCorrectionAttemptInput,
  ): Promise<BudgetedAttemptStartResult>
  recoverAfterProcessRestart: PlayerProcessRestartRecoveryPort['recoverAfterProcessRestart']
}

export interface SessionAgentCoordinatorDependencies {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly registry: RuntimeRegistry
  readonly runCoordinator: AgentRunCoordinator
  readonly recoveryRepository?: SessionRecoveryRepository
  readonly runRepository?: AgentRunLifecycleRepository
  readonly decisionRepository?: PlayerDecisionRepository
  readonly foundationRepository?: AgentFoundationAuditRepository
  readonly strategyPackRepository: StrategyPackRepository
  readonly runEventPort: AgentRunEventPort
  readonly sessionEventPublisher?: CommittedSessionEventPublisher
  readonly nextRunId?: () => string
  readonly nextDecisionRequestId?: () => string
  readonly nextIdempotencyKey?: () => string
}

function noEffects(): PlayerCoordinationEffects {
  return Object.freeze({
    sessionEvents: Object.freeze([]),
    runEffects: Object.freeze([]),
    queuedRunId: null,
  })
}

function freezeEffects(
  input: PlayerCoordinationEffects,
): PlayerCoordinationEffects {
  return Object.freeze({
    sessionEvents: Object.freeze([...input.sessionEvents]),
    runEffects: Object.freeze([...input.runEffects]),
    queuedRunId: input.queuedRunId,
  })
}

function assertTimestamp(value: string): void {
  if (!CanonicalTimestampSchema.safeParse(value).success) {
    throw new TypeError('Player 协调时间戳无效。')
  }
}

class PlayerReplacementDependencyUnavailableError extends Error {
  public constructor() {
    super('Player replacement 的精确依赖不可用。')
    this.name = 'PlayerReplacementDependencyUnavailableError'
  }
}

function sameUuid(left: string | null, right: string | null): boolean {
  return (
    left !== null &&
    right !== null &&
    left.toLowerCase() === right.toLowerCase()
  )
}

function getCurrentAiTurn(recovery: ReadySessionRecovery): {
  readonly actorSeatNumber: number
  readonly actorParticipantId: string
  readonly handId: string
  readonly sourceStateVersion: number
} | null {
  const hand = recovery.state.poker.hand
  const actorSeatNumber = hand?.currentActorSeatNumber
  if (
    recovery.session.lifecycleStatus === 'active' &&
    recovery.state.poker.pokerPhase === 'inHand' &&
    hand !== null &&
    typeof actorSeatNumber === 'number' &&
    actorSeatNumber >= 1 &&
    actorSeatNumber <= 8
  ) {
    const actor = recovery.state.poker.seats.find(
      (seat) => seat.seatNumber === actorSeatNumber && !seat.isUser,
    )
    if (actor !== undefined) {
      return Object.freeze({
        actorSeatNumber,
        actorParticipantId: actor.playerId,
        handId: hand.handId,
        sourceStateVersion: recovery.state.stateVersion,
      })
    }
  }
  return null
}

function assertExactReplacementConfiguration(
  registry: RuntimeRegistry,
  strategyPackRepository: StrategyPackRepository,
  predecessor: PersistedAgentRun<'player'>,
): void {
  let definition
  try {
    definition = registry.resolveExact(
      'player',
      predecessor.runtimeDefinitionVersion,
    )
  } catch {
    throw new PlayerReplacementDependencyUnavailableError()
  }
  if (
    !isDeepStrictEqual(
      createRunConfigurationSnapshot(
        definition,
        predecessor.runConfiguration.dataDependencies,
      ),
      predecessor.runConfiguration,
    )
  ) {
    throw new PlayerReplacementDependencyUnavailableError()
  }
  try {
    strategyPackRepository.read({
      reference: readPinnedStrategyPackReference(
        predecessor.runConfiguration.dataDependencies,
      ),
      usage: 'pinnedRun',
    })
  } catch {
    throw new PlayerReplacementDependencyUnavailableError()
  }
}

function createRunEffect(
  run: PersistedAgentRun<'player'>,
  kind: 'queued' | 'failed' | 'cancelled' | 'stale',
): PersistedAgentRunEffect {
  return Object.freeze({
    runtimeType: 'player' as const,
    runId: run.runId,
    event: Object.freeze({
      runtimeType: 'player' as const,
      kind,
      runId: run.runId,
    }),
  })
}

function asProjectedSession(input: {
  readonly recovery: ReadySessionRecovery
  readonly agentRunState: 'idle' | 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
  readonly nextEventSeq: number
}): LockedSessionView {
  return Object.freeze({
    ...input.recovery.session,
    agentRunState: input.agentRunState,
    activePlayerRunId: input.activePlayerRunId,
    activeDecisionRequestId: input.activeDecisionRequestId,
    nextEventSeq: input.nextEventSeq,
  })
}

async function persistCoordinationEvents(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly recovery: ReadySessionRecovery
  readonly mutationRepository: SessionMutationRepository
  readonly agentRunState: 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
  readonly eventDrafts: readonly PrivateEvent[]
  readonly commandLedgerId: string | null
  readonly mutationAt: string
}): Promise<readonly SseEvent[]> {
  if (
    input.eventDrafts.length === 0 ||
    (input.agentRunState === 'thinking') !==
      (input.activePlayerRunId !== null &&
        input.activeDecisionRequestId !== null)
  ) {
    throw new TypeError('Player 协调事件输入无效。')
  }
  const nextEventSeq =
    input.recovery.locked.nextEventSeq + input.eventDrafts.length
  if (!Number.isSafeInteger(nextEventSeq)) {
    throw new TypeError('Player 协调事件序号溢出。')
  }
  const finalEventSeq = nextEventSeq - 1
  const projectedSession = asProjectedSession({
    recovery: input.recovery,
    agentRunState: input.agentRunState,
    activePlayerRunId: input.activePlayerRunId,
    activeDecisionRequestId: input.activeDecisionRequestId,
    nextEventSeq,
  })
  const reads = createTransactionPublicProjectionReadPort(
    input.transaction,
    input.owner,
  )
  const firstNewEventSeq = finalEventSeq - input.eventDrafts.length + 1
  const roster = await reads.readRoster(projectedSession.sessionId)
  const committedCurrentHandEvents =
    projectedSession.currentHandId === null
      ? []
      : await reads.readCurrentHandEvents({
          sessionId: projectedSession.sessionId,
          handId: projectedSession.currentHandId,
          beforeEventSeq: firstNewEventSeq,
        })
  const finalSnapshot = projectPublicSessionSnapshot({
    state: input.recovery.state,
    session: projectedSession,
    eventSeq: finalEventSeq,
    newPrivateEvents: input.eventDrafts,
    roster,
    committedCurrentHandEvents,
  })
  const events = input.eventDrafts.map((draft, index) => {
    const eventSeq = input.recovery.locked.nextEventSeq + index
    const publicEvent = SseEventSchema.parse({
      eventId: randomUUID(),
      sessionId: input.recovery.locked.sessionId,
      eventSeq,
      stateVersion: input.recovery.locked.stateVersion,
      type: draft.type,
      payload: {
        snapshot: { ...finalSnapshot, eventSeq },
      },
    })
    return Object.freeze({
      eventId: publicEvent.eventId,
      eventSeq,
      handId: getPrivateEventHandId(draft),
      commandLedgerId: input.commandLedgerId,
      stateVersionBefore: input.recovery.locked.stateVersion,
      stateVersionAfter: input.recovery.locked.stateVersion,
      privateEvent:
        input.mutationRepository.currentPrivateEventProtocol.encodeCurrent(
          draft,
        ),
      publicEvent,
      createdAt: input.mutationAt,
    })
  })
  const batch = Object.freeze({
    finalStateVersion: input.recovery.locked.stateVersion,
    lifecycleStatus: 'active' as const,
    currentHandId: input.recovery.locked.currentHandId,
    agentRunState: input.agentRunState,
    activePlayerRunId: input.activePlayerRunId,
    activeDecisionRequestId: input.activeDecisionRequestId,
    snapshot: null,
    events,
    mutationAt: input.mutationAt,
  })
  input.mutationRepository.validateSessionMutation(
    input.transaction,
    input.recovery.locked,
    batch,
  )
  const persisted = await input.mutationRepository.persistSessionMutation(
    input.transaction,
    input.recovery.locked,
    batch,
  )
  return Object.freeze(
    persisted.events.map((event) => SseEventSchema.parse(event)),
  )
}

export function createSessionAgentCoordinator(
  dependencies: SessionAgentCoordinatorDependencies,
): SessionAgentCoordinator & PlayerProcessRestartRecoveryCompositionPort {
  const recoveryRepository =
    dependencies.recoveryRepository ?? productionSessionRecoveryRepository
  const runRepository =
    dependencies.runRepository ?? createAgentRunLifecycleRepository()
  const decisionRepository =
    dependencies.decisionRepository ?? createPlayerDecisionRepository()
  const foundationRepository =
    dependencies.foundationRepository ?? createAgentFoundationAuditRepository()
  const nextRunId = dependencies.nextRunId ?? randomUUID
  const nextDecisionRequestId = dependencies.nextDecisionRequestId ?? randomUUID
  const nextIdempotencyKey = dependencies.nextIdempotencyKey ?? randomUUID
  if (
    typeof dependencies.sql !== 'function' ||
    recoveryRepository === undefined ||
    typeof dependencies.runCoordinator?.createOrReuse !== 'function'
  ) {
    throw new TypeError('Player Session 协调器依赖无效。')
  }
  const mutationRepository = recoveryRepository.sessionMutationRepository

  async function publishBestEffort(
    effects: PlayerCoordinationEffects,
  ): Promise<void> {
    if (
      effects.sessionEvents.length !== 0 &&
      dependencies.sessionEventPublisher !== undefined
    ) {
      try {
        dependencies.sessionEventPublisher.publish(
          effects.sessionEvents as [SseEvent, ...SseEvent[]],
        )
      } catch {
        // Durable session_events are the source of truth; in-memory delivery is a hint.
      }
    }
    if (effects.runEffects.length !== 0) {
      try {
        await dependencies.runEventPort.publish(
          effects.runEffects.map((effect) => effect.event),
        )
      } catch {
        // Durable Run records are the source of truth; process-local delivery is a hint.
      }
    }
  }

  async function createReplacement(input: {
    readonly transaction: TransactionSql
    readonly predecessor: PersistedAgentRun<'player'>
    readonly replacementRunId: string
    readonly decisionRequestId: string
    readonly idempotencyKey: string
    readonly createdAt: string
    readonly triggerType: 'stale_replacement' | 'process_restart'
  }): Promise<{
    readonly run: PersistedAgentRun<'player'>
    readonly effects: readonly PersistedAgentRunEffect[]
  }> {
    assertExactReplacementConfiguration(
      dependencies.registry,
      dependencies.strategyPackRepository,
      input.predecessor,
    )
    const createdAtMilliseconds = Date.parse(input.createdAt)
    const deadlineAt = new Date(
      createdAtMilliseconds + input.predecessor.budget.maxWallClockMs,
    ).toISOString()
    const created = await runRepository.createOrReuse(
      input.transaction,
      dependencies.owner,
      {
        agentRunId: input.replacementRunId,
        runtimeType: 'player',
        sessionId: input.predecessor.sessionId,
        handId: input.predecessor.handId,
        participantId: input.predecessor.participantId,
        sourceStateVersion: input.predecessor.sourceStateVersion,
        decisionRequestId: input.decisionRequestId,
        triggerType: input.triggerType,
        idempotencyKey: input.idempotencyKey,
        parentRunId: input.predecessor.runId,
        deadlineAt,
        runtimeDefinitionVersion: input.predecessor.runtimeDefinitionVersion,
        runConfiguration: input.predecessor.runConfiguration,
        budget: input.predecessor.budget,
        createdAt: input.createdAt,
      },
    )
    if (created.run.runtimeType !== 'player')
      throw new TypeError('Player replacement 类型无效。')
    if (
      !isDeepStrictEqual(
        created.run.runConfiguration,
        input.predecessor.runConfiguration,
      ) ||
      !isDeepStrictEqual(created.run.budget, input.predecessor.budget)
    ) {
      throw new TypeError('Player replacement 配置漂移。')
    }
    await runRepository.linkReplacement(input.transaction, dependencies.owner, {
      predecessorRunId: input.predecessor.runId,
      replacementRunId: created.run.runId,
    })
    return Object.freeze({
      run: created.run,
      effects:
        created.kind === 'created'
          ? Object.freeze([
              Object.freeze({
                runtimeType: 'player' as const,
                runId: created.run.runId,
                event: Object.freeze({
                  runtimeType: 'player' as const,
                  kind: 'queued' as const,
                  runId: created.run.runId,
                }),
              }),
            ])
          : Object.freeze([]),
    })
  }

  async function settleToPaused(input: {
    readonly transaction: TransactionSql
    readonly recovery: ReadySessionRecovery
    readonly run: PersistedAgentRun<'player'>
    readonly actorSeatNumber: number
    readonly decisionRequestId: string
    readonly reason: PlayerPauseReason
    readonly settledAt: string
  }): Promise<PlayerCoordinationEffects> {
    await decisionRepository.markTerminalForCoordination(
      input.transaction,
      dependencies.owner,
      {
        agentRunId: input.run.runId,
        sessionId: input.run.sessionId,
        outcome: 'failed',
        reason: input.reason,
        terminatedAt: input.settledAt,
      },
    )
    const terminatedRun = await runRepository.terminateForCoordination(
      input.transaction,
      dependencies.owner,
      {
        runId: input.run.runId,
        lifecycle: 'failed',
        terminationReason: input.reason,
        completedAt: input.settledAt,
      },
    )
    const event = createPrivateEvent({
      type: 'agentPaused',
      handId: input.run.handId,
      failedAgentRunId: input.run.runId,
      decisionRequestId: input.decisionRequestId,
      actorSeatNumber: input.actorSeatNumber,
      failureCode: input.reason,
    })
    const sessionEvents = await persistCoordinationEvents({
      transaction: input.transaction,
      owner: dependencies.owner,
      recovery: input.recovery,
      mutationRepository,
      agentRunState: 'paused',
      activePlayerRunId: null,
      activeDecisionRequestId: null,
      eventDrafts: [event],
      commandLedgerId: null,
      mutationAt: input.settledAt,
    })
    return freezeEffects({
      sessionEvents,
      runEffects: [createRunEffect(terminatedRun, 'failed')],
      queuedRunId: null,
    })
  }

  async function recoverAfterProcessRestartWithEffects(
    transaction: TransactionSql,
    input: PlayerProcessRestartRecoveryInput,
  ): Promise<PlayerProcessRestartRecoveryTransactionResult> {
    assertTimestamp(input.recoveryAt)
    if (
      input.owner.databaseOwnerId !== dependencies.owner.databaseOwnerId ||
      input.recovery.kind !== 'ready'
    ) {
      throw new TypeError('Player 重启恢复输入无效。')
    }
    const recovered = input.recovery
    if (recovered.session.agentRunState === 'paused') {
      return Object.freeze({
        recovery: Object.freeze({ kind: 'paused' as const }),
        runEffects: Object.freeze([]),
      })
    }
    if (recovered.session.agentRunState !== 'thinking') {
      return Object.freeze({
        recovery: Object.freeze({ kind: 'unchanged' as const }),
        runEffects: Object.freeze([]),
      })
    }
    const currentAiTurn = getCurrentAiTurn(recovered)
    if (
      currentAiTurn === null ||
      recovered.session.activePlayerRunId === null ||
      recovered.session.activeDecisionRequestId === null
    ) {
      return Object.freeze({
        recovery: Object.freeze({ kind: 'unchanged' as const }),
        runEffects: Object.freeze([]),
      })
    }
    const predecessor = await runRepository.lockPlayerRunForCoordination(
      transaction,
      dependencies.owner,
      recovered.session.activePlayerRunId,
    )
    if (
      predecessor.lifecycle === 'completed' ||
      predecessor.lifecycle === 'failed' ||
      predecessor.lifecycle === 'cancelled' ||
      predecessor.lifecycle === 'stale' ||
      predecessor.decisionRequestId !==
        recovered.session.activeDecisionRequestId ||
      predecessor.handId !== currentAiTurn.handId ||
      predecessor.participantId !== currentAiTurn.actorParticipantId ||
      predecessor.sourceStateVersion !== currentAiTurn.sourceStateVersion
    ) {
      return Object.freeze({
        recovery: Object.freeze({ kind: 'unchanged' as const }),
        runEffects: Object.freeze([]),
      })
    }
    try {
      assertExactReplacementConfiguration(
        dependencies.registry,
        dependencies.strategyPackRepository,
        predecessor,
      )
    } catch {
      const effects = await settleToPaused({
        transaction,
        recovery: recovered,
        run: predecessor,
        actorSeatNumber: currentAiTurn.actorSeatNumber,
        decisionRequestId: predecessor.decisionRequestId,
        reason: 'player_dependency_unavailable',
        settledAt: input.recoveryAt,
      })
      return Object.freeze({
        recovery: Object.freeze({
          kind: 'reconciledWithoutReplacement' as const,
          newlyPersistedEvents: effects.sessionEvents,
        }),
        runEffects: effects.runEffects,
      })
    }
    await decisionRepository.markTerminalForCoordination(
      transaction,
      dependencies.owner,
      {
        agentRunId: predecessor.runId,
        sessionId: predecessor.sessionId,
        outcome: 'stale',
        reason: 'process_restart',
        terminatedAt: input.recoveryAt,
      },
    )
    const terminatedRun = await runRepository.terminateForCoordination(
      transaction,
      dependencies.owner,
      {
        runId: predecessor.runId,
        lifecycle: 'cancelled',
        terminationReason: 'process_restart',
        completedAt: input.recoveryAt,
      },
    )
    const replacement = await createReplacement({
      transaction,
      predecessor,
      replacementRunId: nextRunId(),
      decisionRequestId: nextDecisionRequestId(),
      idempotencyKey: nextIdempotencyKey(),
      createdAt: input.recoveryAt,
      triggerType: 'process_restart',
    })
    const event = createPrivateEvent({
      type: 'agentStarted',
      handId: replacement.run.handId,
      agentRunId: replacement.run.runId,
      decisionRequestId: replacement.run.decisionRequestId,
      actorSeatNumber: currentAiTurn.actorSeatNumber,
      trigger: 'processRestartReplacement',
      supersedesRunId: predecessor.runId,
    })
    const sessionEvents = await persistCoordinationEvents({
      transaction,
      owner: dependencies.owner,
      recovery: recovered,
      mutationRepository,
      agentRunState: 'thinking',
      activePlayerRunId: replacement.run.runId,
      activeDecisionRequestId: replacement.run.decisionRequestId,
      eventDrafts: [event],
      commandLedgerId: null,
      mutationAt: input.recoveryAt,
    })
    return Object.freeze({
      recovery: Object.freeze({
        kind: 'replacementQueued' as const,
        replacementRunId: replacement.run.runId,
        newlyPersistedEvents: sessionEvents as [SseEvent, ...SseEvent[]],
      }),
      runEffects: Object.freeze([
        createRunEffect(terminatedRun, 'cancelled'),
        ...replacement.effects,
      ]),
    })
  }

  async function publishCommittedRestartRunEffects(
    runEffects: readonly PersistedAgentRunEffect[],
  ): Promise<void> {
    await publishBestEffort(
      freezeEffects({
        sessionEvents: [],
        runEffects,
        queuedRunId: null,
      }),
    )
  }

  const coordinator: SessionAgentCoordinator &
    PlayerProcessRestartRecoveryCompositionPort = {
    async startIfNeeded(input) {
      assertTimestamp(input.createdAt)
      const transactionResult = await runDatabaseTransaction(
        dependencies.sql,
        async (transaction) => {
          const recovered = await recoveryRepository.recoverSessionForMutation(
            transaction,
            dependencies.owner,
            input.sessionId,
            input.createdAt,
          )
          const currentAiTurn =
            recovered.kind === 'ready' ? getCurrentAiTurn(recovered) : null
          if (
            recovered.kind !== 'ready' ||
            currentAiTurn === null ||
            currentAiTurn.actorSeatNumber !== input.actorSeatNumber ||
            currentAiTurn.actorParticipantId !== input.actorParticipantId
          ) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          if (recovered.session.agentRunState === 'thinking') {
            return { kind: 'alreadyActive' as const, effects: noEffects() }
          }
          if (recovered.session.agentRunState !== 'idle') {
            return { kind: 'alreadyPaused' as const, effects: noEffects() }
          }
          const created = await dependencies.runCoordinator.createOrReuse(
            transaction,
            {
              agentRunId: input.agentRunId,
              runtimeType: 'player',
              sessionId: recovered.session.sessionId,
              handId: currentAiTurn.handId,
              actorParticipantId: input.actorParticipantId,
              sourceStateVersion: currentAiTurn.sourceStateVersion,
              decisionRequestId: input.decisionRequestId,
              triggerType:
                input.trigger === 'initial' ? 'initial' : 'manual_retry',
              idempotencyKey: input.idempotencyKey,
              supersedesRunId: input.supersedesRunId,
              dataDependencies: input.dataDependencies,
              createdAt: input.createdAt,
            },
          )
          if (
            created.run.runtimeType !== 'player' ||
            created.run.participantId !== input.actorParticipantId ||
            created.run.sourceStateVersion !==
              currentAiTurn.sourceStateVersion ||
            created.run.decisionRequestId !== input.decisionRequestId
          ) {
            throw new TypeError('Player 初始 Run 与当前决策点不一致。')
          }
          if (input.supersedesRunId !== null) {
            await runRepository.linkReplacement(
              transaction,
              dependencies.owner,
              {
                predecessorRunId: input.supersedesRunId,
                replacementRunId: created.run.runId,
              },
            )
          }
          const event = createPrivateEvent({
            type: 'agentStarted',
            handId: created.run.handId,
            agentRunId: created.run.runId,
            decisionRequestId: created.run.decisionRequestId,
            actorSeatNumber: input.actorSeatNumber,
            trigger: input.trigger,
            supersedesRunId: input.supersedesRunId,
          })
          const sessionEvents = await persistCoordinationEvents({
            transaction,
            owner: dependencies.owner,
            recovery: recovered,
            mutationRepository,
            agentRunState: 'thinking',
            activePlayerRunId: created.run.runId,
            activeDecisionRequestId: created.run.decisionRequestId,
            eventDrafts: [event],
            commandLedgerId: input.commandLedgerId,
            mutationAt: input.createdAt,
          })
          return {
            kind: 'started' as const,
            effects: freezeEffects({
              sessionEvents,
              runEffects: created.committedEffects,
              queuedRunId:
                created.kind === 'created' ? created.run.runId : null,
            }),
          }
        },
      )
      await publishBestEffort(transactionResult.effects)
      return transactionResult
    },

    async pauseAfterFailure(input) {
      assertTimestamp(input.settledAt)
      const transactionResult = await runDatabaseTransaction(
        dependencies.sql,
        async (transaction) => {
          const recovered = await recoveryRepository.recoverSessionForMutation(
            transaction,
            dependencies.owner,
            input.sessionId,
            input.settledAt,
          )
          if (recovered.kind !== 'ready')
            return { kind: 'noTarget' as const, effects: noEffects() }
          if (recovered.session.agentRunState === 'paused') {
            return { kind: 'alreadyPaused' as const, effects: noEffects() }
          }
          if (
            recovered.session.agentRunState !== 'thinking' ||
            !sameUuid(recovered.session.activePlayerRunId, input.agentRunId) ||
            !sameUuid(
              recovered.session.activeDecisionRequestId,
              input.decisionRequestId,
            )
          ) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          const currentAiTurn = getCurrentAiTurn(recovered)
          if (currentAiTurn === null) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          const run = await runRepository.lockPlayerRunForCoordination(
            transaction,
            dependencies.owner,
            input.agentRunId,
          )
          if (
            run.lifecycle !== 'running' ||
            run.decisionRequestId !== input.decisionRequestId ||
            run.handId !== currentAiTurn.handId ||
            run.participantId !== currentAiTurn.actorParticipantId ||
            run.sourceStateVersion !== currentAiTurn.sourceStateVersion ||
            run.leaseOwner !== input.authority.leaseOwner ||
            run.fencingToken !== input.authority.fencingToken ||
            run.leaseExpiresAt === null ||
            Date.parse(run.leaseExpiresAt) <= Date.parse(input.settledAt)
          ) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          return {
            kind: 'paused' as const,
            effects: await settleToPaused({
              transaction,
              recovery: recovered,
              run,
              actorSeatNumber: currentAiTurn.actorSeatNumber,
              decisionRequestId: input.decisionRequestId,
              reason: input.reason,
              settledAt: input.settledAt,
            }),
          }
        },
      )
      await publishBestEffort(transactionResult.effects)
      return transactionResult
    },

    async reconcileStale(input) {
      assertTimestamp(input.settledAt)
      const transactionResult = await runDatabaseTransaction(
        dependencies.sql,
        async (transaction) => {
          const recovered = await recoveryRepository.recoverSessionForMutation(
            transaction,
            dependencies.owner,
            input.sessionId,
            input.settledAt,
          )
          if (recovered.kind !== 'ready')
            return { kind: 'noTarget' as const, effects: noEffects() }
          if (recovered.session.agentRunState === 'paused') {
            return { kind: 'alreadyPaused' as const, effects: noEffects() }
          }
          if (
            recovered.session.agentRunState !== 'thinking' ||
            !sameUuid(recovered.session.activePlayerRunId, input.agentRunId) ||
            !sameUuid(
              recovered.session.activeDecisionRequestId,
              input.decisionRequestId,
            )
          ) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          const currentAiTurn = getCurrentAiTurn(recovered)
          if (currentAiTurn === null) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          const predecessor = await runRepository.lockPlayerRunForCoordination(
            transaction,
            dependencies.owner,
            input.agentRunId,
          )
          if (
            predecessor.decisionRequestId !== input.decisionRequestId ||
            predecessor.handId !== currentAiTurn.handId ||
            predecessor.participantId !== currentAiTurn.actorParticipantId ||
            predecessor.sourceStateVersion !==
              currentAiTurn.sourceStateVersion ||
            !['queued', 'leased', 'running'].includes(predecessor.lifecycle)
          ) {
            return { kind: 'noTarget' as const, effects: noEffects() }
          }
          if (
            predecessor.fencingToken > input.authority.fencingToken &&
            predecessor.leaseExpiresAt !== null &&
            Date.parse(predecessor.leaseExpiresAt) > Date.parse(input.settledAt)
          ) {
            return { kind: 'newAuthorityActive' as const, effects: noEffects() }
          }
          try {
            assertExactReplacementConfiguration(
              dependencies.registry,
              dependencies.strategyPackRepository,
              predecessor,
            )
          } catch {
            return {
              kind: 'paused' as const,
              effects: await settleToPaused({
                transaction,
                recovery: recovered,
                run: predecessor,
                actorSeatNumber: currentAiTurn.actorSeatNumber,
                decisionRequestId: input.decisionRequestId,
                reason: 'player_dependency_unavailable',
                settledAt: input.settledAt,
              }),
            }
          }
          await decisionRepository.markTerminalForCoordination(
            transaction,
            dependencies.owner,
            {
              agentRunId: predecessor.runId,
              sessionId: predecessor.sessionId,
              outcome: 'stale',
              reason: input.reason,
              terminatedAt: input.settledAt,
            },
          )
          const terminatedRun = await runRepository.terminateForCoordination(
            transaction,
            dependencies.owner,
            {
              runId: predecessor.runId,
              lifecycle: 'stale',
              terminationReason: input.reason,
              completedAt: input.settledAt,
            },
          )
          const replacement = await createReplacement({
            transaction,
            predecessor,
            replacementRunId: input.replacementRunId,
            decisionRequestId: input.replacementDecisionRequestId,
            idempotencyKey: input.replacementIdempotencyKey,
            createdAt: input.settledAt,
            triggerType: 'stale_replacement',
          })
          const event = createPrivateEvent({
            type: 'agentStarted',
            handId: replacement.run.handId,
            agentRunId: replacement.run.runId,
            decisionRequestId: replacement.run.decisionRequestId,
            actorSeatNumber: currentAiTurn.actorSeatNumber,
            trigger: 'staleReplacement',
            supersedesRunId: predecessor.runId,
          })
          const sessionEvents = await persistCoordinationEvents({
            transaction,
            owner: dependencies.owner,
            recovery: recovered,
            mutationRepository,
            agentRunState: 'thinking',
            activePlayerRunId: replacement.run.runId,
            activeDecisionRequestId: replacement.run.decisionRequestId,
            eventDrafts: [event],
            commandLedgerId: null,
            mutationAt: input.settledAt,
          })
          return {
            kind: 'replacementQueued' as const,
            effects: freezeEffects({
              sessionEvents,
              runEffects: [
                createRunEffect(terminatedRun, 'stale'),
                ...replacement.effects,
              ],
              queuedRunId: replacement.run.runId,
            }),
          }
        },
      )
      await publishBestEffort(transactionResult.effects)
      return transactionResult
    },

    async recoverAfterProcessRestart(transaction, input) {
      return (await recoverAfterProcessRestartWithEffects(transaction, input))
        .recovery
    },
    recoverAfterProcessRestartWithEffects,
    publishCommittedRestartRunEffects,

    async startCorrectionAttempt(input) {
      assertTimestamp(input.attemptAt)
      if (
        input.attemptType !== 'correction' ||
        input.routingReasonCode !== 'content_correction'
      ) {
        throw new TypeError('Player correction Attempt 输入无效。')
      }
      return runDatabaseTransaction(dependencies.sql, async (transaction) => {
        const recovered = await recoveryRepository.recoverSessionForMutation(
          transaction,
          dependencies.owner,
          input.sessionId,
          input.attemptAt,
        )
        if (
          recovered.kind !== 'ready' ||
          recovered.session.agentRunState !== 'thinking' ||
          !sameUuid(recovered.session.activePlayerRunId, input.agentRunId) ||
          !sameUuid(
            recovered.session.activeDecisionRequestId,
            input.decisionRequestId,
          )
        ) {
          throw new TypeError('Player correction 已失去当前决策权。')
        }
        const currentAiTurn = getCurrentAiTurn(recovered)
        if (currentAiTurn === null) {
          throw new TypeError('Player correction 当前行动者无效。')
        }
        const run = await runRepository.lockPlayerRunForCoordination(
          transaction,
          dependencies.owner,
          input.agentRunId,
        )
        if (
          run.lifecycle !== 'running' ||
          run.decisionRequestId !== input.decisionRequestId ||
          run.handId !== currentAiTurn.handId ||
          run.participantId !== currentAiTurn.actorParticipantId ||
          run.sourceStateVersion !== currentAiTurn.sourceStateVersion
        ) {
          throw new TypeError('Player correction Run 身份无效。')
        }
        const {
          decisionRequestId: _decisionRequestId,
          authority: _authority,
          attemptAt: _attemptAt,
          ...attemptInput
        } = input
        const started =
          await foundationRepository.startBudgetedAgentAttemptAudit(
            transaction,
            dependencies.owner,
            input.authority,
            attemptInput,
          )
        if (started.kind !== 'started') return started
        const repairOrdinal = started.attemptNumber
        if (repairOrdinal < 1 || repairOrdinal > 2) {
          throw new TypeError('Player correction 次序无效。')
        }
        const event = createPrivateEvent({
          type: 'agentRepairAttempted',
          handId: run.handId,
          agentRunId: run.runId,
          decisionRequestId: run.decisionRequestId,
          actorSeatNumber: currentAiTurn.actorSeatNumber,
          attemptId: started.attemptId,
          repairOrdinal,
        })
        await persistCoordinationEvents({
          transaction,
          owner: dependencies.owner,
          recovery: recovered,
          mutationRepository,
          agentRunState: 'thinking',
          activePlayerRunId: run.runId,
          activeDecisionRequestId: run.decisionRequestId,
          eventDrafts: [event],
          commandLedgerId: null,
          mutationAt: input.attemptAt,
        })
        return started
      })
    },
  }
  return Object.freeze(coordinator)
}
