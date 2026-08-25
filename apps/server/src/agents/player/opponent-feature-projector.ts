import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import { isPlayerVisibleState } from '../../sessions/authoritative-state/player-information-boundary-guard.js'

export interface OpponentRateEvidence {
  readonly metric:
    | 'preflopVoluntaryParticipation'
    | 'preflopFullRaise'
    | 'facingAggressionFold'
    | 'facingAggressionCall'
    | 'facingAggressionRaise'
    | 'currentStreetAggression'
  readonly numerator: number
  readonly denominator: number
  readonly filterCode: string
  readonly firstEventSeq: number | null
  readonly lastEventSeq: number | null
}

export interface OpponentEvidenceProjectionData {
  readonly opponentEvidenceSchemaVersion: 1
  readonly sourceScope: 'currentHand'
  readonly asOfEventSeq: number
  readonly evidenceId: string
  readonly status: 'insufficientEvidence'
  readonly reasonCode: 'crossHandEvidenceUnavailable'
  readonly opponents: readonly {
    readonly participantId: string
    readonly seatNumber: number
    readonly evidence: readonly OpponentRateEvidence[]
  }[]
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function metric(
  name: OpponentRateEvidence['metric'],
  actions: PlayerVisibleState['hand']['publicActions'],
  isOpportunity: (
    action: PlayerVisibleState['hand']['publicActions'][number],
  ) => boolean,
  isSuccess: (
    action: PlayerVisibleState['hand']['publicActions'][number],
  ) => boolean,
  filterCode: string,
): OpponentRateEvidence {
  const opportunities = actions.filter(isOpportunity)
  const sequences = opportunities.map((action) => action.eventSeq)
  return {
    metric: name,
    numerator: opportunities.filter(isSuccess).length,
    denominator: opportunities.length,
    filterCode,
    firstEventSeq: sequences[0] ?? null,
    lastEventSeq: sequences.at(-1) ?? null,
  }
}

export function projectOpponentFeaturesV1(
  observation: PlayerVisibleState,
): OpponentEvidenceProjectionData {
  if (!isPlayerVisibleState(observation)) {
    throw new RangeError('对手证据只接受实时认证 Player 观察。')
  }
  const opponents = observation.table.seats
    .filter(
      (seat) =>
        seat.seatNumber !== observation.identity.actorSeat &&
        observation.hand.participantSeatNumbers.includes(seat.seatNumber),
    )
    .sort((left, right) => left.seatNumber - right.seatNumber)
    .map((seat) => {
      const actions = observation.hand.publicActions.filter(
        (action) => action.actorSeatNumber === seat.seatNumber,
      )
      const preflop = (action: (typeof actions)[number]) =>
        action.streetBefore === 'preflop'
      const facingAggression = (action: (typeof actions)[number]) =>
        action.amountToCallBefore > 0
      const aggressive = (action: (typeof actions)[number]) =>
        action.action.action.type === 'bet' ||
        action.action.action.type === 'raise' ||
        (action.action.action.type === 'allIn' &&
          action.currentBetAfter > action.currentBetBefore)
      return {
        participantId: seat.participantId,
        seatNumber: seat.seatNumber,
        evidence: [
          metric(
            'preflopVoluntaryParticipation',
            actions,
            preflop,
            (action) => action.isVoluntaryPreflopContribution,
            'actorActionOnPreflop',
          ),
          metric(
            'preflopFullRaise',
            actions,
            preflop,
            (action) => action.isFullRaise,
            'actorActionOnPreflop',
          ),
          metric(
            'facingAggressionFold',
            actions,
            facingAggression,
            (action) => action.action.action.type === 'fold',
            'amountToCallBeforePositive',
          ),
          metric(
            'facingAggressionCall',
            actions,
            facingAggression,
            (action) => action.action.action.type === 'call',
            'amountToCallBeforePositive',
          ),
          metric(
            'facingAggressionRaise',
            actions,
            facingAggression,
            aggressive,
            'amountToCallBeforePositive',
          ),
          metric(
            'currentStreetAggression',
            actions,
            (action) => action.streetBefore === observation.hand.street,
            aggressive,
            'actorActionOnCurrentStreet',
          ),
        ],
      }
    })
  const hashInput = {
    opponentEvidenceSchemaVersion: 1 as const,
    sourceScope: 'currentHand' as const,
    asOfEventSeq: observation.identity.asOfEventSeq,
    opponents,
  }
  const evidenceId = createHash('sha256')
    .update(canonicalJson(hashInput as unknown as JsonValue), 'utf8')
    .digest('hex')
  return deepFreeze({
    ...hashInput,
    evidenceId,
    status: 'insufficientEvidence',
    reasonCode: 'crossHandEvidenceUnavailable',
  })
}
