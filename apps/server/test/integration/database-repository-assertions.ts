import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { Sql, TransactionSql } from 'postgres'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { PERSONA_CATALOG_DEFINITIONS } from '../../src/personas/catalog-definitions.js'
import { createActiveModelConfigurationV1Schema } from '../../src/personas/config.js'
import {
  ActiveModelConfigurationError,
  ActiveSessionConflictError,
  CommandPayloadConflictError,
  DatabaseOperationError,
  OwnerScopeResolutionError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
} from '../../src/persistence/errors.js'
import {
  completeCommand,
  failCommand,
  prepareCommandRegistration,
  registerCommand,
  type CommandRegistrationResult,
} from '../../src/persistence/command-ledger-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
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

function createCommandSnapshot(sessionId: string, stateVersion = 1) {
  return {
    protocolVersion: 1 as const,
    sessionId,
    stateVersion,
    eventSeq: 1,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus: 'active' as const,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: randomUUID(),
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
    })),
    hand: null,
    lastCompletedHandSummary: null,
  }
}

async function insertDiagnosticSession(
  query: Sql,
  ownerId: string,
  sessionId: string,
): Promise<void> {
  await query`
    INSERT INTO app_private.sessions (
      id, owner_id, lifecycle_status, state_version, next_event_seq
    ) VALUES (
      ${sessionId}::uuid,
      ${ownerId}::uuid,
      'readonlyDiagnostic',
      0,
      0
    )
  `
}

