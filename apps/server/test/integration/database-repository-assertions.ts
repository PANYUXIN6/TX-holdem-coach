import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { JSONValue, Sql, TransactionSql } from 'postgres'
import { createHandStartedEventDraft } from '../../src/poker/hand-result.js'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { PERSONA_CATALOG_DEFINITIONS } from '../../src/personas/catalog-definitions.js'
import { createActiveModelConfigurationV1Schema } from '../../src/personas/config.js'
import {
  ActiveModelConfigurationError,
  ActiveSessionConflictError,
  CommandPayloadConflictError,
  DatabaseOperationError,
  HandAuditTransitionError,
  OwnerScopeResolutionError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from '../../src/persistence/errors.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import {
  abortHandAudit,
  completeHandAudit,
  insertInProgressHandAudit,
  readHandAudit,
} from '../../src/persistence/hand-audit-repository.js'
import {
  recoverSessionForMutation,
  retryReadonlySessionRecovery,
} from '../../src/persistence/session-recovery-repository.js'
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
import { productionPrivateEventVersionRegistry } from '../../src/sessions/authoritative-state/private-event-version-registry.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshotV1 } from '../../src/sessions/authoritative-state/snapshot-codec-v1.js'
import { productionSnapshotVersionRegistry } from '../../src/sessions/authoritative-state/snapshot-version-registry.js'
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
      id,
      owner_id,
      lifecycle_status,
      state_version,
      next_event_seq,
      diagnostic_code,
      diagnosed_at
    ) VALUES (
      ${sessionId}::uuid,
      ${ownerId}::uuid,
      'readonlyDiagnostic',
      0,
      0,
      'snapshotMissing',
      clock_timestamp()
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
          diagnostic_code = 'snapshotMissing',
          diagnosed_at = clock_timestamp(),
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
  requireAgentRunParentLockQuery = false,
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
      if (!requireAgentRunParentLockQuery) {
        return
      }
      const activityRows = await transaction<
        { readonly waitsOnAgentRunParentLockQuery: boolean }[]
      >`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity AS activity
          WHERE activity.pid = ${secondBackendPid}::int
            AND activity.state = 'active'
            AND activity.query LIKE '%FROM app_private.agent_runs%'
            AND activity.query LIKE '%FOR UPDATE%'
        ) AS "waitsOnAgentRunParentLockQuery"
      `
      if (activityRows[0]?.waitsOnAgentRunParentLockQuery) {
        return
      }
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

const recoveryRegistries = {
  snapshot: productionSnapshotVersionRegistry,
  privateEvent: productionPrivateEventVersionRegistry,
}

async function insertRecoverableSession(
  sql: Sql,
  sessionId: string,
  handId: string,
  eventId: string,
): Promise<void> {
  const owner = await resolveOwnerScope(sql, ownerScope)
  await insertCommittedActiveSession(sql, sessionId, handId)
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
        mutationAt: '2026-08-04T10:00:00.000Z',
      }),
    )
    await transaction`
      UPDATE app_private.hands
      SET status = 'aborted',
          abort_reason = 'M2.6 recovery fixture',
          aborted_at = '2026-08-04T10:00:00.000Z'::timestamptz,
          updated_at = '2026-08-04T10:00:00.000Z'::timestamptz
      WHERE id = ${handId}::uuid
        AND session_id = ${sessionId}::uuid
        AND owner_id = ${owner.databaseOwnerId}::uuid
    `
  })
}

