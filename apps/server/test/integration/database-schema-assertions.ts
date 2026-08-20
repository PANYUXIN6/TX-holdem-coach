import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import {
  LOCAL_USER_IDENTITY_KEY,
  LOCAL_USER_OWNER_ID,
  sessions,
} from '../../src/db/schema.js'
import {
  createDatabaseFixtureContext,
  type DatabaseFixtureContext,
} from './database-fixture-context.js'
import { createDatabaseTestSqlForRole } from './database-test-runtime.js'

const BUSINESS_TABLES = [
  'agent_attempts',
  'agent_capability_invocations',
  'agent_memory_revisions',
  'agent_runs',
  'app_settings',
  'command_ledger',
  'hands',
  'owners',
  'session_agents',
  'session_events',
  'session_participants',
  'session_snapshots',
  'sessions',
] as const

const CONFIG_SNAPSHOT_KEY = 'a'.repeat(64)
const PAYLOAD_DIGEST = 'b'.repeat(64)

interface SessionGraph {
  readonly sessionId: string
  readonly userParticipantId: string
  readonly agentParticipantIds: readonly string[]
}

let activeFixtureContext: DatabaseFixtureContext | undefined

function getFixtureContext(): DatabaseFixtureContext {
  if (activeFixtureContext === undefined) {
    throw new Error('Database fixture context is not active.')
  }

  return activeFixtureContext
}

function fixtureId(value: number): string {
  return getFixtureContext().id(value)
}

function fixtureOwnerId(): string {
  return getFixtureContext().mainOwner.id
}

async function insertSessionGraph(
  tx: TransactionSql,
  base: number,
  options: {
    readonly ownerId?: string
    readonly lifecycle?: 'active' | 'ended'
    readonly agentCount?: number
    readonly omitAgentChildSeat?: number
    readonly attachAgentToUser?: boolean
  } = {},
): Promise<SessionGraph> {
  const sessionId = fixtureId(base)
  const userParticipantId = fixtureId(base + 1)
  const agentCount = options.agentCount ?? 5
  const ownerId = options.ownerId ?? fixtureOwnerId()
  const lifecycle = options.lifecycle ?? 'ended'
  const agentParticipantIds = Array.from({ length: agentCount }, (_, index) =>
    fixtureId(base + 10 + index),
  )

  if (lifecycle === 'ended') {
    await tx`
      INSERT INTO app_private.sessions (
        id,
        owner_id,
        lifecycle_status,
        ended_at
      )
      VALUES (
        ${sessionId},
        ${ownerId},
        'ended',
        now()
      )
    `
  } else {
    await tx`
      INSERT INTO app_private.sessions (
        id,
        owner_id,
        lifecycle_status,
        ended_at
      )
      VALUES (
        ${sessionId},
        ${ownerId},
        'active',
        NULL
      )
    `
  }

  await tx`
    INSERT INTO app_private.session_participants (
      id,
      session_id,
      owner_id,
      participant_type,
      seat_number
    )
    VALUES (
      ${userParticipantId},
      ${sessionId},
      ${ownerId},
      'user',
      0
    )
  `

  for (const [index, participantId] of agentParticipantIds.entries()) {
    const seatNumber = index + 1

    await tx`
      INSERT INTO app_private.session_participants (
        id,
        session_id,
        owner_id,
        participant_type,
        seat_number
      )
      VALUES (
        ${participantId},
        ${sessionId},
        ${ownerId},
        'agent',
        ${seatNumber}
      )
    `

    if (seatNumber === options.omitAgentChildSeat) {
      continue
    }

    await insertSessionAgent(tx, {
      participantId,
      sessionId,
      ownerId,
      suffix: String(seatNumber),
    })
  }

  if (options.attachAgentToUser === true) {
    await insertSessionAgent(tx, {
      participantId: userParticipantId,
      sessionId,
      ownerId,
      suffix: 'user',
    })
  }

  return { sessionId, userParticipantId, agentParticipantIds }
}

async function insertSessionAgent(
  tx: TransactionSql,
  input: {
    readonly participantId: string
    readonly sessionId: string
    readonly ownerId: string
    readonly suffix: string
  },
): Promise<void> {
  await tx`
    INSERT INTO app_private.session_agents (
      participant_id,
      session_id,
      owner_id,
      display_name,
      avatar_color,
      persona_id,
      persona_version,
      config_snapshot_key,
      current_memory_revision,
      config_payload_version,
      config_payload,
      memory_payload_version,
      memory_payload
    )
    VALUES (
      ${input.participantId},
      ${input.sessionId},
      ${input.ownerId},
      ${`Agent ${input.suffix}`},
      '#123456',
      ${`persona-${input.suffix}`},
      1,
      ${CONFIG_SNAPSHOT_KEY},
      0,
      1,
      '{}'::jsonb,
      1,
      '{}'::jsonb
    )
  `

  await tx`
    INSERT INTO app_private.agent_memory_revisions (
      participant_id,
      session_id,
      owner_id,
      revision,
      memory_payload_version,
      memory_payload
    )
    VALUES (
      ${input.participantId},
      ${input.sessionId},
      ${input.ownerId},
      0,
      1,
      '{}'::jsonb
    )
  `
}

