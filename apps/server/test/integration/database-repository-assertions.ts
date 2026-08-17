import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import type { JSONValue, Sql, TransactionSql } from 'postgres'
import { PublicSessionSnapshotSchema } from '@tx-holdem-coach/contracts'
import {
  createHandStartedEventDraft,
  createUncalledBetReturnedEventDraft,
} from '../../src/poker/hand-result.js'
import { getLegalActions } from '../../src/poker/betting.js'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { createPokerTableState } from '../../src/poker/state.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { PERSONA_CATALOG_DEFINITIONS } from '../../src/personas/catalog-definitions.js'
import { createActiveModelConfigurationSchema } from '../../src/personas/config.js'
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
  SessionDeletionTransitionError,
  UnknownPayloadVersionError,
} from '../../src/persistence/errors.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createAgentFoundationAuditRepository as createRawAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import {
  abortHandAudit,
  completeHandAudit,
  insertInProgressHandAudit,
  readHandAudit,
} from '../../src/persistence/hand-audit-repository.js'
import {
  productionSessionRecoveryRepository,
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
  productionSessionMutationRepository,
  type SessionMutationBatch,
} from '../../src/persistence/session-mutation-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  clearOwnerSessionData,
  deleteEndedSessionData,
} from '../../src/persistence/session-deletion-repository.js'
import {
  readPlayerTimeoutSettings,
  writePlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import {
  getSessionById,
  listHistoricalSessions,
  readSessionAgentSnapshots,
} from '../../src/persistence/session-repository.js'
import { assertRosterSnapshotsUseActiveModels } from '../../src/sessions/roster-preparation.js'
import {
  insertSessionRosterSnapshot,
  prepareCurrentCatalogRosterSnapshot,
  prepareLatestEndedRosterSnapshotForReuse,
} from '../helpers/session-roster-fixture.js'
import { insertAgentRunFixture } from '../helpers/agent-run-fixture.js'
import {
  currentPrivateEventReader,
  encodeCurrentPrivateEvent,
} from '../../src/sessions/authoritative-state/private-event-codec.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../../src/sessions/authoritative-state/private-table-state.js'
import {
  currentSnapshotReader,
  encodeSnapshot,
} from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createSessionCommandHandlerMap } from '../../src/sessions/command-execution/command-handler-map.js'
import { createSessionCommandExecutor } from '../../src/sessions/command-execution/session-command-executor.js'
import type { PreparedMutationCapability } from '../../src/sessions/command-execution/command-handler.js'
import type { SnapshotProjectionInput } from '../../src/sessions/command-execution/snapshot-projector.js'
import {
  createTestBettingPokerState,
  createTestPokerState,
} from '../poker/create-test-poker-state.js'
import { createDatabaseFixtureContext } from './database-fixture-context.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
  runDatabaseTestWithCleanup,
  serializeJsonbFixture,
} from './database-test-runtime.js'

const ownerScope = { ownerId: 'local-user' } as const

async function ensureLegacyAuditAuthority(
  transaction: TransactionSql,
  agentRunId: string,
) {
  const leaseOwner = 'database-test:legacy-audit:0'
  const existingRows = await transaction<
    {
      readonly runtimeType: 'player' | 'coach'
      readonly lifecycle: string
      readonly leaseOwner: string | null
      readonly fencingToken: number
      readonly leaseActive: boolean
    }[]
  >`
    SELECT runtime AS "runtimeType", lifecycle, lease_owner AS "leaseOwner",
           fencing_token::float8 AS "fencingToken",
           lease_expires_at > clock_timestamp() AS "leaseActive"
    FROM app_private.agent_runs
    WHERE id = ${agentRunId}::uuid
  `
  const existing = existingRows[0]
  if (existingRows.length === 0) throw new ResourceNotFoundError()
  if (
    existingRows.length === 1 &&
    existing !== undefined &&
    existing.lifecycle === 'running' &&
    existing.leaseOwner === leaseOwner &&
    existing.leaseActive &&
    Number.isSafeInteger(existing.fencingToken) &&
    existing.fencingToken > 0
  ) {
    return issueRuntimeCommitAuthority({
      runtimeType: existing.runtimeType,
      runId: agentRunId,
      leaseOwner,
      fencingToken: existing.fencingToken,
    })
  }
  const rows = await transaction<
    {
      readonly runtimeType: 'player' | 'coach'
      readonly fencingToken: number
    }[]
  >`
    UPDATE app_private.agent_runs
    SET lifecycle = 'running',
        lease_owner = ${leaseOwner},
        lease_expires_at = clock_timestamp() + interval '1 hour',
        fencing_token = GREATEST(fencing_token, 1),
        started_at = COALESCE(started_at, clock_timestamp()),
        updated_at = clock_timestamp()
    WHERE id = ${agentRunId}::uuid
      AND lifecycle IN ('queued', 'leased', 'running')
    RETURNING runtime AS "runtimeType", fencing_token::float8 AS "fencingToken"
  `
  const row = rows[0]
  if (rows.length === 0) throw new ResourceNotFoundError()
  if (rows.length !== 1 || row === undefined) {
    throw new Error('旧审计测试 fixture 无法签发 fencing authority。')
  }
  return issueRuntimeCommitAuthority({
    runtimeType: row.runtimeType,
    runId: agentRunId,
    leaseOwner,
    fencingToken: row.fencingToken,
  })
}

