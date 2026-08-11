import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import { insertInProgressHandAudit } from '../../persistence/hand-audit-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import { startPokerHand } from '../../poker/poker-engine.js'
import type { RandomSource } from '../../poker/random-source.js'
import { createPokerTableState } from '../../poker/state.js'
import { createPrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import {
  createHandStartCheckpointV1,
  type HandStartCheckpointV1,
} from '../hand-audit/hand-start-checkpoint.js'
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from './command-handler.js'

type StartNextHandCommand = Extract<
  LedgerCommand,
  { readonly type: 'startNextHand' }
>

export interface StartNextHandRelationPlan {
  readonly kind: 'startNextHand'
  readonly sessionId: string
  readonly handId: string
  readonly checkpoint: HandStartCheckpointV1
}

interface StartNextHandWritePort {
  insertHand(input: {
    readonly sessionId: string
    readonly checkpoint: HandStartCheckpointV1
    readonly startedAt: string
  }): Promise<{ readonly handId: string; readonly handNumber: number }>
}

const EmptyReadPort = Object.freeze({})
const StartNextHandPlanInputSchema = z.strictObject({
  kind: z.literal('startNextHand'),
  sessionId: z.uuid(),
  handId: z.uuid(),
  checkpoint: z.unknown(),
})

export class StartNextHandHandlerInvariantError extends Error {
  public constructor() {
    super('下一手 Handler 不变量被破坏。')
    this.name = 'StartNextHandHandlerInvariantError'
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

export function parseStartNextHandRelationPlan(
  input: unknown,
): StartNextHandRelationPlan | null {
  const parsed = StartNextHandPlanInputSchema.safeParse(input)
  if (!parsed.success) return null
  try {
    const checkpoint = createHandStartCheckpointV1(parsed.data.checkpoint)
    if (!uuidEquals(checkpoint.startedHand.handId, parsed.data.handId)) {
      return null
    }
    return deepFreeze({ ...parsed.data, checkpoint })
  } catch {
    return null
  }
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

export function createStartNextHandHandlerBinding(input: {
  readonly owner: ResolvedOwnerScope
  readonly nextHandId: () => string
  readonly randomSource: RandomSource
}): SessionCommandHandlerBinding<
  StartNextHandCommand,
  Readonly<Record<string, never>>,
  StartNextHandWritePort,
  StartNextHandRelationPlan
> {
  return defineSessionCommandHandlerBinding({
    commandType: 'startNextHand',
    handler: {
      async prepare({ command, state, session }) {
        if (session.lifecycleStatus !== 'active') {
          throw new StartNextHandHandlerInvariantError()
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
          !isIdleSession(session) ||
          state.completedHandCount < 1
        ) {
          throw new StartNextHandHandlerInvariantError()
        }
        const accountingBySeat = new Map(
          state.seatAccounting.map((seat) => [seat.seatNumber, seat]),
        )
        const userSeat = state.poker.seats.find(
          (seat) => seat.seatNumber === 0 && seat.isUser,
        )
        if (
          userSeat === undefined ||
          accountingBySeat.size !== state.poker.seats.length ||
          !accountingBySeat.has(0)
        ) {
          throw new StartNextHandHandlerInvariantError()
        }
        if (userSeat.stack === 0) {
          return {
            kind: 'rejected',
            rejection: { kind: 'userRebuyRequired' },
          }
        }

        const zeroStackAiSeats = state.poker.seats
          .filter((seat) => !seat.isUser && seat.stack === 0)
          .sort((left, right) => left.seatNumber - right.seatNumber)
        if (
          userSeat.status !== 'active' ||
          state.poker.seats.some(
            (seat) =>
              seat.streetContribution !== 0 ||
              seat.totalContribution !== 0 ||
              (seat.stack === 0
                ? seat.isUser || seat.status !== 'out'
                : seat.status !== 'active'),
          )
        ) {
          throw new StartNextHandHandlerInvariantError()
        }

        const handId = input.nextHandId().toLowerCase()
        if (!z.uuid().safeParse(handId).success) {
          throw new StartNextHandHandlerInvariantError()
        }
        const autoRebuySeatNumbers = new Set(
          zeroStackAiSeats.map((seat) => seat.seatNumber),
        )
        const autoRebuyEvents = zeroStackAiSeats.map((seat) => {
          const accounting = accountingBySeat.get(seat.seatNumber)
          if (accounting === undefined) {
            throw new StartNextHandHandlerInvariantError()
          }
          const cumulativeBuyInAfter =
            BigInt(accounting.cumulativeBuyIn) + 2_000n
          if (cumulativeBuyInAfter > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new StartNextHandHandlerInvariantError()
          }
          const event = createPrivateEventV2({
            type: 'aiAutoRebuy',
            seatNumber: seat.seatNumber,
            amount: 2_000,
            stackBefore: 0,
            stackAfter: 2_000,
            cumulativeBuyInBefore: accounting.cumulativeBuyIn,
            cumulativeBuyInAfter: Number(cumulativeBuyInAfter),
          })
          if (event.type !== 'aiAutoRebuy') {
            throw new StartNextHandHandlerInvariantError()
          }
          return event
        })
        const pokerAfterAutoRebuys = createPokerTableState({
          ...state.poker,
          seats: state.poker.seats.map((seat) =>
            autoRebuySeatNumbers.has(seat.seatNumber)
              ? { ...seat, stack: 2_000, status: 'active' as const }
              : seat,
          ),
        })
        const seatAccounting = state.seatAccounting.map((accounting) =>
          autoRebuySeatNumbers.has(accounting.seatNumber)
            ? {
                ...accounting,
                cumulativeBuyIn: Number(
                  BigInt(accounting.cumulativeBuyIn) + 2_000n,
                ),
              }
            : accounting,
        )
        const startResult = startPokerHand(pokerAfterAutoRebuys, {
          handId,
          completedHandCountBeforeStart: state.completedHandCount,
          randomSource: input.randomSource,
        })
        const checkpoint = createHandStartCheckpointV1({
          stateBeforeStartCommand: state,
          startedHand: startResult.startedHand,
        })
        const handStarted = createPrivateEventV2(startResult.eventDrafts[0])
        if (
          startResult.eventDrafts.length !== 1 ||
          handStarted.type !== 'handStarted'
        ) {
          throw new StartNextHandHandlerInvariantError()
        }
        const relationPlan = parseStartNextHandRelationPlan({
          kind: 'startNextHand',
          sessionId: command.sessionId,
          handId,
          checkpoint,
        })
        if (relationPlan === null) {
          throw new StartNextHandHandlerInvariantError()
        }

        return {
          kind: 'prepared',
          mutation: {
            stateEffect: {
              kind: 'stateChanged',
              stateContent: {
                poker: startResult.state,
                completedHandCount: state.completedHandCount,
                seatAccounting,
                lastCompletedHandSummary: state.lastCompletedHandSummary,
              },
            },
            lifecycleAfter: 'active',
            currentHandIdAfter: handId,
            playerCoordinationAfter: {
              agentRunState: 'idle',
              activePlayerRunId: null,
              activeDecisionRequestId: null,
            },
            privateEventDrafts: Object.freeze([
              ...autoRebuyEvents,
              handStarted,
            ]) as unknown as readonly [
              (typeof autoRebuyEvents)[number] | typeof handStarted,
              ...((typeof autoRebuyEvents)[number] | typeof handStarted)[],
            ],
            relationPlan,
          },
        }
      },
      async applyRelations({ writes, commandAt }, capability) {
        const plan = parseStartNextHandRelationPlan(capability.relationPlan)
        if (plan === null) throw new StartNextHandHandlerInvariantError()
        const inserted = await writes.insertHand({
          sessionId: plan.sessionId,
          checkpoint: plan.checkpoint,
          startedAt: commandAt,
        })
        if (
          !uuidEquals(inserted.handId, plan.handId) ||
          inserted.handNumber !== plan.checkpoint.startedHand.handNumber
        ) {
          throw new StartNextHandHandlerInvariantError()
        }
      },
    },
    bindReadPort: () => EmptyReadPort,
    bindWritePort: (transaction: TransactionSql) =>
      Object.freeze({
        insertHand: (insertInput: {
          readonly sessionId: string
          readonly checkpoint: HandStartCheckpointV1
          readonly startedAt: string
        }) => insertInProgressHandAudit(transaction, input.owner, insertInput),
      }),
  })
}
