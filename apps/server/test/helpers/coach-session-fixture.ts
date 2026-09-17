import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  decodeCurrentSnapshot,
  encodeSnapshot,
} from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import { insertInProgressHandAudit } from '../../src/persistence/hand-audit-repository.js'
import { productionSessionMutationRepository as mutation } from '../../src/persistence/session-mutation-repository.js'
import {
  insertSessionRosterSnapshot,
  prepareCurrentCatalogRosterSnapshot,
} from './session-roster-fixture.js'
import { projectPublicSnapshot } from './public-snapshot-fixture.js'

/** Repository-only setup: no application command executor enters the database suite. */
export async function createSessionFixture(sql: Sql, button: number) {
  await clearLocalOwnerSessions(sql)
  const sessionId = randomUUID(),
    handId = randomUUID()
  const catalog = loadAndValidatePersonaCatalog()
  await sql.begin(async (tx) => {
    const roster = await prepareCurrentCatalogRosterSnapshot(
      tx as unknown as Sql,
      { ownerId: 'local-user' },
      catalog,
      {
        sessionId,
        userParticipantId: randomUUID(),
        agents: catalog
          .list()
          .slice(0, 5)
          .map((entry, index) => ({
            personaId: entry.personaId,
            seatNumber: index + 1,
            agentParticipantId: randomUUID(),
          })),
      },
    )
    await insertSessionRosterSnapshot(tx, roster)
    const poker = initializePokerTable(
      [
        roster.userParticipantId,
        ...roster.agents.map((a) => a.agentParticipantId),
      ].map((playerId, seatNumber) => ({
        playerId,
        seatNumber,
        isUser: seatNumber === 0,
        stack: 1000,
        status: 'active' as const,
        streetContribution: 0,
        totalContribution: 0,
      })),
      { nextInt: (max) => button % max },
    )
    const before = createPrivateTableState({
      stateVersion: 0,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((s) => ({
        seatNumber: s.seatNumber,
        cumulativeBuyIn: s.stack,
      })),
      lastCompletedHandSummary: null,
    })
    const started = startPokerHand(poker, {
      handId,
      completedHandCountBeforeStart: 0,
      randomSource: { nextInt: () => 0 },
    })
    const at = new Date().toISOString()
    await insertInProgressHandAudit(tx, roster.owner, {
      sessionId,
      checkpoint: createHandStartCheckpoint({
        pokerRuleSetVersion: POKER_RULE_SET_VERSION,
        stateBeforeStartCommand: before,
        startedHand: started.startedHand,
      }),
      startedAt: at,
    })
    const locked = await mutation.lockSessionForMutation(
      tx,
      roster.owner,
      sessionId,
    )
    const state = createPrivateTableState({
      ...before,
      stateVersion: 1,
      poker: started.state,
    })
    const eventId = randomUUID(),
      eventSeq = locked.nextEventSeq
    const snapshot = projectPublicSnapshot(
      state,
      { ...locked, currentHandId: handId },
      eventSeq,
    )
    await mutation.persistSessionMutation(tx, locked, {
      finalStateVersion: 1,
      lifecycleStatus: 'active',
      currentHandId: handId,
      agentRunState: 'idle',
      activePlayerRunId: null,
      activeDecisionRequestId: null,
      snapshot: encodeSnapshot(state),
      mutationAt: at,
      events: [
        {
          eventId,
          eventSeq,
          handId,
          commandLedgerId: null,
          stateVersionBefore: 0,
          stateVersionAfter: 1,
          privateEvent: mutation.currentPrivateEventProtocol.encodeCurrent({
            type: 'handStarted',
            startedHand: started.startedHand,
          }),
          publicEvent: {
            eventId,
            sessionId,
            eventSeq,
            stateVersion: 1,
            type: 'handStarted',
            payload: { snapshot },
          },
          createdAt: at,
        },
      ],
    })
  })
  return { sessionId, handId }
}
export async function readPrivateState(
  sql: Sql | TransactionSql,
  sessionId: string,
) {
  const rows = await sql<
    { payloadVersion: number; payload: unknown }[]
  >`SELECT private_table_state_payload_version AS "payloadVersion", private_table_state_payload AS payload FROM app_private.session_snapshots WHERE session_id=${sessionId}::uuid`
  if (rows.length !== 1) throw new Error('m82_missing_snapshot')
  return decodeCurrentSnapshot(rows[0]!).payload.state
}
export async function clearLocalOwnerSessions(sql: Sql) {
  await sql`DELETE FROM app_private.sessions WHERE owner_id=(SELECT id FROM app_private.owners WHERE identity_key='local-user')`
}