async function assertRecoveryRepairAndCapability(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(26_100)
  const handId = fixture.id(26_101)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const postgres = (await import('postgres')).default
  const observerSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  try {
    await insertRecoverableSession(sql, sessionId, handId, fixture.id(26_102))
    await sql`
      UPDATE app_private.sessions
      SET current_hand_id = ${handId}::uuid
      WHERE id = ${sessionId}::uuid
    `
    await sql`
      UPDATE app_private.session_events
      SET public_event_payload = '{"invalid":"public-only"}'::jsonb
      WHERE session_id = ${sessionId}::uuid
    `

    await sql.begin(async (transaction) => {
      const recovered = await recoverSessionForMutation(
        transaction,
        owner,
        sessionId,
        '2026-08-04T10:01:00.000Z',
        recoveryRegistries,
      )
      expect(recovered).toMatchObject({
        kind: 'ready',
        pointerRepair: { from: handId, to: null },
      })
      if (recovered.kind !== 'ready') {
        throw new Error('Expected active recovery capability.')
      }
      const invisible = await observerSql<
        { readonly currentHandId: string | null }[]
      >`
        SELECT current_hand_id::text AS "currentHandId"
        FROM app_private.sessions
        WHERE id = ${sessionId}::uuid
      `
      expect(invisible[0]?.currentHandId).toBe(handId)

      await persistSessionMutation(
        transaction,
        recovered.locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [fixture.id(26_103)],
          lockedStateVersion: 1,
          nextEventSeq: 1,
          mutationAt: '2026-08-04T10:02:00.000Z',
          writeSnapshot: false,
        }),
      )
    })

    const rows = await sql<
      { readonly currentHandId: string | null; readonly nextEventSeq: number }[]
    >`
      SELECT
        current_hand_id::text AS "currentHandId",
        next_event_seq::int AS "nextEventSeq"
      FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({ currentHandId: null, nextEventSeq: 2 })
  } finally {
    await observerSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertRecoveryDiagnosticAndRetry(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(26_200)
  const handId = fixture.id(26_201)
  const eventId = fixture.id(26_202)
  const owner = await resolveOwnerScope(sql, ownerScope)
  try {
    await insertRecoverableSession(sql, sessionId, handId, eventId)
    await sql`
      UPDATE app_private.session_snapshots
      SET private_table_state_payload_version = 2
      WHERE session_id = ${sessionId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        recoverSessionForMutation(
          transaction,
          owner,
          sessionId,
          '2026-08-04T10:03:00.000Z',
          recoveryRegistries,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'readonlyDiagnostic',
      code: 'snapshotVersionUnknown',
    })

    const diagnosticRows = await sql<
      {
        readonly lifecycleStatus: string
        readonly diagnosticCode: string | null
        readonly diagnosedAt: string | null
      }[]
    >`
      SELECT
        lifecycle_status AS "lifecycleStatus",
        diagnostic_code AS "diagnosticCode",
        diagnosed_at::text AS "diagnosedAt"
      FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    expect(diagnosticRows[0]).toMatchObject({
      lifecycleStatus: 'readonlyDiagnostic',
      diagnosticCode: 'snapshotVersionUnknown',
    })
    expect(diagnosticRows[0]?.diagnosedAt).not.toBeNull()

    const currentSnapshot = createMutationBatch({
      sessionId,
      handId,
      eventIds: [eventId],
      lockedStateVersion: 0,
      nextEventSeq: 0,
      mutationAt: '2026-08-04T10:00:00.000Z',
    }).snapshot
    if (currentSnapshot === null) {
      throw new Error('Expected current snapshot fixture.')
    }
    await sql`
      UPDATE app_private.session_snapshots
      SET private_table_state_payload_version = ${currentSnapshot.payloadVersion},
          private_table_state_payload = ${JSON.stringify(currentSnapshot.payload)}::text::jsonb
      WHERE session_id = ${sessionId}::uuid
    `

    await expect(
      sql.begin((transaction) =>
        recoverSessionForMutation(
          transaction,
          owner,
          sessionId,
          '2026-08-04T10:04:00.000Z',
          recoveryRegistries,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'readonlyDiagnostic',
      code: 'snapshotVersionUnknown',
    })
    await expect(
      sql.begin((transaction) =>
        retryReadonlySessionRecovery(
          transaction,
          owner,
          sessionId,
          '2026-08-04T10:05:00.000Z',
          recoveryRegistries,
        ),
      ),
    ).resolves.toMatchObject({ kind: 'ready', lifecycleStatus: 'active' })

    const recoveredRows = await sql<
      {
        readonly lifecycleStatus: string
        readonly diagnosticCode: string | null
        readonly diagnosedAt: string | null
      }[]
    >`
      SELECT
        lifecycle_status AS "lifecycleStatus",
        diagnostic_code AS "diagnosticCode",
        diagnosed_at::text AS "diagnosedAt"
      FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    expect(recoveredRows[0]).toEqual({
      lifecycleStatus: 'active',
      diagnosticCode: null,
      diagnosedAt: null,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertRecoveryDiagnosticCase(
  sql: Sql,
  fixtureValue: number,
  corrupt: (query: Sql, sessionId: string) => Promise<void>,
  expectedCode: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(fixtureValue)
  const handId = fixture.id(fixtureValue + 1)
  const owner = await resolveOwnerScope(sql, ownerScope)
  try {
    await insertRecoverableSession(
      sql,
      sessionId,
      handId,
      fixture.id(fixtureValue + 2),
    )
    await corrupt(sql, sessionId)

    await expect(
      sql.begin((transaction) =>
        recoverSessionForMutation(
          transaction,
          owner,
          sessionId,
          '2026-08-04T10:05:30.000Z',
          recoveryRegistries,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'readonlyDiagnostic',
      code: expectedCode,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertRecoveryDiagnosticMatrix(sql: Sql): Promise<void> {
  await assertRecoveryDiagnosticCase(
    sql,
    26_500,
    async (query, sessionId) => {
      await query`
        UPDATE app_private.session_events
        SET private_event_payload_version = 2
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'eventVersionUnknown',
  )
  await assertRecoveryDiagnosticCase(
    sql,
    26_510,
    async (query, sessionId) => {
      await query`
        UPDATE app_private.session_events
        SET private_event_payload = '{"eventSchemaVersion":1,"event":{}}'::jsonb
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'eventPayloadInvalid',
  )
  await assertRecoveryDiagnosticCase(
    sql,
    26_520,
    async (query, sessionId) => {
      await query`
        DELETE FROM app_private.session_events
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'eventSequenceInvalid',
  )
  await assertRecoveryDiagnosticCase(
    sql,
    26_530,
    async (query, sessionId) => {
      await query`
        UPDATE app_private.session_events
        SET hand_id = NULL
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'eventRowMismatch',
  )
  await assertRecoveryDiagnosticCase(
    sql,
    26_540,
    async (query, sessionId) => {
      await query`
        UPDATE app_private.session_events
        SET state_version_before = 1,
            state_version_after = 1
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'eventRowMismatch',
  )
  await assertRecoveryDiagnosticCase(
    sql,
    26_550,
    async (query, sessionId) => {
      await query`
        UPDATE app_private.session_events
        SET state_version_after = 0
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'stateVersionMismatch',
  )
  await assertRecoveryDiagnosticCase(
    sql,
    26_560,
    async (query, sessionId) => {
      await query`
        UPDATE app_private.session_snapshots
        SET private_table_state_payload =
          '{"snapshotSchemaVersion":1,"state":{}}'::jsonb
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'snapshotPayloadInvalid',
  )
}

async function assertLegacyDiagnosticRetry(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(26_600)
  const handId = fixture.id(26_601)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const diagnosedAt = '2026-08-04T10:06:00.000000Z'
  try {
    await insertRecoverableSession(sql, sessionId, handId, fixture.id(26_602))
    await sql`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          diagnostic_code = 'legacyDiagnosticState',
          diagnosed_at = ${diagnosedAt}::timestamptz
      WHERE id = ${sessionId}::uuid
    `
    await sql`
      UPDATE app_private.session_snapshots
      SET private_table_state_payload_version = 2
      WHERE session_id = ${sessionId}::uuid
    `

    await expect(
      sql.begin((transaction) =>
        retryReadonlySessionRecovery(
          transaction,
          owner,
          sessionId,
          '2026-08-04T10:07:00.000Z',
          recoveryRegistries,
        ),
      ),
    ).resolves.toMatchObject({
      kind: 'readonlyDiagnostic',
      code: 'snapshotVersionUnknown',
      diagnosedAt,
    })

    const rows = await sql<
      {
        readonly diagnosticCode: string | null
        readonly retainedDiagnosedAt: boolean
      }[]
    >`
      SELECT
        diagnostic_code AS "diagnosticCode",
        diagnosed_at = ${diagnosedAt}::timestamptz AS "retainedDiagnosedAt"
      FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      diagnosticCode: 'snapshotVersionUnknown',
      retainedDiagnosedAt: true,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertEndedDiagnosticRetry(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(26_650)
  const handId = fixture.id(26_651)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const endedAt = '2026-08-04T10:07:30.000Z'
  try {
    await insertRecoverableSession(sql, sessionId, handId, fixture.id(26_652))
    await sql`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          ended_at = ${endedAt}::timestamptz,
          diagnostic_code = 'snapshotMissing',
          diagnosed_at = '2026-08-04T10:07:31.000Z'::timestamptz
      WHERE id = ${sessionId}::uuid
    `

    const result = await sql.begin((transaction) =>
      retryReadonlySessionRecovery(
        transaction,
        owner,
        sessionId,
        '2026-08-04T10:08:00.000Z',
        recoveryRegistries,
      ),
    )
    expect(result).toMatchObject({ kind: 'ended', pointerRepair: null })
    expect('locked' in result).toBe(false)

    const rows = await sql<
      {
        readonly lifecycleStatus: string
        readonly endedAtPreserved: boolean
        readonly diagnosticCode: string | null
        readonly diagnosedAt: string | null
      }[]
    >`
      SELECT
        lifecycle_status AS "lifecycleStatus",
        ended_at = ${endedAt}::timestamptz AS "endedAtPreserved",
        diagnostic_code AS "diagnosticCode",
        diagnosed_at::text AS "diagnosedAt"
      FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      lifecycleStatus: 'ended',
      endedAtPreserved: true,
      diagnosticCode: null,
      diagnosedAt: null,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertRecoveryOwnerIsolation(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const owner = await resolveOwnerScope(sql, ownerScope)

  await inRollbackTransaction(sql, async (transaction, query) => {
    const otherOwner = fixture.mainOwner
    const otherSessionId = fixture.id(26_700)
    await query`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${otherOwner.id}::uuid, ${otherOwner.identityKey})
    `
    await insertDiagnosticSession(query, otherOwner.id, otherSessionId)

    await expect(
      recoverSessionForMutation(
        transaction,
        owner,
        otherSessionId,
        '2026-08-04T10:08:00.000Z',
        recoveryRegistries,
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })
}

async function assertRecoveryActiveConflictRollback(sql: Sql): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(26_300)
  const handId = fixture.id(26_301)
  const otherSessionId = fixture.id(26_303)
  const owner = await resolveOwnerScope(sql, ownerScope)
  try {
    await insertRecoverableSession(sql, sessionId, handId, fixture.id(26_302))
    await sql`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          diagnostic_code = 'snapshotMissing',
          diagnosed_at = '2026-08-04T10:06:00.000Z'::timestamptz,
          current_hand_id = ${handId}::uuid
      WHERE id = ${sessionId}::uuid
    `
    await insertCommittedActiveSession(sql, otherSessionId)

    await expect(
      sql.begin((transaction) =>
        retryReadonlySessionRecovery(
          transaction,
          owner,
          sessionId,
          '2026-08-04T10:07:00.000Z',
          recoveryRegistries,
        ),
      ),
    ).rejects.toBeInstanceOf(ActiveSessionConflictError)

    const rows = await sql<
      {
        readonly lifecycleStatus: string
        readonly diagnosticCode: string | null
        readonly currentHandId: string | null
      }[]
    >`
      SELECT
        lifecycle_status AS "lifecycleStatus",
        diagnostic_code AS "diagnosticCode",
        current_hand_id::text AS "currentHandId"
      FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      lifecycleStatus: 'readonlyDiagnostic',
      diagnosticCode: 'snapshotMissing',
      currentHandId: handId,
    })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${sessionId}::uuid, ${otherSessionId}::uuid)
    `
  }
}

async function assertConcurrentRecoveryAfterMutation(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(26_400)
  const handId = fixture.id(26_401)
  const owner = await resolveOwnerScope(sql, ownerScope)
  const postgres = (await import('postgres')).default
  const secondSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  let secondRecovery:
    Promise<Awaited<ReturnType<typeof recoverSessionForMutation>>> | undefined
  try {
    await insertRecoverableSession(sql, sessionId, handId, fixture.id(26_402))

    await sql.begin(async (transaction) => {
      const firstPidRows = await transaction<{ readonly backendPid: number }[]>`
        SELECT pg_backend_pid() AS "backendPid"
      `
      const firstBackendPid = firstPidRows[0]!.backendPid
      const firstRecovery = await recoverSessionForMutation(
        transaction,
        owner,
        sessionId,
        '2026-08-04T10:08:00.000Z',
        recoveryRegistries,
      )
      if (firstRecovery.kind !== 'ready') {
        throw new Error('Expected first active recovery.')
      }

      let signalSecondPid: ((pid: number) => void) | undefined
      const secondPid = new Promise<number>((resolve) => {
        signalSecondPid = resolve
      })
      secondRecovery = secondSql.begin(async (secondTransaction) => {
        const secondPidRows = await secondTransaction<
          { readonly backendPid: number }[]
        >`
          SELECT pg_backend_pid() AS "backendPid"
        `
        const secondBackendPid = secondPidRows[0]?.backendPid
        if (secondBackendPid === undefined) {
          throw new Error('无法取得第二恢复事务 backend PID。')
        }
        signalSecondPid?.(secondBackendPid)
        return recoverSessionForMutation(
          secondTransaction,
          owner,
          sessionId,
          '2026-08-04T10:09:00.000Z',
          recoveryRegistries,
        )
      })
      await waitForTransactionBlock(
        transaction,
        firstBackendPid,
        await secondPid,
      )
      await persistSessionMutation(
        transaction,
        firstRecovery.locked,
        createMutationBatch({
          sessionId,
          handId,
          eventIds: [fixture.id(26_403)],
          lockedStateVersion: 1,
          nextEventSeq: 1,
          mutationAt: '2026-08-04T10:10:00.000Z',
          writeSnapshot: false,
        }),
      )
    })

    await expect(secondRecovery).resolves.toMatchObject({
      kind: 'ready',
      locked: { nextEventSeq: 2 },
    })
  } finally {
    await secondRecovery?.catch(() => undefined)
    await secondSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

export async function assertM26SessionRecoveryRepository(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertRecoveryRepairAndCapability(sql, runtimeUrl)
  await assertRecoveryDiagnosticAndRetry(sql)
  await assertRecoveryDiagnosticMatrix(sql)
  await assertLegacyDiagnosticRetry(sql)
  await assertEndedDiagnosticRetry(sql)
  await assertRecoveryOwnerIsolation(sql)
  await assertRecoveryActiveConflictRollback(sql)
  await assertConcurrentRecoveryAfterMutation(sql, runtimeUrl)
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

const M27_RANDOM_SOURCE = Object.freeze({
  nextInt: (maximum: number) => 0 % maximum,
})

function createM27PokerSeats(rebuySeatNumber?: number) {
  return Array.from({ length: 6 }, (_, seatNumber) => ({
    seatNumber,
    playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
      .toString()
      .padStart(12, '0')}`,
    isUser: seatNumber === 0,
    stack: seatNumber === rebuySeatNumber ? 1_250 : 1_000,
    status: 'active' as const,
    streetContribution: 0,
    totalContribution: 0,
  }))
}

function createM27HandAuditFixture(
  handId: string,
  options: { readonly rebuySeatNumber?: number } = {},
) {
  const stateBeforeStartPoker = initializePokerTable(
    createM27PokerSeats(),
    M27_RANDOM_SOURCE,
  )
  const pokerForStart = initializePokerTable(
    createM27PokerSeats(options.rebuySeatNumber),
    M27_RANDOM_SOURCE,
  )
  const started = startPokerHand(pokerForStart, {
    handId,
    completedHandCountBeforeStart: 0,
    randomSource: M27_RANDOM_SOURCE,
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
  }).completedHand
  if (completed === null) {
    throw new Error('M2.7 Hand fixture 未产生完成结果。')
  }

  return Object.freeze({
    checkpoint: {
      stateBeforeStartCommand: createPrivateTableState({
        stateVersion: 7,
        poker: stateBeforeStartPoker,
        completedHandCount: 0,
        seatAccounting: stateBeforeStartPoker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          cumulativeBuyIn: 1_000,
        })),
        lastCompletedHandSummary: null,
      }),
      startedHand: started.startedHand,
    },
    completed,
  })
}

async function insertCommittedM27Session(sql: Sql, sessionId: string) {
  const roster = await sql.begin(async (transaction) => {
    const input = await createRosterInput(transaction as unknown as Sql)
    await insertSessionRosterSnapshot(transaction, { ...input, sessionId })
    return input
  })
  return roster.owner
}

async function assertM27HandPublicRoundTrips(sql: Sql): Promise<void> {
  const completedSessionId = randomUUID()
  const completedHandId = randomUUID()
  const rebuySessionId = randomUUID()
  const rebuyHandId = randomUUID()

  try {
    const completedOwner = await insertCommittedM27Session(
      sql,
      completedSessionId,
    )
    const completedFixture = createM27HandAuditFixture(completedHandId)
    await sql.begin(async (transaction) => {
      await expect(
        insertInProgressHandAudit(transaction, completedOwner, {
          sessionId: completedSessionId,
          checkpoint: completedFixture.checkpoint,
          startedAt: '2026-08-04T12:00:00.000Z',
        }),
      ).resolves.toEqual({ handId: completedHandId, handNumber: 1 })

      const inProgress = await readHandAudit(
        transaction,
        completedOwner,
        completedSessionId,
        completedHandId,
      )
      expect(inProgress).toMatchObject({
        ownerId: 'local-user',
        sessionId: completedSessionId,
        handId: completedHandId,
        handNumber: 1,
        status: 'inProgress',
        checkpoint: completedFixture.checkpoint,
        result: null,
      })

      const completed = await completeHandAudit(transaction, completedOwner, {
        sessionId: completedSessionId,
        handId: completedHandId,
        result: completedFixture.completed,
        completedAt: '2026-08-04T12:05:00.000Z',
      })
      expect(completed).toMatchObject({
        ownerId: 'local-user',
        sessionId: completedSessionId,
        handId: completedHandId,
        status: 'completed',
        checkpoint: completedFixture.checkpoint,
        result: completedFixture.completed,
        completedAt: '2026-08-04T12:05:00.000000Z',
      })
      expect(Object.isFrozen(completed)).toBe(true)
      expect(Object.isFrozen(completed.result)).toBe(true)
    })

    await expect(
      sql.begin(async (transaction) =>
        readHandAudit(
          transaction,
          completedOwner,
          completedSessionId,
          completedHandId,
        ),
      ),
    ).resolves.toMatchObject({
      status: 'completed',
      result: completedFixture.completed,
    })

    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${completedSessionId}::uuid
    `

    const rebuyOwner = await insertCommittedM27Session(sql, rebuySessionId)
    const rebuyFixture = createM27HandAuditFixture(rebuyHandId, {
      rebuySeatNumber: 1,
    })
    await sql.begin(async (transaction) => {
      await insertInProgressHandAudit(transaction, rebuyOwner, {
        sessionId: rebuySessionId,
        checkpoint: rebuyFixture.checkpoint,
        startedAt: '2026-08-04T12:10:00.000Z',
      })
      const audit = await readHandAudit(
        transaction,
        rebuyOwner,
        rebuySessionId,
        rebuyHandId,
      )
      const beforeSeat =
        audit.checkpoint.stateBeforeStartCommand.poker.seats.find(
          (seat) => seat.seatNumber === 1,
        )
      const startedSeat = audit.checkpoint.startedHand.startingStacks.find(
        (seat) => seat.seatNumber === 1,
      )
      expect(beforeSeat?.stack).toBe(1_000)
      expect(startedSeat?.stack).toBe(1_250)
    })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${completedSessionId}::uuid, ${rebuySessionId}::uuid)
    `
  }
}

async function assertM27HandOwnerAndAssociationBoundaries(
  sql: Sql,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const missingSessionId = randomUUID()
  const missingHandId = randomUUID()
  const owner = await insertCommittedM27Session(sql, sessionId)
  const fixture = createM27HandAuditFixture(handId)

  try {
    await sql.begin((transaction) =>
      insertInProgressHandAudit(transaction, owner, {
        sessionId,
        checkpoint: fixture.checkpoint,
        startedAt: '2026-08-04T12:20:00.000Z',
      }),
    )

    await expect(
      sql.begin((transaction) =>
        readHandAudit(transaction, owner, missingSessionId, handId),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
    await expect(
      sql.begin((transaction) =>
        readHandAudit(transaction, owner, sessionId, missingHandId),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)

    const missingAssociation = createM27HandAuditFixture(randomUUID())
    await expect(
      sql.begin((transaction) =>
        insertInProgressHandAudit(transaction, owner, {
          sessionId: missingSessionId,
          checkpoint: missingAssociation.checkpoint,
          startedAt: '2026-08-04T12:21:00.000Z',
        }),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27HandRollbackAndVisibility(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const owner = await insertCommittedM27Session(sql, sessionId)
  const fixture = createM27HandAuditFixture(handId)
  const postgres = (await import('postgres')).default
  const observerSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })

  try {
    await observerSql`SELECT 1`
    await inRollbackTransaction(sql, async (transaction) => {
      await insertInProgressHandAudit(transaction, owner, {
        sessionId,
        checkpoint: fixture.checkpoint,
        startedAt: '2026-08-04T12:30:00.000Z',
      })
      const observerOwner = await resolveOwnerScope(observerSql, ownerScope)
      await expect(
        observerSql.begin((observerTransaction) =>
          readHandAudit(observerTransaction, observerOwner, sessionId, handId),
        ),
      ).rejects.toBeInstanceOf(ResourceNotFoundError)
    })

    await expect(
      sql.begin((transaction) =>
        readHandAudit(transaction, owner, sessionId, handId),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  } finally {
    await observerSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27HandRestartReadback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const fixture = createM27HandAuditFixture(handId)
  const postgres = (await import('postgres')).default
  let writerSql: Sql | undefined = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  let readerSql: Sql | undefined

  try {
    const owner = await insertCommittedM27Session(writerSql, sessionId)
    await writerSql.begin(async (transaction) => {
      await insertInProgressHandAudit(transaction, owner, {
        sessionId,
        checkpoint: fixture.checkpoint,
        startedAt: '2026-08-04T12:40:00.000Z',
      })
      await completeHandAudit(transaction, owner, {
        sessionId,
        handId,
        result: fixture.completed,
        completedAt: '2026-08-04T12:45:00.000Z',
      })
    })
    await writerSql.end({ timeout: 0 })
    writerSql = undefined

    readerSql = postgres(runtimeUrl, {
      connect_timeout: 10,
      max: 1,
      prepare: false,
      ssl: 'require',
    })
    const readerOwner = await resolveOwnerScope(readerSql, ownerScope)
    await expect(
      readerSql.begin((transaction) =>
        readHandAudit(transaction, readerOwner, sessionId, handId),
      ),
    ).resolves.toMatchObject({
      ownerId: 'local-user',
      sessionId,
      handId,
      status: 'completed',
      checkpoint: fixture.checkpoint,
      result: fixture.completed,
    })
  } finally {
    await writerSql?.end({ timeout: 0 })
    await readerSql?.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27HandSecretBoundaries(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const sentinel = `M27_SECRET_SENTINEL_${randomUUID()}`
  const owner = await insertCommittedM27Session(sql, sessionId)
  const fixture = createM27HandAuditFixture(handId)

  try {
    await expect(
      sql.begin((transaction) =>
        insertInProgressHandAudit(transaction, owner, {
          sessionId,
          checkpoint: {
            ...fixture.checkpoint,
            reasoning_content: sentinel,
          } as never,
          startedAt: '2026-08-04T12:50:00.000Z',
        }),
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)

    const rejectedRows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.hands
      WHERE session_id = ${sessionId}::uuid
    `
    expect(rejectedRows[0]?.count).toBe(0)

    await sql.begin(async (transaction) => {
      await insertInProgressHandAudit(transaction, owner, {
        sessionId,
        checkpoint: fixture.checkpoint,
        startedAt: '2026-08-04T12:51:00.000Z',
      })
      await completeHandAudit(transaction, owner, {
        sessionId,
        handId,
        result: fixture.completed,
        completedAt: '2026-08-04T12:56:00.000Z',
      })
    })

    const persistedRows = await sql<{ readonly persisted: string }[]>`
      SELECT to_jsonb(hand)::text AS persisted
      FROM app_private.hands AS hand
      WHERE hand.id = ${handId}::uuid
        AND hand.session_id = ${sessionId}::uuid
        AND hand.owner_id = ${owner.databaseOwnerId}::uuid
    `
    expect(persistedRows).toHaveLength(1)
    expect(persistedRows[0]?.persisted).not.toContain(sentinel)
    expect(persistedRows[0]?.persisted).not.toContain('reasoning_content')
    expect(persistedRows[0]?.persisted).not.toContain('api_key')
    expect(persistedRows[0]?.persisted).not.toContain('database_url')
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27HandAbortRoundTripAndRollback(sql: Sql): Promise<void> {
  const playerSessionId = randomUUID()
  const playerHandId = randomUUID()
  const playerRunId = randomUUID()
  const decisionRequestId = randomUUID()
  const coachSessionId = randomUUID()
  const coachHandId = randomUUID()
  const coachRunId = randomUUID()

  try {
    const playerOwner = await insertCommittedM27Session(sql, playerSessionId)
    const playerAgents = await readSessionAgentSnapshots(
      sql,
      ownerScope,
      playerSessionId,
    )
    const actor = playerAgents[0]
    if (actor === undefined) {
      throw new Error('M2.7 Player 中止 fixture 缺少 Agent。')
    }
    const playerFixture = createM27HandAuditFixture(playerHandId)
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })

    await sql.begin(async (transaction) => {
      const locked = await lockSessionForMutation(
        transaction,
        playerOwner,
        playerSessionId,
      )
      await insertInProgressHandAudit(transaction, playerOwner, {
        sessionId: playerSessionId,
        checkpoint: playerFixture.checkpoint,
        startedAt: '2026-08-04T13:00:00.000Z',
      })
      await repository.insertAgentRunAudit(
        transaction,
        playerOwner,
        createM27PlayerRunInput(
          playerSessionId,
          playerHandId,
          playerRunId,
          actor.participantId,
          decisionRequestId,
        ),
      )
      await persistSessionMutation(
        transaction,
        locked,
        createM27ThinkingMutationBatch({
          sessionId: playerSessionId,
          handId: playerHandId,
          agentRunId: playerRunId,
          decisionRequestId,
          actorSeatNumber: actor.seatNumber,
        }),
      )
      const aborted = await abortHandAudit(transaction, playerOwner, {
        sessionId: playerSessionId,
        handId: playerHandId,
        failedAgentRunId: playerRunId,
        reasonCode: 'provider_timeout',
        abortedAt: '2026-08-04T13:00:20.000Z',
      })
      expect(aborted).toMatchObject({
        status: 'aborted',
        failedAgentRunId: playerRunId,
        abortReasonCode: 'provider_timeout',
        result: null,
        completedAt: null,
        abortedAt: '2026-08-04T13:00:20.000000Z',
      })
    })

    await expect(
      sql.begin((transaction) =>
        readHandAudit(transaction, playerOwner, playerSessionId, playerHandId),
      ),
    ).resolves.toMatchObject({
      status: 'aborted',
      failedAgentRunId: playerRunId,
      checkpoint: playerFixture.checkpoint,
    })

    await sql`
      INSERT INTO app_private.player_decisions (
        id,
        agent_run_id,
        owner_id,
        session_id,
        hand_id,
        participant_id,
        source_state_version,
        decision_request_id,
        memory_revision,
        runtime,
        submission_status,
        decision_packet_payload_version,
        decision_packet_payload,
        candidate_set_payload_version,
        candidate_set_payload,
        validator_result_payload_version,
        validator_result_payload,
        created_at
      ) VALUES (
        ${randomUUID()}::uuid,
        ${playerRunId}::uuid,
        ${playerOwner.databaseOwnerId}::uuid,
        ${playerSessionId}::uuid,
        ${playerHandId}::uuid,
        ${actor.participantId}::uuid,
        1,
        ${decisionRequestId}::uuid,
        0,
        'player',
        'pending',
        701,
        '{}'::jsonb,
        702,
        '{}'::jsonb,
        703,
        '{}'::jsonb,
        '2026-08-04T13:00:21.000Z'::timestamptz
      )
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(
          transaction,
          playerOwner,
          playerSessionId,
          playerRunId,
        ),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'playerDecisionPacket',
    })

    await sql`DELETE FROM app_private.sessions WHERE id = ${playerSessionId}::uuid`

    const coachOwner = await insertCommittedM27Session(sql, coachSessionId)
    const coachFixture = createM27HandAuditFixture(coachHandId)
    await expect(
      sql.begin(async (transaction) => {
        await insertInProgressHandAudit(transaction, coachOwner, {
          sessionId: coachSessionId,
          checkpoint: coachFixture.checkpoint,
          startedAt: '2026-08-04T13:01:00.000Z',
        })
        await repository.insertAgentRunAudit(
          transaction,
          coachOwner,
          createM27CoachRunInput(coachSessionId, coachHandId, coachRunId),
        )
        await abortHandAudit(transaction, coachOwner, {
          sessionId: coachSessionId,
          handId: coachHandId,
          failedAgentRunId: coachRunId,
          reasonCode: 'provider_timeout',
          abortedAt: '2026-08-04T13:01:20.000Z',
        })
      }),
    ).rejects.toBeInstanceOf(HandAuditTransitionError)

    const rolledBackRows = await sql<
      { readonly handCount: number; readonly runCount: number }[]
    >`
      SELECT
        (
          SELECT count(*)::int
          FROM app_private.hands
          WHERE session_id = ${coachSessionId}::uuid
        ) AS "handCount",
        (
          SELECT count(*)::int
          FROM app_private.agent_runs
          WHERE session_id = ${coachSessionId}::uuid
        ) AS "runCount"
    `
    expect(rolledBackRows[0]).toEqual({ handCount: 0, runCount: 0 })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${playerSessionId}::uuid, ${coachSessionId}::uuid)
    `
  }
}

function createM27RunConfiguration(runtime: 'player' | 'coach') {
  return {
    runtime,
    runtimeDefinitionVersion: 4,
    contextSchemaVersion: 2,
    promptModules: [{ id: `prompt/${runtime}`, version: 3 }],
    capabilityManifest: { id: `capability/${runtime}`, version: 5 },
    capabilities: [{ id: 'capability/equity', version: 2 }],
    routePolicy: { id: `route/${runtime}`, version: 3 },
    outputSchema: { id: `output/${runtime}`, version: 2 },
    validator: { id: `validator/${runtime}`, version: 6 },
    commitGate: { id: `commit/${runtime}`, version: 3 },
    recoveryPolicy: { id: `recovery/${runtime}`, version: 1 },
    dataDependencies: [{ id: 'strategy/preflop', version: 8 }],
  }
}

function createM27ExecutionBudget() {
  return {
    maxAttempts: 4,
    maxInputTokens: 20_000,
    maxOutputTokens: 1_000,
    maxWallClockMs: 45_000,
    maxCapabilityInvocations: 4,
    maxCostMicrounits: 2_000,
  }
}

function createM27CoachRunInput(
  sessionId: string,
  handId: string,
  agentRunId: string,
) {
  return {
    agentRunId,
    sessionId,
    handId,
    runtime: 'coach' as const,
    triggerType: 'hand_completed',
    idempotencyKey: `coach/${agentRunId}`,
    participantId: null,
    sourceStateVersion: null,
    decisionRequestId: null,
    parentRunId: null,
    deadlineAt: '2026-08-04T13:01:00.000Z',
    runtimeDefinitionVersion: 4,
    runConfiguration: createM27RunConfiguration('coach'),
    budget: createM27ExecutionBudget(),
    createdAt: '2026-08-04T13:00:00.000Z',
  }
}

function createM27PlayerRunInput(
  sessionId: string,
  handId: string,
  agentRunId: string,
  participantId: string,
  decisionRequestId: string,
) {
  return {
    agentRunId,
    sessionId,
    handId,
    runtime: 'player' as const,
    triggerType: 'action_required',
    idempotencyKey: `player/${agentRunId}`,
    participantId,
    sourceStateVersion: 1,
    decisionRequestId,
    parentRunId: null,
    deadlineAt: '2026-08-04T13:01:00.000Z',
    runtimeDefinitionVersion: 4,
    runConfiguration: createM27RunConfiguration('player'),
    budget: createM27ExecutionBudget(),
    createdAt: '2026-08-04T13:00:00.000Z',
  }
}

function createM27ThinkingMutationBatch(input: {
  readonly sessionId: string
  readonly handId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly actorSeatNumber: number
}): SessionMutationBatch {
  const base = createMutationBatch({
    sessionId: input.sessionId,
    handId: input.handId,
    eventIds: [randomUUID()],
    lockedStateVersion: 0,
    nextEventSeq: 0,
    mutationAt: '2026-08-04T13:00:00.000Z',
  })
  return {
    ...base,
    agentRunState: 'thinking',
    activePlayerRunId: input.agentRunId,
    activeDecisionRequestId: input.decisionRequestId,
    events: base.events.map((event) => ({
      ...event,
      publicEvent: {
        ...event.publicEvent,
        payload: {
          snapshot: {
            ...event.publicEvent.payload.snapshot,
            agentRunState: 'thinking',
            activeDecision: {
              decisionRequestId: input.decisionRequestId,
              actorSeatNumber: input.actorSeatNumber,
            },
          },
        },
      },
    })),
  }
}

function createM27AttemptInput(
  sessionId: string,
  agentRunId: string,
  sequence: number,
) {
  const hashCharacter = sequence % 2 === 0 ? 'a' : 'b'
  return {
    sessionId,
    agentRunId,
    stage: 'model_selection',
    provider: 'openai',
    model: 'gpt-5.6',
    attemptType: sequence === 0 ? 'primary' : 'retry',
    routingReasonCode: sequence === 0 ? 'primary_route' : 'retry_route',
    actualTimeoutMs: 15_000,
    remainingDeadlineMsAtStart: 45_000 - sequence * 1_000,
    requestProjectionHash: hashCharacter.repeat(64),
    startedAt: new Date(
      Date.parse('2026-08-04T13:00:01.000Z') + sequence * 1_000,
    ).toISOString(),
  }
}

function createM27InvocationInput(
  sessionId: string,
  agentRunId: string,
  sequence: number,
) {
  const inputHashCharacter = sequence % 2 === 0 ? 'c' : 'e'
  const outputHashCharacter = sequence % 2 === 0 ? 'd' : 'f'
  const startedAt = Date.parse('2026-08-04T13:00:10.000Z') + sequence * 1_000
  return {
    sessionId,
    agentRunId,
    capabilityName: 'equity.calculate',
    capabilityVersion: 2,
    authorized: true,
    inputSchemaVersion: 3,
    inputHash: inputHashCharacter.repeat(64),
    outputSchemaVersion: 4,
    outputHash: outputHashCharacter.repeat(64),
    budgetCost: 1,
    durationMs: 125,
    errorCode: null,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(startedAt + 125).toISOString(),
  }
}

async function insertCommittedM27CompletedHand(
  sql: Sql,
  sessionId: string,
  handId: string,
) {
  const owner = await insertCommittedM27Session(sql, sessionId)
  const fixture = createM27HandAuditFixture(handId)
  await sql.begin(async (transaction) => {
    await insertInProgressHandAudit(transaction, owner, {
      sessionId,
      checkpoint: fixture.checkpoint,
      startedAt: '2026-08-04T12:58:00.000Z',
    })
    await completeHandAudit(transaction, owner, {
      sessionId,
      handId,
      result: fixture.completed,
      completedAt: '2026-08-04T12:59:00.000Z',
    })
  })
  return owner
}

async function insertCommittedM27CoachRun(
  sql: Sql,
  sessionId: string,
  handId: string,
  agentRunId: string,
) {
  const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId)
  const repository = createAgentFoundationAuditRepository({
    runtimeAuditDecoders: {},
  })
  await sql.begin((transaction) =>
    repository.insertAgentRunAudit(
      transaction,
      owner,
      createM27CoachRunInput(sessionId, handId, agentRunId),
    ),
  )
  return { owner, repository }
}

async function finishM27CompletedAttempt(
  sql: Sql,
  context: {
    readonly sessionId: string
    readonly agentRunId: string
    readonly attemptId: string
    readonly sequence: number
    readonly repository: ReturnType<typeof createAgentFoundationAuditRepository>
    readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  },
): Promise<void> {
  await sql.begin((transaction) =>
    context.repository.finishAgentAttemptAudit(transaction, context.owner, {
      sessionId: context.sessionId,
      agentRunId: context.agentRunId,
      attemptId: context.attemptId,
      lifecycle: 'completed',
      accepted: true,
      stale: false,
      interrupted: false,
      inputTokens: 100 + context.sequence,
      outputTokens: 20 + context.sequence,
      costMicrounits: 800 + context.sequence,
      durationMs: 1_250 + context.sequence,
      errorCode: null,
      responseProjectionHash: (context.sequence % 2 === 0 ? '8' : '9').repeat(
        64,
      ),
      validationStatus: 'valid',
      completedAt: new Date(
        Date.parse('2026-08-04T13:00:05.000Z') + context.sequence * 1_000,
      ).toISOString(),
    }),
  )
}

async function assertM27AgentPublicAggregateRoundTrip(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()

  try {
    const { owner, repository } = await insertCommittedM27CoachRun(
      sql,
      sessionId,
      handId,
      agentRunId,
    )
    const attemptZero = await sql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 0),
      ),
    )
    const invocationZero = await sql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        createM27InvocationInput(sessionId, agentRunId, 0),
      ),
    )
    const attemptOne = await sql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 1),
      ),
    )
    const invocationOne = await sql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        createM27InvocationInput(sessionId, agentRunId, 1),
      ),
    )
    const invocationWithoutOutput = await sql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(transaction, owner, {
        ...createM27InvocationInput(sessionId, agentRunId, 2),
        outputSchemaVersion: null,
        outputHash: null,
      }),
    )
    const unauthorizedInvocation = await sql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(transaction, owner, {
        ...createM27InvocationInput(sessionId, agentRunId, 3),
        authorized: false,
        outputSchemaVersion: null,
        outputHash: null,
        errorCode: 'capability_not_authorized',
      }),
    )
    const failedInvocation = await sql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(transaction, owner, {
        ...createM27InvocationInput(sessionId, agentRunId, 4),
        outputSchemaVersion: null,
        outputHash: null,
        errorCode: 'capability_failed',
      }),
    )
    await finishM27CompletedAttempt(sql, {
      sessionId,
      agentRunId,
      attemptId: attemptOne.attemptId,
      sequence: 1,
      repository,
      owner,
    })
    await finishM27CompletedAttempt(sql, {
      sessionId,
      agentRunId,
      attemptId: attemptZero.attemptId,
      sequence: 0,
      repository,
      owner,
    })
    const failedAttempt = await sql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 2),
      ),
    )
    await sql.begin((transaction) =>
      repository.finishAgentAttemptAudit(transaction, owner, {
        sessionId,
        agentRunId,
        attemptId: failedAttempt.attemptId,
        lifecycle: 'failed',
        accepted: false,
        stale: false,
        interrupted: false,
        inputTokens: 102,
        outputTokens: 22,
        costMicrounits: 802,
        durationMs: 1_252,
        errorCode: 'provider_failed',
        responseProjectionHash: null,
        validationStatus: 'invalid',
        completedAt: '2026-08-04T13:00:07.000Z',
      }),
    )
    const cancelledAttempt = await sql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 3),
      ),
    )
    await sql.begin((transaction) =>
      repository.finishAgentAttemptAudit(transaction, owner, {
        sessionId,
        agentRunId,
        attemptId: cancelledAttempt.attemptId,
        lifecycle: 'cancelled',
        accepted: false,
        stale: false,
        interrupted: true,
        inputTokens: 103,
        outputTokens: 23,
        costMicrounits: 803,
        durationMs: 1_253,
        errorCode: 'run_cancelled',
        responseProjectionHash: null,
        validationStatus: 'notRun',
        completedAt: '2026-08-04T13:00:08.000Z',
      }),
    )
    const staleAttempt = await sql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 4),
      ),
    )
    await sql.begin((transaction) =>
      repository.finishAgentAttemptAudit(transaction, owner, {
        sessionId,
        agentRunId,
        attemptId: staleAttempt.attemptId,
        lifecycle: 'stale',
        accepted: false,
        stale: true,
        interrupted: false,
        inputTokens: 104,
        outputTokens: 24,
        costMicrounits: 804,
        durationMs: 1_254,
        errorCode: null,
        responseProjectionHash: '7'.repeat(64),
        validationStatus: 'valid',
        completedAt: '2026-08-04T13:00:09.000Z',
      }),
    )

    const audit = await sql.begin((transaction) =>
      repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
    )
    expect(audit).toMatchObject({
      ownerId: 'local-user',
      agentRunId,
      sessionId,
      handId,
      runtime: 'coach',
      lifecycle: 'queued',
      participantId: null,
      sourceStateVersion: null,
      decisionRequestId: null,
      runConfiguration: createM27RunConfiguration('coach'),
      budget: createM27ExecutionBudget(),
      attempts: [
        {
          attemptId: attemptZero.attemptId,
          attemptNumber: 0,
          lifecycle: 'completed',
        },
        {
          attemptId: attemptOne.attemptId,
          attemptNumber: 1,
          lifecycle: 'completed',
        },
        {
          attemptId: failedAttempt.attemptId,
          attemptNumber: 2,
          lifecycle: 'failed',
          errorCode: 'provider_failed',
        },
        {
          attemptId: cancelledAttempt.attemptId,
          attemptNumber: 3,
          lifecycle: 'cancelled',
          inputTokens: 103,
          outputTokens: 23,
          costMicrounits: 803,
        },
        {
          attemptId: staleAttempt.attemptId,
          attemptNumber: 4,
          lifecycle: 'stale',
          validationStatus: 'valid',
        },
      ],
      invocations: [
        {
          invocationId: invocationZero.invocationId,
          invocationNumber: 0,
        },
        {
          invocationId: invocationOne.invocationId,
          invocationNumber: 1,
        },
        {
          invocationId: invocationWithoutOutput.invocationId,
          invocationNumber: 2,
          outputSchemaVersion: null,
          outputHash: null,
          errorCode: null,
        },
        {
          invocationId: unauthorizedInvocation.invocationId,
          invocationNumber: 3,
          authorized: false,
          errorCode: 'capability_not_authorized',
        },
        {
          invocationId: failedInvocation.invocationId,
          invocationNumber: 4,
          authorized: true,
          errorCode: 'capability_failed',
        },
      ],
      runtimeAudit: {
        checkpoint: null,
        result: null,
        review: null,
      },
    })
    expect(audit.attempts).toHaveLength(5)
    expect(audit.invocations).toHaveLength(5)
    expect(new Set(audit.attempts.map(({ attemptId }) => attemptId)).size).toBe(
      5,
    )
    expect(
      new Set(audit.invocations.map(({ invocationId }) => invocationId)).size,
    ).toBe(5)
    expect(Object.isFrozen(audit)).toBe(true)
    expect(Object.isFrozen(audit.attempts)).toBe(true)
    expect(Object.isFrozen(audit.invocations)).toBe(true)

    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(
          transaction,
          owner,
          randomUUID(),
          agentRunId,
        ),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
    await expect(
      sql.begin((transaction) =>
        repository.startAgentAttemptAudit(transaction, owner, {
          ...createM27AttemptInput(sessionId, randomUUID(), 2),
          sessionId,
        }),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
    await expect(
      sql.begin((transaction) =>
        repository.insertAgentRunAudit(
          transaction,
          owner,
          createM27CoachRunInput(sessionId, randomUUID(), randomUUID()),
        ),
      ),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27AgentRestartReadback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()
  const postgres = (await import('postgres')).default
  let writerSql: Sql | undefined = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  let readerSql: Sql | undefined

  try {
    const { owner, repository } = await insertCommittedM27CoachRun(
      writerSql,
      sessionId,
      handId,
      agentRunId,
    )
    const attempt = await writerSql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 0),
      ),
    )
    await finishM27CompletedAttempt(writerSql, {
      sessionId,
      agentRunId,
      attemptId: attempt.attemptId,
      sequence: 0,
      repository,
      owner,
    })
    const startedAttempt = await writerSql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 1),
      ),
    )
    const invocation = await writerSql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        createM27InvocationInput(sessionId, agentRunId, 0),
      ),
    )
    await writerSql.end({ timeout: 0 })
    writerSql = undefined

    readerSql = postgres(runtimeUrl, {
      connect_timeout: 10,
      max: 1,
      prepare: false,
      ssl: 'require',
    })
    const readerOwner = await resolveOwnerScope(readerSql, ownerScope)
    const readerRepository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const [handAudit, runAudit] = await readerSql.begin(async (transaction) => {
      const hand = await readHandAudit(
        transaction,
        readerOwner,
        sessionId,
        handId,
      )
      const run = await readerRepository.readAgentRunAudit(
        transaction,
        readerOwner,
        sessionId,
        agentRunId,
      )
      return [hand, run] as const
    })
    expect(handAudit).toMatchObject({
      sessionId,
      handId,
      status: 'completed',
    })
    expect(runAudit).toMatchObject({
      sessionId,
      handId,
      agentRunId,
      lifecycle: 'queued',
      attempts: [
        {
          attemptId: attempt.attemptId,
          attemptNumber: 0,
          lifecycle: 'completed',
        },
        {
          attemptId: startedAttempt.attemptId,
          attemptNumber: 1,
          lifecycle: 'started',
          completedAt: null,
        },
      ],
      invocations: [
        {
          invocationId: invocation.invocationId,
          invocationNumber: 0,
        },
      ],
    })
  } finally {
    await writerSql?.end({ timeout: 0 })
    await readerSql?.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27AgentUnknownAndCorruptRows(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()

  try {
    const { owner, repository } = await insertCommittedM27CoachRun(
      sql,
      sessionId,
      handId,
      agentRunId,
    )
    const attempt = await sql.begin((transaction) =>
      repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 0),
      ),
    )
    const invocation = await sql.begin((transaction) =>
      repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        createM27InvocationInput(sessionId, agentRunId, 0),
      ),
    )
    const originalRows = await sql<
      {
        readonly runConfigurationPayload: JSONValue
        readonly budgetPayload: JSONValue
        readonly attemptPayload: JSONValue
      }[]
    >`
      SELECT
        run.run_config_payload AS "runConfigurationPayload",
        run.budget_payload AS "budgetPayload",
        attempt.attempt_payload AS "attemptPayload"
      FROM app_private.agent_runs AS run
      JOIN app_private.agent_attempts AS attempt
        ON attempt.agent_run_id = run.id
      WHERE run.id = ${agentRunId}::uuid
        AND attempt.id = ${attempt.attemptId}::uuid
    `
    const original = originalRows[0]
    if (original === undefined) {
      throw new Error('M2.7 异常读取 fixture 缺少原始载荷。')
    }

    await sql`
      UPDATE app_private.agent_runs
      SET run_config_payload_version = 999
      WHERE id = ${agentRunId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'agentRunConfiguration',
    })

    await sql`
      UPDATE app_private.agent_runs
      SET run_config_payload_version = 1,
          run_config_payload = '{}'::jsonb
      WHERE id = ${agentRunId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)

    await sql`
      UPDATE app_private.agent_runs
      SET run_config_payload = ${JSON.stringify(original.runConfigurationPayload)}::text::jsonb,
          budget_payload_version = 999
      WHERE id = ${agentRunId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'agentExecutionBudget',
    })

    await sql`
      UPDATE app_private.agent_runs
      SET budget_payload_version = 1,
          budget_payload = '{}'::jsonb
      WHERE id = ${agentRunId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)

    await sql`
      UPDATE app_private.agent_runs
      SET budget_payload = ${JSON.stringify(original.budgetPayload)}::text::jsonb,
          checkpoint_payload_version = 777,
          checkpoint_payload = '{}'::jsonb
      WHERE id = ${agentRunId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'agentRunCheckpoint',
    })

    await sql`
      UPDATE app_private.agent_runs
      SET checkpoint_payload_version = NULL,
          checkpoint_payload = NULL
      WHERE id = ${agentRunId}::uuid
    `
    await sql`
      UPDATE app_private.agent_runs
      SET result_payload_version = 778,
          result_payload = '{}'::jsonb
      WHERE id = ${agentRunId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'agentRunResult',
    })

    await sql`
      UPDATE app_private.agent_runs
      SET result_payload_version = NULL,
          result_payload = NULL
      WHERE id = ${agentRunId}::uuid
    `
    await sql`
      UPDATE app_private.agent_capability_invocations
      SET invocation_payload_version = 888,
          invocation_payload = '{}'::jsonb
      WHERE id = ${invocation.invocationId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'capabilityInvocationPayload',
    })

    await sql`
      UPDATE app_private.agent_capability_invocations
      SET invocation_payload_version = NULL,
          invocation_payload = NULL
      WHERE id = ${invocation.invocationId}::uuid
    `
    await sql`
      UPDATE app_private.agent_attempts
      SET attempt_payload_version = 999
      WHERE id = ${attempt.attemptId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'agentAttempt',
    })

    await sql`
      UPDATE app_private.agent_attempts
      SET attempt_payload_version = 1,
          attempt_payload = '{}'::jsonb
      WHERE id = ${attempt.attemptId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)

    await sql`
      UPDATE app_private.agent_attempts
      SET attempt_payload = ${JSON.stringify(original.attemptPayload)}::text::jsonb
      WHERE id = ${attempt.attemptId}::uuid
    `
    await sql`
      INSERT INTO app_private.coach_reviews (
        id,
        agent_run_id,
        owner_id,
        session_id,
        hand_id,
        runtime,
        request_id,
        status,
        frozen_context_payload_version,
        frozen_context_payload,
        requested_at,
        updated_at
      ) VALUES (
        ${randomUUID()}::uuid,
        ${agentRunId}::uuid,
        ${owner.databaseOwnerId}::uuid,
        ${sessionId}::uuid,
        ${handId}::uuid,
        'coach',
        ${randomUUID()}::uuid,
        'pending',
        777,
        '{}'::jsonb,
        '2026-08-04T13:00:20.000Z'::timestamptz,
        '2026-08-04T13:00:20.000Z'::timestamptz
      )
    `
    await expect(
      sql.begin((transaction) =>
        repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
      ),
    ).rejects.toMatchObject({
      name: UnknownPayloadVersionError.name,
      payloadKind: 'coachFrozenContext',
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27AgentSequenceConcurrency(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()
  const postgres = (await import('postgres')).default
  const secondSql = postgres(runtimeUrl, {
    connect_timeout: 10,
    max: 1,
    prepare: false,
    ssl: 'require',
  })
  let secondAttempt:
    | Promise<{ readonly attemptId: string; readonly attemptNumber: number }>
    | undefined
  let secondInvocation:
    | Promise<{
        readonly invocationId: string
        readonly invocationNumber: number
      }>
    | undefined

  try {
    const { owner, repository } = await insertCommittedM27CoachRun(
      sql,
      sessionId,
      handId,
      agentRunId,
    )
    await secondSql`SELECT 1`

    await sql.begin(async (firstTransaction) => {
      const firstPidRows = await firstTransaction<{ readonly pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `
      const firstBackendPid = firstPidRows[0]?.pid
      if (firstBackendPid === undefined) {
        throw new Error('无法取得 Attempt 第一事务 backend PID。')
      }
      const firstAttempt = await repository.startAgentAttemptAudit(
        firstTransaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 0),
      )
      expect(firstAttempt.attemptNumber).toBe(0)

      let signalSecondPid: ((pid: number) => void) | undefined
      const secondPid = new Promise<number>((resolve) => {
        signalSecondPid = resolve
      })
      secondAttempt = secondSql.begin(async (secondTransaction) => {
        const pidRows = await secondTransaction<{ readonly pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `
        const secondBackendPid = pidRows[0]?.pid
        if (secondBackendPid === undefined) {
          throw new Error('无法取得 Attempt 第二事务 backend PID。')
        }
        signalSecondPid?.(secondBackendPid)
        return repository.startAgentAttemptAudit(
          secondTransaction,
          owner,
          createM27AttemptInput(sessionId, agentRunId, 1),
        )
      })
      await waitForTransactionBlock(
        firstTransaction,
        firstBackendPid,
        await secondPid,
        true,
      )
    })
    await expect(secondAttempt).resolves.toMatchObject({ attemptNumber: 1 })

    await inRollbackTransaction(sql, async (firstTransaction) => {
      const firstPidRows = await firstTransaction<{ readonly pid: number }[]>`
        SELECT pg_backend_pid() AS pid
      `
      const firstBackendPid = firstPidRows[0]?.pid
      if (firstBackendPid === undefined) {
        throw new Error('无法取得 Invocation 第一事务 backend PID。')
      }
      const firstInvocation = await repository.appendCapabilityInvocationAudit(
        firstTransaction,
        owner,
        createM27InvocationInput(sessionId, agentRunId, 0),
      )
      expect(firstInvocation.invocationNumber).toBe(0)

      let signalSecondPid: ((pid: number) => void) | undefined
      const secondPid = new Promise<number>((resolve) => {
        signalSecondPid = resolve
      })
      secondInvocation = secondSql.begin(async (secondTransaction) => {
        const pidRows = await secondTransaction<{ readonly pid: number }[]>`
          SELECT pg_backend_pid() AS pid
        `
        const secondBackendPid = pidRows[0]?.pid
        if (secondBackendPid === undefined) {
          throw new Error('无法取得 Invocation 第二事务 backend PID。')
        }
        signalSecondPid?.(secondBackendPid)
        return repository.appendCapabilityInvocationAudit(
          secondTransaction,
          owner,
          createM27InvocationInput(sessionId, agentRunId, 1),
        )
      })
      await waitForTransactionBlock(
        firstTransaction,
        firstBackendPid,
        await secondPid,
        true,
      )
    })
    await expect(secondInvocation).resolves.toMatchObject({
      invocationNumber: 0,
    })

    const audit = await sql.begin((transaction) =>
      repository.readAgentRunAudit(transaction, owner, sessionId, agentRunId),
    )
    expect(audit.attempts.map(({ attemptNumber }) => attemptNumber)).toEqual([
      0, 1,
    ])
    expect(
      audit.invocations.map(({ invocationNumber }) => invocationNumber),
    ).toEqual([0])
  } finally {
    await secondAttempt?.catch(() => undefined)
    await secondInvocation?.catch(() => undefined)
    await secondSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM27AgentSecretBoundaries(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()
  const sentinel = `M27_AGENT_SECRET_${randomUUID()}`

  try {
    const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId)
    const repository = createAgentFoundationAuditRepository({
      runtimeAuditDecoders: {},
    })
    const input = createM27CoachRunInput(sessionId, handId, agentRunId)
    await expect(
      sql.begin((transaction) =>
        repository.insertAgentRunAudit(transaction, owner, {
          ...input,
          runConfiguration: {
            ...input.runConfiguration,
            reasoning_content: sentinel,
          } as never,
        }),
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)

    const rejectedRows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.agent_runs
      WHERE id = ${agentRunId}::uuid
    `
    expect(rejectedRows[0]?.count).toBe(0)

    await sql.begin((transaction) =>
      repository.insertAgentRunAudit(transaction, owner, input),
    )
    await sql.begin(async (transaction) => {
      await repository.startAgentAttemptAudit(
        transaction,
        owner,
        createM27AttemptInput(sessionId, agentRunId, 0),
      )
      await repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        createM27InvocationInput(sessionId, agentRunId, 0),
      )
    })

    const persistedRows = await sql<{ readonly persisted: string }[]>`
      SELECT concat_ws(
        ' ',
        to_jsonb(run)::text,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(attempt))::text
          FROM app_private.agent_attempts AS attempt
          WHERE attempt.agent_run_id = run.id
        ), ''),
        COALESCE((
          SELECT jsonb_agg(to_jsonb(invocation))::text
          FROM app_private.agent_capability_invocations AS invocation
          WHERE invocation.agent_run_id = run.id
        ), '')
      ) AS persisted
      FROM app_private.agent_runs AS run
      WHERE run.id = ${agentRunId}::uuid
        AND run.owner_id = ${owner.databaseOwnerId}::uuid
    `
    expect(persistedRows).toHaveLength(1)
    expect(persistedRows[0]?.persisted).not.toContain(sentinel)
    expect(persistedRows[0]?.persisted).not.toContain('reasoning_content')
    expect(persistedRows[0]?.persisted).not.toContain('api_key')
    expect(persistedRows[0]?.persisted).not.toContain('database_url')
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

export async function assertM27HandAgentAuditRepositories(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertM27HandPublicRoundTrips(sql)
  await assertM27HandOwnerAndAssociationBoundaries(sql)
  await assertM27HandRollbackAndVisibility(sql, runtimeUrl)
  await assertM27HandRestartReadback(sql, runtimeUrl)
  await assertM27HandSecretBoundaries(sql)
  await assertM27HandAbortRoundTripAndRollback(sql)
  await assertM27AgentPublicAggregateRoundTrip(sql)
  await assertM27AgentRestartReadback(sql, runtimeUrl)
  await assertM27AgentUnknownAndCorruptRows(sql)
  await assertM27AgentSequenceConcurrency(sql, runtimeUrl)
  await assertM27AgentSecretBoundaries(sql)
}
