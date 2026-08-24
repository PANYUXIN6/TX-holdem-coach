import type { Card } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import {
  certifyPlayerVisibleState,
  isPlayerVisibleState,
  validatePlayerVisibleStateData,
} from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { PlayerObservationBoundaryError } from '../../src/sessions/authoritative-state/player-visible-state.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'

function validDraft() {
  return buildPlayerObservationDraft(createPlayerObservationFixture().input)
}

describe('Player information boundary guard', () => {
  test('certifies and recursively freezes only the exact parsed instance', () => {
    const draft = validDraft()
    const observation = certifyPlayerVisibleState(draft)
    expect(isPlayerVisibleState(observation)).toBe(true)
    expect(isPlayerVisibleState(draft)).toBe(false)
    expect(isPlayerVisibleState(structuredClone(observation))).toBe(false)
    expect(isPlayerVisibleState(JSON.parse(JSON.stringify(observation)))).toBe(
      false,
    )
    expect(() =>
      certifyPlayerVisibleState(JSON.parse(JSON.stringify(draft))),
    ).toThrow(PlayerObservationBoundaryError)
    expect(observation.observationSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.isFrozen(observation.hand.bettingRound.seatStates)).toBe(true)
    const heroCardsTuple: readonly [Readonly<Card>, Readonly<Card>] =
      observation.hand.heroHoleCards
    expect(heroCardsTuple).toHaveLength(2)
  })

  test('changes the observation hash when the decision identity changes', () => {
    const fixture = createPlayerObservationFixture()
    const firstDraft = buildPlayerObservationDraft(fixture.input)
    const secondDraft = buildPlayerObservationDraft({
      ...fixture.input,
      identity: createPlayerDecisionIdentity({
        ...fixture.input.identity,
        decisionRequestId: '40000000-0000-4000-8000-000000000002',
      }),
    })
    expect(certifyPlayerVisibleState(firstDraft).observationSha256).not.toBe(
      certifyPlayerVisibleState(secondDraft).observationSha256,
    )
  })

  test.each([
    ['opponent cards', ['table', 'seats', 1], 'holeCards', ['sentinel-card']],
    ['remaining deck', ['hand'], 'remainingDeck', ['sentinel-deck']],
    ['burn cards', ['hand'], 'burnedCards', ['sentinel-burn']],
    ['coach truth', [], 'auditTruth', 'sentinel-coach'],
    ['agent config', [], 'configPayload', 'sentinel-config'],
    ['agent memory', [], 'memoryPayload', 'sentinel-memory'],
    ['model reasoning', [], 'reasoning', 'sentinel-reasoning'],
    ['owner authority', [], 'databaseOwnerId', 'sentinel-owner'],
    ['lease authority', [], 'leaseOwner', 'sentinel-lease'],
    ['fencing authority', [], 'fencingToken', 7],
  ] as const)(
    'rejects forbidden %s at any level',
    (_label, path, key, value) => {
      const draft = structuredClone(validDraft())
      let target: unknown = draft
      for (const segment of path) {
        target = (target as Record<string | number, unknown>)[segment]
      }
      ;(target as Record<string, unknown>)[key] = value
      expect(() => validatePlayerVisibleStateData(draft)).toThrow(
        PlayerObservationBoundaryError,
      )
      expect(JSON.stringify(draft)).toContain(String(key))
    },
  )

  test('rejects malformed identity, duplicates and credential strings', () => {
    const wrongActor = structuredClone(validDraft())
    ;(wrongActor.identity as { actorSeat: number }).actorSeat = 0
    expect(() => validatePlayerVisibleStateData(wrongActor)).toThrow(
      PlayerObservationBoundaryError,
    )

    const duplicateCard = structuredClone(validDraft())
    ;(
      duplicateCard.hand as unknown as {
        board: unknown[]
        street: string
      }
    ).board = [
      duplicateCard.hand.heroHoleCards[0]!,
      { rank: '2', suit: 'diamonds' },
      { rank: '3', suit: 'diamonds' },
    ]
    ;(
      duplicateCard.hand as unknown as {
        board: unknown[]
        street: string
      }
    ).street = 'flop'
    expect(() => validatePlayerVisibleStateData(duplicateCard)).toThrow(
      PlayerObservationBoundaryError,
    )

    const credential = structuredClone(validDraft())
    ;(credential as Record<string, unknown>).extra =
      'postgresql://user:secret@example.invalid/db'
    expect(() => validatePlayerVisibleStateData(credential)).toThrow(
      PlayerObservationBoundaryError,
    )
  })

  test('rejects public action amount evidence that no longer matches the replay', () => {
    const draft = structuredClone(
      buildPlayerObservationDraft(
        createPlayerObservationFixture({ publicAction: { type: 'call' } })
          .input,
      ),
    )
    const action = draft.hand.publicActions[0]
    if (action === undefined) throw new Error('测试公开行动缺失。')
    ;(action as { contributionDelta: number }).contributionDelta += 1

    expect(() => validatePlayerVisibleStateData(draft)).toThrow(
      PlayerObservationBoundaryError,
    )
  })

  test('rejects non-blind positions that contradict logical assignment', () => {
    const draft = structuredClone(validDraft())
    const positions = draft.hand.positions as {
      seatNumber: number
      position: string
    }[]
    const utg = positions.find((position) => position.position === 'UTG')
    const hj = positions.find((position) => position.position === 'HJ')
    if (utg === undefined || hj === undefined) {
      throw new Error('测试非盲位位置缺失。')
    }
    ;[utg.position, hj.position] = [hj.position, utg.position]

    expect(() => validatePlayerVisibleStateData(draft)).toThrow(
      PlayerObservationBoundaryError,
    )
  })

  test('rejects cyclic, symbolic and mutable-prototype payloads', () => {
    const cyclic = structuredClone(validDraft())
    ;(cyclic as Record<string, unknown>).cycle = cyclic
    expect(() => validatePlayerVisibleStateData(cyclic)).toThrow(
      PlayerObservationBoundaryError,
    )

    const symbolic = structuredClone(validDraft())
    ;(symbolic as Record<PropertyKey, unknown>)[Symbol('hidden')] = 'sentinel'
    expect(() => validatePlayerVisibleStateData(symbolic)).toThrow(
      PlayerObservationBoundaryError,
    )

    const customPrototype = structuredClone(validDraft())
    Object.setPrototypeOf(customPrototype.hand, { hidden: 'sentinel' })
    expect(() => validatePlayerVisibleStateData(customPrototype)).toThrow(
      PlayerObservationBoundaryError,
    )
  })
})
