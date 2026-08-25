import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import type { DatabaseClient } from '../../src/db/client.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import { createPostgresPlayerDecisionReferencePort } from '../../src/persistence/player-decision-reference-authority.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import { encodeCurrentHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import {
  INITIAL_AGENT_MEMORY,
  insertSessionRosterSnapshot,
} from '../helpers/session-roster-fixture.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'
import {
  runDatabaseTestWithCleanup,
  serializeJsonbFixture,
} from './database-test-runtime.js'

const SECOND_OWNER_ID = '10000000-0000-4000-8000-000000000045'
const SECOND_SESSION_ID = '20000000-0000-4000-8000-000000000045'
const PRIMARY_SESSION_ID = '20000000-0000-4000-8000-000000000001'

function asDatabaseClient(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

async function clearFixtures(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM app_private.sessions WHERE id = ${SECOND_SESSION_ID}::uuid
  `
  await sql`
    DELETE FROM app_private.owners WHERE id = ${SECOND_OWNER_ID}::uuid
  `
  await sql`
    DELETE FROM app_private.sessions
    WHERE id = ${PRIMARY_SESSION_ID}::uuid
      AND owner_id = (
        SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
      )
  `
}

async function insertSecondOwnerSession(sql: Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${SECOND_OWNER_ID}::uuid, 'm45-second-owner')
    `
    await transaction`
      INSERT INTO app_private.sessions (id, owner_id)
      VALUES (${SECOND_SESSION_ID}::uuid, ${SECOND_OWNER_ID}::uuid)
    `
    for (let seatNumber = 0; seatNumber < 6; seatNumber += 1) {
      const participantId = `71000000-0000-4000-8000-${String(
        seatNumber + 1,
      ).padStart(12, '0')}`
      await transaction`
        INSERT INTO app_private.session_participants (
          id, session_id, owner_id, participant_type, seat_number
        ) VALUES (
          ${participantId}::uuid, ${SECOND_SESSION_ID}::uuid,
          ${SECOND_OWNER_ID}::uuid,
          ${seatNumber === 0 ? 'user' : 'agent'}, ${seatNumber}
        )
      `
      if (seatNumber > 0) {
        await transaction`
          INSERT INTO app_private.session_agents (
            participant_id, session_id, owner_id, display_name,
            avatar_color, persona_id, persona_version,
            config_snapshot_key, config_payload_version, config_payload,
            memory_payload_version, memory_payload
          ) VALUES (
            ${participantId}::uuid, ${SECOND_SESSION_ID}::uuid,
            ${SECOND_OWNER_ID}::uuid, ${`M45 Agent ${seatNumber}`}, '#000000',
            ${`m45-persona-${seatNumber}`}, 1, ${'0'.repeat(64)},
            1, ${transaction.json({})}, 1, ${transaction.json({})}
          )
        `
        await transaction`
          INSERT INTO app_private.agent_memory_revisions (
            participant_id, session_id, owner_id, revision,
            memory_payload_version, memory_payload
          ) VALUES (
            ${participantId}::uuid, ${SECOND_SESSION_ID}::uuid,
            ${SECOND_OWNER_ID}::uuid, 0, 1, ${transaction.json({})}
          )
        `
      }
    }
  })
}

