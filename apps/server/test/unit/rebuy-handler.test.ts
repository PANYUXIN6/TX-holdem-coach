import { describe, expect, test } from 'vitest'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createRebuyHandlerBinding } from '../../src/sessions/command-execution/rebuy-handler.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const commandId = '30000000-0000-4000-8000-000000000001'
const session = Object.freeze({
  sessionId,
  lifecycleStatus: 'active' as const,
  endedAt: null,
  stateVersion: 7,
  nextEventSeq: 4,
  currentHandId: null,
  diagnosticCode: null,
  diagnosedAt: null,
  agentRunState: 'idle' as const,
  activePlayerRunId: null,
  activeDecisionRequestId: null,
})

function state(userStack: number, userBuyIn = 2_000) {
  const poker = createTestPokerState({
    seats: createTestPokerState().seats.map((seat) =>
      seat.seatNumber === 0
        ? {
            ...seat,
            stack: userStack,
            status: userStack === 0 ? ('out' as const) : ('active' as const),
          }
        : seat.seatNumber === 1
          ? { ...seat, stack: 4_000 - userStack }
          : seat,
    ),
  })
  return createPrivateTableState({
    stateVersion: 7,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: seat.seatNumber === 0 ? userBuyIn : 2_000,
    })),
    lastCompletedHandSummary: null,
  })
}

function command(amount: number) {
  return {
    sessionId,
    commandId,
    expectedStateVersion: 7,
    type: 'rebuy' as const,
    payload: { amount },
  }
}

describe('rebuy handler', () => {
  test('prepares one mirrored user rebuy without relation writes', async () => {
    const binding = createRebuyHandlerBinding()
    const prepared = await binding.handler.prepare({
      command: command(500),
      state: state(1_000),
      session,
      reads: binding.bindReadPort({} as never),
    })

    expect(prepared).toMatchObject({
      kind: 'prepared',
      mutation: {
        lifecycleAfter: 'active',
        currentHandIdAfter: null,
        relationPlan: { kind: 'rebuy' },
        privateEventDrafts: [
          {
            type: 'userRebuy',
            amount: 500,
            stackBefore: 1_000,
            stackAfter: 1_500,
            cumulativeBuyInBefore: 2_000,
            cumulativeBuyInAfter: 2_500,
          },
        ],
      },
    })
    if (prepared.kind !== 'prepared') throw new Error('Expected prepared.')
    expect(
      prepared.mutation.stateEffect.kind === 'stateChanged'
        ? prepared.mutation.stateEffect.stateContent.poker.seats.find(
            (seat) => seat.seatNumber === 0,
          )?.stack
        : null,
    ).toBe(1_500)
    await expect(
      binding.handler.applyRelations(
        { writes: binding.bindWritePort({} as never), commandAt: '' },
        { relationPlan: prepared.mutation.relationPlan } as never,
      ),
    ).resolves.toBeUndefined()
  })

  test('accepts exactly 2000 from zero and rejects every other invalid amount', async () => {
    const binding = createRebuyHandlerBinding()
    const exact = await binding.handler.prepare({
      command: command(2_000),
      state: state(0),
      session,
      reads: binding.bindReadPort({} as never),
    })
    expect(exact.kind).toBe('prepared')

    for (const [userStack, amount] of [
      [0, 1_999],
      [0, 2_001],
      [1_500, 501],
      [2_000, 1],
    ] as const) {
      await expect(
        binding.handler.prepare({
          command: command(amount),
          state: state(userStack),
          session,
          reads: binding.bindReadPort({} as never),
        }),
      ).resolves.toEqual({
        kind: 'rejected',
        rejection: { kind: 'rebuyAmountNotAllowed' },
      })
    }
  })
})
