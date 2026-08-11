import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import { createPokerTableState } from '../../poker/state.js'
import { createPrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from './command-handler.js'

type RebuyCommand = Extract<LedgerCommand, { readonly type: 'rebuy' }>

export interface RebuyRelationPlan {
  readonly kind: 'rebuy'
}

const EmptyPort = Object.freeze({})
const RebuyPlan = Object.freeze({ kind: 'rebuy' as const })

export class RebuyHandlerInvariantError extends Error {
  public constructor() {
    super('补码 Handler 不变量被破坏。')
    this.name = 'RebuyHandlerInvariantError'
  }
}

export function isRebuyAmountAllowed(
  currentStack: number,
  amount: number,
): boolean {
  return currentStack === 0
    ? amount === 2_000
    : currentStack < 2_000 && amount <= 2_000 - currentStack
}

export function parseRebuyRelationPlan(
  input: unknown,
): RebuyRelationPlan | null {
  if (
    typeof input !== 'object' ||
    input === null ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== 1 ||
    !('kind' in input) ||
    input.kind !== 'rebuy'
  ) {
    return null
  }
  return RebuyPlan
}

function isIdleSession(session: {
  readonly agentRunState: 'idle' | 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
}): boolean {
  return (
    session.agentRunState === 'idle' &&
    session.activePlayerRunId === null &&
    session.activeDecisionRequestId === null
  )
}

export function createRebuyHandlerBinding(): SessionCommandHandlerBinding<
  RebuyCommand,
  Readonly<Record<string, never>>,
  Readonly<Record<string, never>>,
  RebuyRelationPlan
> {
  return defineSessionCommandHandlerBinding({
    commandType: 'rebuy',
    handler: {
      async prepare({ command, state, session }) {
        if (session.lifecycleStatus !== 'active') {
          throw new RebuyHandlerInvariantError()
        }
        if (state.poker.pokerPhase !== 'betweenHands') {
          return {
            kind: 'rejected',
            rejection: {
              kind: 'commandNotAllowedInPhase',
              phase: state.poker.pokerPhase,
            },
          }
        }
        if (
          state.poker.hand !== null ||
          session.currentHandId !== null ||
          !isIdleSession(session)
        ) {
          throw new RebuyHandlerInvariantError()
        }
        const userSeat = state.poker.seats.find(
          (seat) => seat.seatNumber === 0 && seat.isUser,
        )
        const userAccounting = state.seatAccounting.find(
          (seat) => seat.seatNumber === 0,
        )
        if (
          userSeat === undefined ||
          userAccounting === undefined ||
          (userSeat.stack === 0 && userSeat.status !== 'out') ||
          (userSeat.stack > 0 && userSeat.status !== 'active')
        ) {
          throw new RebuyHandlerInvariantError()
        }

        const amount = command.payload.amount
        if (!isRebuyAmountAllowed(userSeat.stack, amount)) {
          return {
            kind: 'rejected',
            rejection: { kind: 'rebuyAmountNotAllowed' },
          }
        }
        const cumulativeBuyInAfter =
          BigInt(userAccounting.cumulativeBuyIn) + BigInt(amount)
        if (cumulativeBuyInAfter > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new RebuyHandlerInvariantError()
        }
        const stackAfter = userSeat.stack + amount
        const poker = createPokerTableState({
          ...state.poker,
          seats: state.poker.seats.map((seat) =>
            seat.seatNumber === 0
              ? { ...seat, stack: stackAfter, status: 'active' as const }
              : seat,
          ),
        })
        const seatAccounting = state.seatAccounting.map((seat) =>
          seat.seatNumber === 0
            ? {
                ...seat,
                cumulativeBuyIn: Number(cumulativeBuyInAfter),
              }
            : seat,
        )
        const event = createPrivateEventV2({
          type: 'userRebuy',
          seatNumber: 0,
          amount,
          stackBefore: userSeat.stack,
          stackAfter,
          cumulativeBuyInBefore: userAccounting.cumulativeBuyIn,
          cumulativeBuyInAfter: Number(cumulativeBuyInAfter),
        })
        if (event.type !== 'userRebuy') {
          throw new RebuyHandlerInvariantError()
        }

        return {
          kind: 'prepared',
          mutation: {
            stateEffect: {
              kind: 'stateChanged',
              stateContent: {
                poker,
                completedHandCount: state.completedHandCount,
                seatAccounting,
                lastCompletedHandSummary: state.lastCompletedHandSummary,
              },
            },
            lifecycleAfter: 'active',
            currentHandIdAfter: null,
            playerCoordinationAfter: {
              agentRunState: 'idle',
              activePlayerRunId: null,
              activeDecisionRequestId: null,
            },
            privateEventDrafts: Object.freeze([event]),
            relationPlan: RebuyPlan,
          },
        }
      },
      async applyRelations(_context, capability) {
        if (parseRebuyRelationPlan(capability.relationPlan) === null) {
          throw new RebuyHandlerInvariantError()
        }
      },
    },
    bindReadPort: () => EmptyPort,
    bindWritePort: () => EmptyPort,
  })
}
