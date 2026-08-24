import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import {
  createInitialBettingProjection,
  getProjectedLegalActions,
  projectActionContinuation,
  verifyBettingActionEvidence,
  type BettingProjectionState,
} from '../../poker/betting-projection.js'
import { assignLogicalPositions } from '../../poker/positioning.js'
import {
  isPlayerObservationDraft,
  type PlayerObservationDraft,
} from './player-observation-builder.js'
import {
  PlayerObservationBoundaryError,
  PlayerVisibleStateDataSchema,
  type PlayerVisibleState,
  type PlayerVisibleStateData,
} from './player-visible-state.js'

const certifiedPlayerVisibleStates = new WeakSet<object>()
const ACTION_STREETS = new Set(['preflop', 'flop', 'turn', 'river'])
const FORBIDDEN_KEYS = new Set([
  'authorization',
  'apikey',
  'databaseownerid',
  'databaseurl',
  'leaseowner',
  'fencingtoken',
  'reasoning',
  'reasoningtext',
  'reasoning_content',
])
const FORBIDDEN_STRUCTURE_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
])
const CREDENTIAL_PATTERNS = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/iu,
  /\bpostgres(?:ql)?:\/\/[^\s]+/iu,
  /\bhttps:\/\/[^\s/@]+:[^\s/@]+@[^\s]+/iu,
]

function reject(): never {
  throw new PlayerObservationBoundaryError()
}

function assertPlainJson(
  value: unknown,
  ancestors: Set<object> = new Set(),
): asserts value is JsonValue {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isSafeInteger(value)) reject()
    return
  }
  if (typeof value !== 'object') reject()
  if (ancestors.has(value)) reject()
  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) reject()
  } else if (prototype !== Object.prototype && prototype !== null) {
    reject()
  }
  ancestors.add(value)
  if (Array.isArray(value)) {
    if (
      Object.keys(value).length !== value.length ||
      Reflect.ownKeys(value).length !== value.length + 1
    ) {
      reject()
    }
    for (const entry of value) assertPlainJson(entry, ancestors)
    ancestors.delete(value)
    return
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || FORBIDDEN_STRUCTURE_KEYS.has(key)) reject()
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      'get' in descriptor ||
      descriptor.value === undefined
    ) {
      reject()
    }
    assertPlainJson(descriptor.value, ancestors)
  }
  ancestors.delete(value)
}

function assertNoSensitiveValues(value: JsonValue): void {
  if (typeof value === 'string') {
    if (CREDENTIAL_PATTERNS.some((pattern) => pattern.test(value))) reject()
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveValues(entry)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(key.toLocaleLowerCase('en-US'))) reject()
      assertNoSensitiveValues(entry)
    }
  }
}

function isStrictlyIncreasing(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value > (values[index - 1] as number),
  )
}

function hasSameValues(
  left: readonly number[],
  right: readonly number[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  )
}