async function insertHand(
  tx: TransactionSql,
  input: {
    readonly id: string
    readonly sessionId: string
    readonly ownerId?: string
    readonly handNumber?: number
    readonly status: 'inProgress' | 'completed' | 'aborted'
  },
): Promise<void> {
  const ownerId = input.ownerId ?? fixtureOwnerId()

  if (input.status === 'completed') {
    await tx`
      INSERT INTO app_private.hands (
        id,
        session_id,
        owner_id,
        hand_number,
        status,
        hand_start_checkpoint_payload_version,
        hand_start_checkpoint_payload,
        completed_result_payload_version,
        completed_result_payload,
        button_seat,
        participant_seats,
        started_at,
        completed_at
      )
      VALUES (
        ${input.id},
        ${input.sessionId},
        ${ownerId},
        ${input.handNumber ?? 1},
        'completed',
        1,
        '{}'::jsonb,
        1,
        '{}'::jsonb,
        1,
        ARRAY[0,1,2,3,4,5]::integer[],
        now(),
        now()
      )
    `
    return
  }

  if (input.status === 'aborted') {
    await tx`
      INSERT INTO app_private.hands (
        id,
        session_id,
        owner_id,
        hand_number,
        status,
        hand_start_checkpoint_payload_version,
        hand_start_checkpoint_payload,
        abort_reason,
        button_seat,
        participant_seats,
        started_at,
        aborted_at
      )
      VALUES (
        ${input.id},
        ${input.sessionId},
        ${ownerId},
        ${input.handNumber ?? 1},
        'aborted',
        1,
        '{}'::jsonb,
        'runtime failure',
        1,
        ARRAY[0,1,2,3,4,5]::integer[],
        now(),
        now()
      )
    `
    return
  }

  await tx`
    INSERT INTO app_private.hands (
      id,
      session_id,
      owner_id,
      hand_number,
      status,
      hand_start_checkpoint_payload_version,
      hand_start_checkpoint_payload,
      button_seat,
      participant_seats,
      started_at
    )
    VALUES (
      ${input.id},
      ${input.sessionId},
      ${ownerId},
      ${input.handNumber ?? 1},
      'inProgress',
      1,
      '{}'::jsonb,
      1,
      ARRAY[0,1,2,3,4,5]::integer[],
      now()
    )
  `
}

async function insertAgentRun(
  tx: TransactionSql,
  input: {
    readonly id: string
    readonly sessionId: string
    readonly handId: string
    readonly runtime: 'player' | 'coach'
    readonly lifecycle?: string
    readonly participantId?: string
    readonly sourceStateVersion?: number
    readonly decisionRequestId?: string
    readonly idempotencyKey: string
  },
): Promise<void> {
  await tx`
    INSERT INTO app_private.agent_runs (
      id,
      owner_id,
      session_id,
      runtime,
      trigger_type,
      lifecycle,
      idempotency_key,
      hand_id,
      participant_id,
      source_state_version,
      decision_request_id,
      fencing_token,
      deadline_at,
      runtime_definition_version,
      run_config_payload_version,
      run_config_payload,
      budget_payload_version,
      budget_payload
    )
    VALUES (
      ${input.id},
      ${fixtureOwnerId()},
      ${input.sessionId},
      ${input.runtime},
      'manual',
      ${input.lifecycle ?? 'queued'},
      ${input.idempotencyKey},
      ${input.handId},
      ${input.participantId ?? null},
      ${input.sourceStateVersion ?? null},
      ${input.decisionRequestId ?? null},
      0,
      now() + interval '1 minute',
      1,
      1,
      '{}'::jsonb,
      1,
      '{}'::jsonb
    )
  `
}

