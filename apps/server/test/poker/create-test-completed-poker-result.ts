import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { createPokerTableState } from '../../src/poker/state.js'

const seats = Array.from({ length: 6 }, (_, seatNumber) => ({
  seatNumber,
  playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
    .toString()
    .padStart(12, '0')}`,
  isUser: seatNumber === 0,
  stack: 1_000,
  status: 'active' as const,
  streetContribution: 0,
  totalContribution: 0,
}))

const randomSource = Object.freeze({
  nextInt: (maximum: number) => 0 % maximum,
})

export function createTestCompletedPokerResult() {
  const started = startPokerHand(initializePokerTable(seats, randomSource), {
    handId: '10000000-0000-4000-8000-000000000001',
    completedHandCountBeforeStart: 0,
    randomSource,
  })
  const terminalState = createPokerTableState({
    ...started.state,
    seats: started.state.seats.map((seat) => ({
      ...seat,
      status:
        seat.seatNumber === 2 || seat.seatNumber === 3
          ? ('active' as const)
          : ('folded' as const),
    })),
  })
  const result = applyPokerAction(terminalState, {
    actorSeatNumber: 3,
    action: { type: 'fold' },
  })
  const completedHand = result.completedHand
  if (completedHand === null) {
    throw new Error('Expected a completed poker result.')
  }
  return Object.freeze({ ...result, completedHand })
}