async function insertCommittedDiagnosticSession(
  sql: Sql,
  sessionId: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const query = transaction as unknown as Sql
    const roster = await createRosterInput(query)
    await insertSessionRosterSnapshot(transaction, { ...roster, sessionId })
    await transaction`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          updated_at = clock_timestamp()
      WHERE id = ${sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
  })
}

function commandInputs(sessionId: string) {
  const base = { sessionId, expectedStateVersion: 0 }
  return [
    {
      ...base,
      commandId: randomUUID(),
      type: 'playerAction' as const,
      payload: { action: { type: 'check' as const } },
    },
    {
      ...base,
      commandId: randomUUID(),
      type: 'startNextHand' as const,
      payload: {},
    },
    {
      ...base,
      commandId: randomUUID(),
      type: 'rebuy' as const,
      payload: { amount: 2_000 },
    },
    {
      ...base,
      commandId: randomUUID(),
      type: 'endSession' as const,
      payload: {},
    },
    {
      ...base,
      commandId: randomUUID(),
      type: 'retryAgent' as const,
      payload: {},
    },
    {
      ...base,
      sessionId: sessionId.toUpperCase(),
      commandId: randomUUID().toUpperCase(),
      type: 'aiAction' as const,
      payload: {
        decisionRequestId: randomUUID().toUpperCase(),
        handId: randomUUID().toUpperCase(),
        actorSeatNumber: 2,
        candidateActionId: 'candidate_2',
        action: { type: 'raise' as const, targetStreetCommitment: 120 },
      },
    },
  ]
}

async function assertCommandLedgerLifecycle(sql: Sql): Promise<void> {
  const owner = await resolveOwnerScope(sql, ownerScope)

  await inRollbackTransaction(sql, async (transaction, query) => {
    const sessionId = randomUUID()
    await insertDiagnosticSession(query, owner.databaseOwnerId, sessionId)
    const inputs = commandInputs(sessionId)

    for (const [index, input] of inputs.entries()) {
      const prepared = prepareCommandRegistration(input)
      const acquired = await registerCommand(transaction, owner, prepared)
      expect(acquired.status).toBe('acquired')
      if (acquired.status !== 'acquired') {
        throw new Error('测试未取得命令处理权。')
      }

      const expectedResponse =
        index % 2 === 0
          ? {
              protocolVersion: 1 as const,
              snapshot: createCommandSnapshot(input.sessionId),
            }
          : {
              protocolVersion: 1 as const,
              code: 'expected_failure',
              message: '预期失败。',
            }
      if ('snapshot' in expectedResponse) {
        await completeCommand(transaction, acquired, expectedResponse, {
          firstEventSeq: 1,
          lastEventSeq: 1,
        })
      } else {
        await failCommand(transaction, acquired, expectedResponse)
      }

      const beforeReplay = await query<{ readonly updatedAt: string }[]>`
        SELECT updated_at::text AS "updatedAt"
        FROM app_private.command_ledger
        WHERE id = ${acquired.ledgerId}::uuid
      `
      const replayInput =
        input.type === 'aiAction'
          ? {
              ...input,
              sessionId: input.sessionId.toLowerCase(),
              commandId: input.commandId.toLowerCase(),
              payload: {
                ...input.payload,
                decisionRequestId:
                  input.payload.decisionRequestId.toLowerCase(),
                handId: input.payload.handId.toLowerCase(),
              },
            }
          : input
      const replayPrepared = prepareCommandRegistration(replayInput)
      expect(replayPrepared.canonicalPayloadDigest).toBe(
        prepared.canonicalPayloadDigest,
      )
      const replay = await registerCommand(transaction, owner, replayPrepared)
      expect(replay).toEqual({
        status: 'snapshot' in expectedResponse ? 'completed' : 'failed',
        response: expectedResponse,
      })
      const afterReplay = await query<{ readonly updatedAt: string }[]>`
        SELECT updated_at::text AS "updatedAt"
        FROM app_private.command_ledger
        WHERE id = ${acquired.ledgerId}::uuid
      `
      expect(afterReplay[0]?.updatedAt).toBe(beforeReplay[0]?.updatedAt)
    }

    const processingInput = {
      sessionId,
      commandId: randomUUID(),
      expectedStateVersion: 0,
      type: 'retryAgent' as const,
      payload: {},
    }
    const first = await registerCommand(
      transaction,
      owner,
      prepareCommandRegistration(processingInput),
    )
    const second = await registerCommand(
      transaction,
      owner,
      prepareCommandRegistration(processingInput),
    )
    expect(first.status).toBe('acquired')
    expect(second).toEqual({ status: 'processing' })

    const conflicting = {
      ...inputs[0],
      expectedStateVersion: 1,
    }
    await expect(
      registerCommand(
        transaction,
        owner,
        prepareCommandRegistration(conflicting),
      ),
    ).rejects.toBeInstanceOf(CommandPayloadConflictError)

    const otherOwnerId = randomUUID()
    const otherSessionId = randomUUID()
    await query`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${otherOwnerId}::uuid, ${`test-m2-4:${otherOwnerId}`})
    `
    await insertDiagnosticSession(query, otherOwnerId, otherSessionId)
    await expect(
      registerCommand(
        transaction,
        owner,
        prepareCommandRegistration({
          sessionId: otherSessionId,
          commandId: randomUUID(),
          expectedStateVersion: 0,
          type: 'endSession',
          payload: {},
        }),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)

    await query`
      DELETE FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    const cascadedRows = await query<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.command_ledger
      WHERE session_id = ${sessionId}::uuid
    `
    expect(cascadedRows[0]?.count).toBe(0)
  })
}

async function assertCommandLedgerRollbacks(sql: Sql): Promise<void> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  const rolledBackSessionId = randomUUID()

  await inRollbackTransaction(sql, async (transaction, query) => {
    await insertDiagnosticSession(
      query,
      owner.databaseOwnerId,
      rolledBackSessionId,
    )
    const prepared = prepareCommandRegistration({
      sessionId: rolledBackSessionId,
      commandId: randomUUID(),
      expectedStateVersion: 0,
      type: 'endSession',
      payload: {},
    })
    const acquired = await registerCommand(transaction, owner, prepared)
    if (acquired.status !== 'acquired') {
      throw new Error('测试未取得命令处理权。')
    }
    await completeCommand(
      transaction,
      acquired,
      {
        protocolVersion: 1,
        snapshot: createCommandSnapshot(rolledBackSessionId),
      },
      null,
    )
  })

  const rolledBackRows = await sql<{ readonly count: number }[]>`
    SELECT count(*)::int AS count
    FROM app_private.sessions
    WHERE id = ${rolledBackSessionId}::uuid
  `
  expect(rolledBackRows[0]?.count).toBe(0)

  const processingSessionId = randomUUID()
  try {
    await insertCommittedDiagnosticSession(sql, processingSessionId)
    const acquired = await sql.begin(async (transaction) => {
      const prepared = prepareCommandRegistration({
        sessionId: processingSessionId,
        commandId: randomUUID(),
        expectedStateVersion: 0,
        type: 'endSession',
        payload: {},
      })
      const result = await registerCommand(transaction, owner, prepared)
      if (result.status !== 'acquired') {
        throw new Error('测试未取得命令处理权。')
      }
      return result
    })
    await sql.begin(async (transaction) => {
      const replay = await registerCommand(
        transaction,
        owner,
        prepareCommandRegistration({
          sessionId: processingSessionId,
          commandId: acquired.commandId,
          expectedStateVersion: 0,
          type: 'endSession',
          payload: {},
        }),
      )
      expect(replay).toEqual({ status: 'processing' })

      const forged = { ...acquired } as typeof acquired
      await expect(
        failCommand(transaction, forged, {
          protocolVersion: 1,
          code: 'expected_failure',
          message: '预期失败。',
        }),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      const rows = await transaction<{ readonly status: string }[]>`
        SELECT processing_status AS status
        FROM app_private.command_ledger
        WHERE id = ${acquired.ledgerId}::uuid
      `
      expect(rows[0]?.status).toBe('processing')
    })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${processingSessionId}::uuid
    `
  }
}