async function insertReferenceFixture(transaction: TransactionSql) {
  const owner = await resolveOwnerScope(transaction, { ownerId: 'local-user' })
  const fixture = createPlayerObservationFixture({ withPublicAction: true })
  const observation = certifyPlayerVisibleState(
    buildPlayerObservationDraft(fixture.input),
  )
  const handStarted = fixture.input.events[0]?.event
  if (handStarted?.type !== 'handStarted') {
    throw new Error('M4.5 database fixture 缺少 handStarted。')
  }
  const startingStackBySeat = new Map(
    handStarted.startedHand.startingStacks.map((entry) => [
      entry.seatNumber,
      entry.stack,
    ]),
  )
  const checkpoint = createHandStartCheckpoint({
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    stateBeforeStartCommand: createPrivateTableState({
      stateVersion: 0,
      completedHandCount: 0,
      seatAccounting: fixture.input.state.seatAccounting,
      lastCompletedHandSummary: null,
      poker: {
        pokerPhase: 'betweenHands',
        buttonSeatNumber: fixture.input.state.poker.buttonSeatNumber,
        blinds: fixture.input.state.poker.blinds,
        hand: null,
        seats: fixture.input.state.poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          playerId: seat.playerId,
          isUser: seat.isUser,
          stack: startingStackBySeat.get(seat.seatNumber)!,
          status: 'active' as const,
          streetContribution: 0,
          totalContribution: 0,
        })),
      },
    }),
    startedHand: handStarted.startedHand,
  })
  const storedCheckpoint = encodeCurrentHandStartCheckpoint(checkpoint)
  const personas = loadAndValidatePersonaCatalog().list().slice(0, 5)
  const userParticipantId = fixture.input.state.poker.seats.find(
    (seat) => seat.isUser,
  )?.playerId
  if (userParticipantId === undefined || personas.length !== 5) {
    throw new Error('M4.5 database fixture 缺少完整 roster。')
  }
  await insertSessionRosterSnapshot(transaction, {
    owner,
    sessionId: observation.identity.sessionId,
    userParticipantId,
    agents: personas.map((persona, index) => {
      const seat = fixture.input.state.poker.seats[index + 1]
      if (seat === undefined) {
        throw new Error('M4.5 database fixture 缺少 Agent 座位。')
      }
      return {
        seatNumber: seat.seatNumber,
        agentParticipantId: seat.playerId,
        displayName: persona.name,
        avatarColor: persona.avatarColor,
        personaId: persona.personaId,
        personaVersion: persona.personaVersion,
        configSnapshotKey: createConfigSnapshotKey(
          PERSONA_CONFIG_PAYLOAD_VERSION,
          persona,
        ),
        configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
        configPayload: persona,
        initialMemory: INITIAL_AGENT_MEMORY,
      }
    }),
  })
  await transaction`
    INSERT INTO app_private.hands (
      id, session_id, owner_id, hand_number, status,
      hand_start_checkpoint_payload_version, hand_start_checkpoint_payload,
      completed_result_payload_version, completed_result_payload,
      abort_reason, aborted_by_agent_run_id, button_seat, participant_seats,
      started_at, completed_at, aborted_at, updated_at
    ) VALUES (
      ${observation.identity.handId}::uuid,
      ${observation.identity.sessionId}::uuid,
      ${owner.databaseOwnerId}::uuid,
      ${observation.hand.handNumber}, 'inProgress',
      ${storedCheckpoint.payloadVersion},
      ${serializeJsonbFixture(storedCheckpoint.payload)}::text::jsonb,
      NULL, NULL, NULL, NULL,
      ${handStarted.startedHand.buttonSeatNumber},
      ${handStarted.startedHand.participantSeatNumbers}::integer[],
      CURRENT_TIMESTAMP, NULL, NULL, CURRENT_TIMESTAMP
    )
  `
  await transaction`
    UPDATE app_private.sessions
    SET state_version = ${observation.identity.stateVersion}::bigint,
        current_hand_id = ${observation.identity.handId}::uuid,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${observation.identity.sessionId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
  `
  const actorPersona = personas[observation.identity.actorSeat - 1]
  if (actorPersona === undefined) {
    throw new Error('M4.5 database fixture 缺少行动者 Persona。')
  }
  return { actorPersona, observation, owner }
}