function assertObservationInvariants(data: PlayerVisibleStateData): void {
  const seats = data.table.seats
  const seatNumbers = seats.map((seat) => seat.seatNumber)
  const participantIds = seats.map((seat) => seat.participantId)
  if (
    !isStrictlyIncreasing(seatNumbers) ||
    new Set(participantIds).size !== participantIds.length ||
    seats.filter((seat) => seat.isUser).length !== 1 ||
    seats.some(
      (seat) =>
        (seat.isUser && seat.seatNumber !== 0) ||
        (!seat.isUser && seat.seatNumber === 0) ||
        seat.totalContribution < seat.streetContribution,
    ) ||
    !seatNumbers.includes(data.table.buttonSeatNumber)
  ) {
    reject()
  }

  const actor = seats.find(
    (seat) => seat.seatNumber === data.identity.actorSeat,
  )
  if (
    actor === undefined ||
    actor.isUser ||
    actor.participantId !== data.identity.actorParticipantId ||
    actor.status !== 'active' ||
    actor.stack <= 0 ||
    data.hand.currentActorSeatNumber !== data.identity.actorSeat
  ) {
    reject()
  }

  const participantSeats = data.hand.participantSeatNumbers
  const positionSeats = data.hand.positions.map((entry) => entry.seatNumber)
  const startingStackSeats = data.hand.startingStacks.map(
    (entry) => entry.seatNumber,
  )
  const bettingSeats = data.hand.bettingRound.seatStates.map(
    (entry) => entry.seatNumber,
  )
  const expectedParticipantSeats = seats
    .filter((seat) => seat.status !== 'out')
    .map((seat) => seat.seatNumber)
  if (
    !isStrictlyIncreasing(participantSeats) ||
    !isStrictlyIncreasing(positionSeats) ||
    !isStrictlyIncreasing(startingStackSeats) ||
    !isStrictlyIncreasing(bettingSeats) ||
    !hasSameValues(participantSeats, positionSeats) ||
    !hasSameValues(participantSeats, startingStackSeats) ||
    !hasSameValues(participantSeats, bettingSeats) ||
    !hasSameValues(participantSeats, expectedParticipantSeats) ||
    !participantSeats.includes(data.hand.smallBlindSeatNumber) ||
    !participantSeats.includes(data.hand.bigBlindSeatNumber) ||
    !participantSeats.includes(data.identity.actorSeat) ||
    new Set(data.hand.positions.map((entry) => entry.position)).size !==
      data.hand.positions.length
  ) {
    reject()
  }

  const positionBySeat = new Map(
    data.hand.positions.map((entry) => [entry.seatNumber, entry.position]),
  )
  let expectedPositions
  try {
    expectedPositions = assignLogicalPositions(
      data.table.buttonSeatNumber,
      participantSeats,
    )
  } catch {
    reject()
  }
  if (
    positionBySeat.get(data.table.buttonSeatNumber) !== 'BTN' ||
    positionBySeat.get(data.hand.smallBlindSeatNumber) !== 'SB' ||
    positionBySeat.get(data.hand.bigBlindSeatNumber) !== 'BB' ||
    expectedPositions.some(
      (expected) =>
        positionBySeat.get(expected.seatNumber) !== expected.position,
    )
  ) {
    reject()
  }

  const expectedBoardSize = {
    preflop: 0,
    flop: 3,
    turn: 4,
    river: 5,
  }[data.hand.street]
  const cardKeys = [...data.hand.heroHoleCards, ...data.hand.board].map(
    (card) => `${card.rank}:${card.suit}`,
  )
  if (
    !ACTION_STREETS.has(data.hand.street) ||
    data.hand.board.length !== expectedBoardSize ||
    new Set(cardKeys).size !== cardKeys.length ||
    data.hand.pot !==
      seats.reduce((total, seat) => total + seat.totalContribution, 0) ||
    data.hand.bettingRound.seatStates.some((seatState) => {
      const seat = seats.find(
        (candidate) => candidate.seatNumber === seatState.seatNumber,
      )
      return (
        seat === undefined ||
        seat.streetContribution > data.hand.bettingRound.currentBet ||
        (seatState.betLevelAfterLastAction !== null &&
          seatState.betLevelAfterLastAction > data.hand.bettingRound.currentBet)
      )
    })
  ) {
    reject()
  }

  let previousEventSeq = -1
  let previousStateVersionAfter = -1
  for (const action of data.hand.publicActions) {
    if (
      action.eventSeq <= previousEventSeq ||
      action.eventSeq > data.identity.asOfEventSeq ||
      (previousStateVersionAfter >= 0 &&
        action.stateVersionBefore !== previousStateVersionAfter) ||
      action.stateVersionAfter !== action.stateVersionBefore + 1 ||
      action.stateVersionAfter > data.identity.stateVersion ||
      action.actorSeatNumber !== action.action.actorSeatNumber ||
      !participantSeats.includes(action.actorSeatNumber)
    ) {
      reject()
    }
    previousEventSeq = action.eventSeq
    previousStateVersionAfter = action.stateVersionAfter
  }

  if (
    data.hand.publicActions.length > 0 &&
    previousStateVersionAfter !== data.identity.stateVersion
  ) {
    reject()
  }

  try {
    let replayState: BettingProjectionState = createInitialBettingProjection({
      buttonSeatNumber: data.table.buttonSeatNumber,
      participantSeatNumbers: data.hand.participantSeatNumbers,
      smallBlindSeatNumber: data.hand.smallBlindSeatNumber,
      bigBlindSeatNumber: data.hand.bigBlindSeatNumber,
      startingStacks: data.hand.startingStacks,
      nonParticipantSeats: data.table.seats
        .filter((seat) => seat.status === 'out')
        .map((seat) => ({
          seatNumber: seat.seatNumber,
          status: seat.status,
          stack: seat.stack,
          streetContribution: seat.streetContribution,
          totalContribution: seat.totalContribution,
        })),
    })
    for (const action of data.hand.publicActions) {
      if (action.streetBefore !== replayState.street) reject()
      const transition = verifyBettingActionEvidence(replayState, action)
      const continuation = projectActionContinuation(
        transition.state,
        transition.actorSeatNumber,
      )
      if (
        continuation.kind === 'complete' ||
        continuation.kind === 'showdown'
      ) {
        reject()
      }
      replayState = continuation.state
    }
    if (
      replayState.street !== data.hand.street ||
      replayState.currentActorSeatNumber !== data.hand.currentActorSeatNumber ||
      replayState.pot !== data.hand.pot ||
      replayState.seats.length !== data.table.seats.length ||
      replayState.seats.some((seat, index) => {
        const current = data.table.seats[index]
        return (
          current === undefined ||
          seat.seatNumber !== current.seatNumber ||
          seat.status !== current.status ||
          seat.stack !== current.stack ||
          seat.streetContribution !== current.streetContribution ||
          seat.totalContribution !== current.totalContribution
        )
      }) ||
      replayState.bettingRound.currentBet !==
        data.hand.bettingRound.currentBet ||
      replayState.bettingRound.minimumFullRaiseIncrement !==
        data.hand.bettingRound.minimumFullRaiseIncrement ||
      replayState.bettingRound.seatStates.length !==
        data.hand.bettingRound.seatStates.length ||
      replayState.bettingRound.seatStates.some((seatState, index) => {
        const current = data.hand.bettingRound.seatStates[index]
        return (
          current === undefined ||
          seatState.seatNumber !== current.seatNumber ||
          seatState.betLevelAfterLastAction !== current.betLevelAfterLastAction
        )
      }) ||
      JSON.stringify(getProjectedLegalActions(replayState)) !==
        JSON.stringify(data.hand.legalActions)
    ) {
      reject()
    }
  } catch (error) {
    if (error instanceof PlayerObservationBoundaryError) throw error
    reject()
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function validatePlayerVisibleStateData(
  input: unknown,
): PlayerVisibleStateData {
  assertPlainJson(input)
  assertNoSensitiveValues(input)
  const parsed = PlayerVisibleStateDataSchema.safeParse(input)
  if (!parsed.success) reject()
  const data = parsed.data as PlayerVisibleStateData
  assertObservationInvariants(data)
  return data
}

export function certifyPlayerVisibleState(
  input: PlayerObservationDraft,
): PlayerVisibleState {
  if (!isPlayerObservationDraft(input) || !Object.isFrozen(input)) reject()
  const data = validatePlayerVisibleStateData(input)
  const serialized = canonicalJson(data as JsonValue)
  const observationSha256 = createHash('sha256')
    .update(serialized, 'utf8')
    .digest('hex')
  const certified = deepFreeze({
    ...data,
    observationSha256,
  }) as PlayerVisibleState
  certifiedPlayerVisibleStates.add(certified)
  return certified
}

export function isPlayerVisibleState(
  value: unknown,
): value is PlayerVisibleState {
  return (
    typeof value === 'object' &&
    value !== null &&
    certifiedPlayerVisibleStates.has(value) &&
    Object.isFrozen(value)
  )
}
