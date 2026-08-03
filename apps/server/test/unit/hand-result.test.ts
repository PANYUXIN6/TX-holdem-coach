import type { Card } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import {
  CompletedHandSummarySchema,
  classifyStartingHand,
  createActionCommittedEventDraft,
  createCompletedHandResult,
  createHandStartedEventDraft,
  createStartedHandFacts,
  createUncalledBetReturnedEventDraft,
} from '../../src/poker/hand-result.js'
import type { PokerCommand } from '../../src/poker/commands.js'
import type { SettlementFacts } from '../../src/poker/settlement.js'
import { createPokerTableState } from '../../src/poker/state.js'

const ids = Array.from(
  { length: 6 },
  (_, seatNumber) => `00000000-0000-4000-8000-00000000000${seatNumber + 1}`,
)
const cards: readonly Card[] = [
  { rank: 'A', suit: 'spades' },
  { rank: 'A', suit: 'hearts' },
  { rank: 'K', suit: 'spades' },
  { rank: 'Q', suit: 'spades' },
  { rank: 'K', suit: 'hearts' },
  { rank: 'Q', suit: 'hearts' },
  { rank: 'J', suit: 'spades' },
  { rank: 'T', suit: 'spades' },
  { rank: '9', suit: 'spades' },
  { rank: '8', suit: 'spades' },
  { rank: '7', suit: 'spades' },
  { rank: '6', suit: 'spades' },
]

function started() {
  return {
    handId: '10000000-0000-4000-8000-000000000001',
    handNumber: 1,
    participantSeatNumbers: [5, 4, 3, 2, 1, 0],
    buttonSeatNumber: 0,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    positions: [
      { seatNumber: 5, position: 'UTG' as const },
      { seatNumber: 4, position: 'HJ' as const },
      { seatNumber: 3, position: 'CO' as const },
      { seatNumber: 0, position: 'BTN' as const },
      { seatNumber: 1, position: 'SB' as const },
      { seatNumber: 2, position: 'BB' as const },
    ],
    startingStacks: [5, 4, 3, 2, 1, 0].map((seatNumber) => ({
      seatNumber,
      stack: 1000,
    })),
  }
}

function facts(): SettlementFacts {
  return {
    hand: {
      handId: '10000000-0000-4000-8000-000000000001',
      terminationReason: 'complete',
      buttonSeatNumber: 0,
      remainingDeck: [],
      burnedCards: [],
      board: [],
      pot: 600,
      seats: ids.map((playerId, seatNumber) => ({
        seatNumber,
        playerId,
        isUser: seatNumber === 0,
        statusAtTermination: seatNumber === 0 ? 'active' : 'folded',
        startingStack: 1000,
        streetContribution: 100,
        totalContribution: 100,
      })),
      participants: ids.map((_, seatNumber) => ({
        seatNumber,
        holeCards: [
          cards[seatNumber * 2] as Card,
          cards[seatNumber * 2 + 1] as Card,
        ],
      })),
    },
    uncalledBetReturns: [],
    pots: [
      {
        potIndex: 0,
        kind: 'main',
        amount: 600,
        contributingSeatNumbers: [0, 1, 2, 3, 4, 5],
        eligibleSeatNumbers: [0],
        winningSeatNumbers: [0],
        awards: [
          { seatNumber: 0, baseAmount: 600, oddChipAmount: 0, amount: 600 },
        ],
      },
    ],
    handEvaluations: [],
  }
}

function finalState() {
  return createPokerTableState({
    pokerPhase: 'betweenHands',
    buttonSeatNumber: 0,
    blinds: { smallBlind: 10, bigBlind: 20 },
    hand: null,
    seats: ids.map((playerId, seatNumber) => ({
      seatNumber,
      playerId,
      isUser: seatNumber === 0,
      stack: seatNumber === 0 ? 1500 : 900,
      status: 'active',
      streetContribution: 0,
      totalContribution: 0,
    })),
  })
}