async function assertCandidateLedgerIdCollisions(sql: Sql): Promise<void> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  const sessionId = randomUUID()
  try {
    await insertCommittedDiagnosticSession(sql, sessionId)

    const sameKeyInput = {
      sessionId,
      commandId: randomUUID(),
      expectedStateVersion: 0,
      type: 'retryAgent' as const,
      payload: {},
    }
    const sameKey = prepareCommandRegistration(sameKeyInput)
    await sql`
      INSERT INTO app_private.command_ledger (
        id, session_id, owner_id, command_id,
        canonical_payload_digest, processing_status
      ) VALUES (
        ${sameKey.ledgerId}::uuid,
        ${sessionId}::uuid,
        ${owner.databaseOwnerId}::uuid,
        ${sameKey.command.commandId}::uuid,
        ${sameKey.canonicalPayloadDigest},
        'processing'
      )
    `
    await sql.begin(async (transaction) => {
      await expect(
        registerCommand(transaction, owner, sameKey),
      ).resolves.toEqual({ status: 'processing' })
    })
    await sql`
      DELETE FROM app_private.command_ledger
      WHERE id = ${sameKey.ledgerId}::uuid
    `

    const otherKey = prepareCommandRegistration({
      ...sameKeyInput,
      commandId: randomUUID(),
    })
    const existingCommandId = randomUUID()
    await sql`
      INSERT INTO app_private.command_ledger (
        id, session_id, owner_id, command_id,
        canonical_payload_digest, processing_status
      ) VALUES (
        ${otherKey.ledgerId}::uuid,
        ${sessionId}::uuid,
        ${owner.databaseOwnerId}::uuid,
        ${existingCommandId}::uuid,
        ${'a'.repeat(64)},
        'processing'
      )
    `
    await expect(
      sql.begin((transaction) => registerCommand(transaction, owner, otherKey)),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
  }
}