async function assertSchemaStructure(sql: Sql): Promise<void> {
  const tables = await sql<{ readonly tableName: string }[]>`
    SELECT table_name AS "tableName"
    FROM information_schema.tables
    WHERE table_schema = 'app_private'
      AND table_name <> '__drizzle_migrations'
    ORDER BY table_name
  `

  expect(tables.map((row) => row.tableName)).toEqual([...BUSINESS_TABLES])

  const bannedTables = await sql<{ readonly count: string }[]>`
    SELECT count(*)::text AS count
    FROM information_schema.tables
    WHERE table_schema = 'app_private'
      AND table_name IN (
        'agent_templates',
        'agent_personas',
        'hand_events',
        'streets',
        'betting_rounds',
        'showdowns',
        'hand_actions',
        'coach_decision_assessments',
        'coach_reviews',
        'hand_statistics_shards',
        'session_settlement_statistics_shards'
      )
  `
  expect(bannedTables[0]?.count).toBe('0')

  const bannedColumns = await sql<
    { readonly tableName: string; readonly columnName: string }[]
  >`
    SELECT
      table_name AS "tableName",
      column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = 'app_private'
      AND (
        column_name ~ '(api_key|database_url|password|secret|reasoning_content)'
        OR (table_name = 'session_agents' AND column_name = 'current_stack')
        OR (
          table_name = 'sessions'
          AND column_name IN ('button_position', 'result_summary')
        )
      )
  `
  expect(bannedColumns).toEqual([])

  const triggerFunctions = await sql<{ readonly routineName: string }[]>`
    SELECT routine_name AS "routineName"
    FROM information_schema.routines
    WHERE routine_schema = 'app_private'
      AND routine_name IN (
        'enforce_session_roster',
        'enforce_player_run_coordination',
        'enforce_coach_completed_hand'
      )
    ORDER BY routine_name
  `
  expect(triggerFunctions.map((row) => row.routineName)).toEqual([
    'enforce_coach_completed_hand',
    'enforce_player_run_coordination',
    'enforce_session_roster',
  ])

  const deferredConstraints = await sql<{ readonly constraintName: string }[]>`
    SELECT conname AS "constraintName"
    FROM pg_catalog.pg_constraint
    WHERE connamespace = 'app_private'::regnamespace
      AND condeferrable
      AND condeferred
    ORDER BY conname
  `
  expect(deferredConstraints.map((row) => row.constraintName)).toEqual(
    expect.arrayContaining([
      'agent_runs_parent_scope_fk',
      'agent_runs_replacement_scope_fk',
      'hands_aborted_by_agent_run_fk',
      'session_agents_current_memory_revision_fk',
      'sessions_active_player_run_fk',
      'sessions_current_hand_scope_fk',
    ]),
  )

  const publicPrivileges = await sql<{ readonly count: string }[]>`
    SELECT count(*)::text AS count
    FROM information_schema.role_table_grants
    WHERE table_schema = 'app_private'
      AND grantee IN ('PUBLIC', 'anon', 'authenticated')
  `
  expect(publicPrivileges[0]?.count).toBe('0')
}

async function assertOwnerPayloadAndBigintConstraints(sql: Sql): Promise<void> {
  const owner = await sql<
    { readonly id: string; readonly identityKey: string }[]
  >`
    SELECT id::text AS id, identity_key AS "identityKey"
    FROM app_private.owners
    WHERE id = ${LOCAL_USER_OWNER_ID}
  `
  expect(owner).toEqual([
    { id: LOCAL_USER_OWNER_ID, identityKey: LOCAL_USER_IDENTITY_KEY },
  ])

  const graph = await sql.begin((tx) => insertSessionGraph(tx, 1_000))

  await sql`
    UPDATE app_private.sessions
    SET state_version = 42
    WHERE id = ${graph.sessionId}
  `

  const db = drizzle(sql)
  const rows = await db
    .select({ stateVersion: sessions.stateVersion })
    .from(sessions)
    .where(eq(sessions.id, graph.sessionId))
  expect(rows).toEqual([{ stateVersion: 42 }])
  expect(typeof rows[0]?.stateVersion).toBe('number')

  await expect(
    sql`
      UPDATE app_private.sessions
      SET state_version = 9007199254740992
      WHERE id = ${graph.sessionId}
    `,
  ).rejects.toThrow()

  await expect(
    sql`
      UPDATE app_private.sessions
      SET state_version = -1
      WHERE id = ${graph.sessionId}
    `,
  ).rejects.toThrow()

  await expect(
    sql`
      INSERT INTO app_private.session_snapshots (
        session_id,
        owner_id,
        private_table_state_payload_version,
        private_table_state_payload
      )
      VALUES (
        ${graph.sessionId},
        ${fixtureOwnerId()},
        0,
        '{}'::jsonb
      )
    `,
  ).rejects.toThrow()

  await expect(
    sql`
      INSERT INTO app_private.session_snapshots (
        session_id,
        owner_id,
        private_table_state_payload_version,
        private_table_state_payload
      )
      VALUES (
        ${graph.sessionId},
        ${fixtureOwnerId()},
        1,
        '[]'::jsonb
      )
    `,
  ).rejects.toThrow()

  await sql`
    INSERT INTO app_private.session_snapshots (
      session_id,
      owner_id,
      private_table_state_payload_version,
      private_table_state_payload
    )
    VALUES (
      ${graph.sessionId},
      ${fixtureOwnerId()},
      1,
      '{"revision":1}'::jsonb
    )
    ON CONFLICT (session_id) DO UPDATE
    SET
      private_table_state_payload_version = EXCLUDED.private_table_state_payload_version,
      private_table_state_payload = EXCLUDED.private_table_state_payload,
      updated_at = now()
  `
  await sql`
    INSERT INTO app_private.session_snapshots (
      session_id,
      owner_id,
      private_table_state_payload_version,
      private_table_state_payload
    )
    VALUES (
      ${graph.sessionId},
      ${fixtureOwnerId()},
      1,
      '{"revision":2}'::jsonb
    )
    ON CONFLICT (session_id) DO UPDATE
    SET
      private_table_state_payload_version = EXCLUDED.private_table_state_payload_version,
      private_table_state_payload = EXCLUDED.private_table_state_payload,
      updated_at = now()
  `

  const snapshots = await sql<
    { readonly count: string; readonly revision: string }[]
  >`
    SELECT
      count(*)::text AS count,
      max(private_table_state_payload ->> 'revision') AS revision
    FROM app_private.session_snapshots
    WHERE session_id = ${graph.sessionId}
  `
  expect(snapshots[0]).toEqual({ count: '1', revision: '2' })

  await sql`DELETE FROM app_private.sessions WHERE id = ${graph.sessionId}`
}

