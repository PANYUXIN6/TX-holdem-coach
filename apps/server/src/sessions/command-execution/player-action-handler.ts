import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import {
  completeHandAudit,
  type HandAudit,
} from '../../persistence/hand-audit-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import {
  CompletedHandResultSchema,
  type CompletedHandResult,
} from '../../poker/hand-result.js'
import {
  applyPokerAction,
  PokerActionRejectedError,
} from '../../poker/poker-engine.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'
import type { LockedSessionView } from '../../persistence/session-mutation-repository.js'
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from './command-handler.js'

type PlayerActionCommand = Extract<
  LedgerCommand,
  { readonly type: 'playerAction' }
>
type AiActionCommand = Extract<LedgerCommand, { readonly type: 'aiAction' }>

export type PlayerActionRelationPlan =
  | {
      readonly kind: 'continueHand'
      readonly handId: string
    }
  | {
      readonly kind: 'completeHand'
      readonly sessionId: string
      readonly handId: string
      readonly result: CompletedHandResult
    }

interface PlayerActionWritePort {
  completeHand(input: {
    readonly sessionId: string
    readonly handId: string
    readonly result: CompletedHandResult
    readonly completedAt: string
  }): Promise<Extract<HandAudit, { readonly status: 'completed' }>>
}

const EmptyReadPort = Object.freeze({})
const ContinueHandPlanSchema = z.strictObject({
  kind: z.literal('continueHand'),
  handId: z.uuid(),
})
const CompleteHandPlanInputSchema = z.strictObject({
  kind: z.literal('completeHand'),
  sessionId: z.uuid(),
  handId: z.uuid(),
  result: z.unknown(),
})