export async function assertM45PlayerDecisionReferencePersistence(
  sql: Sql,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      await clearFixtures(sql)
      const { actorPersona, observation, owner } = await sql.begin(
        insertReferenceFixture,
      )
      await insertSecondOwnerSession(sql)
      const port = createPostgresPlayerDecisionReferencePort({
        database: asDatabaseClient(sql),
      })

      const ready = await port.load({ owner, observation })
      expect(ready).toMatchObject({
        kind: 'ready',
        reference: {
          sessionId: observation.identity.sessionId,
          handId: observation.identity.handId,
          actorParticipantId: observation.identity.actorParticipantId,
          actorSeat: observation.identity.actorSeat,
          pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
          handNumber: observation.hand.handNumber,
          personaId: actorPersona.personaId,
          personaVersion: actorPersona.personaVersion,
          personaPolicy: actorPersona.style,
        },
      })
      if (ready.kind !== 'ready') {
        throw new Error('M4.5 database fixture 决策参考未就绪。')
      }
      expect(JSON.stringify(ready)).not.toMatch(
        /stateBeforeStartCommand|strategyDescription|models|memoryPayload/,
      )

      await sql`
        UPDATE app_private.hands
        SET hand_start_checkpoint_payload_version = 999
        WHERE id = ${observation.identity.handId}::uuid
      `
      await expect(port.load({ owner, observation })).rejects.toMatchObject({
        payloadKind: 'handStartCheckpoint',
      })
      await sql`
        UPDATE app_private.hands
        SET hand_start_checkpoint_payload_version = 1
        WHERE id = ${observation.identity.handId}::uuid
      `

      await sql`
        UPDATE app_private.session_agents
        SET config_payload_version = 999
        WHERE participant_id = ${observation.identity.actorParticipantId}::uuid
          AND session_id = ${observation.identity.sessionId}::uuid
      `
      await expect(port.load({ owner, observation })).rejects.toMatchObject({
        payloadKind: 'personaConfig',
      })
      await sql`
        UPDATE app_private.session_agents
        SET config_payload_version = ${PERSONA_CONFIG_PAYLOAD_VERSION}
        WHERE participant_id = ${observation.identity.actorParticipantId}::uuid
          AND session_id = ${observation.identity.sessionId}::uuid
      `

      await sql`
        UPDATE app_private.hands
        SET hand_number = hand_number + 1
        WHERE id = ${observation.identity.handId}::uuid
      `
      await expect(port.load({ owner, observation })).rejects.toMatchObject({
        corruption: 'invalidPlayerDecisionReference',
      })
      await sql`
        UPDATE app_private.hands
        SET hand_number = hand_number - 1
        WHERE id = ${observation.identity.handId}::uuid
      `

      await sql`
        UPDATE app_private.session_agents
        SET config_snapshot_key = ${'0'.repeat(64)}
        WHERE participant_id = ${observation.identity.actorParticipantId}::uuid
          AND session_id = ${observation.identity.sessionId}::uuid
      `
      await expect(port.load({ owner, observation })).rejects.toMatchObject({
        corruption: 'invalidPlayerDecisionReference',
      })
      await sql`
        UPDATE app_private.session_agents
        SET config_snapshot_key = ${ready.reference.configSnapshotKey}
        WHERE participant_id = ${observation.identity.actorParticipantId}::uuid
          AND session_id = ${observation.identity.sessionId}::uuid
      `

      await sql`
        UPDATE app_private.sessions
        SET state_version = state_version + 1
        WHERE id = ${observation.identity.sessionId}::uuid
      `
      await expect(port.load({ owner, observation })).resolves.toEqual({
        kind: 'stale',
      })
      await sql`
        UPDATE app_private.sessions
        SET state_version = state_version - 1
        WHERE id = ${observation.identity.sessionId}::uuid
      `

      const otherFixture = createPlayerObservationFixture({
        withPublicAction: true,
      })
      const otherOwnerObservation = certifyPlayerVisibleState(
        buildPlayerObservationDraft({
          ...otherFixture.input,
          identity: createPlayerDecisionIdentity({
            sessionId: SECOND_SESSION_ID,
            handId: observation.identity.handId,
            stateVersion: observation.identity.stateVersion,
            actorParticipantId: observation.identity.actorParticipantId,
            actorSeat: observation.identity.actorSeat,
            decisionRequestId: observation.identity.decisionRequestId,
          }),
        }),
      )
      await expect(
        port.load({ owner, observation: otherOwnerObservation }),
      ).resolves.toEqual({ kind: 'resourceMissing' })
    },
    () => clearFixtures(sql),
  )
}
