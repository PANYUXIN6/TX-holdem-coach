import { describe, expect, test } from 'vitest'
import {
  COACH_DECISION_UUID_NAMESPACE,
  createCoachDecisionId,
  createPlayerDecisionIdentity,
} from '../../src/sessions/authoritative-state/decision-identity.js'

describe('M4.1 decision identity', () => {
  test('validates and freezes the stable Player decision identity', () => {
    const identity = createPlayerDecisionIdentity({
      sessionId: 'aaaaaaaa-0000-4000-8000-000000000001',
      handId: '20000000-0000-4000-8000-000000000001',
      stateVersion: 4,
      actorParticipantId: '30000000-0000-4000-8000-000000000001',
      actorSeat: 3,
      decisionRequestId: '40000000-0000-4000-8000-000000000001',
    })

    expect(identity.actorSeat).toBe(3)
    expect(Object.isFrozen(identity)).toBe(true)
    expect(() =>
      createPlayerDecisionIdentity({ ...identity, actorSeat: 0 }),
    ).toThrow()
    expect(() =>
      createPlayerDecisionIdentity({
        ...identity,
        sessionId: identity.sessionId.toUpperCase(),
      }),
    ).toThrow()
  })

  test('derives deterministic UUIDv5 Coach decision IDs from authoritative event identity', () => {
    const input = {
      handId: '20000000-0000-4000-8000-000000000001',
      street: 'flop' as const,
      authoritativeSequence: 12,
    }
    const first = createCoachDecisionId(input)

    expect(COACH_DECISION_UUID_NAMESPACE).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(createCoachDecisionId(input)).toBe(first)
    expect(
      createCoachDecisionId({ ...input, authoritativeSequence: 13 }),
    ).not.toBe(first)
    expect(() =>
      createCoachDecisionId({ ...input, street: 'showdown' as never }),
    ).toThrow()
    expect(() =>
      createCoachDecisionId({ ...input, authoritativeSequence: -1 }),
    ).toThrow()
  })
})
