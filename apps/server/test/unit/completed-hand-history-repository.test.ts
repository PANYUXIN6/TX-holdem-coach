import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { encodeCompletedHandResult } from '../../src/sessions/hand-audit/completed-hand-result-codec.js'
import { encodeCurrentHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { createCompletedHandHistoryFactsRepository } from '../../src/persistence/completed-hand-history-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  COMPLETED_HAND_HISTORY_SESSION_ID,
  createDirectWinCompletedHandHistoryFacts,
} from '../fixtures/completed-hand-history-fixture.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'

function createSqlMock(rows: readonly unknown[]): Sql {
  return (() => Promise.resolve(rows)) as unknown as Sql
}

async function resolvedOwner() {
  return resolveOwnerScope(
    (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql,
    { ownerId: 'local-user' },
  )
}

function completedHistoryRow() {
  const facts = createDirectWinCompletedHandHistoryFacts()
  const checkpoint = encodeCurrentHandStartCheckpoint(facts.checkpoint)
  const result = encodeCompletedHandResult(facts.result)
  return {
    handId: facts.handId,
    sessionId: COMPLETED_HAND_HISTORY_SESSION_ID,
    handNumber: facts.handNumber,
    startedAt: '2026-09-03T12:00:00.000000Z',
    completedAt: '2026-09-03T12:01:00.000000Z',
    checkpointPayloadVersion: checkpoint.payloadVersion,
    checkpointPayload: checkpoint.payload,
    completedResultPayloadVersion: result.payloadVersion,
    completedResultPayload: result.payload,
    roster: facts.roster.map((entry) => ({
      seatNumber: entry.seatNumber,
      playerId: entry.playerId,
      participantType: entry.isUser ? 'user' : 'agent',
      displayName: entry.isUser ? null : entry.displayName,
      avatarColor: entry.isUser ? null : entry.avatarColor,
    })),
    events: facts.events
      .slice()
      .reverse()
      .map((fact) => {
        const encoded = encodeCurrentPrivateEvent(fact.event)
        return {
          eventSeq: fact.eventSeq,
          privateEventPayloadVersion: encoded.payloadVersion,
          privateEventPayload: encoded.payload,
        }
      }),
  }
}

describe('completed hand history facts repository', () => {
  test('decodes one completed owner-scoped hand, its frozen roster and all private events', async () => {
    const row = completedHistoryRow()
    const reader = createCompletedHandHistoryFactsRepository({
      sql: createSqlMock([row]),
      owner: await resolvedOwner(),
    })

    const facts = await reader.readCompletedHandHistoryFacts(row.handId)

    expect(facts).toMatchObject({
      ownerId: 'local-user',
      sessionId: COMPLETED_HAND_HISTORY_SESSION_ID,
      handId: row.handId,
      handNumber: 1,
    })
    expect(facts?.roster.map((entry) => entry.seatNumber)).toEqual([
      0, 1, 2, 3, 4, 5,
    ])
    expect(facts?.roster[0]).toMatchObject({
      displayName: '玩家',
      avatarColor: '#0F766E',
    })
    expect(facts?.events.map((entry) => entry.eventSeq)).toEqual([10, 11, 12])
    expect(Object.isFrozen(facts)).toBe(true)
    expect(Object.isFrozen(facts?.events)).toBe(true)
  })

  test('rejects invalid hand IDs before issuing a database query', async () => {
    const reader = createCompletedHandHistoryFactsRepository({
      sql: createSqlMock([]),
      owner: await resolvedOwner(),
    })

    await expect(
      reader.readCompletedHandHistoryFacts('not-a-uuid'),
    ).rejects.toMatchObject({ name: 'RepositoryInputValidationError' })
  })
})
