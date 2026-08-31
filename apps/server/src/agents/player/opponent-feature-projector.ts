import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'
import { isPlayerVisibleState } from '../../sessions/authoritative-state/player-information-boundary-guard.js'
import {
  decodePlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
  type AgentMemoryPayloadV1,
  type PlayerMemoryMetric,
} from './player-session-memory.js'

type OpponentMetric = PlayerMemoryMetric

export interface PlayerSessionMemoryEvidenceInputV1 {
  readonly revision: number
  readonly payloadVersion: 1
  readonly payload: AgentMemoryPayloadV1
  readonly sha256: string
  readonly asOfEventSeq: number
}

export interface OpponentRateEvidence {
  readonly metric: OpponentMetric
  readonly numerator: number
  readonly denominator: number
  readonly distinctHandCount: number
  readonly source: 'currentHandAndSessionMemory'
  readonly memoryRevision: number
  readonly historyAsOfEventSeq: number
  readonly currentHandAsOfEventSeq: number
  readonly confidence: 'insufficient' | 'low' | 'medium' | 'high'
  readonly filterCode: string
  readonly firstEventSeq: number | null
  readonly lastEventSeq: number | null
}

export interface OpponentEvidenceProjectionData {
  readonly opponentEvidenceSchemaVersion: 1
  readonly sourceScope: 'currentHandAndSessionMemory'
  readonly memoryRevision: number
  readonly historyAsOfEventSeq: number
  readonly asOfEventSeq: number
  readonly evidenceId: string
  readonly status: 'insufficientEvidence' | 'available'
  readonly reasonCode: 'insufficientEvidence' | null
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

function confidence(input: {
  readonly denominator: number
  readonly distinctHandCount: number
}): OpponentRateEvidence['confidence'] {
  if (input.denominator < 10 || input.distinctHandCount < 5)
    return 'insufficient'
  if (input.denominator >= 50 && input.distinctHandCount >= 20) return 'high'
  if (input.denominator >= 25 && input.distinctHandCount >= 10) return 'medium'
  return 'low'
}

function metric(
  name: OpponentMetric,
  actions: PlayerVisibleState['hand']['publicActions'],
  isOpportunity: (
    action: PlayerVisibleState['hand']['publicActions'][number],
  ) => boolean,
  isSuccess: (
    action: PlayerVisibleState['hand']['publicActions'][number],
  ) => boolean,
  filterCode: string,
  history: {
    readonly numerator: number
    readonly denominator: number
    readonly distinctHandCount: number
  },
  sessionMemory: PlayerSessionMemoryEvidenceInputV1,
  currentHandAsOfEventSeq: number,
): OpponentRateEvidence {
  const opportunities = actions.filter(isOpportunity)
  const sequences = opportunities.map((action) => action.eventSeq)
  const currentDenominator = opportunities.length
  const numerator = history.numerator + opportunities.filter(isSuccess).length
  const denominator = history.denominator + currentDenominator
  const distinctHandCount =
    history.distinctHandCount + (currentDenominator === 0 ? 0 : 1)
  return {
    metric: name,
    numerator,
    denominator,
    distinctHandCount,
    source: 'currentHandAndSessionMemory',
    memoryRevision: sessionMemory.revision,
    historyAsOfEventSeq: sessionMemory.asOfEventSeq,
    currentHandAsOfEventSeq,
    confidence: confidence({ denominator, distinctHandCount }),
    filterCode,
    firstEventSeq: sequences[0] ?? null,
    lastEventSeq: sequences.at(-1) ?? null,
  }
}

export function projectOpponentFeaturesV1(
  observation: PlayerVisibleState,
  sessionMemory: PlayerSessionMemoryEvidenceInputV1,
): OpponentEvidenceProjectionData {
  if (!isPlayerVisibleState(observation)) {
    throw new RangeError('对手证据只接受实时认证 Player 观察。')
  }
  const payload = decodePlayerSessionMemoryV1(sessionMemory.payload)
  if (
    sessionMemory.payloadVersion !== 1 ||
    !Number.isSafeInteger(sessionMemory.revision) ||
    sessionMemory.revision <= 0 ||
    !Number.isSafeInteger(sessionMemory.asOfEventSeq) ||
    sessionMemory.asOfEventSeq < 0 ||
    hashPlayerSessionMemoryV1(payload) !== sessionMemory.sha256
  ) {
    throw new RangeError('对手证据的 Session Memory 引用无效。')
  }
  const historyByParticipantId = new Map(
    payload.opponents.map((opponent) => [opponent.participantId, opponent]),
  )
  const opponents = observation.table.seats
    .filter(
      (seat) =>
        seat.seatNumber !== observation.identity.actorSeat &&
        observation.hand.participantSeatNumbers.includes(seat.seatNumber),
    )
    .sort((left, right) => left.seatNumber - right.seatNumber)
    .map((seat) => {
      const history = historyByParticipantId.get(seat.participantId)
      if (history !== undefined && history.seatNumber !== seat.seatNumber) {
        throw new RangeError('对手证据的 Memory 座位绑定无效。')
      }
      const actions = observation.hand.publicActions.filter(
        (action) => action.actorSeatNumber === seat.seatNumber,
      )
      const memoryMetric = (name: OpponentMetric) =>
        history?.metrics.find((entry) => entry.metric === name) ?? {
          numerator: 0,
          denominator: 0,
          distinctHandCount: 0,
        }
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
            memoryMetric('preflopVoluntaryParticipation'),
            sessionMemory,
            observation.identity.asOfEventSeq,
          ),
          metric(
            'preflopFullRaise',
            actions,
            preflop,
            (action) => action.isFullRaise,
            'actorActionOnPreflop',
            memoryMetric('preflopFullRaise'),
            sessionMemory,
            observation.identity.asOfEventSeq,
          ),
          metric(
            'facingAggressionFold',
            actions,
            facingAggression,
            (action) => action.action.action.type === 'fold',
            'amountToCallBeforePositive',
            memoryMetric('facingAggressionFold'),
            sessionMemory,
            observation.identity.asOfEventSeq,
          ),
          metric(
            'facingAggressionCall',
            actions,
            facingAggression,
            (action) => action.action.action.type === 'call',
            'amountToCallBeforePositive',
            memoryMetric('facingAggressionCall'),
            sessionMemory,
            observation.identity.asOfEventSeq,
          ),
          metric(
            'facingAggressionRaise',
            actions,
            facingAggression,
            aggressive,
            'amountToCallBeforePositive',
            memoryMetric('facingAggressionRaise'),
            sessionMemory,
            observation.identity.asOfEventSeq,
          ),
          metric(
            'currentStreetAggression',
            actions,
            (action) => action.streetBefore === observation.hand.street,
            aggressive,
            'actorActionOnCurrentStreet',
            memoryMetric('currentStreetAggression'),
            sessionMemory,
            observation.identity.asOfEventSeq,
          ),
        ],
      }
    })
  const hashInput = {
    opponentEvidenceSchemaVersion: 1 as const,
    sourceScope: 'currentHandAndSessionMemory' as const,
    memoryRevision: sessionMemory.revision,
    historyAsOfEventSeq: sessionMemory.asOfEventSeq,
    asOfEventSeq: observation.identity.asOfEventSeq,
    opponents,
  }
  const evidenceId = createHash('sha256')
    .update(canonicalJson(hashInput as unknown as JsonValue), 'utf8')
    .digest('hex')
  const hasUsableEvidence = opponents.some(({ evidence }) =>
    evidence.some(({ confidence: value }) => value !== 'insufficient'),
  )
  return deepFreeze({
    ...hashInput,
    evidenceId,
    status: hasUsableEvidence
      ? ('available' as const)
      : ('insufficientEvidence' as const),
    reasonCode: hasUsableEvidence ? null : ('insufficientEvidence' as const),
  })
}
