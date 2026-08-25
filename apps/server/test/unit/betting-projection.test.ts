import { describe, expect, test } from 'vitest'
import {
  createCandidateActionProof,
  createInitialBettingProjection,
  createProjectedLegalCandidates,
  isLegalCandidateSemanticallyConsistent,
  projectActionContinuation,
  projectBettingTransition,
} from '../../src/poker/betting-projection.js'

function initialState() {
  return createInitialBettingProjection({
    buttonSeatNumber: 0,
    participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    startingStacks: [0, 1, 2, 3, 4, 5].map((seatNumber) => ({
      seatNumber,
      stack: 2_000,
    })),
  })
}

describe('betting projection candidates', () => {
  test('strictly binds candidate IDs to action, target and target kind', () => {
    expect(
      isLegalCandidateSemanticallyConsistent({
        candidateId: 'call:20',
        action: { type: 'call' },
        targetStreetCommitment: 20,
        targetKind: 'call',
      }),
    ).toBe(true)
    expect(
      isLegalCandidateSemanticallyConsistent({
        candidateId: 'call:20',
        action: { type: 'check' },
        targetStreetCommitment: 20,
        targetKind: 'call',
      }),
    ).toBe(false)
    expect(
      isLegalCandidateSemanticallyConsistent({
        candidateId: 'call:20',
        action: { type: 'call' },
        targetStreetCommitment: 21,
        targetKind: 'call',
      }),
    ).toBe(false)
    expect(
      isLegalCandidateSemanticallyConsistent({
        candidateId: 'call:20',
        action: { type: 'call' },
        targetStreetCommitment: 20,
        targetKind: 'allIn',
      }),
    ).toBe(false)
    expect(
      isLegalCandidateSemanticallyConsistent({
        candidateId: 'call:020',
        action: { type: 'call' },
        targetStreetCommitment: 20,
        targetKind: 'call',
      }),
    ).toBe(false)
  })

  test('expands only the finite server-authored target catalog', () => {
    const candidates = createProjectedLegalCandidates(initialState())

    expect(candidates.map((candidate) => candidate.candidateId)).toEqual([
      'fold',
      'call:20',
      'raise:40',
      'raise:45',
      'raise:54',
      'raise:70',
      'allIn:2000',
    ])
    expect(Object.isFrozen(candidates)).toBe(true)
    expect(Object.isFrozen(candidates[0])).toBe(true)
  })

  test('projects a signed candidate through the same transition kernel', () => {
    const state = initialState()
    const candidate = createProjectedLegalCandidates(state).find(
      (entry) => entry.candidateId === 'raise:54',
    )
    if (candidate === undefined) throw new Error('测试候选不存在。')

    const transition = projectBettingTransition(
      state,
      createCandidateActionProof(state, candidate),
    )
    const continuation = projectActionContinuation(
      transition.state,
      transition.actorSeatNumber,
    )

    expect(transition).toMatchObject({
      contributionDelta: 54,
      targetStreetCommitmentAfter: 54,
      potBefore: 30,
      currentBetAfter: 54,
      isFullRaise: true,
    })
    expect(continuation.kind).toBe('sameStreet')
    expect(continuation).toMatchObject({
      responderSeatNumbers: [4, 5, 0, 1, 2],
      canRaiseSeatNumbers: [4, 5, 0, 1, 2],
      handEndsByFold: false,
      bettingRoundClosesImmediately: false,
      furtherBettingPossible: true,
      remainingStreetsToDeal: 3,
    })
    if (continuation.kind === 'sameStreet') {
      expect(continuation.state.currentActorSeatNumber).toBe(4)
    }
  })

  test('rejects a structural clone that has lost the private candidate proof', () => {
    const state = initialState()
    const candidate = createProjectedLegalCandidates(state)[0]
    if (candidate === undefined) throw new Error('测试候选不存在。')

    expect(() =>
      createCandidateActionProof(state, structuredClone(candidate)),
    ).toThrow(/候选证明无效/)
  })
})
