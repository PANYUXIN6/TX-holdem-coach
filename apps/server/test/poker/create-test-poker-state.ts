import {
  createPokerState,
  type PokerState,
  type PokerStateInput,
} from '../../src/poker/state.js'

type DeepPartial<Value> = Value extends readonly (infer Item)[]
  ? readonly DeepPartial<Item>[]
  : Value extends object
    ? { [Key in keyof Value]?: DeepPartial<Value[Key]> }
    : Value

const SIX_PLAYER_BASELINE: PokerStateInput = {
  stateVersion: 0,
  pokerPhase: 'betweenHands',
  seats: [
    {
      seatNumber: 0,
      playerId: '00000000-0000-4000-8000-000000000001',
      isUser: true,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 1,
      playerId: '00000000-0000-4000-8000-000000000002',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 2,
      playerId: '00000000-0000-4000-8000-000000000003',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 3,
      playerId: '00000000-0000-4000-8000-000000000004',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 4,
      playerId: '00000000-0000-4000-8000-000000000005',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
    {
      seatNumber: 5,
      playerId: '00000000-0000-4000-8000-000000000006',
      isUser: false,
      stack: 2000,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    },
  ],
  buttonSeatNumber: 0,
  blinds: { smallBlind: 10, bigBlind: 20 },
  hand: null,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeTestState(base: unknown, overrides: unknown): unknown {
  if (overrides === undefined) {
    return structuredClone(base)
  }

  if (Array.isArray(overrides)) {
    return structuredClone(overrides)
  }

  if (isRecord(base) && isRecord(overrides)) {
    const merged: Record<string, unknown> = structuredClone(base)

    for (const [key, overrideValue] of Object.entries(overrides)) {
      merged[key] = mergeTestState(base[key], overrideValue)
    }

    return merged
  }

  return structuredClone(overrides)
}

export function createTestPokerState(
  overrides: DeepPartial<PokerStateInput> = {},
): PokerState {
  return createPokerState(mergeTestState(SIX_PLAYER_BASELINE, overrides))
}
