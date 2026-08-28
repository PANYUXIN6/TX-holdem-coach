import { isDeepStrictEqual } from 'node:util'
import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import {
  createAgentRunLifecycleRepository,
  type AgentRunLifecycleRepository,
} from '../../persistence/agent-run-lifecycle-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { PersistedAgentRun } from '../foundation/agent-run-types.js'
import { createRunConfigurationSnapshot } from '../foundation/agent-run-coordinator.js'
import type { RuntimeRegistry } from '../foundation/runtime-registry.js'
import type { StrategyPackRepository } from '../../poker-strategy/strategy-pack-repository.js'
import { createPrivateEvent } from '../../sessions/authoritative-state/private-event.js'
import { readPinnedStrategyPackReference } from './player-strategy-pack-audit-reference.js'
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from '../../sessions/command-execution/command-handler.js'

type RetryAgentCommand = Extract<LedgerCommand, { readonly type: 'retryAgent' }>

export interface RetryAgentRelationPlan {
  readonly kind: 'retryAgent'
  readonly sessionId: string
  readonly handId: string
  readonly actorParticipantId: string
  readonly sourceStateVersion: number
  readonly predecessorRunId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly idempotencyKey: string
}

interface RetryAgentReadPort {
  loadFailedPlayerLeafForRetry(input: {
    readonly sessionId: string
    readonly handId: string
    readonly participantId: string
    readonly sourceStateVersion: number
  }): Promise<PersistedAgentRun<'player'> | null>
}

interface RetryAgentWritePort {
  createManualRetryReplacement(
    input: RetryAgentRelationPlan & { readonly commandAt: string },
  ): Promise<PersistedAgentRun<'player'>>
}

const RetryAgentRelationPlanSchema = z.strictObject({
  kind: z.literal('retryAgent'),
  sessionId: z.uuid(),
  handId: z.uuid(),
  actorParticipantId: z.uuid(),
  sourceStateVersion: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  predecessorRunId: z.uuid(),
  agentRunId: z.uuid(),
  decisionRequestId: z.uuid(),
  idempotencyKey: z.string().min(1).max(256),
})

class RetryAgentHandlerInvariantError extends Error {
  public constructor() {
    super('retryAgent Handler 不变量被破坏。')
    this.name = 'RetryAgentHandlerInvariantError'
  }
}

