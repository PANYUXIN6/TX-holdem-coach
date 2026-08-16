import { describe, expect, test } from 'vitest'
import {
  decodeStoredPublicEvent,
  hashStoredPublicEventPage,
} from '../../src/sessions/public-projection/public-event-protocol.js'

const sessionId = '22222222-2222-4222-8222-222222222222'
const eventId = '33333333-3333-4333-8333-333333333333'

function event(type = 'handStarted') {
  return {
    eventId,
    sessionId,
    eventSeq: 0,
    stateVersion: 1,
    type,
    payload: {
      snapshot: {
        sessionId,
        stateVersion: 1,
        eventSeq: 0,
        pokerPhase: 'betweenHands' as const,
        lifecycleStatus: 'active' as const,
        agentRunState: 'idle' as const,
        activeDecision: null,
        seats: Array.from({ length: 6 }, (_, seatNumber) => ({
          seatNumber,
          playerId: `66666666-6666-4666-8666-${seatNumber.toString().padStart(12, '0')}`,
          displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
          avatarColor: '#0f766e',
          isUser: seatNumber === 0,
          stack: 2_000,
          status: 'active' as const,
        })),
        hand: null,
        lastCompletedHandSummary: null,
      },
    },
  }
}

function row(payload = event()) {
  return {
    eventId,
    sessionId,
    eventSeq: 0,
    stateVersionAfter: 1,
    publicEventPayload: payload,
  }
}

describe('stored public event protocol', () => {
  test('strictly decodes row mirrors and creates a stable page proof', () => {
    const decoded = decodeStoredPublicEvent(row())
    expect(decoded).toMatchObject({ kind: 'decoded', event: { eventSeq: 0 } })
    if (decoded.kind !== 'decoded') throw new Error('expected decoded event')
    expect(hashStoredPublicEventPage([decoded.event])).toMatch(/^[0-9a-f]{64}$/)
    expect(hashStoredPublicEventPage([decoded.event])).toBe(
      hashStoredPublicEventPage([structuredClone(decoded.event)]),
    )
  })

  test('rejects row mismatches and persisted calibration', () => {
    expect(decodeStoredPublicEvent({ ...row(), stateVersionAfter: 2 })).toEqual(
      { kind: 'invalid', reason: 'storedPayloadInvalid' },
    )
    expect(decodeStoredPublicEvent(row(event('snapshot')))).toEqual({
      kind: 'invalid',
      reason: 'storedPayloadInvalid',
    })
  })
})
