import { describe, expect, test } from 'vitest'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { createPrivateEvent } from '../../src/sessions/authoritative-state/private-event.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'

describe('Player observation builder', () => {
  test('projects only the acting AI hole cards for every 6-9 player seat', () => {
    for (const playerCount of [6, 7, 8, 9] as const) {
      for (let actorSeat = 1; actorSeat < playerCount; actorSeat += 1) {
        const fixture = createPlayerObservationFixture({
          playerCount,
          actorSeat,
        })
        const observation = certifyPlayerVisibleState(
          buildPlayerObservationDraft(fixture.input),
        )
        expect(observation.hand.heroHoleCards).toEqual(
          fixture.expectedHeroCards,
        )
        expect(observation.table.seats).toHaveLength(playerCount)
        expect(
          observation.table.seats.every(
            (seat) => !Reflect.ownKeys(seat).includes('holeCards'),
          ),
        ).toBe(true)
        expect(JSON.stringify(observation)).not.toMatch(
          /remainingDeck|burnedCards|progression|lastCompletedHandSummary/,
        )
      }
    }
  })

  test('copies only public action facts and produces stable canonical output', () => {
    const fixture = createPlayerObservationFixture({ withPublicAction: true })
    const first = certifyPlayerVisibleState(
      buildPlayerObservationDraft(fixture.input),
    )
    const second = certifyPlayerVisibleState(
      buildPlayerObservationDraft(fixture.input),
    )
    expect(first).toEqual(second)
    expect(first.observationSha256).toBe(second.observationSha256)
    expect(first.hand.publicActions).toEqual([
      expect.objectContaining({
        eventSeq: 2,
        streetBefore: 'preflop',
        actorSeatNumber: 3,
        action: { actorSeatNumber: 3, action: { type: 'fold' } },
        amountToCallBefore: 20,
        contributionDelta: 0,
        targetStreetCommitmentAfter: 0,
        totalContributionAfter: 0,
        potBefore: 30,
        currentBetBefore: 20,
        currentBetAfter: 20,
        minimumFullRaiseIncrementBefore: 20,
        minimumFullRaiseIncrementAfter: 20,
        isVoluntaryPreflopContribution: false,
        isFullRaise: false,
      }),
    ])
    expect(JSON.stringify(first.hand.publicActions)).not.toContain(
      'progression',
    )
  })

  test('rejects a legal command whose action snapshots contradict the replayed transition', () => {
    const fixture = createPlayerObservationFixture({ withPublicAction: true })
    const events = [...fixture.input.events]
    const actionRow = events[1]
    if (actionRow?.event.type !== 'actionCommitted') {
      throw new Error('测试行动事件缺失。')
    }
    events[1] = {
      ...actionRow,
      event: createPrivateEvent({
        ...actionRow.event,
        command: {
          actorSeatNumber: actionRow.event.actorSeatNumber,
          action: { type: 'call' },
        },
        statistics: {
          ...actionRow.event.statistics,
          isVoluntaryPreflopContribution: true,
        },
      }),
    }

    expect(() =>
      buildPlayerObservationDraft({ ...fixture.input, events }),
    ).toThrow('Player 权威观察未通过信息边界。')
  })

  test('rejects a handStarted hand number that contradicts authoritative state', () => {
    const fixture = createPlayerObservationFixture()
    const events = structuredClone(fixture.input.events)
    const handStarted = events[0]?.event
    if (handStarted?.type !== 'handStarted') {
      throw new Error('测试开手事件缺失。')
    }
    ;(
      handStarted.startedHand as {
        handNumber: number
      }
    ).handNumber = 99

    expect(() =>
      buildPlayerObservationDraft({ ...fixture.input, events }),
    ).toThrow('Player 权威观察未通过信息边界。')
  })

  test('rejects non-blind positions that contradict authoritative assignment', () => {
    const fixture = createPlayerObservationFixture()
    const events = structuredClone(fixture.input.events)
    const handStarted = events[0]?.event
    if (handStarted?.type !== 'handStarted') {
      throw new Error('测试开手事件缺失。')
    }
    const positions = handStarted.startedHand.positions as {
      seatNumber: number
      position: string
    }[]
    const utg = positions.find((position) => position.position === 'UTG')
    const hj = positions.find((position) => position.position === 'HJ')
    if (utg === undefined || hj === undefined) {
      throw new Error('测试非盲位位置缺失。')
    }
    ;[utg.position, hj.position] = [hj.position, utg.position]

    expect(() =>
      buildPlayerObservationDraft({ ...fixture.input, events }),
    ).toThrow('Player 权威观察未通过信息边界。')
  })

  test.each([
    {
      action: { type: 'call' as const },
      expected: {
        amountToCallBefore: 20,
        contributionDelta: 20,
        targetStreetCommitmentAfter: 20,
        totalContributionAfter: 20,
        currentBetBefore: 20,
        currentBetAfter: 20,
        minimumFullRaiseIncrementBefore: 20,
        minimumFullRaiseIncrementAfter: 20,
        isVoluntaryPreflopContribution: true,
        isFullRaise: false,
      },
    },
    {
      action: { type: 'allIn' as const },
      expected: {
        amountToCallBefore: 20,
        contributionDelta: 2_000,
        targetStreetCommitmentAfter: 2_000,
        totalContributionAfter: 2_000,
        currentBetBefore: 20,
        currentBetAfter: 2_000,
        minimumFullRaiseIncrementBefore: 20,
        minimumFullRaiseIncrementAfter: 1_980,
        isVoluntaryPreflopContribution: true,
        isFullRaise: true,
      },
    },
  ])(
    'projects authoritative amount proof for $action.type',
    ({ action, expected }) => {
      const fixture = createPlayerObservationFixture({ publicAction: action })
      const observation = certifyPlayerVisibleState(
        buildPlayerObservationDraft(fixture.input),
      )
      expect(observation.hand.publicActions[0]).toMatchObject(expected)
    },
  )

  test('does not retain mutable source references', () => {
    const fixture = createPlayerObservationFixture()
    const draft = buildPlayerObservationDraft(fixture.input)
    const observation = certifyPlayerVisibleState(draft)
    expect(draft.table.seats).not.toBe(fixture.input.state.poker.seats)
    expect(draft.hand.heroHoleCards).not.toBe(
      fixture.input.state.poker.hand?.holeCards,
    )
    expect(Object.isFrozen(draft.hand.heroHoleCards)).toBe(true)
    expect(observation.table.seats[0]?.stack).toBe(2_000)
    expect(observation.hand.heroHoleCards).toEqual(fixture.expectedHeroCards)
    expect(Object.isFrozen(observation.hand.heroHoleCards)).toBe(true)
  })

  test('rejects a gap in adjacent event state-version segments', () => {
    const fixture = createPlayerObservationFixture({ withPublicAction: true })
    const events = [...structuredClone(fixture.input.events)]
    ;(events[1] as { stateVersionBefore: number }).stateVersionBefore = 0

    expect(() =>
      buildPlayerObservationDraft({ ...fixture.input, events }),
    ).toThrow('Player 权威观察未通过信息边界。')
  })

  test('rejects two public actions assigned to the same state-version segment', () => {
    const fixture = createPlayerObservationFixture({ withPublicAction: true })
    const events = [...structuredClone(fixture.input.events)]
    const duplicatedAction = structuredClone(events[1]!)
    ;(duplicatedAction as { eventSeq: number }).eventSeq = 3
    events.push(duplicatedAction)

    expect(() =>
      buildPlayerObservationDraft({
        ...fixture.input,
        events,
        asOfEventSeq: 3,
      }),
    ).toThrow('Player 权威观察未通过信息边界。')
  })
})
