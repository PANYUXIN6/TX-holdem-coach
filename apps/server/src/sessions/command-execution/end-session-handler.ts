import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import { StableAuditCodeSchema } from '../../agents/audit/audit-primitives.js'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import {
  abortHandAudit,
  type HandAudit,
} from '../../persistence/hand-audit-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import {
  loadPausedAbortContext,
  type PausedAbortContext,
} from '../../persistence/session-lifecycle-repository.js'
import { createPrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import {
  createHandStartCheckpointV2,
  type HandStartCheckpointV2,
} from '../hand-audit/hand-start-checkpoint.js'
import {
  defineSessionCommandHandlerBinding,
  type SessionCommandHandlerBinding,
} from './command-handler.js'

type EndSessionCommand = Extract<LedgerCommand, { readonly type: 'endSession' }>

export type EndSessionRelationPlan =
  | { readonly kind: 'normalEnd' }
  | {
      readonly kind: 'abortHand'
      readonly sessionId: string
      readonly handId: string
      readonly failedPlayerRunId: string
      readonly failureReasonCode: string
      readonly checkpoint: HandStartCheckpointV2
    }

interface EndSessionReadPort {
  loadPausedAbortContext(input: {
    readonly sessionId: string
    readonly handId: string
    readonly actorParticipantId: string
    readonly sourceStateVersion: number
  }): Promise<PausedAbortContext>
}

interface EndSessionWritePort {
  abortHand(input: {
    readonly sessionId: string
    readonly handId: string
    readonly failedAgentRunId: string
    readonly reasonCode: string
    readonly abortedAt: string
  }): Promise<Extract<HandAudit, { readonly status: 'aborted' }>>
}

const NormalEndPlan = Object.freeze({ kind: 'normalEnd' as const })
const NormalEndPlanSchema = z.strictObject({ kind: z.literal('normalEnd') })
const AbortHandPlanInputSchema = z.strictObject({
  kind: z.literal('abortHand'),
  sessionId: z.uuid(),
  handId: z.uuid(),
  failedPlayerRunId: z.uuid(),
  failureReasonCode: StableAuditCodeSchema,
  checkpoint: z.unknown(),
})

export class EndSessionHandlerInvariantError extends Error {
  public constructor() {
    super('结束场次 Handler 不变量被破坏。')
    this.name = 'EndSessionHandlerInvariantError'
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

function equalValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

export function parseEndSessionRelationPlan(
  input: unknown,
): EndSessionRelationPlan | null {
  if (NormalEndPlanSchema.safeParse(input).success) return NormalEndPlan
  const parsed = AbortHandPlanInputSchema.safeParse(input)
  if (!parsed.success) return null
  try {
    const checkpoint = createHandStartCheckpointV2(parsed.data.checkpoint)
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

export function createEndSessionHandlerBinding(input: {
  readonly owner: ResolvedOwnerScope
}): SessionCommandHandlerBinding<
  EndSessionCommand,
  EndSessionReadPort,
  EndSessionWritePort,
  EndSessionRelationPlan
> {
  return defineSessionCommandHandlerBinding<
    EndSessionCommand,
    EndSessionReadPort,
    EndSessionWritePort,
    EndSessionRelationPlan
  >({
    commandType: 'endSession',
    handler: {
      async prepare({ command, state, session, reads }) {
        if (session.lifecycleStatus !== 'active') {
          throw new EndSessionHandlerInvariantError()
        }
        if (state.poker.pokerPhase === 'betweenHands') {
          if (
            state.poker.hand !== null ||
            session.currentHandId !== null ||
            !isIdleSession(session)
          ) {
            throw new EndSessionHandlerInvariantError()
          }
          const event = createPrivateEventV2({
            type: 'sessionEnded',
            reason: 'userRequested',
          })
          if (event.type !== 'sessionEnded') {
            throw new EndSessionHandlerInvariantError()
          }
          return {
            kind: 'prepared',
            mutation: {
              stateEffect: { kind: 'stateUnchanged' },
              lifecycleAfter: 'ended',
              currentHandIdAfter: null,
              playerCoordinationAfter: {
                agentRunState: 'idle',
                activePlayerRunId: null,
                activeDecisionRequestId: null,
              },
              privateEventDrafts: Object.freeze([event]),
              relationPlan: NormalEndPlan,
            },
          }
        }

        if (session.agentRunState !== 'paused') {
          return {
            kind: 'rejected',
            rejection: {
              kind: 'commandNotAllowedInPhase',
              phase: 'inHand',
            },
          }
        }
        const hand = state.poker.hand
        if (
          hand === null ||
          !uuidEquals(session.currentHandId, hand.handId) ||
          session.activePlayerRunId !== null ||
          session.activeDecisionRequestId !== null
        ) {
          throw new EndSessionHandlerInvariantError()
        }
        const actorSeat = state.poker.seats.find(
          (seat) => seat.seatNumber === hand.currentActorSeatNumber,
        )
        if (actorSeat === undefined || actorSeat.isUser) {
          throw new EndSessionHandlerInvariantError()
        }
        const abortContext = await reads.loadPausedAbortContext({
          sessionId: command.sessionId,
          handId: hand.handId,
          actorParticipantId: actorSeat.playerId,
          sourceStateVersion: state.stateVersion,
        })
        if (
          !uuidEquals(abortContext.handId, hand.handId) ||
          !uuidEquals(abortContext.checkpoint.startedHand.handId, hand.handId)
        ) {
          throw new EndSessionHandlerInvariantError()
        }
        const checkpointState = abortContext.checkpoint.stateBeforeStartCommand
        const handAborted = createPrivateEventV2({
          type: 'handAborted',
          handId: hand.handId,
          beforeAbort: {
            buttonSeatNumber: state.poker.buttonSeatNumber,
            completedHandCount: state.completedHandCount,
            pot: hand.pot,
            seats: [...state.poker.seats]
              .sort((left, right) => left.seatNumber - right.seatNumber)
              .map((seat) => ({
                seatNumber: seat.seatNumber,
                stack: seat.stack,
                cumulativeBuyIn:
                  state.seatAccounting.find(
                    (accounting) => accounting.seatNumber === seat.seatNumber,
                  )?.cumulativeBuyIn ?? -1,
              })),
          },
          restored: {
            buttonSeatNumber: checkpointState.poker.buttonSeatNumber,
            completedHandCount: checkpointState.completedHandCount,
            seats: [...checkpointState.poker.seats]
              .sort((left, right) => left.seatNumber - right.seatNumber)
              .map((seat) => ({
                seatNumber: seat.seatNumber,
                stack: seat.stack,
                cumulativeBuyIn:
                  checkpointState.seatAccounting.find(
                    (accounting) => accounting.seatNumber === seat.seatNumber,
                  )?.cumulativeBuyIn ?? -1,
              })),
          },
        })
        const sessionEnded = createPrivateEventV2({
          type: 'sessionEnded',
          reason: 'handAborted',
        })
        if (
          handAborted.type !== 'handAborted' ||
          sessionEnded.type !== 'sessionEnded'
        ) {
          throw new EndSessionHandlerInvariantError()
        }
        const relationPlan = parseEndSessionRelationPlan({
          kind: 'abortHand',
          sessionId: command.sessionId,
          handId: hand.handId,
          failedPlayerRunId: abortContext.failedPlayerRunId,
          failureReasonCode: abortContext.failureReasonCode,
          checkpoint: abortContext.checkpoint,
        })
        if (relationPlan === null || relationPlan.kind !== 'abortHand') {
          throw new EndSessionHandlerInvariantError()
        }
        const { stateVersion: _checkpointVersion, ...stateContent } =
          checkpointState
        return {
          kind: 'prepared',
          mutation: {
            stateEffect: { kind: 'stateChanged', stateContent },
            lifecycleAfter: 'ended',
            currentHandIdAfter: null,
            playerCoordinationAfter: {
              agentRunState: 'idle',
              activePlayerRunId: null,
              activeDecisionRequestId: null,
            },
            privateEventDrafts: Object.freeze([handAborted, sessionEnded]),
            relationPlan,
          },
        }
      },
      async applyRelations({ writes, commandAt }, capability) {
        const plan = parseEndSessionRelationPlan(capability.relationPlan)
        if (plan === null) throw new EndSessionHandlerInvariantError()
        if (plan.kind === 'normalEnd') return
        const aborted = await writes.abortHand({
          sessionId: plan.sessionId,
          handId: plan.handId,
          failedAgentRunId: plan.failedPlayerRunId,
          reasonCode: plan.failureReasonCode,
          abortedAt: commandAt,
        })
        if (!equalValue(aborted.checkpoint, plan.checkpoint)) {
          throw new EndSessionHandlerInvariantError()
        }
      },
    },
    bindReadPort: (transaction: TransactionSql) =>
      Object.freeze({
        loadPausedAbortContext: (loadInput: {
          readonly sessionId: string
          readonly handId: string
          readonly actorParticipantId: string
          readonly sourceStateVersion: number
        }) => loadPausedAbortContext(transaction, input.owner, loadInput),
      }),
    bindWritePort: (transaction: TransactionSql) =>
      Object.freeze({
        abortHand: (abortInput: {
          readonly sessionId: string
          readonly handId: string
          readonly failedAgentRunId: string
          readonly reasonCode: string
          readonly abortedAt: string
        }) => abortHandAudit(transaction, input.owner, abortInput),
      }),
  })
}