function createAgentFoundationAuditRepository(
  options: Parameters<typeof createRawAgentFoundationAuditRepository>[0],
) {
  const repository = createRawAgentFoundationAuditRepository(options)
  return {
    ...repository,
    async startAgentAttemptAudit(
      transaction: TransactionSql,
      owner: Parameters<typeof repository.startAgentAttemptAudit>[1],
      input: Parameters<typeof repository.startAgentAttemptAudit>[3],
    ) {
      const authority = await ensureLegacyAuditAuthority(
        transaction,
        input.agentRunId,
      )
      return repository.startAgentAttemptAudit(
        transaction,
        owner,
        authority,
        input,
      )
    },
    async finishAgentAttemptAudit(
      transaction: TransactionSql,
      owner: Parameters<typeof repository.finishAgentAttemptAudit>[1],
      input: Parameters<typeof repository.finishAgentAttemptAudit>[3],
    ) {
      const authority = await ensureLegacyAuditAuthority(
        transaction,
        input.agentRunId,
      )
      return repository.finishAgentAttemptAudit(
        transaction,
        owner,
        authority,
        input,
      )
    },
    async appendCapabilityInvocationAudit(
      transaction: TransactionSql,
      owner: Parameters<typeof repository.appendCapabilityInvocationAudit>[1],
      input: Parameters<typeof repository.appendCapabilityInvocationAudit>[3],
    ) {
      const authority = await ensureLegacyAuditAuthority(
        transaction,
        input.agentRunId,
      )
      return repository.appendCapabilityInvocationAudit(
        transaction,
        owner,
        authority,
        input,
      )
    },
  }
}

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
  return prepareCurrentCatalogRosterSnapshot(query, ownerScope, catalog, {
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
        createActiveModelConfigurationSchema(new Set()),
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
      SET setting_payload = ${serializeJsonbFixture({
        attemptTimeoutSeconds: 30,
        decisionDeadlineSeconds: 15,
      })}::text::jsonb
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
            ended_at = ${updatedAt}::text::timestamptz,
            updated_at = ${updatedAt}::text::timestamptz
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
              snapshot: createCommandSnapshot(input.sessionId),
            }
          : {
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
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm24-replay')
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
      const firstBackendPid = await readTransactionBackendPid(transaction)
      const firstPrepared = prepareCommandRegistration(input)
      const first = await registerCommand(transaction, owner, firstPrepared)
      expect(first.status).toBe('acquired')
      if (first.status !== 'acquired') {
        throw new Error('测试未取得命令处理权。')
      }
      const response = {
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
        const secondBackendPid =
          await readTransactionBackendPid(secondTransaction)
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
        firstBackendPid,
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
  readonly userStack?: number
}

function createMutationPublicSnapshot(
  sessionId: string,
  stateVersion: number,
  eventSeq: number,
  lifecycleStatus: MutationLifecycleStatus,
  userStack = 2_000,
) {
  return {
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
      stack: seatNumber === 0 ? userStack : 2_000,
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
  const poker = createTestPokerState({
    seats: createTestPokerState().seats.map((seat) =>
      seat.seatNumber === 0
        ? { ...seat, stack: input.userStack ?? seat.stack }
        : seat,
    ),
  })
  const privateState = createPrivateTableState({
    stateVersion: finalStateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn:
        seat.seatNumber === 0 ? (input.userStack ?? 2_000) : 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  const privateEvent = encodeCurrentPrivateEvent(
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
        stack: seatNumber === 0 ? (input.userStack ?? 2_000) : 2_000,
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
    snapshot: writeSnapshot ? encodeSnapshot(privateState) : null,
    events: input.eventIds.map((eventId, index) => {
      const eventSeq = input.nextEventSeq + index
      const publicSnapshot = createMutationPublicSnapshot(
        input.sessionId,
        finalStateVersion,
        eventSeq,
        lifecycleStatus,
        input.userStack,
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
  const observerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm25-visibility')

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
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm25-concurrent')
  let secondMutation: Promise<unknown> | undefined

  try {
    await insertCommittedActiveSession(sql, sessionId, handId)
    await secondSql`SELECT 1`
    await sql.begin(async (transaction) => {
      const firstBackendPid = await readTransactionBackendPid(transaction)
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
        const secondBackendPid =
          await readTransactionBackendPid(secondTransaction)
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
  snapshot: currentSnapshotReader,
  privateEvent: currentPrivateEventReader,
}

async function insertRecoverableSession(
  sql: Sql,
  sessionId: string,
  handId: string,
  eventId: string,
  fixtureOptions: { readonly userStack?: number } = {},
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
        ...(fixtureOptions.userStack === undefined
          ? {}
          : { userStack: fixtureOptions.userStack }),
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
  const observerSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm26-repair-observer',
  )
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
          private_table_state_payload = ${serializeJsonbFixture(currentSnapshot.payload)}::text::jsonb
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
        SET private_event_payload_version = 99
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
        SET private_event_payload = '{"event":{}}'::jsonb
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
          '{"state":{}}'::jsonb
        WHERE session_id = ${sessionId}::uuid
      `
    },
    'snapshotPayloadInvalid',
  )
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
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm26-concurrent')
  let secondRecovery:
    Promise<Awaited<ReturnType<typeof recoverSessionForMutation>>> | undefined
  try {
    await insertRecoverableSession(sql, sessionId, handId, fixture.id(26_402))

    await sql.begin(async (transaction) => {
      const firstBackendPid = await readTransactionBackendPid(transaction)
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
        const secondBackendPid =
          await readTransactionBackendPid(secondTransaction)
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
      pokerRuleSetVersion: POKER_RULE_SET_VERSION,
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
  const observerSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm27-hand-observer',
  )

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
  let writerSql: Sql | undefined = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm27-hand-writer',
  )
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

    readerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm27-hand-reader')
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
      await insertAgentRunFixture(
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
        await insertAgentRunFixture(
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
    budgetSchemaVersion: 1 as const,
    maxAttempts: 4,
    maxInputTokens: 20_000,
    maxOutputTokens: 1_000,
    maxWallClockMs: 45_000,
    maxCapabilityInvocations: 4,
    maxCostMicrounits: 2_000,
    maxOwnerConcurrentRuns: 2,
    maxSystemConcurrentRuns: 4,
    minimumAttemptStartRemainingMs: 5_000,
    attemptTimeoutMs: 15_000,
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

export function createM27PlayerRunInput(
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
  const poker = createTestBettingPokerState({
    hand: {
      handId: input.handId,
      currentActorSeatNumber: input.actorSeatNumber,
    },
  })
  const privateState = createPrivateTableState({
    stateVersion: base.finalStateVersion,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      cumulativeBuyIn: 2_000,
    })),
    lastCompletedHandSummary: null,
  })
  return {
    ...base,
    currentHandId: input.handId,
    agentRunState: 'thinking',
    activePlayerRunId: input.agentRunId,
    activeDecisionRequestId: input.decisionRequestId,
    snapshot: encodeSnapshot(privateState),
    events: base.events.map((event) => ({
      ...event,
      publicEvent: {
        ...event.publicEvent,
        payload: {
          snapshot: {
            ...event.publicEvent.payload.snapshot,
            pokerPhase: 'inHand',
            agentRunState: 'thinking',
            activeDecision: {
              decisionRequestId: input.decisionRequestId,
              actorSeatNumber: input.actorSeatNumber,
            },
            hand: {
              handId: input.handId,
              street: poker.hand!.street,
              board: [...poker.hand!.board],
              pot: poker.hand!.pot,
              currentActorSeatNumber: input.actorSeatNumber,
              heroHoleCards:
                poker
                  .hand!.holeCards.find(
                    (holeCards) => holeCards.seatNumber === 0,
                  )
                  ?.cards.map((card) => ({ ...card })) ?? null,
              legalActions: [],
              actionTimeline: [],
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

export async function insertCommittedM27CompletedHand(
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
    insertAgentRunFixture(
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
      lifecycle: 'running',
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
  let writerSql: Sql | undefined = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm27-agent-writer',
  )
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

    readerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm27-agent-reader')
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
      lifecycle: 'running',
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
      SET run_config_payload = ${serializeJsonbFixture(original.runConfigurationPayload)}::text::jsonb,
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
      SET budget_payload = ${serializeJsonbFixture(original.budgetPayload)}::text::jsonb,
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
      SET lifecycle = 'failed',
          lease_owner = NULL,
          lease_expires_at = NULL,
          completed_at = clock_timestamp(),
          termination_reason = 'test_failed',
          result_payload_version = 778,
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
  const secondSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm27-agent-concurrent',
  )
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
    await sql.begin((transaction) =>
      ensureLegacyAuditAuthority(transaction, agentRunId),
    )
    await secondSql`SELECT 1`

    await sql.begin(async (firstTransaction) => {
      const firstBackendPid = await readTransactionBackendPid(firstTransaction)
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
        const secondBackendPid =
          await readTransactionBackendPid(secondTransaction)
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
      const firstBackendPid = await readTransactionBackendPid(firstTransaction)
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
        const secondBackendPid =
          await readTransactionBackendPid(secondTransaction)
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

async function assertNoOpenDatabaseTestTransactions(sql: Sql): Promise<void> {
  const runId = process.env.DATABASE_TEST_RUN_ID
  if (runId === undefined) {
    throw new Error('数据库测试缺少 Run ID。')
  }
  const rows = await sql<
    {
      readonly applicationName: string
      readonly state: string | null
      readonly waitEventType: string | null
      readonly waitEvent: string | null
    }[]
  >`
    SELECT application_name AS "applicationName", state,
           wait_event_type AS "waitEventType", wait_event AS "waitEvent"
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND application_name LIKE ${`txhc-dbtest:${runId}:%`}
      AND pid <> pg_backend_pid()
      AND xact_start IS NOT NULL
    ORDER BY application_name, pid
  `
  if (rows.length > 0) {
    throw new Error(
      `数据库里程碑遗留事务：${rows
        .map(
          (row) =>
            `${row.applicationName}(${row.state ?? 'unknown'},${row.waitEventType ?? 'none'}/${row.waitEvent ?? 'none'})`,
        )
        .join('；')}`,
    )
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
  await assertNoOpenDatabaseTestTransactions(sql)
}

const M28_DELETED_AT = '2026-08-05T04:00:00.000Z'
const M28_SESSION_SCOPED_TABLES = Object.freeze([
  'session_participants',
  'session_agents',
  'agent_memory_revisions',
  'hands',
  'command_ledger',
  'session_events',
  'session_snapshots',
  'agent_runs',
  'agent_attempts',
  'agent_capability_invocations',
  'player_decisions',
] as const)

async function insertM28RosterSession(sql: Sql, sessionId: string) {
  return sql.begin(async (transaction) => {
    const roster = await createRosterInput(transaction as unknown as Sql)
    const input = { ...roster, sessionId }
    await insertSessionRosterSnapshot(transaction, input)
    return input
  })
}

async function insertM28DiagnosticSessionForOwner(
  sql: Sql,
  databaseOwnerId: string,
  sessionId: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO app_private.sessions (id, owner_id)
      VALUES (${sessionId}::uuid, ${databaseOwnerId}::uuid)
    `
    await transaction`
      INSERT INTO app_private.session_participants (
        id, session_id, owner_id, participant_type, seat_number
      ) VALUES (
        ${randomUUID()}::uuid, ${sessionId}::uuid,
        ${databaseOwnerId}::uuid, 'user', 0
      )
    `
    for (let seatNumber = 1; seatNumber <= 5; seatNumber += 1) {
      const participantId = randomUUID()
      await transaction`
        INSERT INTO app_private.session_participants (
          id, session_id, owner_id, participant_type, seat_number
        ) VALUES (
          ${participantId}::uuid, ${sessionId}::uuid,
          ${databaseOwnerId}::uuid, 'agent', ${seatNumber}
        )
      `
      await transaction`
        INSERT INTO app_private.session_agents (
          participant_id, session_id, owner_id, display_name, avatar_color,
          persona_id, persona_version, config_snapshot_key,
          config_payload_version, config_payload,
          memory_payload_version, memory_payload
        ) VALUES (
          ${participantId}::uuid, ${sessionId}::uuid,
          ${databaseOwnerId}::uuid, ${`Other Agent ${seatNumber}`}, '#0f766e',
          ${`other-agent-${seatNumber}`}, 1, ${'a'.repeat(64)},
          1, '{}'::jsonb, 1, '{}'::jsonb
        )
      `
      await transaction`
        INSERT INTO app_private.agent_memory_revisions (
          participant_id, session_id, owner_id, revision,
          memory_payload_version, memory_payload
        ) VALUES (
          ${participantId}::uuid, ${sessionId}::uuid,
          ${databaseOwnerId}::uuid, 0, 1, '{}'::jsonb
        )
      `
    }
    await transaction`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          diagnostic_code = 'snapshotMissing',
          diagnosed_at = ${M28_DELETED_AT}::timestamptz,
          updated_at = ${M28_DELETED_AT}::timestamptz
      WHERE id = ${sessionId}::uuid
        AND owner_id = ${databaseOwnerId}::uuid
    `
  })
}

async function endM28Session(
  sql: Sql,
  ownerId: string,
  sessionId: string,
): Promise<void> {
  await sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'ended',
        ended_at = ${M28_DELETED_AT}::timestamptz,
        updated_at = ${M28_DELETED_AT}::timestamptz
    WHERE id = ${sessionId}::uuid
      AND owner_id = ${ownerId}::uuid
  `
}

interface M28CascadeFixture {
  readonly sessionId: string
  readonly handId: string
  readonly playerRunId: string
  readonly coachRunId: string
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
}

async function insertM28CascadeFixture(
  sql: Sql,
  sessionId: string,
): Promise<M28CascadeFixture> {
  const roster = await insertM28RosterSession(sql, sessionId)
  const handId = randomUUID()
  const handFixture = createM27HandAuditFixture(handId)
  await sql.begin(async (transaction) => {
    await insertInProgressHandAudit(transaction, roster.owner, {
      sessionId,
      checkpoint: handFixture.checkpoint,
      startedAt: '2026-08-05T03:50:00.000Z',
    })
    await completeHandAudit(transaction, roster.owner, {
      sessionId,
      handId,
      result: handFixture.completed,
      completedAt: '2026-08-05T03:51:00.000Z',
    })
  })

  await sql.begin(async (transaction) => {
    const locked = await lockSessionForMutation(
      transaction,
      roster.owner,
      sessionId,
    )
    await persistSessionMutation(
      transaction,
      locked,
      createMutationBatch({
        sessionId,
        handId,
        eventIds: [randomUUID()],
        lockedStateVersion: 0,
        nextEventSeq: 0,
        mutationAt: '2026-08-05T03:52:00.000Z',
      }),
    )
  })

  const command = prepareCommandRegistration({
    sessionId,
    commandId: randomUUID(),
    expectedStateVersion: 1,
    type: 'endSession',
    payload: {},
  })
  await sql.begin(async (transaction) => {
    const registration = await registerCommand(
      transaction,
      roster.owner,
      command,
    )
    expect(registration.status).toBe('acquired')
  })

  const firstAgent = roster.agents[0]
  if (firstAgent === undefined) {
    throw new Error('M2.8 Cascade fixture 缺少 Agent。')
  }
  const playerRunId = randomUUID()
  const coachRunId = randomUUID()
  const decisionRequestId = randomUUID()
  const auditRepository = createAgentFoundationAuditRepository({
    runtimeAuditDecoders: {},
  })
  await sql.begin(async (transaction) => {
    await insertAgentRunFixture(
      transaction,
      roster.owner,
      createM27PlayerRunInput(
        sessionId,
        handId,
        playerRunId,
        firstAgent.agentParticipantId,
        decisionRequestId,
      ),
    )
    await insertAgentRunFixture(
      transaction,
      roster.owner,
      createM27CoachRunInput(sessionId, handId, coachRunId),
    )
    await transaction`
      UPDATE app_private.agent_runs
      SET lifecycle = 'running',
          lease_owner = CASE
            WHEN id = ${coachRunId}::uuid THEN 'database-test:legacy-audit:0'
            ELSE 'm28-worker'
          END,
          lease_expires_at = clock_timestamp() + interval '1 hour',
          fencing_token = CASE
            WHEN id = ${coachRunId}::uuid THEN 17
            ELSE 9007199254740991
          END,
          started_at = COALESCE(started_at, '2026-08-05T03:59:00.000Z'::timestamptz)
      WHERE id IN (${playerRunId}::uuid, ${coachRunId}::uuid)
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
        AND session_id = ${sessionId}::uuid
    `
    await transaction`
      UPDATE app_private.sessions
      SET agent_run_state = 'thinking',
          active_player_run_id = ${playerRunId}::uuid,
          active_decision_request_id = ${decisionRequestId}::uuid
      WHERE id = ${sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
  })

  await sql.begin(async (transaction) => {
    await auditRepository.startAgentAttemptAudit(
      transaction,
      roster.owner,
      createM27AttemptInput(sessionId, coachRunId, 0),
    )
    await auditRepository.appendCapabilityInvocationAudit(
      transaction,
      roster.owner,
      createM27InvocationInput(sessionId, coachRunId, 0),
    )
  })

  await sql.begin(async (transaction) => {
    await transaction`
      INSERT INTO app_private.player_decisions (
        id, agent_run_id, owner_id, session_id, hand_id, participant_id,
        source_state_version, decision_request_id, memory_revision,
        runtime, submission_status, command_ledger_id,
        decision_packet_payload_version, decision_packet_payload,
        candidate_set_payload_version, candidate_set_payload,
        validator_result_payload_version, validator_result_payload
      ) VALUES (
        ${randomUUID()}::uuid, ${playerRunId}::uuid,
        ${roster.owner.databaseOwnerId}::uuid, ${sessionId}::uuid,
        ${handId}::uuid, ${firstAgent.agentParticipantId}::uuid,
        1, ${decisionRequestId}::uuid, 0,
        'player', 'pending', ${command.ledgerId}::uuid,
        1, '{}'::jsonb, 1, '{}'::jsonb, 1, '{}'::jsonb
      )
    `
  })

  await sql`
    UPDATE app_private.session_snapshots
    SET private_table_state_payload_version = 999,
        private_table_state_payload = '{"corrupt":"m28-delete-must-not-decode"}'::jsonb
    WHERE session_id = ${sessionId}::uuid
      AND owner_id = ${roster.owner.databaseOwnerId}::uuid
  `
  await endM28Session(sql, roster.owner.databaseOwnerId, sessionId)
  return {
    sessionId,
    handId,
    playerRunId,
    coachRunId,
    owner: roster.owner,
  }
}

async function readM28SessionScopedCounts(
  sql: Sql,
  sessionId: string,
): Promise<Record<(typeof M28_SESSION_SCOPED_TABLES)[number], number>> {
  const rows = await sql<Record<string, number>[]>`
    SELECT
      (SELECT count(*)::int FROM app_private.session_participants WHERE session_id = ${sessionId}::uuid) AS "session_participants",
      (SELECT count(*)::int FROM app_private.session_agents WHERE session_id = ${sessionId}::uuid) AS "session_agents",
      (SELECT count(*)::int FROM app_private.agent_memory_revisions WHERE session_id = ${sessionId}::uuid) AS "agent_memory_revisions",
      (SELECT count(*)::int FROM app_private.hands WHERE session_id = ${sessionId}::uuid) AS hands,
      (SELECT count(*)::int FROM app_private.command_ledger WHERE session_id = ${sessionId}::uuid) AS "command_ledger",
      (SELECT count(*)::int FROM app_private.session_events WHERE session_id = ${sessionId}::uuid) AS "session_events",
      (SELECT count(*)::int FROM app_private.session_snapshots WHERE session_id = ${sessionId}::uuid) AS "session_snapshots",
      (SELECT count(*)::int FROM app_private.agent_runs WHERE session_id = ${sessionId}::uuid) AS "agent_runs",
      (SELECT count(*)::int FROM app_private.agent_attempts WHERE session_id = ${sessionId}::uuid) AS "agent_attempts",
      (SELECT count(*)::int FROM app_private.agent_capability_invocations WHERE session_id = ${sessionId}::uuid) AS "agent_capability_invocations",
      (SELECT count(*)::int FROM app_private.player_decisions WHERE session_id = ${sessionId}::uuid) AS "player_decisions"
  `
  const counts = rows[0]
  if (counts === undefined) {
    throw new Error('M2.8 无法读取 Session-scoped 表计数。')
  }
  return counts as Record<(typeof M28_SESSION_SCOPED_TABLES)[number], number>
}

export async function assertM28EndedDeletionAndCascade(
  sql: Sql,
): Promise<void> {
  const sessionId = randomUUID()
  const sameOwnerSessionId = randomUUID()
  const otherOwnerId = randomUUID()
  const otherOwnerSessionId = randomUUID()
  const otherOwnerIdentityKey = `m28-other-${otherOwnerId}`

  try {
    const fixture = await insertM28CascadeFixture(sql, sessionId)
    await insertCommittedDiagnosticSession(sql, sameOwnerSessionId)
    await sql`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${otherOwnerId}::uuid, ${otherOwnerIdentityKey})
    `
    await insertM28DiagnosticSessionForOwner(
      sql,
      otherOwnerId,
      otherOwnerSessionId,
    )

    const beforeCounts = await readM28SessionScopedCounts(sql, sessionId)
    for (const table of M28_SESSION_SCOPED_TABLES) {
      expect(
        beforeCounts[table],
        `${table} fixture must exist`,
      ).toBeGreaterThan(0)
    }

    const result = await sql.begin((transaction) =>
      deleteEndedSessionData(transaction, fixture.owner, {
        sessionId,
        deletedAt: M28_DELETED_AT,
      }),
    )
    expect(result).toEqual({
      sessionId,
      invalidatedRuns: [
        { agentRunId: fixture.coachRunId, runtime: 'coach' },
        { agentRunId: fixture.playerRunId, runtime: 'player' },
      ].sort((left, right) => left.agentRunId.localeCompare(right.agentRunId)),
    })

    const afterCounts = await readM28SessionScopedCounts(sql, sessionId)
    expect(afterCounts).toEqual(
      Object.fromEntries(M28_SESSION_SCOPED_TABLES.map((table) => [table, 0])),
    )
    const preservedRows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE id IN (${sameOwnerSessionId}::uuid, ${otherOwnerSessionId}::uuid)
    `
    expect(preservedRows[0]?.count).toBe(2)
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (
        ${sessionId}::uuid,
        ${sameOwnerSessionId}::uuid,
        ${otherOwnerSessionId}::uuid
      )
    `
    await sql`
      DELETE FROM app_private.owners
      WHERE id = ${otherOwnerId}::uuid
    `
  }
}

export async function assertM28SingleDeletionLifecycleBoundary(
  sql: Sql,
): Promise<void> {
  const sessionId = randomUUID()
  try {
    const roster = await insertM28RosterSession(sql, sessionId)
    await expect(
      sql.begin((transaction) =>
        deleteEndedSessionData(transaction, roster.owner, {
          sessionId,
          deletedAt: M28_DELETED_AT,
        }),
      ),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)

    await sql`
      UPDATE app_private.sessions
      SET lifecycle_status = 'readonlyDiagnostic',
          diagnostic_code = 'snapshotMissing',
          diagnosed_at = ${M28_DELETED_AT}::timestamptz,
          updated_at = ${M28_DELETED_AT}::timestamptz
      WHERE id = ${sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
    await expect(
      sql.begin((transaction) =>
        deleteEndedSessionData(transaction, roster.owner, {
          sessionId,
          deletedAt: M28_DELETED_AT,
        }),
      ),
    ).rejects.toBeInstanceOf(SessionDeletionTransitionError)

    const rows = await sql<
      { readonly lifecycleStatus: string; readonly participantCount: number }[]
    >`
      SELECT
        session.lifecycle_status AS "lifecycleStatus",
        (
          SELECT count(*)::int
          FROM app_private.session_participants AS participant
          WHERE participant.session_id = session.id
        ) AS "participantCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      lifecycleStatus: 'readonlyDiagnostic',
      participantCount: 6,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

export async function assertM28ClearAndPreservedRoots(sql: Sql): Promise<void> {
  const endedSessionId = randomUUID()
  const activeSessionId = randomUUID()
  const diagnosticSessionId = randomUUID()
  const otherOwnerId = randomUUID()
  const otherOwnerSessionId = randomUUID()
  const otherOwnerIdentityKey = `m28-clear-other-${otherOwnerId}`
  const owner = await resolveOwnerScope(sql, ownerScope)
  const settings = {
    attemptTimeoutSeconds: 21,
    decisionDeadlineSeconds: 73,
  } as const
  const originalSettingRows = await sql<
    {
      readonly id: string
      readonly settingPayload: JSONValue
      readonly updatedAt: string
    }[]
  >`
    SELECT
      id::text AS id,
      setting_payload AS "settingPayload",
      updated_at::text AS "updatedAt"
    FROM app_private.app_settings
    WHERE owner_id = ${owner.databaseOwnerId}::uuid
      AND setting_key = 'player-timeouts'
  `

  try {
    await sql`
      DELETE FROM app_private.app_settings
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND setting_key = 'player-timeouts'
    `
    await insertM28RosterSession(sql, endedSessionId)
    await endM28Session(sql, owner.databaseOwnerId, endedSessionId)
    await insertCommittedDiagnosticSession(sql, diagnosticSessionId)
    await insertM28RosterSession(sql, activeSessionId)
    await sql`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${otherOwnerId}::uuid, ${otherOwnerIdentityKey})
    `
    await insertM28DiagnosticSessionForOwner(
      sql,
      otherOwnerId,
      otherOwnerSessionId,
    )
    await writePlayerTimeoutSettings(sql, ownerScope, settings)
    const beforeSettings = await readPlayerTimeoutSettings(sql, ownerScope)

    await expect(
      sql.begin((transaction) =>
        clearOwnerSessionData(transaction, owner, {
          deletedAt: M28_DELETED_AT,
        }),
      ),
    ).resolves.toEqual({ deletedSessionCount: 3, invalidatedRuns: [] })

    const afterSettings = await readPlayerTimeoutSettings(sql, ownerScope)
    expect(afterSettings).toEqual(beforeSettings)
    const preservedRows = await sql<
      {
        readonly ownerCount: number
        readonly settingCount: number
        readonly sessionCount: number
        readonly schemaExists: boolean
        readonly migrationCount: number
        readonly otherOwnerCount: number
        readonly otherOwnerSessionCount: number
        readonly otherOwnerParticipantCount: number
        readonly otherOwnerAgentCount: number
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.owners WHERE id = ${owner.databaseOwnerId}::uuid) AS "ownerCount",
        (SELECT count(*)::int FROM app_private.app_settings WHERE owner_id = ${owner.databaseOwnerId}::uuid AND setting_key = 'player-timeouts') AS "settingCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE owner_id = ${owner.databaseOwnerId}::uuid) AS "sessionCount",
        to_regnamespace('app_private') IS NOT NULL AS "schemaExists",
        (SELECT count(*)::int FROM app_private.__drizzle_migrations) AS "migrationCount",
        (SELECT count(*)::int FROM app_private.owners WHERE id = ${otherOwnerId}::uuid) AS "otherOwnerCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${otherOwnerSessionId}::uuid AND owner_id = ${otherOwnerId}::uuid) AS "otherOwnerSessionCount",
        (SELECT count(*)::int FROM app_private.session_participants WHERE session_id = ${otherOwnerSessionId}::uuid AND owner_id = ${otherOwnerId}::uuid) AS "otherOwnerParticipantCount",
        (SELECT count(*)::int FROM app_private.session_agents WHERE session_id = ${otherOwnerSessionId}::uuid AND owner_id = ${otherOwnerId}::uuid) AS "otherOwnerAgentCount"
    `
    expect(preservedRows[0]).toMatchObject({
      ownerCount: 1,
      settingCount: 1,
      sessionCount: 0,
      schemaExists: true,
      otherOwnerCount: 1,
      otherOwnerSessionCount: 1,
      otherOwnerParticipantCount: 6,
      otherOwnerAgentCount: 5,
    })
    expect(preservedRows[0]?.migrationCount).toBeGreaterThan(0)
    expect(loadAndValidatePersonaCatalog().list().length).toBeGreaterThan(0)

    await expect(
      sql.begin((transaction) =>
        clearOwnerSessionData(transaction, owner, {
          deletedAt: M28_DELETED_AT,
        }),
      ),
    ).resolves.toEqual({ deletedSessionCount: 0, invalidatedRuns: [] })
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (
        ${endedSessionId}::uuid,
        ${activeSessionId}::uuid,
        ${diagnosticSessionId}::uuid,
        ${otherOwnerSessionId}::uuid
      )
    `
    await sql`
      DELETE FROM app_private.owners
      WHERE id = ${otherOwnerId}::uuid
    `
    await sql`
      DELETE FROM app_private.app_settings
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND setting_key = 'player-timeouts'
    `
    const originalSetting = originalSettingRows[0]
    if (originalSetting !== undefined) {
      await sql`
        INSERT INTO app_private.app_settings (
          id, owner_id, setting_key, setting_payload, updated_at
        ) VALUES (
          ${originalSetting.id}::uuid, ${owner.databaseOwnerId}::uuid,
          'player-timeouts',
          ${serializeJsonbFixture(originalSetting.settingPayload)}::text::jsonb,
          ${originalSetting.updatedAt}::timestamptz
        )
      `
    }
  }
}

export async function assertM28DeletionRollback(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  try {
    const fixture = await insertM28CascadeFixture(sql, sessionId)
    const beforeCounts = await readM28SessionScopedCounts(sql, sessionId)
    await inRollbackTransaction(sql, async (transaction) => {
      const result = await deleteEndedSessionData(transaction, fixture.owner, {
        sessionId,
        deletedAt: M28_DELETED_AT,
      })
      expect(result.invalidatedRuns).toHaveLength(2)
    })

    expect(await readM28SessionScopedCounts(sql, sessionId)).toEqual(
      beforeCounts,
    )
    const restoredRows = await sql<
      {
        readonly lifecycleStatus: string
        readonly agentRunState: string
        readonly activePlayerRunId: string | null
        readonly activeDecisionRequestId: string | null
        readonly runningRunCount: number
        readonly leasedRunCount: number
        readonly maxFencingToken: string
      }[]
    >`
      SELECT
        session.lifecycle_status AS "lifecycleStatus",
        session.agent_run_state AS "agentRunState",
        session.active_player_run_id::text AS "activePlayerRunId",
        session.active_decision_request_id::text AS "activeDecisionRequestId",
        count(*) FILTER (WHERE run.lifecycle = 'running')::int AS "runningRunCount",
        count(*) FILTER (WHERE run.lease_owner IS NOT NULL AND run.lease_expires_at IS NOT NULL)::int AS "leasedRunCount",
        max(run.fencing_token)::text AS "maxFencingToken"
      FROM app_private.sessions AS session
      JOIN app_private.agent_runs AS run ON run.session_id = session.id
      WHERE session.id = ${sessionId}::uuid
      GROUP BY session.id
    `
    expect(restoredRows[0]).toMatchObject({
      lifecycleStatus: 'ended',
      agentRunState: 'thinking',
      activePlayerRunId: fixture.playerRunId,
      runningRunCount: 2,
      leasedRunCount: 2,
      maxFencingToken: String(Number.MAX_SAFE_INTEGER),
    })
    expect(restoredRows[0]?.activeDecisionRequestId).not.toBeNull()
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

interface M28GateFixture {
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly sessionId: string
  readonly agentRunId: string
  readonly runtime: 'player' | 'coach'
}

async function insertM28PlayerGateFixture(sql: Sql): Promise<M28GateFixture> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()
  const decisionRequestId = randomUUID()
  const roster = await insertM28RosterSession(sql, sessionId)
  const agent = roster.agents[0]
  if (agent === undefined) {
    throw new Error('M2.8 Player Gate fixture 缺少 Agent。')
  }
  await sql.begin(async (transaction) => {
    await insertMutationHand(
      transaction as unknown as Sql,
      roster.owner.databaseOwnerId,
      sessionId,
      handId,
    )
    await insertAgentRunFixture(
      transaction,
      roster.owner,
      createM27PlayerRunInput(
        sessionId,
        handId,
        agentRunId,
        agent.agentParticipantId,
        decisionRequestId,
      ),
    )
    await transaction`
      UPDATE app_private.agent_runs
      SET lifecycle = 'running',
          lease_owner = 'm28-player-gate',
          lease_expires_at = clock_timestamp() + interval '1 hour',
          fencing_token = 17,
          started_at = COALESCE(started_at, '2026-08-05T03:59:00.000Z'::timestamptz)
      WHERE id = ${agentRunId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
        AND session_id = ${sessionId}::uuid
    `
    await transaction`
      UPDATE app_private.sessions
      SET agent_run_state = 'thinking',
          active_player_run_id = ${agentRunId}::uuid,
          active_decision_request_id = ${decisionRequestId}::uuid
      WHERE id = ${sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
  })
  return { owner: roster.owner, sessionId, agentRunId, runtime: 'player' }
}

async function insertM28CoachGateFixture(sql: Sql): Promise<M28GateFixture> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const agentRunId = randomUUID()
  const { owner } = await insertCommittedM27CoachRun(
    sql,
    sessionId,
    handId,
    agentRunId,
  )
  await endM28Session(sql, owner.databaseOwnerId, sessionId)
  return { owner, sessionId, agentRunId, runtime: 'coach' }
}

async function runM28MinimalCommitGate(
  transaction: TransactionSql,
  fixture: M28GateFixture,
): Promise<boolean> {
  const sessionRows = await transaction<
    {
      readonly lifecycleStatus: string
      readonly activePlayerRunId: string | null
    }[]
  >`
    SELECT
      lifecycle_status AS "lifecycleStatus",
      active_player_run_id::text AS "activePlayerRunId"
    FROM app_private.sessions
    WHERE id = ${fixture.sessionId}::uuid
      AND owner_id = ${fixture.owner.databaseOwnerId}::uuid
    FOR UPDATE
  `
  const session = sessionRows[0]
  if (
    session === undefined ||
    (fixture.runtime === 'player' &&
      (session.lifecycleStatus !== 'active' ||
        session.activePlayerRunId !== fixture.agentRunId)) ||
    (fixture.runtime === 'coach' && session.lifecycleStatus !== 'ended')
  ) {
    return false
  }

  const runRows = await transaction<
    { readonly agentRunId: string; readonly lifecycle: string }[]
  >`
    SELECT id::text AS "agentRunId", lifecycle
    FROM app_private.agent_runs
    WHERE id = ${fixture.agentRunId}::uuid
      AND owner_id = ${fixture.owner.databaseOwnerId}::uuid
      AND session_id = ${fixture.sessionId}::uuid
      AND runtime = ${fixture.runtime}
    ORDER BY id ASC
    FOR UPDATE
  `
  const run = runRows[0]
  if (
    run === undefined ||
    !['queued', 'leased', 'running'].includes(run.lifecycle)
  ) {
    return false
  }

  const updatedRows = await transaction<{ readonly agentRunId: string }[]>`
    UPDATE app_private.agent_runs
    SET checkpoint_payload_version = 1,
        checkpoint_payload = '{"minimalGateCommitted":true}'::jsonb,
        updated_at = clock_timestamp()
    WHERE id = ${fixture.agentRunId}::uuid
      AND owner_id = ${fixture.owner.databaseOwnerId}::uuid
      AND session_id = ${fixture.sessionId}::uuid
      AND lifecycle IN ('queued', 'leased', 'running')
    RETURNING id::text AS "agentRunId"
  `
  return updatedRows[0]?.agentRunId === fixture.agentRunId
}

async function runM28Deletion(
  transaction: TransactionSql,
  fixture: M28GateFixture,
): Promise<void> {
  if (fixture.runtime === 'player') {
    await clearOwnerSessionData(transaction, fixture.owner, {
      deletedAt: M28_DELETED_AT,
    })
    return
  }
  await deleteEndedSessionData(transaction, fixture.owner, {
    sessionId: fixture.sessionId,
    deletedAt: M28_DELETED_AT,
  })
}

async function assertM28DeletionFirstRejectsWaitingGate(
  sql: Sql,
  runtimeUrl: string,
  createFixture: (sql: Sql) => Promise<M28GateFixture>,
  role: string,
): Promise<void> {
  const fixture = await createFixture(sql)
  const gateSql = createDatabaseTestSqlForRole(runtimeUrl, role)
  let gateResult: Promise<boolean> | undefined
  try {
    await sql.begin(async (transaction) => {
      const deletionBackendPid = await readTransactionBackendPid(transaction)
      await runM28Deletion(transaction, fixture)
      let signalGatePid: ((pid: number) => void) | undefined
      const gatePid = new Promise<number>((resolve) => {
        signalGatePid = resolve
      })
      gateResult = gateSql.begin(async (gateTransaction) => {
        const pid = await readTransactionBackendPid(gateTransaction)
        signalGatePid?.(pid)
        return runM28MinimalCommitGate(gateTransaction, fixture)
      })
      await waitForTransactionBlock(
        transaction,
        deletionBackendPid,
        await gatePid,
      )
    })

    await expect(gateResult).resolves.toBe(false)
    const rows = await sql<
      { readonly sessionCount: number; readonly runCount: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${fixture.sessionId}::uuid) AS "sessionCount",
        (SELECT count(*)::int FROM app_private.agent_runs WHERE id = ${fixture.agentRunId}::uuid) AS "runCount"
    `
    expect(rows[0]).toEqual({ sessionCount: 0, runCount: 0 })
  } finally {
    await gateSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${fixture.sessionId}::uuid
    `
  }
}

async function assertM28GateFirstIsCascadedByWaitingDeletion(
  sql: Sql,
  runtimeUrl: string,
  createFixture: (sql: Sql) => Promise<M28GateFixture>,
  role: string,
): Promise<void> {
  const fixture = await createFixture(sql)
  const deletionSql = createDatabaseTestSqlForRole(runtimeUrl, role)
  let deletionResult: Promise<void> | undefined
  try {
    await sql.begin(async (transaction) => {
      const gateBackendPid = await readTransactionBackendPid(transaction)
      await expect(runM28MinimalCommitGate(transaction, fixture)).resolves.toBe(
        true,
      )
      let signalDeletionPid: ((pid: number) => void) | undefined
      const deletionPid = new Promise<number>((resolve) => {
        signalDeletionPid = resolve
      })
      deletionResult = deletionSql.begin(async (deletionTransaction) => {
        const pid = await readTransactionBackendPid(deletionTransaction)
        signalDeletionPid?.(pid)
        await runM28Deletion(deletionTransaction, fixture)
      })
      await waitForTransactionBlock(
        transaction,
        gateBackendPid,
        await deletionPid,
      )
    })

    await expect(deletionResult).resolves.toBeUndefined()
    const rows = await sql<
      { readonly sessionCount: number; readonly runCount: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${fixture.sessionId}::uuid) AS "sessionCount",
        (SELECT count(*)::int FROM app_private.agent_runs WHERE id = ${fixture.agentRunId}::uuid) AS "runCount"
    `
    expect(rows[0]).toEqual({ sessionCount: 0, runCount: 0 })
  } finally {
    await deletionSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${fixture.sessionId}::uuid
    `
  }
}

export async function assertM28PlayerDeletionContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertM28DeletionFirstRejectsWaitingGate(
    sql,
    runtimeUrl,
    insertM28PlayerGateFixture,
    'm28-player-wait',
  )
  await assertM28GateFirstIsCascadedByWaitingDeletion(
    sql,
    runtimeUrl,
    insertM28PlayerGateFixture,
    'm28-player-delete',
  )
}

export async function assertM28CoachDeletionContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertM28DeletionFirstRejectsWaitingGate(
    sql,
    runtimeUrl,
    insertM28CoachGateFixture,
    'm28-coach-wait',
  )
  await assertM28GateFirstIsCascadedByWaitingDeletion(
    sql,
    runtimeUrl,
    insertM28CoachGateFixture,
    'm28-coach-delete',
  )
}

async function runM28CurrentCatalogCreation(
  transaction: TransactionSql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  sessionId: string,
): Promise<void> {
  const ownerRows = await transaction<{ readonly databaseOwnerId: string }[]>`
    SELECT id::text AS "databaseOwnerId"
    FROM app_private.owners
    WHERE id = ${owner.databaseOwnerId}::uuid
    FOR UPDATE
  `
  expect(ownerRows[0]?.databaseOwnerId).toBe(owner.databaseOwnerId)
  const prepared = await createRosterInput(transaction as unknown as Sql)
  await insertSessionRosterSnapshot(transaction, { ...prepared, sessionId })
}

async function assertM28ClearFirstThenCurrentCatalogCreation(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const oldSessionId = randomUUID()
  const newSessionId = randomUUID()
  const roster = await insertM28RosterSession(sql, oldSessionId)
  await endM28Session(sql, roster.owner.databaseOwnerId, oldSessionId)
  const creationSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm28-current-create',
  )
  let creationResult: Promise<void> | undefined
  try {
    await sql.begin(async (transaction) => {
      const clearPid = await readTransactionBackendPid(transaction)
      await clearOwnerSessionData(transaction, roster.owner, {
        deletedAt: M28_DELETED_AT,
      })
      let signalCreationPid: ((pid: number) => void) | undefined
      const creationPid = new Promise<number>((resolve) => {
        signalCreationPid = resolve
      })
      creationResult = creationSql.begin(async (creationTransaction) => {
        const pid = await readTransactionBackendPid(creationTransaction)
        signalCreationPid?.(pid)
        await runM28CurrentCatalogCreation(
          creationTransaction,
          roster.owner,
          newSessionId,
        )
      })
      await waitForTransactionBlock(transaction, clearPid, await creationPid)
    })

    await expect(creationResult).resolves.toBeUndefined()
    const rows = await sql<
      {
        readonly oldCount: number
        readonly newCount: number
        readonly newParticipantCount: number
        readonly oldDerivedCount: number
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${oldSessionId}::uuid) AS "oldCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${newSessionId}::uuid) AS "newCount",
        (SELECT count(*)::int FROM app_private.session_participants WHERE session_id = ${newSessionId}::uuid) AS "newParticipantCount",
        (
          (SELECT count(*) FROM app_private.hands WHERE session_id = ${oldSessionId}::uuid) +
          (SELECT count(*) FROM app_private.session_events WHERE session_id = ${oldSessionId}::uuid) +
          (SELECT count(*) FROM app_private.agent_runs WHERE session_id = ${oldSessionId}::uuid)
        )::int AS "oldDerivedCount"
    `
    expect(rows[0]).toEqual({
      oldCount: 0,
      newCount: 1,
      newParticipantCount: 6,
      oldDerivedCount: 0,
    })
  } finally {
    await creationSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${oldSessionId}::uuid, ${newSessionId}::uuid)
    `
  }
}

async function assertM28CurrentCatalogCreationFirstThenClear(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const oldSessionId = randomUUID()
  const newSessionId = randomUUID()
  const roster = await insertM28RosterSession(sql, oldSessionId)
  await endM28Session(sql, roster.owner.databaseOwnerId, oldSessionId)
  const clearSql = createDatabaseTestSqlForRole(runtimeUrl, 'm28-current-clear')
  let clearResult: Promise<void> | undefined
  try {
    await sql.begin(async (transaction) => {
      const creationPid = await readTransactionBackendPid(transaction)
      await runM28CurrentCatalogCreation(
        transaction,
        roster.owner,
        newSessionId,
      )
      let signalClearPid: ((pid: number) => void) | undefined
      const clearPid = new Promise<number>((resolve) => {
        signalClearPid = resolve
      })
      clearResult = clearSql.begin(async (clearTransaction) => {
        const pid = await readTransactionBackendPid(clearTransaction)
        signalClearPid?.(pid)
        await clearOwnerSessionData(clearTransaction, roster.owner, {
          deletedAt: M28_DELETED_AT,
        })
      })
      await waitForTransactionBlock(transaction, creationPid, await clearPid)
    })

    await expect(clearResult).resolves.toBeUndefined()
    const rows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE id IN (${oldSessionId}::uuid, ${newSessionId}::uuid)
    `
    expect(rows[0]?.count).toBe(0)
  } finally {
    await clearSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${oldSessionId}::uuid, ${newSessionId}::uuid)
    `
  }
}

export async function assertM28CurrentCatalogCreationContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertM28ClearFirstThenCurrentCatalogCreation(sql, runtimeUrl)
  await assertM28CurrentCatalogCreationFirstThenClear(sql, runtimeUrl)
}

interface M28HistoricalSourceFixture {
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly sessionId: string
  readonly historicalConfigSnapshotKey: string
}

async function insertM28HistoricalEndedSession(
  sql: Sql,
  sessionId: string,
  endedAt = '2026-08-05T03:59:00.000Z',
): Promise<M28HistoricalSourceFixture> {
  const changedDefinitions = structuredClone(
    PERSONA_CATALOG_DEFINITIONS,
  ) as unknown as Record<string, unknown>[]
  for (const [index, definition] of changedDefinitions.entries()) {
    if (index >= 5) {
      break
    }
    definition.name = `Historical M2.8 ${index + 1}`
  }
  const historicalCatalog = loadAndValidatePersonaCatalog(changedDefinitions)
  const prepared = await sql.begin(async (transaction) => {
    const roster = await prepareCurrentCatalogRosterSnapshot(
      transaction as unknown as Sql,
      ownerScope,
      historicalCatalog,
      {
        sessionId,
        userParticipantId: randomUUID(),
        agents: historicalCatalog
          .list()
          .slice(0, 5)
          .map((entry, index) => ({
            seatNumber: index + 1,
            agentParticipantId: randomUUID(),
            personaId: entry.personaId,
          })),
      },
    )
    await insertSessionRosterSnapshot(transaction, roster)
    await transaction`
      UPDATE app_private.sessions
      SET lifecycle_status = 'ended',
          ended_at = ${endedAt}::timestamptz,
          updated_at = ${endedAt}::timestamptz
      WHERE id = ${sessionId}::uuid
        AND owner_id = ${roster.owner.databaseOwnerId}::uuid
    `
    return roster
  })
  const snapshots = await readSessionAgentSnapshots(sql, ownerScope, sessionId)
  const historicalConfigSnapshotKey = snapshots[0]?.configSnapshotKey
  if (historicalConfigSnapshotKey === undefined) {
    throw new Error('M2.8 历史阵容 fixture 缺少配置 Key。')
  }
  return {
    owner: prepared.owner,
    sessionId,
    historicalConfigSnapshotKey,
  }
}

async function runM28HistoricalRosterCreation(
  transaction: TransactionSql,
  owner: Awaited<ReturnType<typeof resolveOwnerScope>>,
  newSessionId: string,
  onCandidate?: (candidateId: string) => Promise<void>,
): Promise<boolean> {
  const ownerRows = await transaction<{ readonly databaseOwnerId: string }[]>`
    SELECT id::text AS "databaseOwnerId"
    FROM app_private.owners
    WHERE id = ${owner.databaseOwnerId}::uuid
    FOR UPDATE
  `
  if (ownerRows[0]?.databaseOwnerId !== owner.databaseOwnerId) {
    return false
  }
  const candidateRows = await transaction<{ readonly sessionId: string }[]>`
    SELECT id::text AS "sessionId"
    FROM app_private.sessions
    WHERE owner_id = ${owner.databaseOwnerId}::uuid
      AND lifecycle_status = 'ended'
    ORDER BY ended_at DESC, id DESC
    LIMIT 1
  `
  const candidateId = candidateRows[0]?.sessionId
  if (candidateId === undefined) {
    return false
  }
  await onCandidate?.(candidateId)

  const lockedRows = await transaction<{ readonly sessionId: string }[]>`
    SELECT id::text AS "sessionId"
    FROM app_private.sessions
    WHERE id = ${candidateId}::uuid
      AND owner_id = ${owner.databaseOwnerId}::uuid
      AND lifecycle_status = 'ended'
    FOR UPDATE
  `
  if (lockedRows[0]?.sessionId !== candidateId) {
    return false
  }
  const latestRows = await transaction<{ readonly sessionId: string }[]>`
    SELECT id::text AS "sessionId"
    FROM app_private.sessions
    WHERE owner_id = ${owner.databaseOwnerId}::uuid
      AND lifecycle_status = 'ended'
    ORDER BY ended_at DESC, id DESC
    LIMIT 1
  `
  if (latestRows[0]?.sessionId !== candidateId) {
    return false
  }

  const prepared = await prepareLatestEndedRosterSnapshotForReuse(
    transaction as unknown as Sql,
    ownerScope,
    {
      sessionId: newSessionId,
      userParticipantId: randomUUID(),
      agentParticipants: Array.from({ length: 5 }, (_, index) => ({
        seatNumber: index + 1,
        agentParticipantId: randomUUID(),
      })),
    },
  )
  await insertSessionRosterSnapshot(transaction, prepared)
  return true
}

async function assertM28ClearRejectsStaleHistoricalPreflight(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sourceSessionId = randomUUID()
  const newSessionId = randomUUID()
  const source = await insertM28HistoricalEndedSession(sql, sourceSessionId)
  const cachedPreflight = await prepareLatestEndedRosterSnapshotForReuse(
    sql,
    ownerScope,
    {
      sessionId: newSessionId,
      userParticipantId: randomUUID(),
      agentParticipants: Array.from({ length: 5 }, (_, index) => ({
        seatNumber: index + 1,
        agentParticipantId: randomUUID(),
      })),
    },
  )
  expect(cachedPreflight.agents[0]?.configSnapshotKey).toBe(
    source.historicalConfigSnapshotKey,
  )
  const reuseSql = createDatabaseTestSqlForRole(runtimeUrl, 'm28-reuse-wait')
  let reuseResult: Promise<boolean> | undefined
  try {
    await sql.begin(async (transaction) => {
      const clearPid = await readTransactionBackendPid(transaction)
      await clearOwnerSessionData(transaction, source.owner, {
        deletedAt: M28_DELETED_AT,
      })
      let signalReusePid: ((pid: number) => void) | undefined
      const reusePid = new Promise<number>((resolve) => {
        signalReusePid = resolve
      })
      reuseResult = reuseSql.begin(async (reuseTransaction) => {
        const pid = await readTransactionBackendPid(reuseTransaction)
        signalReusePid?.(pid)
        return runM28HistoricalRosterCreation(
          reuseTransaction,
          source.owner,
          newSessionId,
        )
      })
      await waitForTransactionBlock(transaction, clearPid, await reusePid)
    })

    await expect(reuseResult).resolves.toBe(false)
    const rows = await sql<
      { readonly newCount: number; readonly historicalKeyCount: number }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${newSessionId}::uuid) AS "newCount",
        (SELECT count(*)::int FROM app_private.session_agents WHERE config_snapshot_key = ${source.historicalConfigSnapshotKey}) AS "historicalKeyCount"
    `
    expect(rows[0]).toEqual({ newCount: 0, historicalKeyCount: 0 })
  } finally {
    await reuseSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${sourceSessionId}::uuid, ${newSessionId}::uuid)
    `
  }
}

async function assertM28HistoricalReuseFirstThenClear(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sourceSessionId = randomUUID()
  const newSessionId = randomUUID()
  const source = await insertM28HistoricalEndedSession(sql, sourceSessionId)
  const clearSql = createDatabaseTestSqlForRole(runtimeUrl, 'm28-reuse-clear')
  let clearResult: Promise<void> | undefined
  try {
    await sql.begin(async (transaction) => {
      const reusePid = await readTransactionBackendPid(transaction)
      await expect(
        runM28HistoricalRosterCreation(transaction, source.owner, newSessionId),
      ).resolves.toBe(true)
      let signalClearPid: ((pid: number) => void) | undefined
      const clearPid = new Promise<number>((resolve) => {
        signalClearPid = resolve
      })
      clearResult = clearSql.begin(async (clearTransaction) => {
        const pid = await readTransactionBackendPid(clearTransaction)
        signalClearPid?.(pid)
        await clearOwnerSessionData(clearTransaction, source.owner, {
          deletedAt: M28_DELETED_AT,
        })
      })
      await waitForTransactionBlock(transaction, reusePid, await clearPid)
    })

    await expect(clearResult).resolves.toBeUndefined()
    const rows = await sql<{ readonly count: number }[]>`
      SELECT count(*)::int AS count
      FROM app_private.sessions
      WHERE id IN (${sourceSessionId}::uuid, ${newSessionId}::uuid)
    `
    expect(rows[0]?.count).toBe(0)
  } finally {
    await clearSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${sourceSessionId}::uuid, ${newSessionId}::uuid)
    `
  }
}

export async function assertM28HistoricalClearContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertM28ClearRejectsStaleHistoricalPreflight(sql, runtimeUrl)
  await assertM28HistoricalReuseFirstThenClear(sql, runtimeUrl)
}

async function insertM28OlderEndedSession(
  sql: Sql,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof insertM28RosterSession>>> {
  const roster = await insertM28RosterSession(sql, sessionId)
  await sql`
    UPDATE app_private.sessions
    SET lifecycle_status = 'ended',
        ended_at = '2026-08-05T03:00:00.000Z'::timestamptz,
        updated_at = '2026-08-05T03:00:00.000Z'::timestamptz
    WHERE id = ${sessionId}::uuid
      AND owner_id = ${roster.owner.databaseOwnerId}::uuid
  `
  return roster
}

async function assertM28CandidateDeleteFirstDoesNotFallback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const olderSessionId = randomUUID()
  const latestSessionId = randomUUID()
  const newSessionId = randomUUID()
  await insertM28OlderEndedSession(sql, olderSessionId)
  const latest = await insertM28HistoricalEndedSession(sql, latestSessionId)
  const creationSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm28-exact-reuse',
  )
  let resumeCreation: (() => void) | undefined
  const creationResume = new Promise<void>((resolve) => {
    resumeCreation = resolve
  })
  let signalCandidate:
    | ((value: { readonly candidateId: string; readonly pid: number }) => void)
    | undefined
  const selectedCandidate = new Promise<{
    readonly candidateId: string
    readonly pid: number
  }>((resolve) => {
    signalCandidate = resolve
  })
  let creationPid = 0
  const creationResult = creationSql.begin(async (transaction) => {
    creationPid = await readTransactionBackendPid(transaction)
    return runM28HistoricalRosterCreation(
      transaction,
      latest.owner,
      newSessionId,
      async (candidateId) => {
        signalCandidate?.({ candidateId, pid: creationPid })
        await creationResume
      },
    )
  })

  try {
    const candidate = await selectedCandidate
    expect(candidate.candidateId).toBe(latestSessionId)
    await sql.begin(async (transaction) => {
      const deletionPid = await readTransactionBackendPid(transaction)
      await deleteEndedSessionData(transaction, latest.owner, {
        sessionId: latestSessionId,
        deletedAt: M28_DELETED_AT,
      })
      resumeCreation?.()
      await waitForTransactionBlock(transaction, deletionPid, candidate.pid)
    })

    await expect(creationResult).resolves.toBe(false)
    const rows = await sql<
      {
        readonly olderCount: number
        readonly latestCount: number
        readonly newCount: number
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${olderSessionId}::uuid) AS "olderCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${latestSessionId}::uuid) AS "latestCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${newSessionId}::uuid) AS "newCount"
    `
    expect(rows[0]).toEqual({ olderCount: 1, latestCount: 0, newCount: 0 })
  } finally {
    resumeCreation?.()
    await creationResult.catch(() => undefined)
    await creationSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (
        ${olderSessionId}::uuid,
        ${latestSessionId}::uuid,
        ${newSessionId}::uuid
      )
    `
  }
}

async function assertM28CandidateReuseFirstSurvivesSourceDelete(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const olderSessionId = randomUUID()
  const latestSessionId = randomUUID()
  const newSessionId = randomUUID()
  await insertM28OlderEndedSession(sql, olderSessionId)
  const latest = await insertM28HistoricalEndedSession(sql, latestSessionId)
  const deletionSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm28-exact-delete',
  )
  let deletionResult: Promise<void> | undefined
  try {
    await sql.begin(async (transaction) => {
      const creationPid = await readTransactionBackendPid(transaction)
      await expect(
        runM28HistoricalRosterCreation(transaction, latest.owner, newSessionId),
      ).resolves.toBe(true)
      let signalDeletionPid: ((pid: number) => void) | undefined
      const deletionPid = new Promise<number>((resolve) => {
        signalDeletionPid = resolve
      })
      deletionResult = deletionSql.begin(async (deletionTransaction) => {
        const pid = await readTransactionBackendPid(deletionTransaction)
        signalDeletionPid?.(pid)
        await deleteEndedSessionData(deletionTransaction, latest.owner, {
          sessionId: latestSessionId,
          deletedAt: M28_DELETED_AT,
        })
      })
      await waitForTransactionBlock(transaction, creationPid, await deletionPid)
    })

    await expect(deletionResult).resolves.toBeUndefined()
    const rows = await sql<
      {
        readonly olderCount: number
        readonly latestCount: number
        readonly newCount: number
        readonly historicalKeyCount: number
      }[]
    >`
      SELECT
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${olderSessionId}::uuid) AS "olderCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${latestSessionId}::uuid) AS "latestCount",
        (SELECT count(*)::int FROM app_private.sessions WHERE id = ${newSessionId}::uuid) AS "newCount",
        (SELECT count(*)::int FROM app_private.session_agents WHERE session_id = ${newSessionId}::uuid AND config_snapshot_key = ${latest.historicalConfigSnapshotKey}) AS "historicalKeyCount"
    `
    expect(rows[0]).toEqual({
      olderCount: 1,
      latestCount: 0,
      newCount: 1,
      historicalKeyCount: 1,
    })
  } finally {
    await deletionSql.end({ timeout: 0 })
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (
        ${olderSessionId}::uuid,
        ${latestSessionId}::uuid,
        ${newSessionId}::uuid
      )
    `
  }
}

export async function assertM28HistoricalCandidateContention(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  await assertM28CandidateDeleteFirstDoesNotFallback(sql, runtimeUrl)
  await assertM28CandidateReuseFirstSurvivesSourceDelete(sql, runtimeUrl)
}

function createM31SnapshotProjectorBinding(sessionId: string) {
  return {
    projector: {
      project: async ({
        state,
        session,
        eventSeq,
      }: SnapshotProjectionInput) => {
        const hand = state.poker.hand
        return PublicSessionSnapshotSchema.parse({
          sessionId,
          stateVersion: state.stateVersion,
          eventSeq,
          pokerPhase: state.poker.pokerPhase,
          lifecycleStatus: session.lifecycleStatus,
          agentRunState: session.agentRunState,
          activeDecision: null,
          seats: state.poker.seats.map((seat) => ({
            seatNumber: seat.seatNumber,
            playerId: seat.playerId,
            displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
            avatarColor: '#0f766e',
            isUser: seat.isUser,
            stack: seat.stack,
            status: seat.status,
          })),
          hand:
            hand === null
              ? null
              : {
                  handId: hand.handId,
                  street: hand.street,
                  board: hand.board,
                  pot: hand.pot,
                  currentActorSeatNumber: hand.currentActorSeatNumber,
                  heroHoleCards:
                    hand.holeCards.find((cards) => cards.seatNumber === 0)
                      ?.cards ?? null,
                  legalActions: getLegalActions(state.poker),
                  actionTimeline: [],
                },
          lastCompletedHandSummary: null,
        })
      },
    },
    bindReadPort: () => Object.freeze({}),
  }
}

function createM31Executor(input: {
  readonly sql: Sql
  readonly owner: Awaited<ReturnType<typeof resolveOwnerScope>>
  readonly sessionId: string
  readonly commandType: 'rebuy' | 'endSession'
  readonly handler: object
  readonly eventId: string
  readonly commandAt: string
}) {
  return createSessionCommandExecutor({
    sql: input.sql,
    owner: input.owner,
    handlers: createSessionCommandHandlerMap({
      enabledCommandTypes: [input.commandType],
      bindings: [
        {
          commandType: input.commandType,
          handler: input.handler,
          bindReadPort: () => Object.freeze({}),
          bindWritePort: (transaction: TransactionSql) =>
            Object.freeze({
              insertProtocolRelation: async (plan: {
                readonly checkpoint: Parameters<
                  typeof insertInProgressHandAudit
                >[2]['checkpoint']
                readonly completed: Parameters<
                  typeof completeHandAudit
                >[2]['result']
              }) => {
                await insertInProgressHandAudit(transaction, input.owner, {
                  sessionId: input.sessionId,
                  checkpoint: plan.checkpoint,
                  startedAt: '2026-08-05T10:00:00.000Z',
                })
                await completeHandAudit(transaction, input.owner, {
                  sessionId: input.sessionId,
                  handId: plan.checkpoint.startedHand.handId,
                  result: plan.completed,
                  completedAt: '2026-08-05T10:00:01.000Z',
                })
              },
            }),
        } as never,
      ],
    }),
    mutationRepository: productionSessionMutationRepository,
    recoveryRepository: productionSessionRecoveryRepository,
    recoveryRegistries,
    snapshotProjectorBinding: createM31SnapshotProjectorBinding(
      input.sessionId,
    ),
    now: () => input.commandAt,
    nextEventId: () => input.eventId,
  })
}

function createM31RebuyHandler(
  relationHandId: string,
  beforePrepare: () => Promise<void> = async () => {},
) {
  const relationFixture = createM27HandAuditFixture(relationHandId)
  type RelationPlan = {
    readonly kind: 'rebuy'
  }
  type WritePort = {
    readonly insertProtocolRelation: (plan: RelationPlan) => Promise<unknown>
  }
  return {
    prepare: async ({ state }: { readonly state: PrivateTableState }) => {
      await beforePrepare()
      const userSeat = state.poker.seats.find((seat) => seat.seatNumber === 0)
      const userAccounting = state.seatAccounting.find(
        (seat) => seat.seatNumber === 0,
      )
      if (userSeat === undefined || userAccounting === undefined) {
        throw new Error('M3.1 rebuy fixture 缺少用户座位。')
      }
      const amount = 500
      const stackAfter = userSeat.stack + amount
      const cumulativeBuyInAfter = userAccounting.cumulativeBuyIn + amount
      return {
        kind: 'prepared' as const,
        mutation: {
          stateEffect: {
            kind: 'stateChanged' as const,
            stateContent: {
              poker: {
                ...state.poker,
                seats: state.poker.seats.map((seat) =>
                  seat.seatNumber === 0
                    ? { ...seat, stack: stackAfter, status: 'active' as const }
                    : seat,
                ),
              },
              completedHandCount: state.completedHandCount,
              seatAccounting: state.seatAccounting.map((seat) =>
                seat.seatNumber === 0
                  ? { ...seat, cumulativeBuyIn: cumulativeBuyInAfter }
                  : seat,
              ),
              lastCompletedHandSummary: state.lastCompletedHandSummary,
            },
          },
          lifecycleAfter: 'active' as const,
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle' as const,
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            {
              type: 'userRebuy' as const,
              seatNumber: 0 as const,
              amount,
              stackBefore: userSeat.stack,
              stackAfter,
              cumulativeBuyInBefore: userAccounting.cumulativeBuyIn,
              cumulativeBuyInAfter,
            },
          ],
          relationPlan: Object.freeze({
            kind: 'rebuy' as const,
          }),
        },
      }
    },
    applyRelations: async (
      { writes }: { readonly writes: WritePort },
      capability: PreparedMutationCapability<RelationPlan>,
    ) => {
      await writes.insertProtocolRelation({
        ...capability.relationPlan,
        checkpoint: relationFixture.checkpoint,
        completed: relationFixture.completed,
      } as never)
    },
  }
}

function reportM31ContentionTransactionPid(
  sql: Sql,
  report: (pid: number) => void,
): Sql {
  return {
    begin: async (callback: (transaction: TransactionSql) => unknown) =>
      sql.begin(async (transaction) => {
        await transaction`SET LOCAL statement_timeout = '240s'`
        await transaction`SET LOCAL idle_in_transaction_session_timeout = '240s'`
        report(await readTransactionBackendPid(transaction))
        return callback(transaction)
      }),
  } as unknown as Sql
}

function isPostgresLockTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '55P03'
  )
}

async function deleteM31FixtureSessions(
  sql: Sql,
  sessionIds: readonly string[],
): Promise<void> {
  const deadline = Date.now() + 30_000
  while (true) {
    try {
      await sql.begin(async (transaction) => {
        await transaction`SET LOCAL lock_timeout = '2s'`
        for (const sessionId of sessionIds) {
          await transaction`
            DELETE FROM app_private.sessions
            WHERE id = ${sessionId}::uuid
          `
        }
      })
      return
    } catch (error) {
      if (!isPostgresLockTimeout(error) || Date.now() >= deadline) {
        throw error
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function cleanupM31ConcurrentFixture(input: {
  readonly runtimeUrl: string
  readonly role: string
  readonly release: () => void
  readonly clients: readonly Sql[]
  readonly operations: readonly (Promise<unknown> | undefined)[]
  readonly sessionIds: readonly string[]
}): Promise<void> {
  input.release()
  const cleanupFailures: unknown[] = []
  const closeResults = await Promise.allSettled(
    input.clients.map((client) => client.end({ timeout: 0 })),
  )
  cleanupFailures.push(
    ...closeResults.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    ),
  )
  await Promise.allSettled(
    input.operations.filter(
      (operation): operation is Promise<unknown> => operation !== undefined,
    ),
  )

  const cleanupSql = createDatabaseTestSqlForRole(input.runtimeUrl, input.role)
  try {
    await deleteM31FixtureSessions(cleanupSql, input.sessionIds)
  } catch (error) {
    cleanupFailures.push(error)
  } finally {
    const cleanupClose = await Promise.allSettled([
      cleanupSql.end({ timeout: 0 }),
    ])
    if (cleanupClose[0]?.status === 'rejected') {
      cleanupFailures.push(cleanupClose[0].reason)
    }
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(cleanupFailures, 'M3.1 并发夹具清理失败。')
  }
}

async function storeInitialM31EventAsCurrent(
  sql: Sql,
  sessionId: string,
  handId: string,
): Promise<void> {
  const stored = encodeCurrentPrivateEvent(
    createUncalledBetReturnedEventDraft(handId, [
      { seatNumber: 1, amount: 10 },
    ]),
  )
  await sql`
    UPDATE app_private.session_events
    SET private_event_payload_version = ${stored.payloadVersion},
        private_event_payload = ${serializeJsonbFixture(stored.payload as unknown as JSONValue)}::text::jsonb,
        public_event_payload = jsonb_set(
          public_event_payload,
          '{type}',
          to_jsonb('uncalledBetReturned'::text)
        )
    WHERE session_id = ${sessionId}::uuid
      AND event_seq = 0
  `
}

async function insertM31RebuyableSession(
  sql: Sql,
  sessionId: string,
  previousHandId: string,
  eventId: string,
): Promise<void> {
  await insertRecoverableSession(sql, sessionId, previousHandId, eventId, {
    userStack: 1_000,
  })
  await sql`
    UPDATE app_private.hands
    SET hand_number = 2
    WHERE id = ${previousHandId}::uuid
      AND session_id = ${sessionId}::uuid
  `
  const stored = encodeCurrentPrivateEvent(
    createUncalledBetReturnedEventDraft(previousHandId, [
      { seatNumber: 1, amount: 10 },
    ]),
  )
  await sql`
    UPDATE app_private.session_events
    SET private_event_payload_version = ${stored.payloadVersion},
        private_event_payload = ${serializeJsonbFixture(stored.payload as unknown as JSONValue)}::text::jsonb,
        public_event_payload = jsonb_set(
          public_event_payload,
          '{type}',
          to_jsonb('uncalledBetReturned'::text)
        )
    WHERE session_id = ${sessionId}::uuid
      AND event_seq = 0
  `
}

async function assertM31ConcurrentVersionConflict(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_200)
  const previousHandId = fixture.id(31_201)
  const relationHandId = fixture.id(31_207)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-first')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-second')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let signalFirstEntered!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    signalFirstEntered = resolve
  })
  let signalFirstPid!: (pid: number) => void
  const firstPid = new Promise<number>((resolve) => {
    signalFirstPid = resolve
  })
  let signalSecondPid!: (pid: number) => void
  const secondPid = new Promise<number>((resolve) => {
    signalSecondPid = resolve
  })
  let firstResult: Promise<unknown> | undefined
  let secondResult: Promise<unknown> | undefined

  await runDatabaseTestWithCleanup(
    async () => {
      await insertM31RebuyableSession(
        sql,
        sessionId,
        previousHandId,
        fixture.id(31_202),
      )
      await storeInitialM31EventAsCurrent(sql, sessionId, previousHandId)
      const firstExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(firstSql, signalFirstPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(relationHandId, async () => {
          signalFirstEntered()
          await firstGate
        }),
        eventId: fixture.id(31_205),
        commandAt: '2026-08-05T10:01:00.000Z',
      })
      const secondExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(secondSql, signalSecondPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(relationHandId),
        eventId: fixture.id(31_206),
        commandAt: '2026-08-05T10:01:01.000Z',
      })
      const firstCommand = {
        sessionId,
        commandId: fixture.id(31_203),
        expectedStateVersion: 1,
        type: 'rebuy' as const,
        payload: { amount: 500 },
      }
      const secondCommand = {
        ...firstCommand,
        commandId: fixture.id(31_204),
      }

      firstResult = firstExecutor.execute(firstCommand)
      await firstEntered
      secondResult = secondExecutor.execute(secondCommand)
      try {
        await waitForTransactionBlock(
          sql as unknown as TransactionSql,
          await firstPid,
          await secondPid,
        )
      } finally {
        releaseFirst()
      }

      await Promise.all([
        expect(firstResult).resolves.toMatchObject({
          kind: 'completed',
          origin: 'newCommit',
          response: { snapshot: { stateVersion: 2, eventSeq: 1 } },
        }),
        expect(secondResult).resolves.toMatchObject({
          kind: 'rejected',
          origin: 'ledgerCommit',
          response: {
            code: 'STATE_VERSION_CONFLICT',
            latestSnapshot: { stateVersion: 2, eventSeq: 1 },
          },
        }),
      ])
      await expect(firstExecutor.execute(firstCommand)).resolves.toMatchObject({
        kind: 'completed',
        origin: 'replay',
      })
      await expect(
        secondExecutor.execute({ ...firstCommand, expectedStateVersion: 2 }),
      ).rejects.toBeInstanceOf(CommandPayloadConflictError)

      const rows = await sql<
        {
          readonly stateVersion: number
          readonly nextEventSeq: number
          readonly eventVersions: number[]
          readonly completedLedgers: number
          readonly failedLedgers: number
        }[]
      >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (SELECT array_agg(event.private_event_payload_version ORDER BY event.event_seq)
         FROM app_private.session_events AS event
         WHERE event.session_id = session.id) AS "eventVersions",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id
           AND ledger.processing_status = 'completed') AS "completedLedgers",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id
           AND ledger.processing_status = 'failed') AS "failedLedgers"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
      expect(rows[0]).toEqual({
        stateVersion: 2,
        nextEventSeq: 2,
        eventVersions: [1, 1],
        completedLedgers: 1,
        failedLedgers: 1,
      })
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-conflict-cleanup',
        release: releaseFirst,
        clients: [firstSql, secondSql],
        operations: [firstResult, secondResult],
        sessionIds: [sessionId],
      }),
  )
}

async function assertM31FailureCleanupDoesNotPollute(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_250)
  const workerSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm31-failure-worker',
  )
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseWorker!: () => void
  const workerGate = new Promise<void>((resolve) => {
    releaseWorker = resolve
  })
  let signalWorkerEntered!: () => void
  const workerEntered = new Promise<void>((resolve) => {
    signalWorkerEntered = resolve
  })
  let workerResult: Promise<unknown> | undefined
  const expectedFailure = new Error('expected M3.1 fixture failure')

  try {
    await runDatabaseTestWithCleanup(
      async () => {
        await insertM31RebuyableSession(
          sql,
          sessionId,
          fixture.id(31_251),
          fixture.id(31_252),
        )
        const executor = createM31Executor({
          sql: reportM31ContentionTransactionPid(workerSql, () => {}),
          owner,
          sessionId,
          commandType: 'rebuy',
          handler: createM31RebuyHandler(fixture.id(31_256), async () => {
            signalWorkerEntered()
            await workerGate
          }),
          eventId: fixture.id(31_254),
          commandAt: '2026-08-05T10:01:30.000Z',
        })
        workerResult = executor.execute({
          sessionId,
          commandId: fixture.id(31_253),
          expectedStateVersion: 1,
          type: 'rebuy',
          payload: { amount: 500 },
        })
        await workerEntered
        throw expectedFailure
      },
      async () =>
        cleanupM31ConcurrentFixture({
          runtimeUrl,
          role: 'm31-failure-clean',
          release: releaseWorker,
          clients: [workerSql],
          operations: [workerResult],
          sessionIds: [sessionId],
        }),
    )
  } catch (error) {
    expect(error).toBe(expectedFailure)
  }

  const rows = await sql<{ readonly sessionCount: number }[]>`
    SELECT count(*)::int AS "sessionCount"
    FROM app_private.sessions
    WHERE id = ${sessionId}::uuid
  `
  expect(rows[0]?.sessionCount).toBe(0)
}

async function assertM31WaiterAcquiresAfterRollback(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_300)
  const previousHandId = fixture.id(31_301)
  const relationHandId = fixture.id(31_306)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-rollback')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-waiter')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  let signalFirstEntered!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    signalFirstEntered = resolve
  })
  let signalFirstPid!: (pid: number) => void
  const firstPid = new Promise<number>((resolve) => {
    signalFirstPid = resolve
  })
  let signalSecondPid!: (pid: number) => void
  const secondPid = new Promise<number>((resolve) => {
    signalSecondPid = resolve
  })
  let firstResult: Promise<unknown> | undefined
  let secondResult: Promise<unknown> | undefined

  await runDatabaseTestWithCleanup(
    async () => {
      await insertM31RebuyableSession(
        sql,
        sessionId,
        previousHandId,
        fixture.id(31_302),
      )
      const failingHandler = {
        prepare: async () => {
          signalFirstEntered()
          await firstGate
          throw new Error('injected M3.1 rollback')
        },
        applyRelations: async () => {},
      }
      const firstExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(firstSql, signalFirstPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: failingHandler,
        eventId: fixture.id(31_304),
        commandAt: '2026-08-05T10:02:00.000Z',
      })
      const secondExecutor = createM31Executor({
        sql: reportM31ContentionTransactionPid(secondSql, signalSecondPid),
        owner,
        sessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(relationHandId),
        eventId: fixture.id(31_305),
        commandAt: '2026-08-05T10:02:01.000Z',
      })
      const command = {
        sessionId,
        commandId: fixture.id(31_303),
        expectedStateVersion: 1,
        type: 'rebuy' as const,
        payload: { amount: 500 },
      }

      firstResult = firstExecutor.execute(command)
      await firstEntered
      secondResult = secondExecutor.execute(command)
      try {
        await waitForTransactionBlock(
          sql as unknown as TransactionSql,
          await firstPid,
          await secondPid,
        )
      } finally {
        releaseFirst()
      }

      await Promise.all([
        expect(firstResult).rejects.toThrow('injected M3.1 rollback'),
        expect(secondResult).resolves.toMatchObject({
          kind: 'completed',
          origin: 'newCommit',
          response: { snapshot: { stateVersion: 2, eventSeq: 1 } },
        }),
      ])
      const rows = await sql<
        {
          readonly stateVersion: number
          readonly nextEventSeq: number
          readonly eventCount: number
          readonly ledgerCount: number
        }[]
      >`
      SELECT
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (SELECT count(*)::int FROM app_private.session_events AS event
         WHERE event.session_id = session.id) AS "eventCount",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id) AS "ledgerCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
      expect(rows[0]).toEqual({
        stateVersion: 2,
        nextEventSeq: 2,
        eventCount: 2,
        ledgerCount: 1,
      })
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-rollback-cleanup',
        release: releaseFirst,
        clients: [firstSql, secondSql],
        operations: [firstResult, secondResult],
        sessionIds: [sessionId],
      }),
  )
}

function holdM31TransactionBeforeCommit(
  sql: Sql,
  signalReady: () => void,
  waitForRelease: Promise<void>,
): Sql {
  return {
    begin: async (callback: (transaction: TransactionSql) => unknown) =>
      sql.begin(async (transaction) => {
        const result = await callback(transaction)
        signalReady()
        await waitForRelease
        return result
      }),
  } as unknown as Sql
}

function rollbackM31TransactionAfterWrites(sql: Sql): Sql {
  return {
    begin: async (callback: (transaction: TransactionSql) => unknown) =>
      sql.begin(async (transaction) => {
        await callback(transaction)
        throw new Error('injected transaction rollback after writes')
      }),
  } as unknown as Sql
}

async function readM31AtomicCounts(sql: Sql, sessionId: string) {
  const rows = await sql<
    {
      readonly stateVersion: number
      readonly nextEventSeq: number
      readonly snapshotStateVersion: number
      readonly eventCount: number
      readonly ledgerCount: number
      readonly handCount: number
    }[]
  >`
    SELECT
      session.state_version::int AS "stateVersion",
      session.next_event_seq::int AS "nextEventSeq",
      (SELECT (snapshot.private_table_state_payload #>> '{state,stateVersion}')::int
       FROM app_private.session_snapshots AS snapshot
       WHERE snapshot.session_id = session.id) AS "snapshotStateVersion",
      (SELECT count(*)::int FROM app_private.session_events AS event
       WHERE event.session_id = session.id) AS "eventCount",
      (SELECT count(*)::int FROM app_private.command_ledger AS ledger
       WHERE ledger.session_id = session.id) AS "ledgerCount",
      (SELECT count(*)::int FROM app_private.hands AS hand
       WHERE hand.session_id = session.id) AS "handCount"
    FROM app_private.sessions AS session
    WHERE session.id = ${sessionId}::uuid
  `
  return rows[0]
}

async function assertM31AtomicCommitRollbackAndVisibility(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const commitSessionId = fixture.id(31_400)
  const commitPreviousHandId = fixture.id(31_401)
  const commitRelationHandId = fixture.id(31_402)
  const rollbackSessionId = fixture.id(31_410)
  const rollbackPreviousHandId = fixture.id(31_411)
  const rollbackRelationHandId = fixture.id(31_412)
  const observerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-observer')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let releaseCommit!: () => void
  const commitGate = new Promise<void>((resolve) => {
    releaseCommit = resolve
  })
  let signalWritesReady!: () => void
  const writesReady = new Promise<void>((resolve) => {
    signalWritesReady = resolve
  })
  let commitResult: Promise<unknown> | undefined
  let rollbackResult: Promise<unknown> | undefined
  await runDatabaseTestWithCleanup(
    async () => {
      await insertM31RebuyableSession(
        sql,
        commitSessionId,
        commitPreviousHandId,
        fixture.id(31_403),
      )
      const executor = createM31Executor({
        sql: holdM31TransactionBeforeCommit(
          observerSql,
          signalWritesReady,
          commitGate,
        ),
        owner,
        sessionId: commitSessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(commitRelationHandId),
        eventId: fixture.id(31_404),
        commandAt: '2026-08-05T10:04:00.000Z',
      })
      commitResult = executor.execute({
        sessionId: commitSessionId,
        commandId: fixture.id(31_405),
        expectedStateVersion: 1,
        type: 'rebuy',
        payload: { amount: 500 },
      })
      await writesReady
      expect(await readM31AtomicCounts(sql, commitSessionId)).toEqual({
        stateVersion: 1,
        nextEventSeq: 1,
        snapshotStateVersion: 1,
        eventCount: 1,
        ledgerCount: 0,
        handCount: 1,
      })
      releaseCommit()
      await expect(commitResult).resolves.toMatchObject({
        kind: 'completed',
        origin: 'newCommit',
      })
      expect(await readM31AtomicCounts(sql, commitSessionId)).toEqual({
        stateVersion: 2,
        nextEventSeq: 2,
        snapshotStateVersion: 2,
        eventCount: 2,
        ledgerCount: 1,
        handCount: 2,
      })
      await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${commitSessionId}::uuid
    `

      await insertM31RebuyableSession(
        sql,
        rollbackSessionId,
        rollbackPreviousHandId,
        fixture.id(31_413),
      )
      const rollbackExecutor = createM31Executor({
        sql: rollbackM31TransactionAfterWrites(observerSql),
        owner,
        sessionId: rollbackSessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(rollbackRelationHandId),
        eventId: fixture.id(31_414),
        commandAt: '2026-08-05T10:04:10.000Z',
      })
      rollbackResult = rollbackExecutor.execute({
        sessionId: rollbackSessionId,
        commandId: fixture.id(31_415),
        expectedStateVersion: 1,
        type: 'rebuy',
        payload: { amount: 500 },
      })
      await expect(rollbackResult).rejects.toBeInstanceOf(
        DatabaseOperationError,
      )
      expect(await readM31AtomicCounts(sql, rollbackSessionId)).toEqual({
        stateVersion: 1,
        nextEventSeq: 1,
        snapshotStateVersion: 1,
        eventCount: 1,
        ledgerCount: 0,
        handCount: 1,
      })
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-atomic-cleanup',
        release: releaseCommit,
        clients: [observerSql],
        operations: [commitResult, rollbackResult],
        sessionIds: [commitSessionId, rollbackSessionId],
      }),
  )
}

async function assertM31DifferentSessionsRunInParallel(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const firstSessionId = fixture.id(31_500)
  const secondSessionId = fixture.id(31_510)
  const firstSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-parallel-1')
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm31-parallel-2')
  const owner = await resolveOwnerScope(sql, ownerScope)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let signalFirst!: () => void
  const firstEntered = new Promise<void>((resolve) => {
    signalFirst = resolve
  })
  let signalSecond!: () => void
  const secondEntered = new Promise<void>((resolve) => {
    signalSecond = resolve
  })
  let first: Promise<unknown> | undefined
  let second: Promise<unknown> | undefined
  await runDatabaseTestWithCleanup(
    async () => {
      await insertRecoverableSession(
        sql,
        firstSessionId,
        fixture.id(31_501),
        fixture.id(31_502),
      )
      const endingHandler = {
        prepare: async () => ({
          kind: 'prepared' as const,
          mutation: {
            stateEffect: { kind: 'stateUnchanged' as const },
            lifecycleAfter: 'ended' as const,
            currentHandIdAfter: null,
            playerCoordinationAfter: {
              agentRunState: 'idle' as const,
              activePlayerRunId: null,
              activeDecisionRequestId: null,
            },
            privateEventDrafts: [
              {
                type: 'sessionEnded' as const,
                reason: 'userRequested' as const,
              },
            ] as const,
            relationPlan: Object.freeze({ kind: 'normalEnd' }),
          },
        }),
        applyRelations: async () => {},
      }
      const endedCommand = {
        sessionId: firstSessionId,
        commandId: fixture.id(31_505),
        expectedStateVersion: 1,
        type: 'endSession' as const,
        payload: {},
      }
      await expect(
        createM31Executor({
          sql: firstSql,
          owner,
          sessionId: firstSessionId,
          commandType: 'endSession',
          handler: endingHandler,
          eventId: fixture.id(31_504),
          commandAt: '2026-08-05T10:05:00.000Z',
        }).execute(endedCommand),
      ).resolves.toMatchObject({ kind: 'completed', origin: 'newCommit' })
      await insertM31RebuyableSession(
        sql,
        secondSessionId,
        fixture.id(31_511),
        fixture.id(31_512),
      )
      const firstExecutor = createM31Executor({
        sql: holdM31TransactionBeforeCommit(firstSql, signalFirst, gate),
        owner,
        sessionId: firstSessionId,
        commandType: 'endSession',
        handler: endingHandler,
        eventId: fixture.id(31_504),
        commandAt: '2026-08-05T10:05:00.000Z',
      })
      const secondExecutor = createM31Executor({
        sql: secondSql,
        owner,
        sessionId: secondSessionId,
        commandType: 'rebuy',
        handler: createM31RebuyHandler(fixture.id(31_513), async () => {
          signalSecond()
          await gate
        }),
        eventId: fixture.id(31_514),
        commandAt: '2026-08-05T10:05:01.000Z',
      })
      first = firstExecutor.execute(endedCommand)
      second = secondExecutor.execute({
        sessionId: secondSessionId,
        commandId: fixture.id(31_515),
        expectedStateVersion: 1,
        type: 'rebuy',
        payload: { amount: 500 },
      })
      await Promise.all([firstEntered, secondEntered])
      release()
      await expect(Promise.all([first, second])).resolves.toMatchObject([
        { kind: 'completed', origin: 'replay' },
        { kind: 'completed', origin: 'newCommit' },
      ])
    },
    async () =>
      cleanupM31ConcurrentFixture({
        runtimeUrl,
        role: 'm31-parallel-cleanup',
        release,
        clients: [firstSql, secondSql],
        operations: [first, second],
        sessionIds: [firstSessionId, secondSessionId],
      }),
  )
}

export async function assertM31SessionCommandExecutor(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const fixture = createDatabaseFixtureContext()
  const sessionId = fixture.id(31_100)
  const handId = fixture.id(31_101)
  const initialEventId = fixture.id(31_102)
  const commandId = fixture.id(31_103)
  const terminalEventId = fixture.id(31_104)
  const owner = await resolveOwnerScope(sql, ownerScope)
  try {
    await insertRecoverableSession(sql, sessionId, handId, initialEventId)
    const handler = {
      prepare: async () => ({
        kind: 'prepared' as const,
        mutation: {
          stateEffect: { kind: 'stateUnchanged' as const },
          lifecycleAfter: 'ended' as const,
          currentHandIdAfter: null,
          playerCoordinationAfter: {
            agentRunState: 'idle' as const,
            activePlayerRunId: null,
            activeDecisionRequestId: null,
          },
          privateEventDrafts: [
            { type: 'sessionEnded' as const, reason: 'userRequested' as const },
          ] as const,
          relationPlan: Object.freeze({ kind: 'normalEnd' }),
        },
      }),
      applyRelations: async () => {},
    }
    const executor = createM31Executor({
      sql,
      owner,
      sessionId,
      commandType: 'endSession',
      handler,
      eventId: terminalEventId,
      commandAt: '2026-08-05T10:00:00.000Z',
    })
    const command = {
      sessionId,
      commandId,
      expectedStateVersion: 1,
      type: 'endSession' as const,
      payload: {},
    }

    const committed = await executor.execute(command)
    expect(committed).toMatchObject({
      kind: 'completed',
      origin: 'newCommit',
      response: {
        snapshot: {
          lifecycleStatus: 'ended',
          stateVersion: 1,
          eventSeq: 1,
        },
      },
    })
    const replay = await executor.execute(command)
    expect(replay).toEqual({
      kind: 'completed',
      origin: 'replay',
      response: committed.kind === 'completed' ? committed.response : null,
    })

    const rows = await sql<
      {
        readonly lifecycleStatus: string
        readonly stateVersion: number
        readonly nextEventSeq: number
        readonly eventCount: number
        readonly ledgerCount: number
      }[]
    >`
      SELECT
        session.lifecycle_status AS "lifecycleStatus",
        session.state_version::int AS "stateVersion",
        session.next_event_seq::int AS "nextEventSeq",
        (SELECT count(*)::int FROM app_private.session_events AS event
         WHERE event.session_id = session.id) AS "eventCount",
        (SELECT count(*)::int FROM app_private.command_ledger AS ledger
         WHERE ledger.session_id = session.id) AS "ledgerCount"
      FROM app_private.sessions AS session
      WHERE session.id = ${sessionId}::uuid
    `
    expect(rows[0]).toEqual({
      lifecycleStatus: 'ended',
      stateVersion: 1,
      nextEventSeq: 2,
      eventCount: 2,
      ledgerCount: 1,
    })
  } finally {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
  await assertM31ConcurrentVersionConflict(sql, runtimeUrl)
  await assertM31FailureCleanupDoesNotPollute(sql, runtimeUrl)
  await assertM31WaiterAcquiresAfterRollback(sql, runtimeUrl)
  await assertM31AtomicCommitRollbackAndVisibility(sql, runtimeUrl)
  await assertM31DifferentSessionsRunInParallel(sql, runtimeUrl)
}