describe('hand result facts', () => {
  function actionDraft(
    street: 'preflop' | 'flop' | 'turn' | 'river',
    action: PokerCommand['action'],
    statistics: {
      isVoluntaryPreflopContribution: boolean
      isPreflopRaise: boolean
      isVoluntaryPreflopFullRaise: boolean
      canMakeFullRaiseBeforeAction: boolean
    },
  ) {
    return createActionCommittedEventDraft({
      handId: '10000000-0000-4000-8000-000000000001',
      actorSeatNumber: 0,
      command: { actorSeatNumber: 0, action },
      legalActionsBefore: [
        { type: 'fold' },
        ...(action.type === 'call'
          ? [{ type: 'call' as const, amount: 10 }]
          : action.type === 'check'
            ? [{ type: 'check' as const }]
            : action.type === 'allIn'
              ? [{ type: 'allIn' as const, target: 10 }]
              : action.type === 'bet' || action.type === 'raise'
                ? [
                    {
                      type: action.type,
                      minTarget: 20,
                      maxTarget: 40,
                      suggestedTargets: [
                        {
                          kind: 'minimum' as const,
                          targetStreetCommitment: 20,
                        },
                      ],
                    },
                  ]
                : []),
      ],
      before: {
        street,
        board: [],
        currentActorSeatNumber: 0,
        pot: 0,
        seats: [
          {
            seatNumber: 0,
            status: 'active',
            stack: 10,
            streetContribution: 0,
            totalContribution: 0,
          },
        ],
      },
      after: {
        street,
        board: [],
        currentActorSeatNumber: 1,
        pot: 10,
        seats: [
          {
            seatNumber: 0,
            status: action.type === 'fold' ? 'folded' : 'active',
            stack: 0,
            streetContribution: 10,
            totalContribution: 10,
          },
        ],
      },
      progression: {
        streetTransitions: [],
        burnedCardsAdded: [],
        boardCardsAdded: [],
        terminationReason: null,
      },
      statistics,
    })
  }

  test('classifies pairs, suited and offsuit hands independently of card order', () => {
    expect(classifyStartingHand([cards[0] as Card, cards[1] as Card])).toBe(
      'AA',
    )
    expect(classifyStartingHand([cards[2] as Card, cards[0] as Card])).toBe(
      'AKs',
    )
    expect(classifyStartingHand([cards[4] as Card, cards[0] as Card])).toBe(
      'AKo',
    )
  })

  test('sorts and freezes started facts without retaining input references', () => {
    const input = started()
    const result = createStartedHandFacts(input)
    input.participantSeatNumbers[0] = 0
    expect(result.participantSeatNumbers).toEqual([0, 1, 2, 3, 4, 5])
    expect(result.positions.map((item) => item.seatNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.positions)).toBe(true)
  })

  test('copies settlement facts into a frozen completed result and private summary', () => {
    const settlementFacts = facts()
    const result = createCompletedHandResult({
      ...started(),
      facts: settlementFacts,
      state: finalState(),
    })
    expect(result.seats[0]).toMatchObject({
      startingStack: 1000,
      endingStack: 1500,
      netChange: 500,
      startingHandCategory: 'AA',
    })
    expect(result.pots).not.toBe(settlementFacts.pots)
    expect(result.summary).not.toHaveProperty('remainingDeck')
    expect(result.summary.participantHands).toEqual([
      { seatNumber: 0, holeCards: [cards[0], cards[1]], handEvaluation: null },
      { seatNumber: 1, holeCards: [cards[2], cards[3]], handEvaluation: null },
      { seatNumber: 2, holeCards: [cards[4], cards[5]], handEvaluation: null },
      { seatNumber: 3, holeCards: [cards[6], cards[7]], handEvaluation: null },
      { seatNumber: 4, holeCards: [cards[8], cards[9]], handEvaluation: null },
      {
        seatNumber: 5,
        holeCards: [cards[10], cards[11]],
        handEvaluation: null,
      },
    ])
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.pots)).toBe(true)
  })

  test('strictly parses a completed-hand summary owned by the poker domain', () => {
    const result = createCompletedHandResult({
      ...started(),
      facts: facts(),
      state: finalState(),
    })

    expect(CompletedHandSummarySchema.parse(result.summary)).toEqual(
      result.summary,
    )
    expect(() =>
      CompletedHandSummarySchema.parse({ ...result.summary, extra: true }),
    ).toThrow()
  })

  test('rejects damaged stack deltas, blind positions and starting-hand mirrors', () => {
    const summary = createCompletedHandResult({
      ...started(),
      facts: facts(),
      state: finalState(),
    }).summary
    const invalidSummaries = [
      {
        ...summary,
        seats: summary.seats.map((seat) =>
          seat.seatNumber === 0 ? { ...seat, netChange: 1_277 } : seat,
        ),
      },
      {
        ...summary,
        positions: summary.positions.map((position) =>
          position.seatNumber === summary.buttonSeatNumber
            ? { ...position, position: 'SB' as const }
            : position.seatNumber === summary.smallBlindSeatNumber
              ? { ...position, position: 'BTN' as const }
              : position,
        ),
      },
      {
        ...summary,
        seats: summary.seats.map((seat) =>
          seat.seatNumber === 0
            ? { ...seat, startingHandCategory: '22' as const }
            : seat,
        ),
      },
    ]

    for (const invalidSummary of invalidSummaries) {
      expect(CompletedHandSummarySchema.safeParse(invalidSummary).success).toBe(
        false,
      )
    }
  })

  test('rejects an evaluation for a folded showdown participant', () => {
    const base = facts()
    const showdown: SettlementFacts = {
      ...base,
      hand: { ...base.hand, terminationReason: 'showdown' },
      handEvaluations: [
        {
          seatNumber: 1,
          evaluation: {
            category: 'onePair',
            comparisonGrade: [1, 14, 13, 12, 11, 10],
            bestFive: [
              cards[0] as Card,
              cards[1] as Card,
              cards[2] as Card,
              cards[3] as Card,
              cards[4] as Card,
            ],
            displayName: '一对',
          },
        },
      ],
    }
    expect(() =>
      createCompletedHandResult({
        ...started(),
        facts: showdown,
        state: finalState(),
      }),
    ).toThrow(RangeError)
  })

  test('copies only existing showdown evaluations into immutable participant hands', () => {
    const base = facts()
    const evaluation = {
      category: 'onePair' as const,
      comparisonGrade: [1, 14, 13, 12, 11, 10] as const,
      bestFive: [
        cards[0] as Card,
        cards[1] as Card,
        cards[2] as Card,
        cards[3] as Card,
        cards[4] as Card,
      ] as const,
      displayName: '一对',
    }
    const showdown: SettlementFacts = {
      ...base,
      hand: {
        ...base.hand,
        terminationReason: 'showdown',
        participants: [...base.hand.participants].reverse(),
      },
      handEvaluations: [
        {
          seatNumber: 0,
          evaluation,
        },
      ],
    }
    const result = createCompletedHandResult({
      ...started(),
      facts: showdown,
      state: finalState(),
    })
    expect(
      result.summary.participantHands.map((hand) => hand.seatNumber),
    ).toEqual([0, 1, 2, 3, 4, 5])
    expect(result.summary.participantHands[0]?.handEvaluation?.category).toBe(
      'onePair',
    )
    expect(result.summary.participantHands[1]?.handEvaluation).toBeNull()
    expect(Object.isFrozen(result.summary.participantHands)).toBe(true)
    expect(Object.isFrozen(result.summary.participantHands[0])).toBe(true)
    expect(Object.isFrozen(result.summary.participantHands[0]?.holeCards)).toBe(
      true,
    )
    expect(
      Object.isFrozen(result.summary.participantHands[0]?.handEvaluation),
    ).toBe(true)
    const originalSeatZero = showdown.hand.participants.find(
      (participant) => participant.seatNumber === 0,
    )
    expect(result.summary.participantHands[0]?.holeCards).not.toBe(
      originalSeatZero?.holeCards,
    )
    expect(result.summary.participantHands[0]?.handEvaluation).not.toBe(
      evaluation,
    )
  })

  test('creates sorted immutable event facts and rejects malformed facts', () => {
    const handStarted = createHandStartedEventDraft(started())
    expect(handStarted.type).toBe('handStarted')
    expect(
      createUncalledBetReturnedEventDraft(
        '10000000-0000-4000-8000-000000000001',
        [
          { seatNumber: 5, amount: 10 },
          { seatNumber: 1, amount: 20 },
        ],
      ),
    ).toMatchObject({
      returns: [
        { seatNumber: 1, amount: 20 },
        { seatNumber: 5, amount: 10 },
      ],
    })
    expect(() =>
      createStartedHandFacts({ ...started(), positions: [] }),
    ).toThrow(RangeError)
    expect(() =>
      createActionCommittedEventDraft({
        handId: '10000000-0000-4000-8000-000000000001',
        actorSeatNumber: 0,
        command: { actorSeatNumber: 0, action: { type: 'fold' } },
        legalActionsBefore: [{ type: 'fold' }],
        before: {
          street: 'preflop',
          board: [],
          currentActorSeatNumber: 0,
          pot: 0,
          seats: [],
        },
        after: {
          street: 'preflop',
          board: [],
          currentActorSeatNumber: 1,
          pot: 0,
          seats: [],
        },
        progression: {
          streetTransitions: [],
          burnedCardsAdded: [],
          boardCardsAdded: [],
          terminationReason: null,
        },
        statistics: {
          isVoluntaryPreflopContribution: false,
          isPreflopRaise: false,
          isVoluntaryPreflopFullRaise: false,
          canMakeFullRaiseBeforeAction: true,
        },
      }),
    ).toThrow(RangeError)
  })

  test('rejects command-incompatible statistics and contradictory final button', () => {
    expect(() =>
      createActionCommittedEventDraft({
        handId: '10000000-0000-4000-8000-000000000001',
        actorSeatNumber: 0,
        command: { actorSeatNumber: 0, action: { type: 'fold' } },
        legalActionsBefore: [{ type: 'fold' }],
        before: {
          street: 'preflop',
          board: [],
          currentActorSeatNumber: 0,
          pot: 0,
          seats: [
            {
              seatNumber: 0,
              status: 'active',
              stack: 1,
              streetContribution: 0,
              totalContribution: 0,
            },
          ],
        },
        after: {
          street: 'preflop',
          board: [],
          currentActorSeatNumber: 1,
          pot: 0,
          seats: [
            {
              seatNumber: 0,
              status: 'folded',
              stack: 1,
              streetContribution: 0,
              totalContribution: 0,
            },
          ],
        },
        progression: {
          streetTransitions: [],
          burnedCardsAdded: [],
          boardCardsAdded: [],
          terminationReason: null,
        },
        statistics: {
          isVoluntaryPreflopContribution: true,
          isPreflopRaise: true,
          isVoluntaryPreflopFullRaise: true,
          canMakeFullRaiseBeforeAction: true,
        },
      }),
    ).toThrow(RangeError)
    const state = finalState()
    const wrongButton = createPokerTableState({ ...state, buttonSeatNumber: 1 })
    expect(() =>
      createCompletedHandResult({
        ...started(),
        facts: facts(),
        state: wrongButton,
      }),
    ).toThrow(RangeError)
  })

  test('accepts all-false local statistics for a postflop action', () => {
    expect(
      createActionCommittedEventDraft({
        handId: '10000000-0000-4000-8000-000000000001',
        actorSeatNumber: 0,
        command: { actorSeatNumber: 0, action: { type: 'call' } },
        legalActionsBefore: [{ type: 'fold' }, { type: 'call', amount: 10 }],
        before: {
          street: 'flop',
          board: [],
          currentActorSeatNumber: 0,
          pot: 10,
          seats: [
            {
              seatNumber: 0,
              status: 'active',
              stack: 10,
              streetContribution: 0,
              totalContribution: 0,
            },
          ],
        },
        after: {
          street: 'flop',
          board: [],
          currentActorSeatNumber: 1,
          pot: 20,
          seats: [
            {
              seatNumber: 0,
              status: 'active',
              stack: 0,
              streetContribution: 10,
              totalContribution: 10,
            },
          ],
        },
        progression: {
          streetTransitions: [],
          burnedCardsAdded: [],
          boardCardsAdded: [],
          terminationReason: null,
        },
        statistics: {
          isVoluntaryPreflopContribution: false,
          isPreflopRaise: false,
          isVoluntaryPreflopFullRaise: false,
          canMakeFullRaiseBeforeAction: false,
        },
      }),
    ).toMatchObject({ type: 'actionCommitted' })
  })

  test.each([
    [
      'fold',
      { type: 'fold' as const },
      {
        isVoluntaryPreflopContribution: false,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: true,
      },
    ],
    [
      'check',
      { type: 'check' as const },
      {
        isVoluntaryPreflopContribution: false,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: true,
      },
    ],
    [
      'call',
      { type: 'call' as const },
      {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: true,
      },
    ],
    [
      'ordinary bet',
      { type: 'bet' as const, targetStreetCommitment: 20 },
      {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: true,
        isVoluntaryPreflopFullRaise: true,
        canMakeFullRaiseBeforeAction: true,
      },
    ],
    [
      'ordinary raise',
      { type: 'raise' as const, targetStreetCommitment: 40 },
      {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: true,
        isVoluntaryPreflopFullRaise: true,
        canMakeFullRaiseBeforeAction: true,
      },
    ],
    [
      'all-in call',
      { type: 'allIn' as const },
      {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: false,
      },
    ],
    [
      'incomplete all-in raise',
      { type: 'allIn' as const },
      {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: true,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: false,
      },
    ],
    [
      'full all-in raise',
      { type: 'allIn' as const },
      {
        isVoluntaryPreflopContribution: true,
        isPreflopRaise: true,
        isVoluntaryPreflopFullRaise: true,
        canMakeFullRaiseBeforeAction: true,
      },
    ],
  ])(
    'accepts valid preflop statistics for %s',
    (_label, action, statistics) => {
      expect(actionDraft('preflop', action, statistics)).toMatchObject({
        type: 'actionCommitted',
        statistics,
      })
    },
  )

  test.each(
    (['flop', 'turn', 'river'] as const).flatMap((street) =>
      [
        { type: 'call' as const },
        { type: 'bet' as const, targetStreetCommitment: 20 },
        { type: 'raise' as const, targetStreetCommitment: 40 },
        { type: 'allIn' as const },
      ].map((action) => [street, action] as const),
    ),
  )('accepts all-false statistics for %s %s', (street, action) => {
    expect(
      actionDraft(street, action, {
        isVoluntaryPreflopContribution: false,
        isPreflopRaise: false,
        isVoluntaryPreflopFullRaise: false,
        canMakeFullRaiseBeforeAction: false,
      }),
    ).toMatchObject({ type: 'actionCommitted' })
  })
})