function sameUuid(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase()
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function parseRetryAgentRelationPlan(
  input: unknown,
): RetryAgentRelationPlan | null {
  const parsed = RetryAgentRelationPlanSchema.safeParse(input)
  return parsed.success ? deepFreeze(parsed.data) : null
}

function createRetryAgentWritePort(input: {
  readonly transaction: TransactionSql
  readonly owner: ResolvedOwnerScope
  readonly registry: RuntimeRegistry
  readonly strategyPackRepository: StrategyPackRepository
  readonly runRepository: AgentRunLifecycleRepository
}): RetryAgentWritePort {
  return Object.freeze({
    async createManualRetryReplacement(
      plan: RetryAgentRelationPlan & { readonly commandAt: string },
    ) {
      const { commandAt, ...relationPlan } = plan
      const parsed = parseRetryAgentRelationPlan(relationPlan)
      if (
        parsed === null ||
        !z.iso.datetime({ precision: 3 }).safeParse(commandAt).success
      ) {
        throw new RetryAgentHandlerInvariantError()
      }
      const predecessor =
        await input.runRepository.lockPlayerRunForCoordination(
          input.transaction,
          input.owner,
          parsed.predecessorRunId,
        )
      if (
        predecessor.lifecycle !== 'failed' ||
        predecessor.replacementRunId !== null ||
        predecessor.sessionId !== parsed.sessionId ||
        predecessor.handId !== parsed.handId ||
        predecessor.participantId !== parsed.actorParticipantId ||
        predecessor.sourceStateVersion !== parsed.sourceStateVersion
      ) {
        throw new RetryAgentHandlerInvariantError()
      }
      let definition
      try {
        definition = input.registry.resolveExact(
          'player',
          predecessor.runtimeDefinitionVersion,
        )
      } catch {
        throw new RetryAgentHandlerInvariantError()
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
        throw new RetryAgentHandlerInvariantError()
      }
      try {
        input.strategyPackRepository.read({
          reference: readPinnedStrategyPackReference(
            predecessor.runConfiguration.dataDependencies,
          ),
          usage: 'pinnedRun',
        })
      } catch {
        throw new RetryAgentHandlerInvariantError()
      }
      const createdAtMilliseconds = Date.parse(commandAt)
      if (
        !Number.isSafeInteger(createdAtMilliseconds) ||
        predecessor.budget.maxWallClockMs >
          Number.MAX_SAFE_INTEGER - createdAtMilliseconds
      ) {
        throw new RetryAgentHandlerInvariantError()
      }
      const created = await input.runRepository.createOrReuse(
        input.transaction,
        input.owner,
        {
          agentRunId: parsed.agentRunId,
          runtimeType: 'player',
          sessionId: predecessor.sessionId,
          handId: predecessor.handId,
          participantId: predecessor.participantId,
          sourceStateVersion: predecessor.sourceStateVersion,
          decisionRequestId: parsed.decisionRequestId,
          triggerType: 'manual_retry',
          idempotencyKey: parsed.idempotencyKey,
          parentRunId: predecessor.runId,
          deadlineAt: new Date(
            createdAtMilliseconds + predecessor.budget.maxWallClockMs,
          ).toISOString(),
          runtimeDefinitionVersion: predecessor.runtimeDefinitionVersion,
          runConfiguration: predecessor.runConfiguration,
          budget: predecessor.budget,
          createdAt: commandAt,
        },
      )
      if (
        created.run.runtimeType !== 'player' ||
        created.run.decisionRequestId !== parsed.decisionRequestId ||
        !isDeepStrictEqual(
          created.run.runConfiguration,
          predecessor.runConfiguration,
        ) ||
        !isDeepStrictEqual(created.run.budget, predecessor.budget)
      ) {
        throw new RetryAgentHandlerInvariantError()
      }
      await input.runRepository.linkReplacement(
        input.transaction,
        input.owner,
        {
          predecessorRunId: predecessor.runId,
          replacementRunId: created.run.runId,
        },
      )
      return created.run
    },
  })
}

export function createRetryAgentHandlerBinding(input: {
  readonly owner: ResolvedOwnerScope
  readonly registry: RuntimeRegistry
  readonly strategyPackRepository: StrategyPackRepository
  readonly nextRunId: () => string
  readonly nextDecisionRequestId: () => string
  readonly runRepository?: AgentRunLifecycleRepository
}): SessionCommandHandlerBinding<
  RetryAgentCommand,
  RetryAgentReadPort,
  RetryAgentWritePort,
  RetryAgentRelationPlan
> {
  const runRepository =
    input.runRepository ?? createAgentRunLifecycleRepository()
  return defineSessionCommandHandlerBinding({
    commandType: 'retryAgent',
    handler: {
      async prepare({ command, state, session, reads }) {
        const hand = state.poker.hand
        const actorSeatNumber = hand?.currentActorSeatNumber
        if (
          session.lifecycleStatus !== 'active' ||
          session.agentRunState !== 'paused' ||
          session.activePlayerRunId !== null ||
          session.activeDecisionRequestId !== null ||
          state.poker.pokerPhase !== 'inHand' ||
          hand === null ||
          typeof actorSeatNumber !== 'number' ||
          actorSeatNumber < 1 ||
          actorSeatNumber > 8 ||
          !sameUuid(session.currentHandId, hand.handId)
        ) {
          return {
            kind: 'rejected',
            rejection: { kind: 'agentRetryNotAllowed' },
          }
        }
        const actor = state.poker.seats.find(
          (seat) => seat.seatNumber === actorSeatNumber && !seat.isUser,
        )
        if (actor === undefined) {
          return {
            kind: 'rejected',
            rejection: { kind: 'agentRetryNotAllowed' },
          }
        }
        const predecessor = await reads.loadFailedPlayerLeafForRetry({
          sessionId: command.sessionId,
          handId: hand.handId,
          participantId: actor.playerId,
          sourceStateVersion: state.stateVersion,
        })
        if (predecessor === null) {
          return {
            kind: 'rejected',
            rejection: { kind: 'agentRetryNotAllowed' },
          }
        }
        try {
          const definition = input.registry.resolveExact(
            'player',
            predecessor.runtimeDefinitionVersion,
          )
          if (
            !isDeepStrictEqual(
              createRunConfigurationSnapshot(
                definition,
                predecessor.runConfiguration.dataDependencies,
              ),
              predecessor.runConfiguration,
            )
          ) {
            return {
              kind: 'rejected',
              rejection: { kind: 'agentRetryNotAllowed' },
            }
          }
          input.strategyPackRepository.read({
            reference: readPinnedStrategyPackReference(
              predecessor.runConfiguration.dataDependencies,
            ),
            usage: 'pinnedRun',
          })
        } catch {
          return {
            kind: 'rejected',
            rejection: { kind: 'agentRetryNotAllowed' },
          }
        }
        const agentRunId = input.nextRunId().toLowerCase()
        const decisionRequestId = input.nextDecisionRequestId().toLowerCase()
        if (
          !z.uuid().safeParse(agentRunId).success ||
          !z.uuid().safeParse(decisionRequestId).success
        ) {
          throw new RetryAgentHandlerInvariantError()
        }
        const relationPlan = parseRetryAgentRelationPlan({
          kind: 'retryAgent',
          sessionId: command.sessionId,
          handId: hand.handId,
          actorParticipantId: actor.playerId,
          sourceStateVersion: state.stateVersion,
          predecessorRunId: predecessor.runId,
          agentRunId,
          decisionRequestId,
          idempotencyKey: `retry-agent:${command.commandId.toLowerCase()}`,
        })
        if (relationPlan === null) throw new RetryAgentHandlerInvariantError()
        const event = createPrivateEvent({
          type: 'agentStarted',
          handId: hand.handId,
          agentRunId,
          decisionRequestId,
          actorSeatNumber,
          trigger: 'manualRetry',
          supersedesRunId: predecessor.runId,
        })
        if (event.type !== 'agentStarted') {
          throw new RetryAgentHandlerInvariantError()
        }
        return {
          kind: 'prepared',
          mutation: {
            stateEffect: { kind: 'stateUnchanged' },
            lifecycleAfter: 'active',
            currentHandIdAfter: hand.handId,
            playerCoordinationAfter: {
              agentRunState: 'thinking',
              activePlayerRunId: agentRunId,
              activeDecisionRequestId: decisionRequestId,
            },
            privateEventDrafts: Object.freeze([event]),
            relationPlan,
          },
        }
      },
      async applyRelations({ writes, commandAt }, capability) {
        const plan = parseRetryAgentRelationPlan(capability.relationPlan)
        if (plan === null) throw new RetryAgentHandlerInvariantError()
        const replacement = await writes.createManualRetryReplacement({
          ...plan,
          commandAt,
        })
        if (
          replacement.runId !== plan.agentRunId ||
          replacement.decisionRequestId !== plan.decisionRequestId ||
          replacement.parentRunId !== plan.predecessorRunId
        ) {
          throw new RetryAgentHandlerInvariantError()
        }
      },
    },
    bindReadPort: (transaction) =>
      Object.freeze({
        loadFailedPlayerLeafForRetry: (query: {
          readonly sessionId: string
          readonly handId: string
          readonly participantId: string
          readonly sourceStateVersion: number
        }) =>
          runRepository.loadFailedPlayerLeafForRetry(
            transaction,
            input.owner,
            query,
          ),
      }),
    bindWritePort: (transaction) =>
      createRetryAgentWritePort({
        transaction,
        owner: input.owner,
        registry: input.registry,
        strategyPackRepository: input.strategyPackRepository,
        runRepository,
      }),
  })
}
