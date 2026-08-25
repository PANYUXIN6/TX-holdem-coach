import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../../src/personas/config.js'
import type { DatabaseClient } from '../../src/db/client.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createPostgresPlayerObservationPort } from '../../src/persistence/player-observation-authority.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { isPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import {
  INITIAL_AGENT_MEMORY,
  insertSessionRosterSnapshot,
} from '../helpers/session-roster-fixture.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'
import {
  createDatabaseTestSqlForRole,
  runDatabaseTestWithCleanup,
  serializeJsonbFixture,
} from './database-test-runtime.js'

const RUN_ID = '60000000-0000-4000-8000-000000000001'
const SECOND_OWNER_ID = '10000000-0000-4000-8000-000000000044'
const SECOND_SESSION_ID = '20000000-0000-4000-8000-000000000044'
const LEASE_OWNER = 'm44-database:player:0'
const FENCING_TOKEN = 7

function asDatabaseClient(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

async function clearOwnerSessions(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM app_private.sessions WHERE id = ${SECOND_SESSION_ID}::uuid
  `
  await sql`
    DELETE FROM app_private.owners WHERE id = ${SECOND_OWNER_ID}::uuid
  `
  await sql`
    DELETE FROM app_private.sessions
    WHERE owner_id = (
      SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
    )
  `
}

async function insertSecondOwnerSession(sql: Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${SECOND_OWNER_ID}::uuid, 'm44-second-owner')
    `
    await transaction`
      INSERT INTO app_private.sessions (id, owner_id)
      VALUES (${SECOND_SESSION_ID}::uuid, ${SECOND_OWNER_ID}::uuid)
    `
    for (let seatNumber = 0; seatNumber < 6; seatNumber += 1) {
      const participantId = `70000000-0000-4000-8000-${String(
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
            ${SECOND_OWNER_ID}::uuid, ${`M44 Agent ${seatNumber}`}, '#000000',
            ${`m44-persona-${seatNumber}`}, 1, ${'0'.repeat(64)},
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

async function insertFixture(transaction: TransactionSql) {
  const owner = await resolveOwnerScope(transaction, { ownerId: 'local-user' })
  const fixture = createPlayerObservationFixture({ withPublicAction: true })
  const catalog = loadAndValidatePersonaCatalog().list().slice(0, 5)
  const stateSeats = fixture.input.state.poker.seats
  const userParticipantId = stateSeats.find((seat) => seat.isUser)?.playerId
  if (userParticipantId === undefined) throw new Error('M4.4 缺少用户座位。')
  await insertSessionRosterSnapshot(transaction, {
    owner,
    sessionId: fixture.input.identity.sessionId,
    userParticipantId,
    agents: catalog.map((entry, index) => {
      const payload = PersonaConfigPayloadSchema.parse({
        ...entry,
        personaVersion: 1,
      })
      const seat = stateSeats[index + 1]
      if (seat === undefined) throw new Error('M4.4 缺少 Agent 座位。')
      return {
        seatNumber: seat.seatNumber,
        agentParticipantId: seat.playerId,
        displayName: payload.name,
        avatarColor: payload.avatarColor,
        personaId: payload.personaId,
        personaVersion: payload.personaVersion,
        configSnapshotKey: createConfigSnapshotKey(
          PERSONA_CONFIG_PAYLOAD_VERSION,
          payload,
        ),
        configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
        configPayload: payload,
        initialMemory: INITIAL_AGENT_MEMORY,
      }
    }),
  })
  const participantSeats = fixture.input.state.poker.seats.map(
    (seat) => seat.seatNumber,
  )
  await transaction`
    INSERT INTO app_private.hands (
      id, session_id, owner_id, hand_number, status,
      hand_start_checkpoint_payload_version, hand_start_checkpoint_payload,
      completed_result_payload_version, completed_result_payload,
      abort_reason, aborted_by_agent_run_id, button_seat, participant_seats,
      started_at, completed_at, aborted_at, updated_at
    ) VALUES (
      ${fixture.input.identity.handId}::uuid,
      ${fixture.input.identity.sessionId}::uuid,
      ${owner.databaseOwnerId}::uuid,
      1, 'inProgress', 1, ${transaction.json({})}, NULL, NULL,
      NULL, NULL, 0, ${participantSeats}::integer[],
      CURRENT_TIMESTAMP, NULL, NULL, CURRENT_TIMESTAMP
    )
  `
  const snapshot = encodeSnapshot(fixture.input.state)
  await transaction`
    INSERT INTO app_private.session_snapshots (
      session_id, owner_id, private_table_state_payload_version,
      private_table_state_payload
    ) VALUES (
      ${fixture.input.identity.sessionId}::uuid,
      ${owner.databaseOwnerId}::uuid,
      ${snapshot.payloadVersion},
      ${serializeJsonbFixture(snapshot.payload)}::text::jsonb
    )
  `
  for (const row of fixture.input.events) {
    const stored = encodeCurrentPrivateEvent(row.event)
    await transaction`
      INSERT INTO app_private.session_events (
        id, session_id, owner_id, hand_id, command_ledger_id,
        event_seq, state_version_before, state_version_after,
        private_event_payload_version, private_event_payload,
        public_event_payload, created_at
      ) VALUES (
        ${randomUUID()}::uuid, ${fixture.input.identity.sessionId}::uuid,
        ${owner.databaseOwnerId}::uuid, ${row.handId}::uuid, NULL,
        ${row.eventSeq}::bigint, ${row.stateVersionBefore}::bigint,
        ${row.stateVersionAfter}::bigint, ${stored.payloadVersion},
        ${serializeJsonbFixture(stored.payload)}::text::jsonb,
        ${transaction.json({})},
        CURRENT_TIMESTAMP
      )
    `
  }
  await transaction`
    INSERT INTO app_private.agent_runs (
      id, owner_id, session_id, runtime, trigger_type, lifecycle,
      idempotency_key, hand_id, participant_id, source_state_version,
      decision_request_id, parent_run_id, replacement_run_id,
      lease_owner, lease_expires_at, fencing_token, deadline_at,
      runtime_definition_version, termination_reason,
      run_config_payload_version, run_config_payload,
      budget_payload_version, budget_payload,
      created_at, started_at, completed_at, updated_at
    ) VALUES (
      ${RUN_ID}::uuid, ${owner.databaseOwnerId}::uuid,
      ${fixture.input.identity.sessionId}::uuid, 'player', 'action_required',
      'running', 'm44/database/player', ${fixture.input.identity.handId}::uuid,
      ${fixture.input.identity.actorParticipantId}::uuid,
      ${fixture.input.identity.stateVersion}::bigint,
      ${fixture.input.identity.decisionRequestId}::uuid,
      NULL, NULL, ${LEASE_OWNER}, CURRENT_TIMESTAMP + interval '10 minutes',
      ${FENCING_TOKEN}::bigint, CURRENT_TIMESTAMP + interval '10 minutes',
      1, NULL, 1, ${transaction.json({})}, 1, ${transaction.json({})},
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
    )
  `
  await transaction`
    UPDATE app_private.sessions
    SET state_version = ${fixture.input.identity.stateVersion}::bigint,
        next_event_seq = ${fixture.input.asOfEventSeq + 1}::bigint,
        current_hand_id = ${fixture.input.identity.handId}::uuid,
        agent_run_state = 'thinking',
        active_player_run_id = ${RUN_ID}::uuid,
        active_decision_request_id =
          ${fixture.input.identity.decisionRequestId}::uuid,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ${fixture.input.identity.sessionId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
  `
  return { owner, fixture }
}

function createDeferred(): {
  readonly promise: Promise<void>
  readonly resolve: () => void
} {
  let resolvePromise: (() => void) | undefined
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: () => resolvePromise?.() }
}

async function waitForObservationLock(
  writer: Sql,
  relation: 'sessions' | 'agent_runs',
  id: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await writer.begin(async (transaction) => {
        await transaction`SET LOCAL lock_timeout = '100ms'`
        if (relation === 'sessions') {
          await transaction`
            UPDATE app_private.sessions
            SET updated_at = updated_at
            WHERE id = ${id}::uuid
          `
        } else {
          await transaction`
            UPDATE app_private.agent_runs
            SET updated_at = updated_at
            WHERE id = ${id}::uuid
          `
        }
      })
    } catch (error) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '55P03'
      ) {
        return
      }
      throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`M4.4 observation did not retain ${relation} shared lock.`)
}

async function assertObservationRetainsSessionLock(
  blocker: Sql,
  writer: Sql,
  observationPort: ReturnType<typeof createPostgresPlayerObservationPort>,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  fixture: ReturnType<typeof createPlayerObservationFixture>,
): Promise<void> {
  const locked = createDeferred()
  const release = createDeferred()
  const holder = blocker.begin(async (transaction) => {
    await transaction`
      UPDATE app_private.agent_runs
      SET updated_at = updated_at
      WHERE id = ${RUN_ID}::uuid
    `
    locked.resolve()
    await release.promise
  })
  await locked.promise
  const loading = observationPort.load({
    owner,
    identity: fixture.input.identity,
  })
  try {
    await waitForObservationLock(
      writer,
      'sessions',
      fixture.input.identity.sessionId,
    )
  } finally {
    release.resolve()
    await holder
  }
  await expect(loading).resolves.toMatchObject({ kind: 'ready' })
}

async function assertObservationRetainsRunLock(
  blocker: Sql,
  writer: Sql,
  observationPort: ReturnType<typeof createPostgresPlayerObservationPort>,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  fixture: ReturnType<typeof createPlayerObservationFixture>,
): Promise<void> {
  const locked = createDeferred()
  const release = createDeferred()
  const holder = blocker.begin(async (transaction) => {
    await transaction`
      LOCK TABLE app_private.session_snapshots IN ACCESS EXCLUSIVE MODE
    `
    locked.resolve()
    await release.promise
  })
  await locked.promise
  const loading = observationPort.load({
    owner,
    identity: fixture.input.identity,
  })
  try {
    await waitForObservationLock(writer, 'agent_runs', RUN_ID)
  } finally {
    release.resolve()
    await holder
  }
  await expect(loading).resolves.toMatchObject({ kind: 'ready' })
}

async function waitForRunLeaseExpiry(sql: Sql): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const rows = await sql<{ readonly expired: boolean }[]>`
      SELECT (lease_expires_at <= clock_timestamp()) AS expired
      FROM app_private.agent_runs
      WHERE id = ${RUN_ID}::uuid
    `
    if (rows[0]?.expired === true) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('M4.4 test lease did not expire in time.')
}

async function assertObservationRejectsLeaseExpiryDuringRead(
  blocker: Sql,
  writer: Sql,
  observationPort: ReturnType<typeof createPostgresPlayerObservationPort>,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  fixture: ReturnType<typeof createPlayerObservationFixture>,
): Promise<void> {
  await writer`
    UPDATE app_private.agent_runs
    SET lease_expires_at = clock_timestamp() + interval '2 seconds',
        updated_at = clock_timestamp()
    WHERE id = ${RUN_ID}::uuid
  `
  const locked = createDeferred()
  const release = createDeferred()
  const holder = blocker.begin(async (transaction) => {
    await transaction`
      LOCK TABLE app_private.session_snapshots IN ACCESS EXCLUSIVE MODE
    `
    locked.resolve()
    await release.promise
  })
  await locked.promise
  const loading = observationPort.load({
    owner,
    identity: fixture.input.identity,
  })
  try {
    await waitForObservationLock(writer, 'agent_runs', RUN_ID)
    await waitForRunLeaseExpiry(writer)
  } finally {
    release.resolve()
    await holder
  }
  try {
    await expect(loading).resolves.toEqual({ kind: 'authorityLost' })
  } finally {
    await writer`
      UPDATE app_private.agent_runs
      SET lease_expires_at = clock_timestamp() + interval '10 minutes',
          updated_at = clock_timestamp()
      WHERE id = ${RUN_ID}::uuid
    `
  }
}

export async function assertM44PlayerObservationPersistence(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const secondary = createDatabaseTestSqlForRole(runtimeUrl, 'm44-secondary')
  const tertiary = createDatabaseTestSqlForRole(runtimeUrl, 'm44-tertiary')
  await runDatabaseTestWithCleanup(
    async () => {
      await clearOwnerSessions(sql)
      const { owner, fixture } = await sql.begin(insertFixture)
      await insertSecondOwnerSession(sql)
      const observationPort = createPostgresPlayerObservationPort({
        authority: issueRuntimeCommitAuthority({
          runtimeType: 'player',
          runId: RUN_ID,
          leaseOwner: LEASE_OWNER,
          fencingToken: FENCING_TOKEN,
        }),
        database: asDatabaseClient(sql),
      })
      const ready = await observationPort.load({
        owner,
        identity: fixture.input.identity,
      })
      expect(ready.kind).toBe('ready')
      if (ready.kind !== 'ready') throw new Error('M4.4 权威观察未就绪。')
      expect(isPlayerVisibleState(ready.observation)).toBe(true)
      expect(ready.observation.hand.heroHoleCards).toEqual(
        fixture.expectedHeroCards,
      )

      for (const identity of [
        createPlayerDecisionIdentity({
          ...fixture.input.identity,
          sessionId: SECOND_SESSION_ID,
        }),
        createPlayerDecisionIdentity({
          ...fixture.input.identity,
          handId: randomUUID(),
        }),
        createPlayerDecisionIdentity({
          ...fixture.input.identity,
          decisionRequestId: randomUUID(),
        }),
        createPlayerDecisionIdentity({
          ...fixture.input.identity,
          actorParticipantId: randomUUID(),
        }),
        createPlayerDecisionIdentity({
          ...fixture.input.identity,
          actorSeat: fixture.input.identity.actorSeat + 1,
        }),
      ]) {
        const expectedKind =
          identity.sessionId === fixture.input.identity.sessionId
            ? 'stale'
            : 'resourceMissing'
        await expect(
          observationPort.load({ owner, identity }),
        ).resolves.toEqual({ kind: expectedKind })
      }

      await assertObservationRetainsSessionLock(
        secondary,
        tertiary,
        observationPort,
        owner,
        fixture,
      )
      await assertObservationRetainsRunLock(
        secondary,
        tertiary,
        observationPort,
        owner,
        fixture,
      )
      await assertObservationRejectsLeaseExpiryDuringRead(
        secondary,
        tertiary,
        observationPort,
        owner,
        fixture,
      )

      await sql`
        UPDATE app_private.sessions
        SET state_version = state_version + 1
        WHERE id = ${fixture.input.identity.sessionId}::uuid
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).resolves.toEqual({ kind: 'stale' })
      await sql`
        UPDATE app_private.sessions
        SET state_version = state_version - 1
        WHERE id = ${fixture.input.identity.sessionId}::uuid
      `

      await sql`
        UPDATE app_private.agent_runs SET fencing_token = 8
        WHERE id = ${RUN_ID}::uuid
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).resolves.toEqual({ kind: 'authorityLost' })
      await sql`
        UPDATE app_private.agent_runs SET fencing_token = ${FENCING_TOKEN}
        WHERE id = ${RUN_ID}::uuid
      `

      await sql`
        UPDATE app_private.agent_runs
        SET updated_at = clock_timestamp() - interval '2 seconds',
            lease_expires_at = clock_timestamp() - interval '1 second'
        WHERE id = ${RUN_ID}::uuid
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).resolves.toEqual({ kind: 'authorityLost' })
      await sql`
        UPDATE app_private.agent_runs
        SET lease_expires_at = clock_timestamp() + interval '10 minutes'
        WHERE id = ${RUN_ID}::uuid
      `

      await sql`
        UPDATE app_private.session_events
        SET state_version_before = 0
        WHERE session_id = ${fixture.input.identity.sessionId}::uuid
          AND event_seq = 2
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).rejects.toMatchObject({ corruption: 'invalidPlayerObservation' })
      await sql`
        UPDATE app_private.session_events
        SET state_version_before = 1
        WHERE session_id = ${fixture.input.identity.sessionId}::uuid
          AND event_seq = 2
      `

      await sql`
        UPDATE app_private.session_snapshots
        SET private_table_state_payload_version = 999
        WHERE session_id = ${fixture.input.identity.sessionId}::uuid
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).rejects.toMatchObject({ corruption: 'invalidPlayerObservation' })

      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE app_private.agent_runs
          SET lifecycle = 'cancelled', lease_owner = NULL,
              lease_expires_at = NULL, completed_at = clock_timestamp(),
              termination_reason = 'm44_test_terminated',
              updated_at = clock_timestamp()
          WHERE id = ${RUN_ID}::uuid
        `
        await transaction`
          UPDATE app_private.sessions
          SET agent_run_state = 'idle', active_player_run_id = NULL,
              active_decision_request_id = NULL,
              updated_at = clock_timestamp()
          WHERE id = ${fixture.input.identity.sessionId}::uuid
        `
      })
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).resolves.toEqual({ kind: 'stale' })
      await sql`
        UPDATE app_private.sessions
        SET lifecycle_status = 'ended', agent_run_state = 'idle',
            active_player_run_id = NULL, active_decision_request_id = NULL,
            ended_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${fixture.input.identity.sessionId}::uuid
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).resolves.toEqual({ kind: 'stale' })

      await sql`
        DELETE FROM app_private.sessions
        WHERE id = ${fixture.input.identity.sessionId}::uuid
      `
      await expect(
        observationPort.load({ owner, identity: fixture.input.identity }),
      ).resolves.toEqual({ kind: 'resourceMissing' })
    },
    async () => {
      await secondary.end({ timeout: 0 })
      await tertiary.end({ timeout: 0 })
      await clearOwnerSessions(sql)
    },
  )
}
