import { randomUUID } from 'node:crypto'
import type { JSONValue, Sql } from 'postgres'
import { expect } from 'vitest'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { createCompletedHandHistoryFactsRepository } from '../../src/persistence/completed-hand-history-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { createAuthoritativeCompletedHandHistoryReader } from '../../src/sessions/hand-history/completed-hand-history-service.js'
import { insertCommittedM27CompletedHand } from './database-repository-assertions.js'

const randomSource = Object.freeze({ nextInt: () => 0 })

function createM51PlayerIds(): readonly string[] {
  return Array.from({ length: 6 }, () => randomUUID())
}

function createTerminalEvents(handId: string, playerIds: readonly string[]) {
  if (playerIds.length !== 6) {
    throw new Error('M5.1 fixture 需要六名参与者。')
  }
  const initialPoker = initializePokerTable(
    Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: playerIds[seatNumber] ?? '',
      isUser: seatNumber === 0,
      stack: 1_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    randomSource,
  )
  const started = startPokerHand(initialPoker, {
    handId,
    completedHandCountBeforeStart: 0,
    randomSource,
  })
  const terminalState = createPokerTableState({
    ...started.state,
    seats: started.state.seats.map((seat) => ({
      ...seat,
      status:
        seat.seatNumber === 2 || seat.seatNumber === 3
          ? ('active' as const)
          : ('folded' as const),
    })),
  })
  const completed = applyPokerAction(terminalState, {
    actorSeatNumber: 3,
    action: { type: 'fold' },
  })
  if (completed.completedHand === null) {
    throw new Error('M5.1 fixture 未产生完成手。')
  }
  return completed.eventDrafts
}

async function insertTerminalEvents(
  sql: Sql,
  input: {
    readonly sessionId: string
    readonly handId: string
    readonly databaseOwnerId: string
    readonly playerIds: readonly string[]
  },
): Promise<void> {
  const events = createTerminalEvents(input.handId, input.playerIds)
  for (const [eventSeq, event] of events.entries()) {
    const encoded = encodeCurrentPrivateEvent(event)
    await sql`
      INSERT INTO app_private.session_events (
        id,
        session_id,
        owner_id,
        hand_id,
        command_ledger_id,
        event_seq,
        state_version_before,
        state_version_after,
        private_event_payload_version,
        private_event_payload,
        public_event_payload,
        created_at
      ) VALUES (
        ${randomUUID()}::uuid,
        ${input.sessionId}::uuid,
        ${input.databaseOwnerId}::uuid,
        ${input.handId}::uuid,
        NULL,
        ${eventSeq}::bigint,
        0,
        1,
        ${encoded.payloadVersion},
        ${sql.json(encoded.payload as unknown as JSONValue)},
        ${sql.json({})},
        '2026-09-03T12:01:00.000Z'::timestamptz
      )
    `
  }
}

/**
 * The completed Hand itself is written through M2.7's public Repository API.
 * The compact historical event fixture is inserted only to exercise M5.1's
 * current-event Codec read boundary; M3.3 owns production event composition.
 */
export async function assertM51CompletedHandHistory(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const playerIds = createM51PlayerIds()
  try {
    const owner = await insertCommittedM27CompletedHand(
      sql,
      sessionId,
      handId,
      {
        playerIds,
      },
    )
    await insertTerminalEvents(sql, {
      sessionId,
      handId,
      databaseOwnerId: owner.databaseOwnerId,
      playerIds,
    })
    const factsReader = createCompletedHandHistoryFactsRepository({
      sql,
      owner,
    })
    const reader = createAuthoritativeCompletedHandHistoryReader({
      factsReader,
    })
    const history = await reader.read({ handId })

    expect(history).toMatchObject({
      sessionId,
      handId,
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
      participantSeatNumbers: [0, 1, 2, 3, 4, 5],
    })
    expect(history?.phases.at(-1)).toMatchObject({
      phase: 'showdown',
      terminationReason: 'complete',
    })
    expect(history?.phases[0]?.actions.length).toBeGreaterThan(0)
    expect(JSON.stringify(history)).not.toContain('remainingDeck')

    await expect(reader.read({ handId: randomUUID() })).resolves.toBeNull()
    const localOwner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    await expect(
      createCompletedHandHistoryFactsRepository({
        sql,
        owner: localOwner,
      }).readCompletedHandHistoryFacts(handId),
    ).resolves.toMatchObject({ handId })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
  }
}
