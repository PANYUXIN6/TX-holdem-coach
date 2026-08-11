import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { PersistenceDataCorruptionError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { loadPausedAbortContext } from '../../src/persistence/session-lifecycle-repository.js'
import { startPokerHand } from '../../src/poker/poker-engine.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeHandStartCheckpointV1 } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec-v1.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '20000000-0000-4000-8000-000000000001'
const handId = '10000000-0000-4000-8000-000000000001'
const actorParticipantId = '00000000-0000-4000-8000-000000000002'
const failedPlayerRunId = '70000000-0000-4000-8000-000000000001'

async function owner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function checkpoint() {
  const poker = createTestPokerState()
  const state = createPrivateTableState({
    stateVersion: 6,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  return {
    stateBeforeStartCommand: state,
    startedHand: startPokerHand(poker, {
      handId,
      completedHandCountBeforeStart: 0,
      randomSource: { nextInt: () => 0 },
    }).startedHand,
  }
}

function handRow() {
  const encoded = encodeHandStartCheckpointV1(checkpoint())
  return {
    handId,
    sessionId,
    handNumber: 1,
    status: 'inProgress',
    checkpointPayloadVersion: encoded.payloadVersion,
    checkpointPayload: encoded.payload,
    completedResultPayloadVersion: null,
    completedResultPayload: null,
    abortReasonCode: null,
    failedAgentRunId: null,
    buttonSeatNumber: encoded.payload.checkpoint.startedHand.buttonSeatNumber,
    participantSeatNumbers:
      encoded.payload.checkpoint.startedHand.participantSeatNumbers,
    startedAt: '2026-08-11T04:00:00.000000Z',
    completedAt: null,
    abortedAt: null,
    updatedAt: '2026-08-11T04:00:00.000000Z',
    abortedRunRuntime: null,
    abortedRunOwnerId: null,
    abortedRunSessionId: null,
    abortedRunHandId: null,
  }
}

function transaction(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  return ((template: TemplateStringsArray) => {
    if (!('raw' in template)) throw new Error('Unexpected helper call.')
    return Promise.resolve(pending.shift())
  }) as unknown as TransactionSql
}

describe('session lifecycle repository', () => {
  test('loads one exact failed Player leaf and returns only the abort context', async () => {
    const context = await loadPausedAbortContext(
      transaction([
        [handRow()],
        [{ failedPlayerRunId, failureReasonCode: 'provider_timeout' }],
      ]),
      await owner(),
      {
        sessionId,
        handId,
        actorParticipantId,
        sourceStateVersion: 7,
      },
    )

    expect(context).toEqual({
      handId,
      checkpoint: encodeHandStartCheckpointV1(checkpoint()).payload.checkpoint,
      failedPlayerRunId,
      failureReasonCode: 'provider_timeout',
    })
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.keys(context).sort()).toEqual([
      'checkpoint',
      'failedPlayerRunId',
      'failureReasonCode',
      'handId',
    ])
  })

  test('rejects zero, multiple, empty, or malformed failed leaves', async () => {
    for (const runRows of [
      [],
      [
        { failedPlayerRunId, failureReasonCode: 'provider_timeout' },
        {
          failedPlayerRunId: '70000000-0000-4000-8000-000000000002',
          failureReasonCode: 'provider_timeout',
        },
      ],
      [{ failedPlayerRunId, failureReasonCode: '' }],
      [{ failedPlayerRunId, failureReasonCode: 'MODEL-TIMEOUT' }],
    ]) {
      await expect(
        loadPausedAbortContext(
          transaction([[handRow()], runRows]),
          await owner(),
          {
            sessionId,
            handId,
            actorParticipantId,
            sourceStateVersion: 7,
          },
        ),
      ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
    }
  })
})
