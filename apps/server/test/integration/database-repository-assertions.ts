import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { Sql, TransactionSql } from 'postgres'
import { createHandStartedEventDraft } from '../../src/poker/hand-result.js'
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
import {
  lockSessionForMutation,
  persistSessionMutation,
  type SessionMutationBatch,
} from '../../src/persistence/session-mutation-repository.js'
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
import { encodePrivateEventV1 } from '../../src/sessions/authoritative-state/private-event-codec-v1.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshotV1 } from '../../src/sessions/authoritative-state/snapshot-codec-v1.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'
import { createDatabaseFixtureContext } from './database-fixture-context.js'

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
  const wrapped = ((
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
  Object.assign(wrapped, {
    json: transaction.json.bind(transaction),
    typed: transaction.typed.bind(transaction),
  })
  return wrapped
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

async function waitForTransactionBlock(
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
  throw new Error('未观察到第二事务等待第一事务。')
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
      await waitForTransactionBlock(
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

type MutationLifecycleStatus = 'active' | 'ended'

interface MutationBatchFixtureInput {
  readonly sessionId: string
  readonly handId: string
  readonly eventIds: readonly string[]
  readonly lockedStateVersion: number
  readonly nextEventSeq: number
  readonly mutationAt: string
  readonly lifecycleStatus?: MutationLifecycleStatus
  readonly writeSnapshot?: boolean
  readonly commandLedgerId?: string | null
}

function createMutationPublicSnapshot(
  sessionId: string,
  stateVersion: number,
  eventSeq: number,
  lifecycleStatus: MutationLifecycleStatus,
) {
  return {
    protocolVersion: 1 as const,
    sessionId,
    stateVersion,
    eventSeq,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `77777777-7777-4777-8777-${(seatNumber + 1)
        .toString()
        .padStart(12, '0')}`,
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

function createMutationBatch(
  input: MutationBatchFixtureInput,
): SessionMutationBatch {
  const lifecycleStatus = input.lifecycleStatus ?? 'active'
  const writeSnapshot = input.writeSnapshot ?? true
  const finalStateVersion = writeSnapshot
    ? input.lockedStateVersion + 1
    : input.lockedStateVersion
  const poker = createTestPokerState()
  const privateState = createPrivateTableState({
    stateVersion: finalStateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const privateEvent = encodePrivateEventV1(
    createHandStartedEventDraft({
      handId: input.handId,
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
    }),
  )

  return {
    finalStateVersion,
    lifecycleStatus,
    currentHandId: null,
    agentRunState: 'idle',
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    snapshot: writeSnapshot ? encodeSnapshotV1(privateState) : null,
    events: input.eventIds.map((eventId, index) => {
      const eventSeq = input.nextEventSeq + index
      const publicSnapshot = createMutationPublicSnapshot(
        input.sessionId,
        finalStateVersion,
        eventSeq,
        lifecycleStatus,
      )
      return {
        eventId,
        eventSeq,
        handId: input.handId,
        commandLedgerId: input.commandLedgerId ?? null,
        stateVersionBefore: input.lockedStateVersion,
        stateVersionAfter: finalStateVersion,
        privateEvent,
        publicEvent: {
          protocolVersion: 1,
          eventId,
          sessionId: input.sessionId,
          eventSeq,
          stateVersion: finalStateVersion,
          type: 'handStarted',
          payload: { snapshot: publicSnapshot },
        },
        createdAt: input.mutationAt,
      }
    }),
    mutationAt: input.mutationAt,
  }
}

async function insertMutationHand(
  query: Sql,
  ownerId: string,
  sessionId: string,
  handId: string,
): Promise<void> {
  await query`
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
    ) VALUES (
      ${handId}::uuid,
      ${sessionId}::uuid,
      ${ownerId}::uuid,
      1,
      'inProgress',
      1,
      '{}'::jsonb,
      0,
      ARRAY[0, 1, 2, 3, 4, 5]::integer[],
      '2026-08-03T10:00:00.000Z'::timestamptz
    )
  `
}

async function insertCommittedActiveSession(
  sql: Sql,
  sessionId: string,
  handId?: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const query = transaction as unknown as Sql
    const roster = await createRosterInput(query)
    await insertSessionRosterSnapshot(transaction, { ...roster, sessionId })
    if (handId !== undefined) {
      await insertMutationHand(
        query,
        roster.owner.databaseOwnerId,
        sessionId,
        handId,
      )
    }
  })
}

async function assertMutationOwnerAndCreationBoundaries(
  sql: Sql,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const owner = await resolveOwnerScope(sql, ownerScope)

  await inRollbackTransaction(sql, async (transaction, query) => {
    const otherOwner = fixture.mainOwner
    const otherSessionId = fixture.id(25_001)
    await query`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${otherOwner.id}::uuid, ${otherOwner.identityKey})
    `
    await insertDiagnosticSession(query, otherOwner.id, otherSessionId)
    await expect(
      lockSessionForMutation(transaction, owner, otherSessionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })

  await inRollbackTransaction(sql, async (transaction, query) => {
    const sessionId = fixture.id(25_002)
    const handId = fixture.id(25_003)
    const roster = await createRosterInput(query)
    await insertSessionRosterSnapshot(transaction, { ...roster, sessionId })
    await insertMutationHand(
      query,
      roster.owner.databaseOwnerId,
      sessionId,
      handId,
    )

    const locked = await lockSessionForMutation(transaction, owner, sessionId)
    const persisted = await persistSessionMutation(
      transaction,
      locked,
      createMutationBatch({
        sessionId,
        handId,
        eventIds: [fixture.id(25_004)],
        lockedStateVersion: 0,
        nextEventSeq: 0,
        mutationAt: '2026-08-03T10:01:00.000Z',
      }),
    )
    expect(persisted).toMatchObject({
      sessionId,
      finalStateVersion: 1,
      nextEventSeq: 1,
      firstEventSeq: 0,
      lastEventSeq: 0,
    })
    const rows = await query<
      { readonly stateVersion: number; readonly eventCount: number }[]
    >`
      SELECT
        session.state_version::int AS "stateVersion",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({ stateVersion: 1, eventCount: 1 })
  })
}

async function assertSingleEventVisibility(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(25_100)
  const handId = fixture.id(25_101)
  const eventId = fixture.id(25_102)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const postgres = (await import('postgres')).default
  const observerSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })

  try {
    await insertCommittedActiveSession(sql, sessionId, handId)
    await observerSql`SELECT 1`
    await sql.begin(async (transaction) => {
      const locked = await lockSessionForMutation(transaction, owner, sessionId)
      await persistSessionMutation(
        transaction,
        locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [eventId],
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: '2026-08-03T10:02:00.000Z',
        }),
      )
      const invisibleRows = await observerSql<
        {
          readonly stateVersion: number
          readonly nextEventSeq: number
          readonly snapshotCount: number
          readonly eventCount: number
        }[]
      >`
        SELECT
          session.state_version::int AS "stateVersion",
          session.next_event_seq::int AS "nextEventSeq",
          (
            SELECT count(*)::int
            FROM app_private.session_snapshots AS snapshot
            WHERE snapshot.session_id = session.id
          ) AS "snapshotCount",
          (
            SELECT count(*)::int
            FROM app_private.session_events AS event
            WHERE event.session_id = session.id
          ) AS "eventCount"
        FROM app_private.sessions AS session
        WHERE session.id = ${sessionId}::uuid
      `
      expect(invisibleRows[0]).toEqual({
        stateVersion: 0,
        nextEventSeq: 0,
        snapshotCount: 0,
        eventCount: 0,
      })
    })

    const visibleRows = await observerSql<
      {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly snapshotCount: number
        readonly eventCount: number
      }[]
    >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (
          SELECT count(*)::int
          FROM app_private.session_snapshots AS snapshot
          WHERE snapshot.session_id = session.id
        ) AS "snapshotCount",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
    expect(visibleRows[0]).toEqual({
      stateVersion: 1,
      nextEventSeq: 1,
      snapshotCount: 1,
      eventCount: 1,
    })
  } finally {
    await observerSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertMultiEventAndUniqueConstraint(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(25_200)
  const handId = fixture.id(25_201)
  const eventIds = [fixture.id(25_202), fixture.id(25_203)] as const
  const owner = await resolveOwnerScope(sql, ownerScope)

  try {
    await insertCommittedActiveSession(sql, sessionId, handId)
    await sql.begin(async (transaction) => {
      const locked = await lockSessionForMutation(transaction, owner, sessionId)
      await persistSessionMutation(
        transaction,
        locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds,
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: '2026-08-03T10:03:00.000Z',
        }),
      )
    })

    const committedRows = await sql<
      {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly eventSeqs: number[]
        readonly stateVersionsAfter: number[]
      }[]
    >`
      SELECT
        max(session.state_version)::int AS "stateVersion",
        max(session.next_event_seq)::int AS "nextEventSeq",
        array_agg(event.event_seq::int ORDER BY event.event_seq) AS "eventSeqs",
        array_agg(
          event.state_version_after::int ORDER BY event.event_seq
        ) AS "stateVersionsAfter"
      FROM app_private.sessions AS session
      JOIN app_private.session_events AS event
        ON event.session_id = session.id
      WHERE session.id = ${sessionId}::uuid
      GROUP BY session.id
    `
    expect(committedRows[0]).toEqual({
      stateVersion: 1,
      nextEventSeq: 2,
      eventSeqs: [0, 1],
      stateVersionsAfter: [1, 1],
    })

    await expect(
      sql.begin(async (transaction) => {
        const locked = await lockSessionForMutation(
          transaction,
          owner,
          sessionId,
        )
        await persistSessionMutation(
          transaction,
          locked,
          createMutationBatch({
            sessionId,
            handId,
            eventIds: [eventIds[0]],
            lockedStateVersion: 1,
            nextEventSeq: 2,
            mutationAt: '2026-08-03T10:03:01.000Z',
          }),
        )
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)

    const afterConflict = await sql<
      {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly snapshotStateVersion: number
        readonly eventCount: number
      }[]
    >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (
          snapshot.private_table_state_payload #>> '{state,stateVersion}'
        )::int AS "snapshotStateVersion",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount"
      FROM app_private.sessions AS session
      JOIN app_private.session_snapshots AS snapshot
        ON snapshot.session_id = session.id
      WHERE session.id = ${sessionId}::uuid
    `
    expect(afterConflict[0]).toEqual({
      stateVersion: 1,
      nextEventSeq: 2,
      snapshotStateVersion: 1,
      eventCount: 2,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertEndedMutationWithoutSnapshot(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(25_300)
  const handId = fixture.id(25_301)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const snapshotMutationAt = '2026-08-03T10:04:00.000Z'
  const endedMutationAt = '2026-08-03T10:04:01.000Z'

  try {
    await insertCommittedActiveSession(sql, sessionId, handId)
    await sql.begin(async (transaction) => {
      const locked = await lockSessionForMutation(transaction, owner, sessionId)
      await persistSessionMutation(
        transaction,
        locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [fixture.id(25_302)],
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: snapshotMutationAt,
        }),
      )
    })
    await sql.begin(async (transaction) => {
      const locked = await lockSessionForMutation(transaction, owner, sessionId)
      await persistSessionMutation(
        transaction,
        locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [fixture.id(25_303)],
          lockedStateVersion: 1,
          nextEventSeq: 1,
          mutationAt: endedMutationAt,
          lifecycleStatus: 'ended',
          writeSnapshot: false,
        }),
      )
    })

    const rows = await sql<
      {
        readonly lifecycleStatus: string
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly endedAt: string
        readonly updatedAt: string
        readonly snapshotUpdatedAt: string
        readonly eventCount: number
      }[]
    >`
      SELECT
        session.lifecycle_status AS "lifecycleStatus",
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        to_char(
          session.ended_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "endedAt",
        to_char(
          session.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "updatedAt",
        to_char(
          snapshot.updated_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
        ) AS "snapshotUpdatedAt",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount"
      FROM app_private.sessions AS session
      JOIN app_private.session_snapshots AS snapshot
        ON snapshot.session_id = session.id
      WHERE session.id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      lifecycleStatus: 'ended',
      stateVersion: 1,
      nextEventSeq: 2,
      endedAt: endedMutationAt,
      updatedAt: endedMutationAt,
      snapshotUpdatedAt: snapshotMutationAt,
      eventCount: 2,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertMutationRollbacks(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(25_400)
  const handId = fixture.id(25_401)
  const owner = await resolveOwnerScope(sql, ownerScope)

  try {
    await insertCommittedActiveSession(sql, sessionId, handId)
    await inRollbackTransaction(sql, async (transaction) => {
      const locked = await lockSessionForMutation(transaction, owner, sessionId)
      await persistSessionMutation(
        transaction,
        locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [fixture.id(25_402)],
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: '2026-08-03T10:05:00.000Z',
        }),
      )
    })

    await expect(
      sql.begin(async (transaction) => {
        const missingHandId = fixture.id(25_403)
        const locked = await lockSessionForMutation(
          transaction,
          owner,
          sessionId,
        )
        await persistSessionMutation(
          transaction,
          locked,
          createMutationBatch({
            sessionId,
            handId: missingHandId,
            eventIds: [fixture.id(25_404)],
            lockedStateVersion: 0,
            nextEventSeq: 0,
            mutationAt: '2026-08-03T10:05:01.000Z',
          }),
        )
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)

    const rows = await sql<
      {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly snapshotCount: number
        readonly eventCount: number
      }[]
    >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (
          SELECT count(*)::int
          FROM app_private.session_snapshots AS snapshot
          WHERE snapshot.session_id = session.id
        ) AS "snapshotCount",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      stateVersion: 0,
      nextEventSeq: 0,
      snapshotCount: 0,
      eventCount: 0,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertConcurrentSessionMutations(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(25_500)
  const handId = fixture.id(25_501)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const postgres = (await import('postgres')).default
  const secondSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  let secondMutation: Promise<unknown> | undefined

  try {
    await insertCommittedActiveSession(sql, sessionId, handId)
    await secondSql`SELECT 1`
    await sql.begin(async (transaction) => {
      const firstPidRows = await transaction<{ readonly pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `
      const firstBackendPid = firstPidRows[0]?.pid
      if (firstBackendPid === undefined) {
        throw new Error('无法取得第一事务 backend PID。')
      }
      const firstLocked = await lockSessionForMutation(
        transaction,
        owner,
        sessionId,
      )

      let signalSecondPid: ((pid: number) => void) | undefined
      const secondPid = new Promise<number>((resolve) => {
        signalSecondPid = resolve
      })
      secondMutation = secondSql.begin(async (secondTransaction) => {
        const pidRows = await secondTransaction<{ readonly pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `
        const secondBackendPid = pidRows[0]?.pid
        if (secondBackendPid === undefined) {
          throw new Error('无法取得第二事务 backend PID。')
        }
        signalSecondPid?.(secondBackendPid)
        const secondLocked = await lockSessionForMutation(
          secondTransaction,
          owner,
          sessionId,
        )
        expect(secondLocked).toMatchObject({
          stateVersion: 1,
          nextEventSeq: 1,
        })
        return persistSessionMutation(
          secondTransaction,
          secondLocked,
          createMutationBatch({
            sessionId,
            handId,
            eventIds: [fixture.id(25_503)],
            lockedStateVersion: 1,
            nextEventSeq: 1,
            mutationAt: '2026-08-03T10:06:01.000Z',
          }),
        )
      })

      const secondBackendPid = await secondPid
      await waitForTransactionBlock(
        transaction,
        firstBackendPid,
        secondBackendPid,
      )
      await persistSessionMutation(
        transaction,
        firstLocked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [fixture.id(25_502)],
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: '2026-08-03T10:06:00.000Z',
        }),
      )
    })
    await secondMutation

    const rows = await sql<
      {
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly eventSeqs: number[]
      }[]
    >`
      SELECT
        max(session.state_version)::int AS "stateVersion",
        max(session.next_event_seq)::int AS "nextEventSeq",
        array_agg(event.event_seq::int ORDER BY event.event_seq) AS "eventSeqs"
      FROM app_private.sessions AS session
      JOIN app_private.session_events AS event
        ON event.session_id = session.id
      WHERE session.id = ${sessionId}::uuid
      GROUP BY session.id
    `
    expect(rows[0]).toEqual({
      stateVersion: 2,
      nextEventSeq: 2,
      eventSeqs: [0, 1],
    })
  } finally {
    await secondMutation?.catch(() => undefined)
    await secondSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

export async function assertM25SessionMutationRepository(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertMutationOwnerAndCreationBoundaries(sql)
  await assertSingleEventVisibility(sql, runtimeUrl)
  await assertMultiEventAndUniqueConstraint(sql)
  await assertEndedMutationWithoutSnapshot(sql)
  await assertMutationRollbacks(sql)
  await assertConcurrentSessionMutations(sql, runtimeUrl)
}

export async function assertM24M25AtomicComposition(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const owner = await resolveOwnerScope(sql, ownerScope)

  const successSessionId = fixture.id(25_600)
  const successHandId = fixture.id(25_601)
  try {
    await insertCommittedActiveSession(sql, successSessionId)
    await sql.begin(async (transaction) => {
      const locked = await lockSessionForMutation(
        transaction,
        owner,
        successSessionId,
      )
      const acquired = await registerCommand(
        transaction,
        owner,
        prepareCommandRegistration({
          sessionId: successSessionId,
          commandId: fixture.id(25_602),
          expectedStateVersion: 0,
          type: 'startNextHand',
          payload: {},
        }),
      )
      if (acquired.status !== 'acquired') {
        throw new Error('测试未取得命令处理权。')
      }
      await insertMutationHand(
        transaction as unknown as Sql,
        owner.databaseOwnerId,
        successSessionId,
        successHandId,
      )
      const batch = createMutationBatch({
        sessionId: successSessionId,
        handId: successHandId,
        eventIds: [fixture.id(25_603)],
        lockedStateVersion: 0,
        nextEventSeq: 0,
        mutationAt: '2026-08-03T10:07:00.000Z',
        commandLedgerId: acquired.ledgerId,
      })
      const persisted = await persistSessionMutation(transaction, locked, batch)
      await completeCommand(
        transaction,
        acquired,
        {
          protocolVersion: 1,
          snapshot: batch.events[0]!.publicEvent.payload.snapshot,
        },
        {
          firstEventSeq: persisted.firstEventSeq,
          lastEventSeq: persisted.lastEventSeq,
        },
      )
    })

    const rows = await sql<
      {
        readonly processingStatus: string
        readonly finalStateVersion: number
        readonly firstEventSeq: number
        readonly lastEventSeq: number
        readonly sessionStateVersion: number
        readonly nextEventSeq: number
        readonly snapshotCount: number
        readonly eventCount: number
        readonly commandEventCount: number
        readonly handCount: number
      }[]
    >`
      SELECT
        ledger.processing_status AS "processingStatus",
        ledger.final_state_version::int AS "finalStateVersion",
        ledger.first_event_seq::int AS "firstEventSeq",
        ledger.last_event_seq::int AS "lastEventSeq",
        session.state_version::int AS "sessionStateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (
          SELECT count(*)::int
          FROM app_private.session_snapshots AS snapshot
          WHERE snapshot.session_id = session.id
        ) AS "snapshotCount",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
            AND event.command_ledger_id = ledger.id
        ) AS "commandEventCount",
        (
          SELECT count(*)::int
          FROM app_private.hands AS hand
          WHERE hand.session_id = session.id
        ) AS "handCount"
      FROM app_private.sessions AS session
      JOIN app_private.command_ledger AS ledger
        ON ledger.session_id = session.id
      WHERE session.id = ${successSessionId}::uuid
    `
    expect(rows[0]).toEqual({
      processingStatus: 'completed',
      finalStateVersion: 1,
      firstEventSeq: 0,
      lastEventSeq: 0,
      sessionStateVersion: 1,
      nextEventSeq: 1,
      snapshotCount: 1,
      eventCount: 1,
      commandEventCount: 1,
      handCount: 1,
    })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${successSessionId}::uuid
    `
  }

  const completeFailureSessionId = fixture.id(25_610)
  const completeFailureHandId = fixture.id(25_611)
  try {
    await insertCommittedActiveSession(sql, completeFailureSessionId)
    await expect(
      sql.begin(async (transaction) => {
        const locked = await lockSessionForMutation(
          transaction,
          owner,
          completeFailureSessionId,
        )
        const acquired = await registerCommand(
          transaction,
          owner,
          prepareCommandRegistration({
            sessionId: completeFailureSessionId,
            commandId: fixture.id(25_612),
            expectedStateVersion: 0,
            type: 'startNextHand',
            payload: {},
          }),
        )
        if (acquired.status !== 'acquired') {
          throw new Error('测试未取得命令处理权。')
        }
        await insertMutationHand(
          transaction as unknown as Sql,
          owner.databaseOwnerId,
          completeFailureSessionId,
          completeFailureHandId,
        )
        const batch = createMutationBatch({
          sessionId: completeFailureSessionId,
          handId: completeFailureHandId,
          eventIds: [fixture.id(25_613)],
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: '2026-08-03T10:07:01.000Z',
          commandLedgerId: acquired.ledgerId,
        })
        await persistSessionMutation(transaction, locked, batch)
        await completeCommand(
          transaction,
          acquired,
          {
            protocolVersion: 1,
            snapshot: createMutationPublicSnapshot(
              completeFailureSessionId,
              1,
              1,
              'active',
            ),
          },
          { firstEventSeq: 0, lastEventSeq: 0 },
        )
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)

    const rows = await sql<
      {
        readonly stateVersion: number
        readonly ledgerCount: number
        readonly snapshotCount: number
        readonly eventCount: number
        readonly handCount: number
      }[]
    >`
      SELECT
        session.state_version::int AS "stateVersion",
        (
          SELECT count(*)::int
          FROM app_private.command_ledger AS ledger
          WHERE ledger.session_id = session.id
        ) AS "ledgerCount",
        (
          SELECT count(*)::int
          FROM app_private.session_snapshots AS snapshot
          WHERE snapshot.session_id = session.id
        ) AS "snapshotCount",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount",
        (
          SELECT count(*)::int
          FROM app_private.hands AS hand
          WHERE hand.session_id = session.id
        ) AS "handCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${completeFailureSessionId}::uuid
    `
    expect(rows[0]).toEqual({
      stateVersion: 0,
      ledgerCount: 0,
      snapshotCount: 0,
      eventCount: 0,
      handCount: 0,
    })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${completeFailureSessionId}::uuid
    `
  }

  const commitFailureSessionId = fixture.id(25_620)
  const commitFailureHandId = fixture.id(25_621)
  try {
    await insertCommittedActiveSession(sql, commitFailureSessionId)
    let reachedCommit = false
    await expect(
      sql.begin(async (transaction) => {
        const locked = await lockSessionForMutation(
          transaction,
          owner,
          commitFailureSessionId,
        )
        const acquired = await registerCommand(
          transaction,
          owner,
          prepareCommandRegistration({
            sessionId: commitFailureSessionId,
            commandId: fixture.id(25_622),
            expectedStateVersion: 0,
            type: 'startNextHand',
            payload: {},
          }),
        )
        if (acquired.status !== 'acquired') {
          throw new Error('测试未取得命令处理权。')
        }
        await insertMutationHand(
          transaction as unknown as Sql,
          owner.databaseOwnerId,
          commitFailureSessionId,
          commitFailureHandId,
        )
        const batch = createMutationBatch({
          sessionId: commitFailureSessionId,
          handId: commitFailureHandId,
          eventIds: [fixture.id(25_623)],
          lockedStateVersion: 0,
          nextEventSeq: 0,
          mutationAt: '2026-08-03T10:07:02.000Z',
          commandLedgerId: acquired.ledgerId,
        })
        const persisted = await persistSessionMutation(
          transaction,
          locked,
          batch,
        )
        await completeCommand(
          transaction,
          acquired,
          {
            protocolVersion: 1,
            snapshot: batch.events[0]!.publicEvent.payload.snapshot,
          },
          {
            firstEventSeq: persisted.firstEventSeq,
            lastEventSeq: persisted.lastEventSeq,
          },
        )
        await transaction`
          DELETE FROM app_private.session_participants
          WHERE session_id = ${commitFailureSessionId}::uuid
            AND participant_type = 'user'
        `
        reachedCommit = true
      }),
    ).rejects.toThrow()
    expect(reachedCommit).toBe(true)

    const rows = await sql<
      {
        readonly stateVersion: number
        readonly participantCount: number
        readonly ledgerCount: number
        readonly snapshotCount: number
        readonly eventCount: number
        readonly handCount: number
      }[]
    >`
      SELECT
        session.state_version::int AS "stateVersion",
        (
          SELECT count(*)::int
          FROM app_private.session_participants AS participant
          WHERE participant.session_id = session.id
        ) AS "participantCount",
        (
          SELECT count(*)::int
          FROM app_private.command_ledger AS ledger
          WHERE ledger.session_id = session.id
        ) AS "ledgerCount",
        (
          SELECT count(*)::int
          FROM app_private.session_snapshots AS snapshot
          WHERE snapshot.session_id = session.id
        ) AS "snapshotCount",
        (
          SELECT count(*)::int
          FROM app_private.session_events AS event
          WHERE event.session_id = session.id
        ) AS "eventCount",
        (
          SELECT count(*)::int
          FROM app_private.hands AS hand
          WHERE hand.session_id = session.id
        ) AS "handCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${commitFailureSessionId}::uuid
    `
    expect(rows[0]).toEqual({
      stateVersion: 0,
      participantCount: 6,
      ledgerCount: 0,
      snapshotCount: 0,
      eventCount: 0,
      handCount: 0,
    })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${commitFailureSessionId}::uuid
    `
  }
}
