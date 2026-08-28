import {
  ErrorResponseSchema,
  type ErrorResponse,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'
import { isRebuyAmountAllowed } from './rebuy-handler.js'

interface CommandNotAllowedInPhaseRejection {
  readonly kind: 'commandNotAllowedInPhase'
  readonly phase: 'betweenHands' | 'inHand'
}

export type StableCommandRejection =
  | CommandNotAllowedInPhaseRejection
  | { readonly kind: 'playerNotCurrentActor' }
  | { readonly kind: 'pokerActionNotLegal' }
  | { readonly kind: 'pokerActionTargetOutOfRange' }
  | { readonly kind: 'rebuyAmountNotAllowed' }
  | { readonly kind: 'userRebuyRequired' }
  | { readonly kind: 'agentRetryNotAllowed' }

export type StableCommandRejectionCode =
  | 'COMMAND_NOT_ALLOWED_IN_PHASE'
  | 'PLAYER_NOT_CURRENT_ACTOR'
  | 'POKER_ACTION_NOT_LEGAL'
  | 'POKER_ACTION_TARGET_OUT_OF_RANGE'
  | 'REBUY_AMOUNT_NOT_ALLOWED'
  | 'USER_REBUY_REQUIRED'
  | 'AGENT_RETRY_NOT_ALLOWED'

const StableCommandRejectionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('commandNotAllowedInPhase'),
    phase: z.enum(['betweenHands', 'inHand']),
  }),
  z.strictObject({ kind: z.literal('playerNotCurrentActor') }),
  z.strictObject({ kind: z.literal('pokerActionNotLegal') }),
  z.strictObject({ kind: z.literal('pokerActionTargetOutOfRange') }),
  z.strictObject({ kind: z.literal('rebuyAmountNotAllowed') }),
  z.strictObject({ kind: z.literal('userRebuyRequired') }),
  z.strictObject({ kind: z.literal('agentRetryNotAllowed') }),
])

export function parseStableCommandRejection(
  input: unknown,
  context: {
    readonly command: LedgerCommand
    readonly state: PrivateTableState
  },
): StableCommandRejection | null {
  const parsed = StableCommandRejectionSchema.safeParse(input)
  if (!parsed.success) return null
  const rejection = parsed.data
  if (rejection.kind === 'commandNotAllowedInPhase') {
    return rejection.phase === context.state.poker.pokerPhase
      ? Object.freeze(rejection)
      : null
  }
  if (rejection.kind === 'rebuyAmountNotAllowed') {
    const userSeat = context.state.poker.seats.find(
      (seat) => seat.seatNumber === 0 && seat.isUser,
    )
    return context.command.type === 'rebuy' &&
      context.state.poker.pokerPhase === 'betweenHands' &&
      userSeat !== undefined &&
      !isRebuyAmountAllowed(userSeat.stack, context.command.payload.amount)
      ? Object.freeze(rejection)
      : null
  }
  if (rejection.kind === 'userRebuyRequired') {
    const userSeat = context.state.poker.seats.find(
      (seat) => seat.seatNumber === 0 && seat.isUser,
    )
    return context.command.type === 'startNextHand' &&
      context.state.poker.pokerPhase === 'betweenHands' &&
      userSeat?.stack === 0
      ? Object.freeze(rejection)
      : null
  }
  if (rejection.kind === 'agentRetryNotAllowed') {
    return context.command.type === 'retryAgent'
      ? Object.freeze(rejection)
      : null
  }
  const hand = context.state.poker.hand
  if (
    context.command.type !== 'playerAction' ||
    context.state.poker.pokerPhase !== 'inHand' ||
    hand === null
  ) {
    return null
  }
  const actorIsUser = hand.currentActorSeatNumber === 0
  if (
    (rejection.kind === 'playerNotCurrentActor' && actorIsUser) ||
    (rejection.kind !== 'playerNotCurrentActor' && !actorIsUser)
  ) {
    return null
  }
  return Object.freeze(rejection)
}

export function mapCommandRejectionToErrorResponse(
  rejection: StableCommandRejection,
  latestSnapshot: PublicSessionSnapshot,
): ErrorResponse {
  const error: {
    readonly code: StableCommandRejectionCode
    readonly message: string
  } = (() => {
    switch (rejection.kind) {
      case 'commandNotAllowedInPhase':
        return {
          code: 'COMMAND_NOT_ALLOWED_IN_PHASE',
          message: '当前牌局阶段不允许执行该命令。',
        }
      case 'playerNotCurrentActor':
        return {
          code: 'PLAYER_NOT_CURRENT_ACTOR',
          message: '当前尚未轮到你行动。',
        }
      case 'pokerActionNotLegal':
        return {
          code: 'POKER_ACTION_NOT_LEGAL',
          message: '该行动在当前局面不可用。',
        }
      case 'pokerActionTargetOutOfRange':
        return {
          code: 'POKER_ACTION_TARGET_OUT_OF_RANGE',
          message: '下注或加注金额超出当前合法范围。',
        }
      case 'rebuyAmountNotAllowed':
        return {
          code: 'REBUY_AMOUNT_NOT_ALLOWED',
          message: '当前补码金额不符合桌上限或归零补码规则。',
        }
      case 'userRebuyRequired':
        return {
          code: 'USER_REBUY_REQUIRED',
          message: '筹码为零，请先补入 2,000 或结束本场。',
        }
      case 'agentRetryNotAllowed':
        return {
          code: 'AGENT_RETRY_NOT_ALLOWED',
          message: '当前无法重试 AI 行动。',
        }
    }
  })()
  return ErrorResponseSchema.parse({
    ...error,
    latestSnapshot,
  })
}
