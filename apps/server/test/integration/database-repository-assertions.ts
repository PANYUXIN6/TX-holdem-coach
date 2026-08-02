import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { Sql, TransactionSql } from 'postgres'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { PERSONA_CATALOG_DEFINITIONS } from '../../src/personas/catalog-definitions.js'
import { createActiveModelConfigurationV1Schema } from '../../src/personas/config.js'
import {
  ActiveModelConfigurationError,
  ActiveSessionConflictError,
  DatabaseOperationError,
  OwnerScopeResolutionError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
} from '../../src/persistence/errors.js'
import {
  readPlayerTimeoutSettings,
  writePlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import {
  getSessionById,
  insertSessionRosterSnapshot,
  listHistoricalSessions,
  readSessionAgentSnapshots,
} from '../../src/persistence/session-repository.js'
import {
  assertRosterSnapshotsUseActiveModels,
  prepareCurrentCatalogRoster,
} from '../../src/sessions/roster-preparation.js'

const ownerScope = { ownerId: 'local-user' } as const

class ExpectedRollback extends Error {}

async function inRollbackTransaction(
  sql: Sql,
  assertion: (transaction: TransactionSql, query: Sql) => Promise<void>,
): Promise<void> {
  try {
    await sql.begin(async (transaction) => {
      await assertion(transaction, transaction as unknown as Sql)
      throw new ExpectedRollback()
    })
  } catch (error) {
    if (error instanceof ExpectedRollback) {
      return
    }
    throw error
  }
  throw new Error('测试事务未按预期回滚。')
}

async function createRosterInput(query: Sql) {
  const catalog = loadAndValidatePersonaCatalog()
  return prepareCurrentCatalogRoster(query, ownerScope, catalog, {
    sessionId: randomUUID(),
    userParticipantId: randomUUID(),
    agents: catalog
      .list()
      .slice(0, 5)
      .map((entry, index) => ({
        personaId: entry.personaId,
        seatNumber: index + 1,
        agentParticipantId: randomUUID(),
      })),
  })
}

function withInjectedWriteFailure(
  transaction: TransactionSql,
  failedWriteNumber: number,
): TransactionSql {
  let writeNumber = 0
  return ((
    first: TemplateStringsArray | readonly unknown[],
    ...parameters: unknown[]
  ) => {
    if ('raw' in first) {
      writeNumber += 1
      if (writeNumber === failedWriteNumber) {
        throw new Error(`injected roster write failure ${failedWriteNumber}`)
      }
    }
    return Reflect.apply(transaction, transaction, [first, ...parameters])
  }) as unknown as TransactionSql
}

async function assertRosterAndSettings(sql: Sql): Promise<void> {
  let rolledBackSessionId = ''

  await inRollbackTransaction(sql, async (transaction, query) => {
    const roster = await createRosterInput(query)
    rolledBackSessionId = roster.sessionId
    await insertSessionRosterSnapshot(transaction, roster)

    const snapshots = await readSessionAgentSnapshots(
      query,
      ownerScope,
      roster.sessionId,
    )
    expect(snapshots).toHaveLength(5)
    expect(snapshots.map((snapshot) => snapshot.seatNumber)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(() =>
      assertRosterSnapshotsUseActiveModels(
        snapshots,
        createActiveModelConfigurationV1Schema(new Set()),
      ),
    ).toThrow(ActiveModelConfigurationError)

    const changedDefinitions = structuredClone(
      PERSONA_CATALOG_DEFINITIONS,
    ) as unknown as Record<string, unknown>[]
    const firstDefinition = changedDefinitions[0]
    if (firstDefinition !== undefined) {
      firstDefinition.name = 'changed source definition'
    }
    expect(
      loadAndValidatePersonaCatalog(changedDefinitions).list()[0]?.name,
    ).toBe('changed source definition')
    await expect(
      readSessionAgentSnapshots(query, ownerScope, roster.sessionId),
    ).resolves.toEqual(snapshots)

    const memoryRows = await query<
      {
        readonly currentRevision: number
        readonly currentVersion: number
        readonly currentPayload: Record<string, unknown>
        readonly revision: number
        readonly revisionVersion: number
        readonly revisionPayload: Record<string, unknown>
      }[]
    >`
      SELECT
        agent.current_memory_revision::int AS "currentRevision",
        agent.memory_payload_version AS "currentVersion",
        agent.memory_payload AS "currentPayload",
        revision.revision::int AS "revision",
        revision.memory_payload_version AS "revisionVersion",
        revision.memory_payload AS "revisionPayload"
      FROM app_private.session_agents AS agent
      JOIN app_private.agent_memory_revisions AS revision
        ON revision.participant_id = agent.participant_id
        AND revision.session_id = agent.session_id
        AND revision.owner_id = agent.owner_id
        AND revision.revision = 0
      WHERE agent.session_id = ${roster.sessionId}::uuid
        AND agent.owner_id = ${roster.owner.databaseOwnerId}::uuid
      ORDER BY agent.participant_id
    `
    expect(memoryRows).toHaveLength(5)
    expect(
      memoryRows.every(
        (row) =>
          row.currentRevision === 0 &&
          row.currentVersion === 1 &&
          row.revision === 0 &&
          row.revisionVersion === 1 &&
          JSON.stringify(row.currentPayload) === '{}' &&
          JSON.stringify(row.revisionPayload) === '{}',
      ),
    ).toBe(true)

    await query`
      DELETE FROM app_private.app_settings
      WHERE owner_id = ${roster.owner.databaseOwnerId}::uuid
        AND setting_key = 'player-timeouts'
    `
    await expect(readPlayerTimeoutSettings(query, ownerScope)).resolves.toEqual(
      {
        attemptTimeoutSeconds: 15,
        decisionDeadlineSeconds: 45,
      },
    )

    await writePlayerTimeoutSettings(query, ownerScope, {
      attemptTimeoutSeconds: 10,
      decisionDeadlineSeconds: 30,
    })
    const firstSettingRow = await query<{ readonly id: string }[]>`
      SELECT id::text AS id
      FROM app_private.app_settings
      WHERE owner_id = ${roster.owner.databaseOwnerId}::uuid
        AND setting_key = 'player-timeouts'
    `
    await writePlayerTimeoutSettings(query, ownerScope, {
      attemptTimeoutSeconds: 20,
      decisionDeadlineSeconds: 60,
    })
    const secondSettingRow = await query<{ readonly id: string }[]>`
      SELECT id::text AS id
      FROM app_private.app_settings
      WHERE owner_id = ${roster.owner.databaseOwnerId}::uuid
        AND setting_key = 'player-timeouts'
    `
    expect(secondSettingRow[0]?.id).toBe(firstSettingRow[0]?.id)
    await expect(readPlayerTimeoutSettings(query, ownerScope)).resolves.toEqual(
      {
        attemptTimeoutSeconds: 20,
        decisionDeadlineSeconds: 60,
      },
    )
    await query`
      UPDATE app_private.app_settings
      SET setting_payload = ${JSON.stringify({
        attemptTimeoutSeconds: 30,
        decisionDeadlineSeconds: 15,
      })}::jsonb
      WHERE owner_id = ${roster.owner.databaseOwnerId}::uuid
        AND setting_key = 'player-timeouts'
    `
    await expect(
      readPlayerTimeoutSettings(query, ownerScope),
    ).rejects.toMatchObject({ corruption: 'invalidPayload' })

    await query`
      UPDATE app_private.session_agents
      SET display_name = 'tampered'
      WHERE participant_id = ${roster.agents[0]?.agentParticipantId ?? ''}::uuid
        AND session_id = ${roster.sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
    await expect(
      readSessionAgentSnapshots(query, ownerScope, roster.sessionId),
    ).rejects.toMatchObject({ corruption: 'mirrorMismatch' })
    await query`
      UPDATE app_private.session_agents
      SET display_name = ${snapshots[0]?.displayName ?? ''},
          config_snapshot_key = ${'0'.repeat(64)}
      WHERE participant_id = ${roster.agents[0]?.agentParticipantId ?? ''}::uuid
        AND session_id = ${roster.sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
    await expect(
      readSessionAgentSnapshots(query, ownerScope, roster.sessionId),
    ).rejects.toMatchObject({ corruption: 'snapshotKeyMismatch' })
  })

  const rows = await sql<{ readonly count: number }[]>`
    SELECT count(*)::int AS count
    FROM app_private.sessions
    WHERE id = ${rolledBackSessionId}::uuid
  `
  expect(rows[0]?.count).toBe(0)
}

async function assertRosterCorruptionClassification(sql: Sql): Promise<void> {
  await inRollbackTransaction(sql, async (transaction, query) => {
    const ownerRows = await query<{ readonly id: string }[]>`
      SELECT id::text AS id
      FROM app_private.owners
      WHERE identity_key = 'local-user'
    `
    const ownerId = ownerRows[0]?.id ?? ''
    const emptySessionId = randomUUID()
    await query`
      INSERT INTO app_private.sessions (
        id, owner_id, lifecycle_status, ended_at
      ) VALUES (
        ${emptySessionId}::uuid,
        ${ownerId}::uuid,
        'ended',
        clock_timestamp()
      )
    `
    await expect(
      readSessionAgentSnapshots(query, ownerScope, emptySessionId),
    ).rejects.toMatchObject({ corruption: 'invalidRoster' })

    const roster = await createRosterInput(query)
    await insertSessionRosterSnapshot(transaction, roster)
    await query`
      DELETE FROM app_private.session_agents
      WHERE participant_id = ${roster.agents[0]?.agentParticipantId ?? ''}::uuid
    `
    await expect(
      readSessionAgentSnapshots(query, ownerScope, roster.sessionId),
    ).rejects.toMatchObject({ corruption: 'invalidRoster' })
  })

  await inRollbackTransaction(sql, async (transaction, query) => {
    const roster = await createRosterInput(query)
    await insertSessionRosterSnapshot(transaction, roster)
    await query`
      DELETE FROM app_private.session_participants
      WHERE id = ${roster.agents[0]?.agentParticipantId ?? ''}::uuid
        AND session_id = ${roster.sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `

    await expect(
      readSessionAgentSnapshots(query, ownerScope, roster.sessionId),
    ).rejects.toMatchObject({ corruption: 'invalidRoster' })
  })
}

async function assertEveryRosterWriteStageRollsBack(sql: Sql): Promise<void> {
  for (const failedWriteNumber of [1, 2, 3, 4]) {
    const rosterId = randomUUID()
    let failure: unknown
    try {
      await sql.begin(async (transaction) => {
        const query = transaction as unknown as Sql
        const roster = await createRosterInput(query)
        const input = { ...roster, sessionId: rosterId }
        await insertSessionRosterSnapshot(
          withInjectedWriteFailure(transaction, failedWriteNumber),
          input,
        )
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(DatabaseOperationError)
    const rows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE id = ${rosterId}::uuid
    `
    expect(rows[0]?.count).toBe(0)
  }
}

async function assertMissingOwnerBoundaries(sql: Sql): Promise<void> {
  await inRollbackTransaction(sql, async (_transaction, query) => {
    const ownerRows = await query<{ readonly id: string }[]>`
      SELECT id::text AS id
      FROM app_private.owners
      WHERE identity_key = 'local-user'
    `
    const ownerId = ownerRows[0]?.id ?? ''
    const beforeRows = await query<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.app_settings
      WHERE owner_id = ${ownerId}::uuid
    `
    await query`
      UPDATE app_private.owners
      SET identity_key = ${`test-m2-3-missing:${ownerId}`}
      WHERE id = ${ownerId}::uuid
    `

    await expect(
      readPlayerTimeoutSettings(query, ownerScope),
    ).rejects.toBeInstanceOf(OwnerScopeResolutionError)
    await expect(
      writePlayerTimeoutSettings(query, ownerScope, {
        attemptTimeoutSeconds: 10,
        decisionDeadlineSeconds: 30,
      }),
    ).rejects.toBeInstanceOf(OwnerScopeResolutionError)

    const afterRows = await query<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.app_settings
      WHERE owner_id = ${ownerId}::uuid
    `
    expect(afterRows[0]?.count).toBe(beforeRows[0]?.count)
  })
}

async function assertAtomicConflictRollback(sql: Sql): Promise<void> {
  let firstSessionId = ''
  let secondSessionId = ''
  let conflict: unknown

  try {
    await sql.begin(async (transaction) => {
      const query = transaction as unknown as Sql
      const first = await createRosterInput(query)
      const second = await createRosterInput(query)
      firstSessionId = first.sessionId
      secondSessionId = second.sessionId
      await insertSessionRosterSnapshot(transaction, first)
      await insertSessionRosterSnapshot(transaction, second)
    })
  } catch (error) {
    conflict = error
  }

  expect(conflict).toBeInstanceOf(ActiveSessionConflictError)
  const rows = await sql<{ readonly count: number }[]>`
    SELECT count(*)::int AS count
    FROM app_private.sessions
    WHERE id IN (${firstSessionId}::uuid, ${secondSessionId}::uuid)
  `
  expect(rows[0]?.count).toBe(0)
}

async function assertHistoricalPaginationAndOwnerIsolation(
  sql: Sql,
): Promise<void> {
  await inRollbackTransaction(sql, async (_transaction, query) => {
    const localOwnerRows = await query<{ readonly id: string }[]>`
      SELECT id::text AS id
      FROM app_private.owners
      WHERE identity_key = 'local-user'
    `
    const localOwnerId = localOwnerRows[0]?.id
    expect(localOwnerId).toBeDefined()

    const firstId = 'ffffffff-ffff-4fff-bfff-ffffffffffff'
    const secondId = 'eeeeeeee-eeee-4eee-beee-eeeeeeeeeeee'
    const thirdId = 'dddddddd-dddd-4ddd-bddd-dddddddddddd'
    await query`
      INSERT INTO app_private.sessions (
        id, owner_id, lifecycle_status, ended_at, updated_at
      ) VALUES
        (${firstId}::uuid, ${localOwnerId ?? ''}::uuid, 'ended', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00.123456Z'),
        (${secondId}::uuid, ${localOwnerId ?? ''}::uuid, 'ended', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00.123456Z'),
        (${thirdId}::uuid, ${localOwnerId ?? ''}::uuid, 'ended', '2099-01-01T00:00:00Z', '2099-01-01T00:00:00.123455Z')
    `

    const firstPage = await listHistoricalSessions(query, ownerScope, {
      limit: 1,
    })
    expect(firstPage.sessions[0]?.id).toBe(firstId)
    expect(firstPage.nextCursor?.updatedAt).toBe('2099-01-01T00:00:00.123456Z')
    const secondPage = await listHistoricalSessions(query, ownerScope, {
      limit: 1,
      cursor: firstPage.nextCursor ?? {
        id: firstId,
        updatedAt: '2099-01-01T00:00:00.123456Z',
      },
    })
    expect(secondPage.sessions[0]?.id).toBe(secondId)
    const thirdPage = await listHistoricalSessions(query, ownerScope, {
      limit: 1,
      cursor: secondPage.nextCursor ?? {
        id: secondId,
        updatedAt: '2099-01-01T00:00:00.123456Z',
      },
    })
    expect(thirdPage.sessions[0]?.id).toBe(thirdId)

    const otherOwnerId = randomUUID()
    const otherSessionId = randomUUID()
    await query`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${otherOwnerId}::uuid, ${`test-m2-3:${otherOwnerId}`})
    `
    await query`
      INSERT INTO app_private.sessions (
        id, owner_id, lifecycle_status, ended_at, updated_at
      ) VALUES (
        ${otherSessionId}::uuid,
        ${otherOwnerId}::uuid,
        'ended',
        clock_timestamp(),
        clock_timestamp()
      )
    `
    await expect(
      getSessionById(query, ownerScope, otherSessionId),
    ).resolves.toBeNull()
    await expect(
      readSessionAgentSnapshots(query, ownerScope, otherSessionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
    const ownerHistory = await listHistoricalSessions(query, ownerScope, {
      limit: 100,
    })
    expect(
      ownerHistory.sessions.some((session) => session.id === otherSessionId),
    ).toBe(false)

    for (const limit of [0, 101, 1.5]) {
      await expect(
        listHistoricalSessions(query, ownerScope, { limit }),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    }
    await expect(
      listHistoricalSessions(query, ownerScope, {
        limit: 1,
        cursor: {
          id: firstId,
          updatedAt: 'not-a-database-timestamp',
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })
}

async function assertHistoricalRefreshConvergesAfterUpdate(
  sql: Sql,
): Promise<void> {
  const createdSessionIds: string[] = []
  const insertEndedSession = async (updatedAt: string): Promise<string> => {
    let sessionId = ''
    await sql.begin(async (transaction) => {
      const query = transaction as unknown as Sql
      const roster = await createRosterInput(query)
      sessionId = roster.sessionId
      await insertSessionRosterSnapshot(transaction, roster)
      await transaction`
        UPDATE app_private.sessions
        SET lifecycle_status = 'ended',
            ended_at = ${updatedAt}::timestamptz,
            updated_at = ${updatedAt}::timestamptz
        WHERE id = ${sessionId}::uuid
          AND owner_id = ${roster.owner.databaseOwnerId}::uuid
      `
    })
    createdSessionIds.push(sessionId)
    return sessionId
  }

  try {
    const initiallyFirstId = await insertEndedSession(
      '9999-12-31T23:59:59.000002Z',
    )
    const movedId = await insertEndedSession('9999-12-31T23:59:59.000001Z')
    const firstPage = await listHistoricalSessions(sql, ownerScope, {
      limit: 1,
    })
    expect(firstPage.sessions[0]?.id).toBe(initiallyFirstId)
    expect(firstPage.nextCursor).not.toBeNull()

    await sql`
      UPDATE app_private.sessions
      SET updated_at = '9999-12-31T23:59:59.000003Z'::timestamptz
      WHERE id = ${movedId}::uuid
    `

    const staleContinuation = await listHistoricalSessions(sql, ownerScope, {
      limit: 1,
      cursor: firstPage.nextCursor ?? undefined,
    })
    expect(
      staleContinuation.sessions.some((session) => session.id === movedId),
    ).toBe(false)

    const refreshedFirstPage = await listHistoricalSessions(sql, ownerScope, {
      limit: 1,
    })
    expect(refreshedFirstPage.sessions[0]?.id).toBe(movedId)
  } finally {
    for (const sessionId of createdSessionIds) {
      await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
    }
  }
}

export async function assertM23Repositories(sql: Sql): Promise<void> {
  await assertRosterAndSettings(sql)
  await assertRosterCorruptionClassification(sql)
  await assertAtomicConflictRollback(sql)
  await assertEveryRosterWriteStageRollsBack(sql)
  await assertMissingOwnerBoundaries(sql)
  await assertHistoricalPaginationAndOwnerIsolation(sql)
  await assertHistoricalRefreshConvergesAfterUpdate(sql)
}