async function waitForUniqueKeyConflict(
  transaction: TransactionSql,
  firstBackendPid: number,
  secondBackendPid: number,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await transaction<
      {
        readonly waitsForTransactionId: boolean
        readonly blockedByFirst: boolean
      }[]
    >`
      SELECT
        EXISTS (
          SELECT 1
          FROM pg_locks AS waiting
          JOIN pg_locks AS held
            ON held.locktype = 'transactionid'
            AND held.transactionid = waiting.transactionid
            AND held.granted
            AND held.pid = ${firstBackendPid}::int
          WHERE waiting.pid = ${secondBackendPid}::int
            AND waiting.locktype = 'transactionid'
            AND NOT waiting.granted
        ) AS "waitsForTransactionId",
        ${firstBackendPid}::int = ANY(
          pg_blocking_pids(${secondBackendPid}::int)
        ) AS "blockedByFirst"
    `
    if (rows[0]?.waitsForTransactionId && rows[0].blockedByFirst) {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('未观察到第二事务等待第一事务的唯一键冲突。')
}

async function assertConcurrentCommandReplay(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const postgres = (await import('postgres')).default
  const secondSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  const owner = await resolveOwnerScope(sql, ownerScope)
  const sessionId = randomUUID()
  const input = {
    sessionId,
    commandId: randomUUID(),
    expectedStateVersion: 0,
    type: 'endSession' as const,
    payload: {},
  }
  let secondResult: Promise<CommandRegistrationResult> | undefined
  let updatedAtAfterFirst = ''

  try {
    await insertCommittedDiagnosticSession(sql, sessionId)
    await sql.begin(async (transaction) => {
      const firstPidRows = await transaction<{ readonly pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `
      const firstBackendPid = firstPidRows[0]?.pid
      expect(firstBackendPid).toBeDefined()
      const firstPrepared = prepareCommandRegistration(input)
      const first = await registerCommand(transaction, owner, firstPrepared)
      expect(first.status).toBe('acquired')
      if (first.status !== 'acquired') {
        throw new Error('测试未取得命令处理权。')
      }
      const response = {
        protocolVersion: 1 as const,
        snapshot: createCommandSnapshot(sessionId),
      }
      await completeCommand(transaction, first, response, null)
      const updatedRows = await transaction<{ readonly updatedAt: string }[]>`
        SELECT updated_at::text AS "updatedAt"
        FROM app_private.command_ledger
        WHERE id = ${first.ledgerId}::uuid
      `
      updatedAtAfterFirst = updatedRows[0]?.updatedAt ?? ''

      let signalSecondPid: ((pid: number) => void) | undefined
      const secondPid = new Promise<number>((resolve) => {
        signalSecondPid = resolve
      })
      secondResult = secondSql.begin(async (secondTransaction) => {
        const pidRows = await secondTransaction<{ readonly pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `
        const secondBackendPid = pidRows[0]?.pid
        if (secondBackendPid === undefined) {
          throw new Error('无法取得第二事务 backend PID。')
        }
        signalSecondPid?.(secondBackendPid)
        return registerCommand(
          secondTransaction,
          owner,
          prepareCommandRegistration(input),
        )
      })
      const secondBackendPid = await secondPid
      await waitForUniqueKeyConflict(
        transaction,
        firstBackendPid ?? -1,
        secondBackendPid,
      )
    })

    const replay = await secondResult
    expect(replay?.status).toBe('completed')
    const rows = await sql<
      { readonly count: number; readonly updatedAt: string }[]
    >`
      SELECT count(*)::int AS count, max(updated_at)::text AS "updatedAt"
      FROM app_private.command_ledger
      WHERE session_id = ${sessionId}::uuid
        AND command_id = ${input.commandId}::uuid
    `
    expect(rows[0]).toEqual({ count: 1, updatedAt: updatedAtAfterFirst })
  } finally {
    await secondSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
  }
}

export async function assertM24CommandLedgerRepository(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertCommandLedgerLifecycle(sql)
  await assertCommandLedgerRollbacks(sql)
  await assertCandidateLedgerIdCollisions(sql)
  await assertConcurrentCommandReplay(sql, runtimeUrl)
}
