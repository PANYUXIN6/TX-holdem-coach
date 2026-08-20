import { describe, expect, test } from 'vitest'
import { createHandStartedEventDraft } from '../../src/poker/hand-result.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  decideSessionRecovery,
  getSessionDiagnosticSummary,
  SESSION_DIAGNOSTIC_CODES,
  type SessionRecoveryFacts,
} from '../../src/sessions/authoritative-state/recovery-decision.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'
import { createTestBettingPokerState } from '../poker/create-test-poker-state.js'

const handId = '10000000-0000-4000-8000-000000000001'

function currentState(stateVersion = 1) {
  const poker = createTestPokerState()
  return createPrivateTableState({
    stateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
}

function handStartedEvent() {
  return createHandStartedEventDraft({
    handId,
    handNumber: 1,
    participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    buttonSeatNumber: 0,
    smallBlindSeatNumber: 1,
    bigBlindSeatNumber: 2,
    positions: [
      { seatNumber: 0, position: 'BTN' },
      { seatNumber: 1, position: 'SB' },
      { seatNumber: 2, position: 'BB' },
      { seatNumber: 3, position: 'UTG' },
      { seatNumber: 4, position: 'HJ' },
      { seatNumber: 5, position: 'CO' },
    ],
    startingStacks: [0, 1, 2, 3, 4, 5].map((seatNumber) => ({
      seatNumber,
      stack: 2_000,
    })),
  })
}

function validFacts(): SessionRecoveryFacts {
  const snapshot = encodeSnapshot(currentState())
  const event = encodeCurrentPrivateEvent(handStartedEvent())
  return {
    session: {
      lifecycleStatus: 'active',
      endedAt: null,
      stateVersion: 1,
      nextEventSeq: 1,
      currentHandId: null,
      diagnosticCode: null,
      diagnosedAt: null,
    },
    snapshotRow: {
      rowPayloadVersion: snapshot.payloadVersion,
      payload: snapshot.payload,
    },
    inProgressHandIds: [],
    eventRows: [
      {
        eventSeq: 0,
        handId,
        stateVersionBefore: 0,
        stateVersionAfter: 1,
        rowPayloadVersion: event.payloadVersion,
        payload: event.payload,
      },
    ],
  }
}

function factsWith(
  overrides: Readonly<{
    session?: Partial<SessionRecoveryFacts['session']>
    snapshotRow?: SessionRecoveryFacts['snapshotRow']
    inProgressHandIds?: readonly string[]
    eventRows?: readonly SessionRecoveryFacts['eventRows'][number][]
  }>,
): SessionRecoveryFacts {
  const facts = validFacts()
  return {
    session: { ...facts.session, ...overrides.session },
    snapshotRow:
      overrides.snapshotRow === undefined
        ? facts.snapshotRow
        : overrides.snapshotRow,
    inProgressHandIds: overrides.inProgressHandIds ?? facts.inProgressHandIds,
    eventRows: overrides.eventRows ?? facts.eventRows,
  }
}

function decide(facts: SessionRecoveryFacts) {
  return decideSessionRecovery(facts)
}

function inHandSnapshotRow() {
  const poker = createTestBettingPokerState()
  const snapshot = encodeSnapshot(
    createPrivateTableState({
      stateVersion: 1,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    }),
  )
  return {
    rowPayloadVersion: snapshot.payloadVersion,
    payload: snapshot.payload,
  }
}

describe('session recovery decision', () => {
  test('returns the authoritative state when the full persisted fact set is valid', () => {
    const facts = validFacts()

    expect(decide(facts)).toEqual({
      kind: 'ready',
      state: currentState(),
    })
  })

  test('recovers current history with nullable Session-event hand ids', () => {
    const facts = validFacts()
    const sessionEvent = encodeCurrentPrivateEvent({
      type: 'sessionEnded',
      reason: 'userRequested',
    })

    expect(
      decide(
        factsWith({
          session: { nextEventSeq: 2 },
          eventRows: [
            facts.eventRows[0]!,
            {
              eventSeq: 1,
              handId: null,
              stateVersionBefore: 1,
              stateVersionAfter: 1,
              rowPayloadVersion: sessionEvent.payloadVersion,
              payload: sessionEvent.payload,
            },
          ],
        }),
      ).kind,
    ).toBe('ready')
  })

  test('rejects every non-exact event sequence before inspecting later facts', () => {
    const row = validFacts().eventRows[0]!
    const invalidFacts = [
      factsWith({
        session: { nextEventSeq: 0 },
        snapshotRow: null,
        eventRows: [],
      }),
      factsWith({ session: { nextEventSeq: 2 }, eventRows: [row] }),
      factsWith({
        session: { nextEventSeq: 2 },
        eventRows: [row, { ...row }],
      }),
      factsWith({ eventRows: [{ ...row, eventSeq: 1 }] }),
      factsWith({
        eventRows: [row, { ...row, eventSeq: 1 }],
      }),
    ]

    for (const facts of invalidFacts) {
      expect(decide(facts)).toEqual({
        kind: 'readonlyDiagnostic',
        code: 'eventSequenceInvalid',
      })
    }
  })

  test('classifies event versions, payloads and private hand mirrors deterministically', () => {
    const row = validFacts().eventRows[0]!
    expect(
      decide(factsWith({ eventRows: [{ ...row, rowPayloadVersion: 3 }] })),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'eventVersionUnknown',
    })
    expect(
      decide(
        factsWith({
          eventRows: [
            {
              ...row,
              payload: { event: {} },
            },
          ],
        }),
      ),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'eventPayloadInvalid',
    })
    expect(
      decide(factsWith({ eventRows: [{ ...row, handId: null }] })),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'eventRowMismatch',
    })
  })

  test('validates continuous state-version segments and the final Session mirror', () => {
    const row = validFacts().eventRows[0]!
    const invalidChains = [
      [{ ...row, stateVersionBefore: 1, stateVersionAfter: 1 }],
      [{ ...row, stateVersionAfter: 2 }],
      [
        row,
        {
          ...row,
          eventSeq: 1,
          stateVersionBefore: 2,
          stateVersionAfter: 2,
        },
      ],
      [
        row,
        {
          ...row,
          eventSeq: 1,
          stateVersionBefore: 0,
          stateVersionAfter: 0,
        },
      ],
      [{ ...row, stateVersionAfter: Number.MAX_SAFE_INTEGER + 1 }],
    ]

    for (const eventRows of invalidChains) {
      expect(
        decide(
          factsWith({
            session: { nextEventSeq: eventRows.length },
            eventRows,
          }),
        ),
      ).toEqual({
        kind: 'readonlyDiagnostic',
        code: 'eventRowMismatch',
      })
    }

    const stableSegment = [row, { ...row, eventSeq: 1 }]
    expect(
      decide(
        factsWith({
          session: { nextEventSeq: 2 },
          eventRows: stableSegment,
        }),
      ).kind,
    ).toBe('ready')
    expect(decide(factsWith({ session: { stateVersion: 2 } }))).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'stateVersionMismatch',
    })
  })

  test('classifies missing, unknown, invalid and version-mismatched snapshots', () => {
    const snapshotRow = validFacts().snapshotRow!
    expect(decide(factsWith({ snapshotRow: null }))).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'snapshotMissing',
    })
    expect(
      decide(
        factsWith({
          snapshotRow: { ...snapshotRow, rowPayloadVersion: 2 },
        }),
      ),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'snapshotVersionUnknown',
    })
    expect(
      decide(
        factsWith({
          snapshotRow: {
            ...snapshotRow,
            payload: { state: {} },
          },
        }),
      ),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'snapshotPayloadInvalid',
    })
    const versionTwo = encodeSnapshot(currentState(2))
    expect(
      decide(
        factsWith({
          snapshotRow: {
            rowPayloadVersion: versionTwo.payloadVersion,
            payload: versionTwo.payload,
          },
        }),
      ),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'stateVersionMismatch',
    })
  })

  test('validates Hand relationships and repairs only the current-hand mirror', () => {
    expect(
      decide(
        factsWith({
          snapshotRow: inHandSnapshotRow(),
          inProgressHandIds: [handId],
        }),
      ),
    ).toEqual({
      kind: 'repairCurrentHandPointer',
      state: inHandSnapshotRow().payload.state,
      currentHandId: handId,
    })
    expect(
      decide(
        factsWith({
          session: { currentHandId: handId },
        }),
      ),
    ).toEqual({
      kind: 'repairCurrentHandPointer',
      state: currentState(),
      currentHandId: null,
    })
    for (const facts of [
      factsWith({ snapshotRow: inHandSnapshotRow() }),
      factsWith({
        snapshotRow: inHandSnapshotRow(),
        inProgressHandIds: ['20000000-0000-4000-8000-000000000001'],
      }),
      factsWith({
        snapshotRow: inHandSnapshotRow(),
        inProgressHandIds: [handId, '20000000-0000-4000-8000-000000000001'],
      }),
      factsWith({
        session: {
          lifecycleStatus: 'ended',
          endedAt: '2026-08-04T00:00:00.000Z',
        },
        snapshotRow: inHandSnapshotRow(),
        inProgressHandIds: [handId],
      }),
    ]) {
      expect(decide(facts)).toEqual({
        kind: 'readonlyDiagnostic',
        code: 'handRelationshipInvalid',
      })
    }
  })

  test('ignores public event payloads and keeps the earliest diagnostic priority', () => {
    const row = {
      ...validFacts().eventRows[0]!,
      publicEventPayload: { definitely: 'broken' },
    }
    expect(decide(factsWith({ eventRows: [row] })).kind).toBe('ready')
    expect(
      decide(
        factsWith({
          session: { nextEventSeq: 2 },
          snapshotRow: null,
          eventRows: [row],
        }),
      ),
    ).toEqual({
      kind: 'readonlyDiagnostic',
      code: 'eventSequenceInvalid',
    })
  })

  test('maps every stable diagnostic code to a fixed redacted summary', () => {
    const summaries = SESSION_DIAGNOSTIC_CODES.map((code) =>
      getSessionDiagnosticSummary(code),
    )

    expect(summaries.every((summary) => summary.length > 0)).toBe(true)
    expect(new Set(summaries).size).toBe(SESSION_DIAGNOSTIC_CODES.length)
  })
})