async function assertSessionDiagnosticConstraints(sql: Sql): Promise<void> {
  const graph = await sql.begin((transaction) =>
    insertSessionGraph(transaction, 1_850, { lifecycle: 'ended' }),
  )

  await expect(sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'readonlyDiagnostic'
    WHERE id = ${graph.sessionId}::uuid
  `).rejects.toThrow()
  await expect(sql`
    UPDATE app_private.sessions
    SET diagnostic_code = 'snapshotMissing'
    WHERE id = ${graph.sessionId}::uuid
  `).rejects.toThrow()
  await expect(sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'readonlyDiagnostic',
        diagnostic_code = 'notAStableDiagnosticCode',
        diagnosed_at = clock_timestamp()
    WHERE id = ${graph.sessionId}::uuid
  `).rejects.toThrow()
  await expect(sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'active'
    WHERE id = ${graph.sessionId}::uuid
  `).rejects.toThrow()

  await sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'readonlyDiagnostic',
        diagnostic_code = 'snapshotMissing',
        diagnosed_at = clock_timestamp()
    WHERE id = ${graph.sessionId}::uuid
  `
  const rows = await sql<
    {
      readonly diagnosticCode: string | null
      readonly diagnosedAt: string | null
      readonly endedAt: string | null
    }[]
  >`
    SELECT
      diagnostic_code AS "diagnosticCode",
      diagnosed_at::text AS "diagnosedAt",
      ended_at::text AS "endedAt"
    FROM app_private.sessions
    WHERE id = ${graph.sessionId}::uuid
  `
  expect(rows[0]?.diagnosticCode).toBe('snapshotMissing')
  expect(rows[0]?.diagnosedAt).not.toBeNull()
  expect(rows[0]?.endedAt).not.toBeNull()
}

async function assertRosterConstraints(sql: Sql): Promise<void> {
  await expect(
    sql.begin(async (tx) => {
      await tx`
        INSERT INTO app_private.sessions (
          id,
          owner_id,
          lifecycle_status,
          ended_at
        )
        VALUES (
          ${fixtureId(2_000)},
          ${fixtureOwnerId()},
          'ended',
          now()
        )
      `
    }),
  ).rejects.toThrow()

  await expect(
    sql.begin((tx) =>
      insertSessionGraph(tx, 2_100, {
        agentCount: 4,
      }),
    ),
  ).rejects.toThrow()

  await expect(
    sql.begin((tx) =>
      insertSessionGraph(tx, 2_200, {
        omitAgentChildSeat: 5,
      }),
    ),
  ).rejects.toThrow()

  await expect(
    sql.begin((tx) =>
      insertSessionGraph(tx, 2_300, {
        attachAgentToUser: true,
      }),
    ),
  ).rejects.toThrow()

  await expect(
    sql.begin(async (tx) => {
      const graph = await insertSessionGraph(tx, 2_400)
      await tx`
        INSERT INTO app_private.session_participants (
          id,
          session_id,
          owner_id,
          participant_type,
          seat_number
        )
        VALUES (
          ${fixtureId(2_499)},
          ${graph.sessionId},
          ${fixtureOwnerId()},
          'agent',
          1
        )
      `
    }),
  ).rejects.toThrow()

  const graph = await sql.begin((tx) => insertSessionGraph(tx, 2_500))
  await expect(
    sql`DELETE FROM app_private.session_agents
        WHERE participant_id = ${graph.agentParticipantIds[0]!}`,
  ).rejects.toThrow()

  await sql`DELETE FROM app_private.sessions WHERE id = ${graph.sessionId}`
  const remaining = await sql<{ readonly count: string }[]>`
    SELECT count(*)::text AS count
    FROM app_private.session_participants
    WHERE session_id = ${graph.sessionId}
  `
  expect(remaining[0]?.count).toBe('0')
}

async function assertHandParticipantSeats(sql: Sql): Promise<void> {
  const graph = await sql.begin((tx) => insertSessionGraph(tx, 2_600))
  const handId = fixtureId(2_700)

  await sql.begin((tx) =>
    insertHand(tx, {
      id: handId,
      sessionId: graph.sessionId,
      status: 'completed',
    }),
  )

  await expect(
    sql`
      UPDATE app_private.hands
      SET participant_seats = ARRAY[0,1,1,2,3,4]::integer[]
      WHERE id = ${handId}
    `,
  ).rejects.toThrow()

  await sql`DELETE FROM app_private.sessions WHERE id = ${graph.sessionId}`
}

async function assertActiveSessionConcurrency(
  sql: Sql,
  testDatabaseUrl: string,
): Promise<void> {
  const competingSql = createDatabaseTestSqlForRole(
    testDatabaseUrl,
    'm22-active-concurrent',
  )

  try {
    await competingSql`SELECT 1`
    const sameOwnerResults = await Promise.allSettled([
      sql.begin((tx) => insertSessionGraph(tx, 3_000, { lifecycle: 'active' })),
      competingSql.begin((tx) =>
        insertSessionGraph(tx, 3_100, { lifecycle: 'active' }),
      ),
    ])
    expect(
      sameOwnerResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)

    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${fixtureId(3_000)}, ${fixtureId(3_100)})
    `

    const ownerTwo = getFixtureContext().registerOwner('concurrency-two', 3_200)
    const ownerThree = getFixtureContext().registerOwner(
      'concurrency-three',
      3_300,
    )
    await sql`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES
        (${ownerTwo.id}, ${ownerTwo.identityKey}),
        (${ownerThree.id}, ${ownerThree.identityKey})
    `

    const differentOwnerResults = await Promise.allSettled([
      sql.begin((tx) =>
        insertSessionGraph(tx, 3_201, {
          ownerId: ownerTwo.id,
          lifecycle: 'active',
        }),
      ),
      competingSql.begin((tx) =>
        insertSessionGraph(tx, 3_301, {
          ownerId: ownerThree.id,
          lifecycle: 'active',
        }),
      ),
    ])
    expect(
      differentOwnerResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(2)

    await sql`
      DELETE FROM app_private.sessions
      WHERE owner_id IN (${ownerTwo.id}, ${ownerThree.id})
    `
    await sql`
      DELETE FROM app_private.owners
      WHERE id IN (${ownerTwo.id}, ${ownerThree.id})
    `
  } finally {
    await competingSql.end({ timeout: 0 })
  }
}

async function assertPlayerCoordination(
  sql: Sql,
  testDatabaseUrl: string,
): Promise<void> {
  const competingSql = createDatabaseTestSqlForRole(
    testDatabaseUrl,
    'm22-player-concurrent',
  )
  let competingSessionId: string | undefined

  try {
    await competingSql`SELECT 1`
    const competingGraph = await sql.begin((tx) =>
      insertSessionGraph(tx, 3_500),
    )
    competingSessionId = competingGraph.sessionId
    const competingHandId = fixtureId(3_600)
    const competingParticipantId = competingGraph.agentParticipantIds[0]!
    const competingRunIds = [fixtureId(3_700), fixtureId(3_701)] as const
    const competingRequestIds = [fixtureId(3_800), fixtureId(3_801)] as const

    await sql.begin((tx) =>
      insertHand(tx, {
        id: competingHandId,
        sessionId: competingGraph.sessionId,
        status: 'inProgress',
      }),
    )

    const competingResults = await Promise.allSettled(
      [sql, competingSql].map((connection, index) =>
        connection.begin(async (tx) => {
          const runId = competingRunIds[index]!
          const requestId = competingRequestIds[index]!

          await insertAgentRun(tx, {
            id: runId,
            sessionId: competingGraph.sessionId,
            handId: competingHandId,
            runtime: 'player',
            participantId: competingParticipantId,
            sourceStateVersion: 6,
            decisionRequestId: requestId,
            idempotencyKey: `player-concurrent-${index}`,
          })
          await tx`
            UPDATE app_private.sessions
            SET
              agent_run_state = 'thinking',
              active_player_run_id = ${runId},
              active_decision_request_id = ${requestId}
            WHERE id = ${competingGraph.sessionId}
          `
        }),
      ),
    )
    expect(
      competingResults.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1)

    const activeRuns = await sql<{ readonly count: string }[]>`
      SELECT count(*)::text AS count
      FROM app_private.agent_runs
      WHERE session_id = ${competingGraph.sessionId}
        AND runtime = 'player'
        AND lifecycle IN ('queued', 'leased', 'running')
    `
    expect(activeRuns[0]?.count).toBe('1')
  } finally {
    try {
      if (competingSessionId !== undefined) {
        await sql`
          DELETE FROM app_private.sessions
          WHERE id = ${competingSessionId}
        `
      }
    } finally {
      await competingSql.end({ timeout: 0 })
    }
  }

  const graph = await sql.begin((tx) => insertSessionGraph(tx, 4_000))
  const handId = fixtureId(4_100)
  const firstRunId = fixtureId(4_200)
  const secondRunId = fixtureId(4_201)
  const firstRequestId = fixtureId(4_300)
  const secondRequestId = fixtureId(4_301)
  const participantId = graph.agentParticipantIds[0]!

  await sql.begin((tx) =>
    insertHand(tx, {
      id: handId,
      sessionId: graph.sessionId,
      status: 'inProgress',
    }),
  )

  await sql.begin(async (tx) => {
    await insertAgentRun(tx, {
      id: firstRunId,
      sessionId: graph.sessionId,
      handId,
      runtime: 'player',
      participantId,
      sourceStateVersion: 7,
      decisionRequestId: firstRequestId,
      idempotencyKey: 'player-first',
    })
    await tx`
      UPDATE app_private.sessions
      SET
        agent_run_state = 'thinking',
        active_player_run_id = ${firstRunId},
        active_decision_request_id = ${firstRequestId}
      WHERE id = ${graph.sessionId}
    `
  })

  await expect(
    sql.begin((tx) =>
      insertAgentRun(tx, {
        id: secondRunId,
        sessionId: graph.sessionId,
        handId,
        runtime: 'player',
        participantId,
        sourceStateVersion: 7,
        decisionRequestId: secondRequestId,
        idempotencyKey: 'player-conflict',
      }),
    ),
  ).rejects.toThrow()

  await sql.begin(async (tx) => {
    await tx`
      UPDATE app_private.agent_runs
      SET lifecycle = 'stale',
          termination_reason = 'fixture_stale',
          completed_at = now()
      WHERE id = ${firstRunId}
    `
    await insertAgentRun(tx, {
      id: secondRunId,
      sessionId: graph.sessionId,
      handId,
      runtime: 'player',
      participantId,
      sourceStateVersion: 7,
      decisionRequestId: secondRequestId,
      idempotencyKey: 'player-replacement',
    })
    await tx`
      UPDATE app_private.sessions
      SET
        active_player_run_id = ${secondRunId},
        active_decision_request_id = ${secondRequestId}
      WHERE id = ${graph.sessionId}
    `
  })

  await expect(
    sql`
      UPDATE app_private.sessions
      SET agent_run_state = 'idle'
      WHERE id = ${graph.sessionId}
    `,
  ).rejects.toThrow()

  await expect(
    sql`
      UPDATE app_private.sessions
      SET agent_run_state = 'paused'
      WHERE id = ${graph.sessionId}
    `,
  ).rejects.toThrow()

  await expect(
    sql`
      UPDATE app_private.sessions
      SET
        agent_run_state = 'idle',
        active_player_run_id = NULL,
        active_decision_request_id = NULL
      WHERE id = ${graph.sessionId}
    `,
  ).rejects.toThrow()

  await expect(
    sql.begin(async (tx) => {
      await tx`
        UPDATE app_private.agent_runs
        SET lifecycle = 'completed',
            started_at = COALESCE(started_at, now()),
            completed_at = now()
        WHERE id = ${secondRunId}
      `
      await tx`
        UPDATE app_private.sessions
        SET
          active_player_run_id = ${firstRunId},
          active_decision_request_id = ${secondRequestId}
        WHERE id = ${graph.sessionId}
      `
    }),
  ).rejects.toThrow()

  await sql.begin(async (tx) => {
    await tx`
      UPDATE app_private.agent_runs
      SET lifecycle = 'completed',
          started_at = COALESCE(started_at, now()),
          completed_at = now()
      WHERE id = ${secondRunId}
    `
    await tx`
      UPDATE app_private.sessions
      SET
        agent_run_state = 'idle',
        active_player_run_id = NULL,
        active_decision_request_id = NULL
      WHERE id = ${graph.sessionId}
    `
  })

  await expect(
    sql.begin((tx) =>
      insertAgentRun(tx, {
        id: fixtureId(4_202),
        sessionId: graph.sessionId,
        handId,
        runtime: 'player',
        participantId: graph.userParticipantId,
        sourceStateVersion: 8,
        decisionRequestId: fixtureId(4_302),
        idempotencyKey: 'player-user-invalid',
      }),
    ),
  ).rejects.toThrow()

  await expect(
    sql.begin((tx) =>
      insertAgentRun(tx, {
        id: fixtureId(4_203),
        sessionId: graph.sessionId,
        handId,
        runtime: 'player',
        participantId,
        sourceStateVersion: 9,
        decisionRequestId: firstRequestId,
        idempotencyKey: 'player-duplicate-request',
      }),
    ),
  ).rejects.toThrow()

  await sql`DELETE FROM app_private.sessions WHERE id = ${graph.sessionId}`
}

async function assertAgentAuditAndCommandConstraints(sql: Sql): Promise<void> {
  const graph = await sql.begin((tx) => insertSessionGraph(tx, 5_000))
  const handId = fixtureId(5_100)
  const invalidCoachRunId = fixtureId(5_200)
  const coachRunId = fixtureId(5_201)

  await sql.begin((tx) =>
    insertHand(tx, {
      id: handId,
      sessionId: graph.sessionId,
      status: 'inProgress',
    }),
  )

  await expect(
    sql.begin((tx) =>
      insertAgentRun(tx, {
        id: invalidCoachRunId,
        sessionId: graph.sessionId,
        handId,
        runtime: 'coach',
        idempotencyKey: 'coach-in-progress-invalid',
      }),
    ),
  ).rejects.toThrow()

  await sql`
    UPDATE app_private.hands
    SET
      status = 'completed',
      completed_result_payload_version = 1,
      completed_result_payload = '{}'::jsonb,
      completed_at = now()
    WHERE id = ${handId}
  `

  await sql.begin((tx) =>
    insertAgentRun(tx, {
      id: coachRunId,
      sessionId: graph.sessionId,
      handId,
      runtime: 'coach',
      idempotencyKey: 'coach-valid',
    }),
  )

  await expect(
    sql`
      UPDATE app_private.hands
      SET
        status = 'aborted',
        completed_result_payload_version = NULL,
        completed_result_payload = NULL,
        completed_at = NULL,
        abort_reason = 'invalid transition',
        aborted_at = now()
      WHERE id = ${handId}
    `,
  ).rejects.toThrow()

  const commandLedgerId = fixtureId(5_400)
  const commandId = fixtureId(5_401)
  await sql`
    INSERT INTO app_private.command_ledger (
      id,
      session_id,
      owner_id,
      command_id,
      canonical_payload_digest,
      processing_status,
      final_state_version,
      first_event_seq,
      last_event_seq,
      response_payload_version,
      response_payload,
      completed_at
    )
    VALUES (
      ${commandLedgerId},
      ${graph.sessionId},
      ${fixtureOwnerId()},
      ${commandId},
      ${PAYLOAD_DIGEST},
      'completed',
      1,
      0,
      0,
      1,
      '{}'::jsonb,
      now()
    )
  `
  await expect(
    sql`
      INSERT INTO app_private.command_ledger (
        id,
        session_id,
        owner_id,
        command_id,
        canonical_payload_digest,
        processing_status
      )
      VALUES (
        ${fixtureId(5_403)},
        ${graph.sessionId},
        ${fixtureOwnerId()},
        ${commandId},
        ${PAYLOAD_DIGEST},
        'processing'
      )
    `,
  ).rejects.toThrow()

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
      public_event_payload
    )
    VALUES (
      ${fixtureId(5_402)},
      ${graph.sessionId},
      ${fixtureOwnerId()},
      ${handId},
      ${commandLedgerId},
      0,
      0,
      1,
      1,
      '{}'::jsonb,
      '{}'::jsonb
    )
  `
  await expect(
    sql`
      INSERT INTO app_private.session_events (
        id,
        session_id,
        owner_id,
        event_seq,
        state_version_before,
        state_version_after,
        private_event_payload_version,
        private_event_payload,
        public_event_payload
      )
      VALUES (
        ${fixtureId(5_404)},
        ${graph.sessionId},
        ${fixtureOwnerId()},
        0,
        1,
        2,
        1,
        '{}'::jsonb,
        '{}'::jsonb
      )
    `,
  ).rejects.toThrow()

  await sql`
    INSERT INTO app_private.agent_attempts (
      id,
      agent_run_id,
      owner_id,
      session_id,
      attempt_number,
      fencing_token,
      stage,
      lifecycle,
      provider,
      model,
      attempt_type,
      input_tokens,
      output_tokens,
      cost_microunits,
      duration_ms,
      attempt_payload_version,
      attempt_payload,
      started_at,
      completed_at
    )
    VALUES (
      ${fixtureId(5_500)},
      ${coachRunId},
      ${fixtureOwnerId()},
      ${graph.sessionId},
      0,
      1,
      'analysis',
      'completed',
      'test-provider',
      'test-model',
      'primary',
      1,
      1,
      1,
      1,
      1,
      '{}'::jsonb,
      now(),
      now()
    )
  `
  await sql`
    INSERT INTO app_private.agent_capability_invocations (
      id,
      agent_run_id,
      owner_id,
      session_id,
      invocation_number,
      fencing_token,
      capability_name,
      capability_version,
      authorized,
      input_schema_version,
      input_hash,
      output_schema_version,
      output_hash,
      budget_cost,
      duration_ms,
      started_at,
      completed_at
    )
    VALUES (
      ${fixtureId(5_501)},
      ${coachRunId},
      ${fixtureOwnerId()},
      ${graph.sessionId},
      0,
      1,
      'equity',
      1,
      true,
      1,
      ${PAYLOAD_DIGEST},
      1,
      ${CONFIG_SNAPSHOT_KEY},
      1,
      1,
      now(),
      now()
    )
  `

  await sql`
    INSERT INTO app_private.app_settings (
      id,
      owner_id,
      setting_key,
      setting_payload
    )
    VALUES (
      ${fixtureId(5_700)},
      ${fixtureOwnerId()},
      'player-timeouts',
      '{}'::jsonb
    )
  `

  await sql`DELETE FROM app_private.sessions WHERE id = ${graph.sessionId}`

  const cascadeCounts = await sql<
    {
      readonly attempts: string
    }[]
  >`
    SELECT
      (SELECT count(*)::text FROM app_private.agent_attempts
        WHERE session_id = ${graph.sessionId}) AS attempts
  `
  expect(cascadeCounts[0]).toEqual({
    attempts: '0',
  })

  await sql`
    DELETE FROM app_private.app_settings
    WHERE owner_id = ${fixtureOwnerId()}
      AND setting_key = 'player-timeouts'
  `
}

export async function assertM22DatabaseSchema(
  sql: Sql,
  testDatabaseUrl: string,
): Promise<void> {
  const fixtureContext = createDatabaseFixtureContext()
  activeFixtureContext = fixtureContext
  let assertionError: unknown
  let cleanupError: unknown

  try {
    await sql`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (
        ${fixtureContext.mainOwner.id},
        ${fixtureContext.mainOwner.identityKey}
      )
    `

    await assertSchemaStructure(sql)
    await assertOwnerPayloadAndBigintConstraints(sql)
    await assertSessionDiagnosticConstraints(sql)
    await assertRosterConstraints(sql)
    await assertHandParticipantSeats(sql)
    await assertActiveSessionConcurrency(sql, testDatabaseUrl)
    await assertPlayerCoordination(sql, testDatabaseUrl)
    await assertAgentAuditAndCommandConstraints(sql)
  } catch (error) {
    assertionError = error
  }

  try {
    await sql.begin(async (tx) => {
      for (const ownerId of fixtureContext.ownerIds) {
        await tx`
          DELETE FROM app_private.sessions
          WHERE owner_id = ${ownerId}
        `
      }

      for (const ownerId of fixtureContext.ownerIds) {
        await tx`
          DELETE FROM app_private.owners
          WHERE id = ${ownerId}
        `
      }
    })
  } catch (error) {
    cleanupError = error
  } finally {
    activeFixtureContext = undefined
  }

  if (assertionError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [assertionError, cleanupError],
      '数据库断言和 fixture 清理均失败。',
    )
  }

  if (assertionError !== undefined) {
    throw assertionError
  }

  if (cleanupError !== undefined) {
    throw cleanupError
  }
}