export class PlayerActionHandlerInvariantError extends Error {
  public constructor() {
    super('玩家行动 Handler 不变量被破坏。')
    this.name = 'PlayerActionHandlerInvariantError'
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function uuidEquals(left: string | null, right: string | null): boolean {
  return left === null || right === null
    ? left === right
    : left.toLowerCase() === right.toLowerCase()
}

export function parsePlayerActionRelationPlan(
  input: unknown,
): PlayerActionRelationPlan | null {
  const continuePlan = ContinueHandPlanSchema.safeParse(input)
  if (continuePlan.success) return deepFreeze(continuePlan.data)
  const completePlan = CompleteHandPlanInputSchema.safeParse(input)
  if (!completePlan.success) return null
  const result = CompletedHandResultSchema.safeParse(completePlan.data.result)
  if (
    !result.success ||
    result.data.handId.toLowerCase() !== completePlan.data.handId.toLowerCase()
  ) {
    return null
  }
  return deepFreeze({ ...completePlan.data, result: result.data })
}

async function preparePokerActionMutation(input: {
  readonly sessionId: string
  readonly actorSeatNumber: number
  readonly action: PlayerActionCommand['payload']['action']
  readonly authorizationKind: 'user' | 'agent'
  readonly state: PrivateTableState
  readonly session: LockedSessionView
}) {
  const { authorizationKind, session, state } = input
  if (session.lifecycleStatus !== 'active') {
    throw new PlayerActionHandlerInvariantError()
  }
  const hand = state.poker.hand
  if (state.poker.pokerPhase !== 'inHand' || hand === null) {
    if (authorizationKind === 'agent') {
      throw new PlayerActionHandlerInvariantError()
    }
    return {
      kind: 'rejected' as const,
      rejection: {
        kind: 'commandNotAllowedInPhase' as const,
        phase: state.poker.pokerPhase,
      },
    }
  }
  if (!uuidEquals(session.currentHandId, hand.handId)) {
    throw new PlayerActionHandlerInvariantError()
  }
  if (hand.currentActorSeatNumber !== input.actorSeatNumber) {
    if (authorizationKind === 'agent') {
      throw new PlayerActionHandlerInvariantError()
    }
    return {
      kind: 'rejected' as const,
      rejection: { kind: 'playerNotCurrentActor' as const },
    }
  }
  const validCoordination =
    authorizationKind === 'user'
      ? session.agentRunState === 'idle' &&
        session.activePlayerRunId === null &&
        session.activeDecisionRequestId === null
      : session.agentRunState === 'thinking' &&
        session.activePlayerRunId !== null &&
        session.activeDecisionRequestId !== null
  if (!validCoordination) throw new PlayerActionHandlerInvariantError()

  let engineResult
  try {
    engineResult = applyPokerAction(state.poker, {
      actorSeatNumber: input.actorSeatNumber,
      action: input.action,
    })
  } catch (error) {
    if (!(error instanceof PokerActionRejectedError)) throw error
    if (authorizationKind === 'agent') {
      throw new PlayerActionHandlerInvariantError()
    }
    switch (error.reason) {
      case 'actionNotLegal':
        return {
          kind: 'rejected' as const,
          rejection: { kind: 'pokerActionNotLegal' as const },
        }
      case 'targetOutOfRange':
        return {
          kind: 'rejected' as const,
          rejection: { kind: 'pokerActionTargetOutOfRange' as const },
        }
      case 'notInActionPhase':
      case 'actorMismatch':
        throw new PlayerActionHandlerInvariantError()
    }
  }

  const completedHand = engineResult.completedHand
  const relationPlan = parsePlayerActionRelationPlan(
    completedHand === null
      ? { kind: 'continueHand', handId: hand.handId }
      : {
          kind: 'completeHand',
          sessionId: input.sessionId,
          handId: completedHand.handId,
          result: completedHand,
        },
  )
  if (relationPlan === null) throw new PlayerActionHandlerInvariantError()
  const completedHandCount =
    completedHand === null
      ? state.completedHandCount
      : Number(BigInt(state.completedHandCount) + 1n)
  if (!Number.isSafeInteger(completedHandCount)) {
    throw new PlayerActionHandlerInvariantError()
  }
  return {
    kind: 'prepared' as const,
    mutation: {
      stateEffect: {
        kind: 'stateChanged' as const,
        stateContent: {
          poker: engineResult.state,
          completedHandCount,
          seatAccounting: state.seatAccounting,
          lastCompletedHandSummary:
            completedHand?.summary ?? state.lastCompletedHandSummary,
        },
      },
      lifecycleAfter: 'active' as const,
      currentHandIdAfter: completedHand === null ? hand.handId : null,
      playerCoordinationAfter: {
        agentRunState: 'idle' as const,
        activePlayerRunId: null,
        activeDecisionRequestId: null,
      },
      privateEventDrafts: engineResult.eventDrafts as readonly [
        (typeof engineResult.eventDrafts)[number],
        ...(typeof engineResult.eventDrafts)[number][],
      ],
      relationPlan,
    },
  }
}

function createPokerActionWritePort(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
): PlayerActionWritePort {
  return Object.freeze({
    completeHand: (completeInput: {
      readonly sessionId: string
      readonly handId: string
      readonly result: CompletedHandResult
      readonly completedAt: string
    }) => completeHandAudit(transaction, owner, completeInput),
  })
}

async function applyPokerActionRelations(
  writes: PlayerActionWritePort,
  commandAt: string,
  capability: { readonly relationPlan: unknown },
): Promise<void> {
  const plan = parsePlayerActionRelationPlan(capability.relationPlan)
  if (plan === null) throw new PlayerActionHandlerInvariantError()
  if (plan.kind === 'continueHand') return
  await writes.completeHand({
    sessionId: plan.sessionId,
    handId: plan.handId,
    result: plan.result,
    completedAt: commandAt,
  })
}

export function createPlayerActionHandlerBinding(input: {
  readonly owner: ResolvedOwnerScope
}): SessionCommandHandlerBinding<
  PlayerActionCommand,
  Readonly<Record<string, never>>,
  PlayerActionWritePort,
  PlayerActionRelationPlan
> {
  return defineSessionCommandHandlerBinding({
    commandType: 'playerAction',
    handler: {
      prepare: ({ command, state, session }) =>
        preparePokerActionMutation({
          sessionId: command.sessionId,
          actorSeatNumber: 0,
          action: command.payload.action,
          authorizationKind: 'user',
          state,
          session,
        }),
      applyRelations: ({ writes, commandAt }, capability) =>
        applyPokerActionRelations(writes, commandAt, capability),
    },
    bindReadPort: () => EmptyReadPort,
    bindWritePort: (transaction: TransactionSql) =>
      createPokerActionWritePort(transaction, input.owner),
  })
}

/**
 * 私有 aiAction 的动作语义绑定；它不是命令执行入口。只有固定组合持有
 * Session executor 签发的内部执行器，才能让该 binding 进入事务。
 */
export function createAiActionHandlerBinding(input: {
  readonly owner: ResolvedOwnerScope
}): SessionCommandHandlerBinding<
  AiActionCommand,
  Readonly<Record<string, never>>,
  PlayerActionWritePort,
  PlayerActionRelationPlan
> {
  return defineSessionCommandHandlerBinding({
    commandType: 'aiAction',
    handler: {
      prepare: ({ command, state, session }) =>
        preparePokerActionMutation({
          sessionId: command.sessionId,
          actorSeatNumber: command.payload.actorSeatNumber,
          action: command.payload.action,
          authorizationKind: 'agent',
          state,
          session,
        }),
      applyRelations: ({ writes, commandAt }, capability) =>
        applyPokerActionRelations(writes, commandAt, capability),
    },
    bindReadPort: () => EmptyReadPort,
    bindWritePort: (transaction: TransactionSql) =>
      createPokerActionWritePort(transaction, input.owner),
  })
}
