import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createStartNextHandHandlerBinding } from '../../src/sessions/command-execution/start-next-hand-handler.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000009'
const commandId = '30000000-0000-4000-8000-000000000001'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
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
const command = Object.freeze({
  sessionId,
  commandId,
  expectedStateVersion: 7,
  type: 'startNextHand' as const,
  payload: Object.freeze({}),
})

async function owner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function betweenHandsState(zeroSeats: readonly number[]) {
  const poker = createTestPokerState({
    seats: createTestPokerState().seats.map((seat) => {
      if (zeroSeats.includes(seat.seatNumber)) {
        return { ...seat, stack: 0, status: 'out' as const }
      }
      if (seat.seatNumber === 5) {
        return { ...seat, stack: 2_000 + zeroSeats.length * 2_000 }
      }
      return seat
    }),
  })
  return createPrivateTableState({
    stateVersion: 7,
    poker,
    completedHandCount: 1,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary:
      createTestCompletedPokerResult().completedHand.summary,
  })
}

function transactionReturning(response: readonly unknown[]): TransactionSql {
  const transaction = (() =>
    Promise.resolve(response)) as unknown as TransactionSql
  Object.assign(transaction, {
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return transaction
}

describe('start next hand handler', () => {
  test('auto-rebuys zero-stack AIs in seat order and checkpoints the command-before state', async () => {
    const state = betweenHandsState([1, 3])
    let idCalls = 0
    let randomCalls = 0
    const binding = createStartNextHandHandlerBinding({
      owner: await owner(),
      nextHandId: () => {
        idCalls += 1
        return handId
      },
      randomSource: {
        nextInt: () => {
          randomCalls += 1
          return 0
        },
      },
    })

    const prepared = await binding.handler.prepare({
      command,
      state,
      session,
      reads: binding.bindReadPort({} as never),
    })

    expect(prepared.kind).toBe('prepared')
    if (prepared.kind !== 'prepared') throw new Error('Expected prepared.')
    expect(idCalls).toBe(1)
    expect(randomCalls).toBeGreaterThan(0)
    expect(
      prepared.mutation.privateEventDrafts.map((event) => event.type),
    ).toEqual(['aiAutoRebuy', 'aiAutoRebuy', 'handStarted'])
    expect(
      prepared.mutation.privateEventDrafts
        .slice(0, 2)
        .map((event) =>
          event.type === 'aiAutoRebuy' ? event.seatNumber : null,
        ),
    ).toEqual([1, 3])
    expect(prepared.mutation.relationPlan).toMatchObject({
      kind: 'startNextHand',
      sessionId,
      handId,
      checkpoint: { stateBeforeStartCommand: state },
    })
    expect(prepared.mutation.relationPlan.checkpoint.pokerRuleSetVersion).toBe(
      POKER_RULE_SET_VERSION,
    )
    expect(
      prepared.mutation.relationPlan.checkpoint.startedHand.startingStacks.find(
        (seat) => seat.seatNumber === 1,
      )?.stack,
    ).toBe(2_000)
    expect(
      prepared.mutation.relationPlan.checkpoint.stateBeforeStartCommand.poker.seats.find(
        (seat) => seat.seatNumber === 1,
      )?.stack,
    ).toBe(0)

    await expect(
      binding.handler.applyRelations(
        {
          writes: binding.bindWritePort(
            transactionReturning([{ handId, handNumber: 2 }]),
          ),
          commandAt: '2026-08-11T04:00:00.000Z',
        },
        { relationPlan: prepared.mutation.relationPlan } as never,
      ),
    ).resolves.toBeUndefined()
  })

  test('rejects a zero-stack user before consuming an id or randomness', async () => {
    let idCalls = 0
    let randomCalls = 0
    const binding = createStartNextHandHandlerBinding({
      owner: await owner(),
      nextHandId: () => {
        idCalls += 1
        return handId
      },
      randomSource: {
        nextInt: () => {
          randomCalls += 1
          return 0
        },
      },
    })

    await expect(
      binding.handler.prepare({
        command,
        state: betweenHandsState([0]),
        session,
        reads: binding.bindReadPort({} as never),
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      rejection: { kind: 'userRebuyRequired' },
    })
    expect(idCalls).toBe(0)
    expect(randomCalls).toBe(0)
  })
})
