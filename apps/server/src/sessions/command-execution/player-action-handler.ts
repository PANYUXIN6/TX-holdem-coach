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
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from './command-handler.js'

type PlayerActionCommand = Extract<
  LedgerCommand,
  { readonly type: 'playerAction' }
>

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
      async prepare({ command, state, session }) {
        if (session.lifecycleStatus !== 'active') {
          throw new PlayerActionHandlerInvariantError()
        }
        const hand = state.poker.hand
        if (state.poker.pokerPhase !== 'inHand' || hand === null) {
          return {
            kind: 'rejected',
            rejection: {
              kind: 'commandNotAllowedInPhase',
              phase: state.poker.pokerPhase,
            },
          }
        }
        if (!uuidEquals(session.currentHandId, hand.handId)) {
          throw new PlayerActionHandlerInvariantError()
        }
        if (hand.currentActorSeatNumber !== 0) {
          return {
            kind: 'rejected',
            rejection: { kind: 'playerNotCurrentActor' },
          }
        }
        if (
          session.agentRunState !== 'idle' ||
          session.activePlayerRunId !== null ||
          session.activeDecisionRequestId !== null
        ) {
          throw new PlayerActionHandlerInvariantError()
        }

        let engineResult
        try {
          engineResult = applyPokerAction(state.poker, {
            actorSeatNumber: 0,
            action: command.payload.action,
          })
        } catch (error) {
          if (!(error instanceof PokerActionRejectedError)) throw error
          switch (error.reason) {
            case 'actionNotLegal':
              return {
                kind: 'rejected',
                rejection: { kind: 'pokerActionNotLegal' },
              }
            case 'targetOutOfRange':
              return {
                kind: 'rejected',
                rejection: { kind: 'pokerActionTargetOutOfRange' },
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
                sessionId: command.sessionId,
                handId: completedHand.handId,
                result: completedHand,
              },
        )
        if (relationPlan === null) {
          throw new PlayerActionHandlerInvariantError()
        }
        const completedHandCount =
          completedHand === null
            ? state.completedHandCount
            : Number(BigInt(state.completedHandCount) + 1n)
        if (!Number.isSafeInteger(completedHandCount)) {
          throw new PlayerActionHandlerInvariantError()
        }

        return {
          kind: 'prepared',
          mutation: {
            stateEffect: {
              kind: 'stateChanged',
              stateContent: {
                poker: engineResult.state,
                completedHandCount,
                seatAccounting: state.seatAccounting,
                lastCompletedHandSummary:
                  completedHand?.summary ?? state.lastCompletedHandSummary,
              },
            },
            lifecycleAfter: 'active',
            currentHandIdAfter: completedHand === null ? hand.handId : null,
            playerCoordinationAfter: {
              agentRunState: 'idle',
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
      },
      async applyRelations({ writes, commandAt }, capability) {
        const plan = parsePlayerActionRelationPlan(capability.relationPlan)
        if (plan === null) throw new PlayerActionHandlerInvariantError()
        if (plan.kind === 'continueHand') return
        await writes.completeHand({
          sessionId: plan.sessionId,
          handId: plan.handId,
          result: plan.result,
          completedAt: commandAt,
        })
      },
    },
    bindReadPort: () => EmptyReadPort,
    bindWritePort: (transaction: TransactionSql) =>
      Object.freeze({
        completeHand: (completeInput: {
          readonly sessionId: string
          readonly handId: string
          readonly result: CompletedHandResult
          readonly completedAt: string
        }) => completeHandAudit(transaction, input.owner, completeInput),
      }),
  })
}
