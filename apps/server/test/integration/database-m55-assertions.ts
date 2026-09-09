import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { JSONValue, Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { createAgentCallQueryService } from '../../src/agents/audit/agent-call-query-service.js'
import { normalizeAgentCallListQuery } from '../../src/agents/audit/agent-call-query.js'
import {
  playerCandidateSetSnapshotCodec,
  playerModelChoiceCodec,
  playerValidatorResultCodec,
} from '../../src/agents/player/player-decision-audit-codec.js'
import { createPlayerValidatorResultV1 } from '../../src/agents/player/player-bounded-choice.js'
import { certifyPlayerDecisionPacketV1 } from '../../src/agents/player/player-decision-packet-leak-guard.js'
import { buildPlayerModelProjectionV1 } from '../../src/agents/player/player-model-projection.js'
import { initializePokerTable } from '../../src/poker/poker-engine.js'
import {
  loadAndValidatePersonaCatalog,
  type PersonaCatalog,
} from '../../src/personas/catalog.js'
import { PERSONA_CATALOG_DEFINITIONS } from '../../src/personas/catalog-definitions.js'
import { createAgentCallQueryRepository } from '../../src/persistence/agent-call-query-repository.js'
import { createAgentRunLifecycleRepository } from '../../src/persistence/agent-run-lifecycle-repository.js'
import { runDatabaseTransaction } from '../../src/persistence/database-transaction.js'
import type { ResolvedOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  clearOwnerSessionData,
  deleteEndedSessionData,
} from '../../src/persistence/session-deletion-repository.js'
import { productionSessionRecoveryRepository } from '../../src/persistence/session-recovery-repository.js'
import { productionSessionMutationRepository } from '../../src/persistence/session-mutation-repository.js'
import {
  patchPlayerTimeoutSettings,
  readResolvedPlayerTimeoutSettings,
} from '../../src/persistence/player-settings-repository.js'
import { insertAgentRunFixture } from '../helpers/agent-run-fixture.js'
import {
  readPlayerTimeoutSettingsRow,
  restorePlayerTimeoutSettingsRow,
} from '../helpers/player-timeout-settings-fixture.js'
import { createSessionManagementFactsRepository } from '../../src/persistence/session-management-query-repository.js'
import {
  createPrivateTableState,
  type PrivateTableState,
} from '../../src/sessions/authoritative-state/private-table-state.js'
import { createPrivateEvent } from '../../src/sessions/authoritative-state/private-event.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { currentCompletedHandResultReader } from '../../src/sessions/hand-audit/completed-hand-result-codec.js'
import { createSessionManagementQueryService } from '../../src/sessions/data-management/session-management-query-service.js'
import { normalizeSessionManagementQuery } from '../../src/sessions/data-management/session-management-query.js'
import {
  createM27CoachRunInput,
  insertCommittedM27CompletedHand,
} from './database-repository-assertions.js'
import {
  clearLocalOwnerSessions,
  projectPublicSnapshot,
} from './database-m32-assertions.js'
import { createDatabaseTestSqlForRole } from './database-test-runtime.js'
import { seedM47CommittedPlayerQueryFixture } from './database-m47-assertions.js'
import { createPlayerDecisionAuditFixture } from '../helpers/player-decision-packet-fixture.js'

const randomSource = Object.freeze({ nextInt: () => 0 })

function afterFirstBusinessReadSql(
  sql: Sql,
  afterRead: () => Promise<void>,
): Sql {
  const wrapper = (() => {
    throw new Error('M5.5 查询屏障只允许事务入口。')
  }) as unknown as Sql
  return Object.assign(wrapper, {
    begin: <Result>(
      operation: (transaction: TransactionSql) => Promise<Result>,
    ) =>
      sql.begin(async (transaction) => {
        let triggered = false
        const intercept = async <Rows>(
          statement: string,
          query: PromiseLike<Rows>,
        ): Promise<Rows> => {
          const rows = await query
          if (!triggered && !/^\s*SET\s+TRANSACTION\b/i.test(statement)) {
            triggered = true
            await afterRead()
          }
          return rows
        }
        const intercepted = new Proxy(transaction, {
          apply(target, _thisArgument, argumentsList) {
            const [strings] = argumentsList as [TemplateStringsArray]
            return intercept(
              taggedStatement(strings),
              Reflect.apply(target, target, argumentsList),
            )
          },
          get(target, property) {
            if (property === 'unsafe') {
              return (
                statement: string,
                parameters: (string | number | null)[],
              ) => intercept(statement, target.unsafe(statement, parameters))
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as TransactionSql
        return operation(intercepted)
      }),
  })
}

function afterSessionSnapshotReadSql(
  sql: Sql,
  input: {
    readonly ownerId: string
    readonly sessionId: string
    readonly afterSnapshotRead: () => Promise<void>
  },
): Sql {
  const wrapper = (() => {
    throw new Error('M5.5 场次一致视图屏障只允许事务入口。')
  }) as unknown as Sql
  return Object.assign(wrapper, {
    begin: <Result>(
      operation: (transaction: TransactionSql) => Promise<Result>,
    ) =>
      sql.begin((transaction) => {
        let snapshotEstablished = false
        const intercepted = new Proxy(transaction, {
          apply(target, _thisArgument, argumentsList) {
            return Reflect.apply(target, target, argumentsList)
          },
          get(target, property) {
            if (property === 'unsafe') {
              return async (
                statement: string,
                parameters: (string | number | null)[],
              ) => {
                if (!snapshotEstablished) {
                  snapshotEstablished = true
                  const rows = await target<
                    readonly { readonly sessionId: string }[]
                  >`
                    SELECT id::text AS "sessionId"
                    FROM app_private.sessions
                    WHERE id = ${input.sessionId}::uuid
                      AND owner_id = ${input.ownerId}::uuid
                  `
                  if (
                    rows.length !== 1 ||
                    rows[0]?.sessionId !== input.sessionId
                  ) {
                    throw new Error('M5.5 场次一致视图屏障无法建立快照。')
                  }
                  await input.afterSnapshotRead()
                }
                return target.unsafe(statement, parameters)
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as TransactionSql
        return operation(intercepted)
      }),
  })
}

async function endSessionThroughMutationRepository(
  sql: Sql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  state: PrivateTableState,
) {
  const endedAt = new Date().toISOString()
  return runDatabaseTransaction(sql, async (transaction) => {
    const locked =
      await productionSessionMutationRepository.lockSessionForMutation(
        transaction,
        owner,
        sessionId,
      )
    if (
      locked.stateVersion !== state.stateVersion ||
      locked.currentHandId !== null ||
      locked.agentRunState !== 'idle' ||
      locked.activePlayerRunId !== null ||
      locked.activeDecisionRequestId !== null ||
      state.poker.pokerPhase !== 'betweenHands' ||
      state.poker.hand !== null
    ) {
      throw new Error('M5.5 场次结束夹具不满足正式持久化写入前置条件。')
    }
    const privateEvent = createPrivateEvent({
      type: 'sessionEnded',
      reason: 'userRequested',
    })
    if (privateEvent.type !== 'sessionEnded') {
      throw new Error('M5.5 场次结束夹具生成了错误事件。')
    }
    const eventId = randomUUID()
    const eventSeq = locked.nextEventSeq
    const publicSnapshot = projectPublicSnapshot(
      state,
      {
        ...locked,
        lifecycleStatus: 'ended',
        endedAt,
      },
      eventSeq,
    )
    return productionSessionMutationRepository.persistSessionMutation(
      transaction,
      locked,
      {
        finalStateVersion: state.stateVersion,
        lifecycleStatus: 'ended',
        currentHandId: null,
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        snapshot: null,
        events: [
          {
            eventId,
            eventSeq,
            handId: null,
            commandLedgerId: null,
            stateVersionBefore: locked.stateVersion,
            stateVersionAfter: state.stateVersion,
            privateEvent:
              productionSessionMutationRepository.currentPrivateEventProtocol.encodeCurrent(
                privateEvent,
              ),
            publicEvent: {
              eventId,
              sessionId,
              eventSeq,
              stateVersion: state.stateVersion,
              type: 'sessionEnded',
              payload: { snapshot: publicSnapshot },
            },
            createdAt: endedAt,
          },
        ],
        mutationAt: endedAt,
      },
    )
  })
}

interface SqlMeasurement {
  readonly statement: string
  readonly parameters: (string | number | null)[]
  readonly rowCount: number
  readonly durationMs: number
}

function taggedStatement(strings: TemplateStringsArray): string {
  return strings.reduce(
    (statement, part, index) =>
      `${statement}${index === 0 ? '' : `$${index}`}${part}`,
    '',
  )
}

function observeReadSql(
  sql: Sql,
  observe: (measurement: SqlMeasurement) => Promise<void>,
): Sql {
  const wrapper = (() => {
    throw new Error('M5.5 SQL 观测只允许事务入口。')
  }) as unknown as Sql
  return Object.assign(wrapper, {
    begin: <Result>(
      operation: (transaction: TransactionSql) => Promise<Result>,
    ) =>
      sql.begin((transaction) => {
        const observed = new Proxy(transaction, {
          apply(target, _thisArgument, argumentsList) {
            const [strings, ...parameters] = argumentsList as [
              TemplateStringsArray,
              ...(string | number | null)[],
            ]
            const statement = taggedStatement(strings)
            const query = Reflect.apply(target, target, argumentsList)
            if (/^\s*SET\s+TRANSACTION\b/i.test(statement)) return query
            const startedAt = performance.now()
            return Promise.resolve(query).then(async (rows) => {
              await observe({
                statement,
                parameters,
                rowCount: (rows as { readonly length: number }).length,
                durationMs: performance.now() - startedAt,
              })
              return rows
            })
          },
          get(target, property) {
            if (property === 'unsafe') {
              return async (
                statement: string,
                parameters: (string | number | null)[],
              ) => {
                const startedAt = performance.now()
                const rows = await target.unsafe(statement, parameters)
                await observe({
                  statement,
                  parameters,
                  rowCount: rows.length,
                  durationMs: performance.now() - startedAt,
                })
                return rows
              }
            }
            const value = Reflect.get(target, property, target)
            return typeof value === 'function' ? value.bind(target) : value
          },
        }) as TransactionSql
        return operation(observed)
      }),
  })
}

async function assertBoundedPagePlan(
  sql: Sql,
  measurements: readonly SqlMeasurement[],
  input: {
    readonly pageTable: string
    readonly excludedTables: readonly string[]
  },
): Promise<void> {
  expect(measurements).toHaveLength(2)
  const page = measurements[1]
  if (page === undefined) {
    throw new Error(`M5.5 缺少 ${input.pageTable} 子页 SQL 观测。`)
  }
  expect(page.statement).toContain(input.pageTable)
  expect(page.rowCount).toBeLessThanOrEqual(2)
  expect(Number.isFinite(page.durationMs)).toBe(true)
  expect(page.durationMs).toBeGreaterThanOrEqual(0)
  const plan = await sql.unsafe(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${page.statement}`,
    page.parameters,
  )
  const serializedPlan = JSON.stringify(plan[0])
  expect(serializedPlan).toMatch(/Actual Rows/)
  expect(serializedPlan).toMatch(/Actual Total Time/)
  expect(serializedPlan).toMatch(/Total Cost/)
  for (const excludedTable of input.excludedTables) {
    expect(serializedPlan).not.toContain(excludedTable)
  }
}

async function seedOtherOwnerM55Fixture(sql: Sql) {
  const primaryRows = await sql<readonly { readonly ownerId: string }[]>`
    SELECT id::text AS "ownerId"
    FROM app_private.owners
    WHERE identity_key = 'local-user'
  `
  const primaryOwnerId = primaryRows[0]?.ownerId
  if (primaryOwnerId === undefined || primaryRows.length !== 1) {
    throw new Error('M5.5 缺少唯一 local Owner。')
  }
  const otherOwnerId = randomUUID()
  const primaryTemporaryIdentity = `m55-primary-${randomUUID()}`
  const otherIdentity = `m55-other-${randomUUID()}`
  let identitiesSwapped = false
  try {
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE app_private.owners
        SET identity_key = ${primaryTemporaryIdentity}
        WHERE id = ${primaryOwnerId}::uuid
      `
      await transaction`
        INSERT INTO app_private.owners (id, identity_key)
        VALUES (${otherOwnerId}::uuid, 'local-user')
      `
    })
    identitiesSwapped = true
    const fixture = await seedM55QueryFixture(sql)
    await sql.begin(async (transaction) => {
      await transaction`
        UPDATE app_private.owners
        SET identity_key = ${otherIdentity}
        WHERE id = ${otherOwnerId}::uuid
      `
      await transaction`
        UPDATE app_private.owners
        SET identity_key = 'local-user'
        WHERE id = ${primaryOwnerId}::uuid
      `
    })
    identitiesSwapped = false
    return { fixture, otherOwnerId }
  } catch (error) {
    if (identitiesSwapped) {
      await sql.begin(async (transaction) => {
        await transaction`
          UPDATE app_private.owners
          SET identity_key = ${otherIdentity}
          WHERE id = ${otherOwnerId}::uuid
        `
        await transaction`
          UPDATE app_private.owners
          SET identity_key = 'local-user'
          WHERE id = ${primaryOwnerId}::uuid
        `
      })
    }
    await sql`DELETE FROM app_private.owners WHERE id = ${otherOwnerId}::uuid`
    throw error
  }
}

export async function seedM55QueryFixture(
  sql: Sql,
  options: { readonly catalog?: PersonaCatalog } = {},
) {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const playerIds = Array.from({ length: 6 }, () => randomUUID())
  try {
    const owner = await insertCommittedM27CompletedHand(
      sql,
      sessionId,
      handId,
      {
        playerIds,
        initialStack: 2_000,
        ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
      },
    )
    const poker = initializePokerTable(
      playerIds.map((playerId, seatNumber) => ({
        seatNumber,
        playerId,
        isUser: seatNumber === 0,
        stack: seatNumber === 0 ? 3_700 : seatNumber === 1 ? 2_300 : 2_000,
        status: 'active' as const,
        streetContribution: 0,
        totalContribution: 0,
      })),
      randomSource,
    )
    const completedRows = await sql<
      {
        readonly payloadVersion: number
        readonly payload: unknown
      }[]
    >`
      SELECT completed_result_payload_version AS "payloadVersion",
        completed_result_payload AS payload
      FROM app_private.hands
      WHERE id = ${handId}::uuid
    `
    const completed = currentCompletedHandResultReader.read(
      completedRows[0]?.payloadVersion,
      completedRows[0]?.payload,
    )
    if (completed.kind !== 'decoded') {
      throw new Error('M5.5 fixture 缺少有效完成手结果。')
    }
    const state = createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 1,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: seat.seatNumber === 0 ? 4_000 : 2_000,
      })),
      lastCompletedHandSummary: completed.value.summary,
    })
    const snapshot = encodeSnapshot(state)
    await sql`
      INSERT INTO app_private.session_snapshots (
        session_id, owner_id, private_table_state_payload_version,
        private_table_state_payload
      ) VALUES (
        ${sessionId}::uuid, ${owner.databaseOwnerId}::uuid,
        ${snapshot.payloadVersion},
        ${sql.json(snapshot.payload as unknown as JSONValue)}
      )
    `
    await sql`
      UPDATE app_private.sessions
      SET state_version = 7, current_hand_id = NULL
      WHERE id = ${sessionId}::uuid
    `
    const runId = randomUUID()
    await sql.begin((transaction) =>
      insertAgentRunFixture(
        transaction,
        owner,
        createM27CoachRunInput(sessionId, handId, runId),
      ),
    )
    return {
      identity: {
        sessionId,
        handId,
        userParticipantId: playerIds[0]!,
        agentParticipants: [{ participantId: playerIds[1]! }],
      },
      owner,
      runId,
      state,
    }
  } catch (error) {
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
    throw error
  }
}

async function installCurrentDecisionQueryPayloads(
  sql: Sql,
  decisionId: string,
): Promise<void> {
  const { snapshot } = createPlayerDecisionAuditFixture()
  const projection = buildPlayerModelProjectionV1(snapshot)
  const packet = certifyPlayerDecisionPacketV1({
    snapshot,
    decisionRecordId: decisionId,
    projection,
  })
  const selected = snapshot.candidates.candidates.find(
    (candidate) => candidate.action.type === 'fold',
  )
  if (selected === undefined) {
    throw new Error('M5.5 查询夹具缺少候选行动。')
  }
  const choice = { candidateActionId: selected.candidateId }
  const validator = createPlayerValidatorResultV1({ packet, choice })
  const candidates = playerCandidateSetSnapshotCodec.encode(snapshot.candidates)
  const encodedChoice = playerModelChoiceCodec.encode(choice)
  const encodedValidator = playerValidatorResultCodec.encode(validator)
  await sql`
    UPDATE app_private.player_decisions
    SET candidate_set_payload_version = ${candidates.payloadVersion},
        candidate_set_payload = ${sql.json(candidates.payload as unknown as JSONValue)},
        model_choice_payload_version = ${encodedChoice.payloadVersion},
        model_choice_payload = ${sql.json(encodedChoice.payload as unknown as JSONValue)},
        validator_result_payload_version = ${encodedValidator.payloadVersion},
        validator_result_payload = ${sql.json(encodedValidator.payload as unknown as JSONValue)}
    WHERE id = ${decisionId}::uuid
  `
}

export async function assertM55SessionAndAgentCallQueries(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionIds: string[] = []
  let otherOwnerId: string | undefined
  let otherSessionId: string | undefined
  let restoreSettings: (() => Promise<void>) | undefined
  await clearLocalOwnerSessions(sql)
  await sql`
    DELETE FROM app_private.sessions
    WHERE owner_id IN (
      SELECT id FROM app_private.owners
      WHERE identity_key LIKE 'm55-other-%'
         OR identity_key LIKE 'm55-primary-%'
    )
  `
  await sql`
    DELETE FROM app_private.owners
    WHERE identity_key LIKE 'm55-other-%'
       OR identity_key LIKE 'm55-primary-%'
  `
  try {
    const historicalDefinitions = structuredClone(
      PERSONA_CATALOG_DEFINITIONS,
    ) as unknown as Record<string, unknown>[]
    const historicalDefinition = historicalDefinitions.find(
      ({ personaId }) => personaId === 'nit_fish',
    )
    if (historicalDefinition === undefined) {
      throw new Error('M5.5 缺少历史人物定义。')
    }
    historicalDefinition.name = 'M5.5 历史紧弱鱼'
    historicalDefinition.avatarColor = '#123456'
    const historicalCatalog = loadAndValidatePersonaCatalog(
      historicalDefinitions,
    )
    const ended = await seedM55QueryFixture(sql, {
      catalog: historicalCatalog,
    })
    sessionIds.push(ended.identity.sessionId)
    await sql`
      UPDATE app_private.sessions
      SET lifecycle_status = 'ended', ended_at = clock_timestamp()
      WHERE id = ${ended.identity.sessionId}::uuid
    `
    const diagnostic = await seedM55QueryFixture(sql)
    sessionIds.push(diagnostic.identity.sessionId)
    const removedDiagnosticSnapshots = await sql.begin(async (transaction) => {
      const removed = await transaction<
        readonly { readonly sessionId: string }[]
      >`
        DELETE FROM app_private.session_snapshots
        WHERE session_id = ${diagnostic.identity.sessionId}::uuid
          AND owner_id = ${diagnostic.owner.databaseOwnerId}::uuid
        RETURNING session_id::text AS "sessionId"
      `
      await transaction`
        UPDATE app_private.sessions
        SET lifecycle_status = 'readonlyDiagnostic',
            diagnostic_code = 'snapshotMissing', diagnosed_at = clock_timestamp()
        WHERE id = ${diagnostic.identity.sessionId}::uuid
          AND owner_id = ${diagnostic.owner.databaseOwnerId}::uuid
      `
      return removed
    })
    expect(removedDiagnosticSnapshots).toEqual([
      { sessionId: diagnostic.identity.sessionId },
    ])
    const fixture = await seedM55QueryFixture(sql)
    sessionIds.push(fixture.identity.sessionId)
    const otherOwner = await seedOtherOwnerM55Fixture(sql)
    otherOwnerId = otherOwner.otherOwnerId
    otherSessionId = otherOwner.fixture.identity.sessionId
    await sql`
      UPDATE app_private.sessions
      SET created_at = '2026-09-08T08:00:00.123456Z'::timestamptz
      WHERE id = ANY(${[
        ended.identity.sessionId,
        diagnostic.identity.sessionId,
        fixture.identity.sessionId,
      ]}::uuid[])
    `
    const sessions = createSessionManagementQueryService({
      reader: createSessionManagementFactsRepository({
        sql,
        owner: fixture.owner,
      }),
    })
    const rootPageMeasurements: SqlMeasurement[] = []
    const measuredSessions = createSessionManagementQueryService({
      reader: createSessionManagementFactsRepository({
        sql: observeReadSql(sql, async (measurement) => {
          rootPageMeasurements.push({
            ...measurement,
            parameters: [...measurement.parameters],
          })
        }),
        owner: fixture.owner,
      }),
    })
    await expect(
      measuredSessions.list(
        normalizeSessionManagementQuery(new URLSearchParams('limit=1')),
      ),
    ).resolves.toMatchObject({ items: [expect.any(Object)] })
    expect(rootPageMeasurements).toHaveLength(1)
    expect(rootPageMeasurements[0]?.rowCount).toBeLessThanOrEqual(2)
    expect(Number.isFinite(rootPageMeasurements[0]?.durationMs)).toBe(true)
    const rootMeasurement = rootPageMeasurements[0]
    if (rootMeasurement === undefined) {
      throw new Error('M5.5 缺少根页 SQL 观测。')
    }
    const plan = await sql.unsafe(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${rootMeasurement.statement}`,
      rootMeasurement.parameters,
    )
    const rootPlan = JSON.stringify(plan[0])
    expect(rootPlan).toMatch(/Actual Rows/)
    expect(rootPlan).toMatch(/Actual Total Time/)
    expect(rootPlan).toMatch(/Total Cost/)
    expect(rootPlan).not.toMatch(
      /agent_attempts|agent_capability_invocations|player_decisions/,
    )
    const seenSessions: unknown[] = []
    let sessionQuery = normalizeSessionManagementQuery(
      new URLSearchParams('limit=1&sort=oldest'),
    )
    for (let pageNumber = 0; pageNumber < 4; pageNumber += 1) {
      const page = await sessions.list(sessionQuery)
      expect(page.items).toHaveLength(1)
      expect(page.items[0]?.roster).toHaveLength(6)
      seenSessions.push(page.items[0])
      if (page.nextCursor === null) break
      sessionQuery = normalizeSessionManagementQuery(
        new URLSearchParams(`limit=1&sort=oldest&cursor=${page.nextCursor}`),
      )
    }
    expect(seenSessions).toHaveLength(3)
    expect(seenSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          lifecycle: 'active',
          accounting: {
            status: 'available',
            stateVersion: 7,
            seats: expect.any(Array),
          },
        }),
        expect.objectContaining({
          lifecycle: 'ended',
          accounting: {
            status: 'available',
            stateVersion: 7,
            seats: expect.any(Array),
          },
        }),
        expect.objectContaining({
          sessionId: diagnostic.identity.sessionId,
          lifecycle: 'readonlyDiagnostic',
          accounting: { status: 'unavailable', reason: 'readonlyDiagnostic' },
        }),
      ]),
    )
    const oldestIds = seenSessions.map(
      (item) => (item as { readonly sessionId: string }).sessionId,
    )
    const newestIds: string[] = []
    let newestQuery = normalizeSessionManagementQuery(
      new URLSearchParams('limit=1&sort=newest'),
    )
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await sessions.list(newestQuery)
      const item = page.items[0]
      if (item === undefined) throw new Error('M5.5 newest 分页缺少场次。')
      newestIds.push(item.sessionId)
      if (page.nextCursor === null) break
      newestQuery = normalizeSessionManagementQuery(
        new URLSearchParams(`limit=1&sort=newest&cursor=${page.nextCursor}`),
      )
    }
    expect(newestIds).toEqual([...oldestIds].reverse())

    const endedPage = await sessions.list(
      normalizeSessionManagementQuery(
        new URLSearchParams('lifecycle=ended&limit=1'),
      ),
    )
    const endedItem = endedPage.items[0]
    expect(endedItem?.sessionId).toBe(ended.identity.sessionId)
    expect(endedItem?.accounting).toMatchObject({
      status: 'available',
      seats: expect.arrayContaining([
        {
          participantId: ended.identity.userParticipantId,
          seatNumber: 0,
          initialChips: 2_000,
          currentChips: 3_700,
          cumulativeBuyIn: 4_000,
          finalChips: 3_700,
          sessionNetChange: -300,
        },
      ]),
    })
    const historicalAgents = await sql<
      readonly {
        readonly participantId: string
        readonly displayName: string
        readonly avatarColor: string
        readonly configSnapshotKey: string
      }[]
    >`
      SELECT participant_id::text AS "participantId",
        display_name AS "displayName", avatar_color AS "avatarColor",
        config_snapshot_key AS "configSnapshotKey"
      FROM app_private.session_agents
      WHERE session_id = ${ended.identity.sessionId}::uuid
      ORDER BY participant_id
    `
    const historicalNitFish = historicalAgents.find(
      ({ participantId }) =>
        participantId === ended.identity.agentParticipants[0]?.participantId,
    )
    const currentNitFish =
      loadAndValidatePersonaCatalog().getPublicSummary('nit_fish')
    expect(historicalNitFish).toMatchObject({
      displayName: 'M5.5 历史紧弱鱼',
      avatarColor: '#123456',
    })
    expect(currentNitFish).toBeDefined()
    expect(historicalNitFish?.displayName).not.toBe(currentNitFish?.name)
    expect(historicalNitFish?.avatarColor).not.toBe(currentNitFish?.avatarColor)
    for (const historical of historicalAgents) {
      expect(endedItem?.roster).toContainEqual(
        expect.objectContaining(historical),
      )
    }

    const sessionConsistencySql = createDatabaseTestSqlForRole(
      runtimeUrl,
      'm55-session-writer',
    )
    try {
      let sessionEndCommitted = false
      const consistentSessions = createSessionManagementQueryService({
        reader: createSessionManagementFactsRepository({
          sql: afterSessionSnapshotReadSql(sql, {
            ownerId: fixture.owner.databaseOwnerId,
            sessionId: fixture.identity.sessionId,
            afterSnapshotRead: async () => {
              const endedResult = await endSessionThroughMutationRepository(
                sessionConsistencySql,
                fixture.owner,
                fixture.identity.sessionId,
                fixture.state,
              )
              expect(endedResult).toMatchObject({
                sessionId: fixture.identity.sessionId,
                finalStateVersion: 7,
                firstEventSeq: 0,
                lastEventSeq: 0,
                nextEventSeq: 1,
              })
              sessionEndCommitted = true
            },
          }),
          owner: fixture.owner,
        }),
      })
      const inFlightActivePage = await consistentSessions.list(
        normalizeSessionManagementQuery(
          new URLSearchParams('lifecycle=active&limit=100'),
        ),
      )
      expect(sessionEndCommitted).toBe(true)
      expect(inFlightActivePage.items).toContainEqual(
        expect.objectContaining({
          sessionId: fixture.identity.sessionId,
          lifecycle: 'active',
          endedAt: null,
          accounting: expect.objectContaining({
            status: 'available',
            seats: expect.arrayContaining([
              expect.objectContaining({
                participantId: fixture.identity.userParticipantId,
                finalChips: null,
                sessionNetChange: null,
              }),
            ]),
          }),
        }),
      )
      const refreshedEndedPage = await sessions.list(
        normalizeSessionManagementQuery(
          new URLSearchParams('lifecycle=ended&limit=100'),
        ),
      )
      expect(refreshedEndedPage.items).toContainEqual(
        expect.objectContaining({
          sessionId: fixture.identity.sessionId,
          lifecycle: 'ended',
          endedAt: expect.any(String),
          accounting: expect.objectContaining({
            status: 'available',
            seats: expect.arrayContaining([
              expect.objectContaining({
                participantId: fixture.identity.userParticipantId,
                finalChips: 3_700,
                sessionNetChange: -300,
              }),
            ]),
          }),
        }),
      )
    } finally {
      await sessionConsistencySql.end({ timeout: 0 })
    }

    const calls = createAgentCallQueryService({
      reader: createAgentCallQueryRepository({ sql, owner: fixture.owner }),
    })
    const secondRunId = randomUUID()
    const failedBeforeDecisionRunId = randomUUID()
    await sql.begin((transaction) =>
      insertAgentRunFixture(
        transaction,
        fixture.owner,
        createM27CoachRunInput(
          fixture.identity.sessionId,
          fixture.identity.handId,
          secondRunId,
        ),
      ),
    )
    const failedRunCreatedAt = new Date().toISOString()
    await sql.begin((transaction) =>
      insertAgentRunFixture(transaction, fixture.owner, {
        ...createM27CoachRunInput(
          fixture.identity.sessionId,
          fixture.identity.handId,
          failedBeforeDecisionRunId,
        ),
        createdAt: failedRunCreatedAt,
        deadlineAt: new Date(Date.now() + 45_000).toISOString(),
      }),
    )
    const runLifecycle = createAgentRunLifecycleRepository()
    const leasedFailure = await runDatabaseTransaction(
      sql,
      async (transaction) => {
        const claim = await runLifecycle.claimNext(
          transaction,
          fixture.owner,
          { runtimeType: 'coach', leaseOwner: 'm55-failed-before-decision' },
          (candidate) =>
            candidate.runId === failedBeforeDecisionRunId
              ? { kind: 'eligible' }
              : {
                  kind: 'rejected',
                  diagnostic: 'agent_run_runtime_unavailable',
                },
        )
        if (
          claim.kind !== 'claimed' ||
          claim.value.run.runId !== failedBeforeDecisionRunId
        ) {
          throw new Error('M5.5 未能精确领取 Decision 前失败的 Run。')
        }
        return claim.value.run
      },
    )
    const failedRunAuthority = issueRuntimeCommitAuthority({
      runtimeType: 'coach',
      runId: leasedFailure.runId,
      leaseOwner: leasedFailure.leaseOwner,
      fencingToken: leasedFailure.fencingToken,
    })
    const runningFailure = await runDatabaseTransaction(sql, (transaction) =>
      runLifecycle.markRunning(transaction, fixture.owner, failedRunAuthority),
    )
    if (runningFailure.startedAt === null) {
      throw new Error('M5.5 Decision 前失败的 Run 未进入 running。')
    }
    const audit = createAgentFoundationAuditRepository()
    const startedAttempt = await runDatabaseTransaction(sql, (transaction) =>
      audit.startBudgetedAgentAttemptAudit(
        transaction,
        fixture.owner,
        failedRunAuthority,
        {
          sessionId: fixture.identity.sessionId,
          agentRunId: failedBeforeDecisionRunId,
          stage: 'coach.consistency-check',
          provider: 'deepseek',
          model: 'deepseek-chat',
          attemptType: 'initial',
          routingReasonCode: null,
          estimatedInputTokens: 10,
          requestedMaximumOutputTokens: 10,
          reservedCostMicrounits: 1,
          requestProjectionHash: '7'.repeat(64),
        },
      ),
    )
    if (startedAttempt.kind !== 'started') {
      throw new Error('M5.5 一致视图夹具无法启动 Attempt。')
    }
    const reservedInvocation = await runDatabaseTransaction(
      sql,
      (transaction) =>
        audit.reserveCapabilityInvocationAudit(
          transaction,
          fixture.owner,
          failedRunAuthority,
          {
            sessionId: fixture.identity.sessionId,
            agentRunId: failedBeforeDecisionRunId,
            capabilityName: 'coach.consistency-check',
            capabilityVersion: 1,
            inputSchemaVersion: 1,
            inputHash: '8'.repeat(64),
            grantMaximum: 1,
            startedAt: new Date().toISOString(),
          },
        ),
    )
    if (reservedInvocation.kind !== 'reserved') {
      throw new Error('M5.5 一致视图夹具无法预留 Capability Invocation。')
    }
    const auditConsistencySql = createDatabaseTestSqlForRole(
      runtimeUrl,
      'm55-audit-writer',
    )
    try {
      let attemptFinishCommitted = false
      const consistentAttemptCalls = createAgentCallQueryService({
        reader: createAgentCallQueryRepository({
          sql: afterFirstBusinessReadSql(sql, async () => {
            await expect(
              runDatabaseTransaction(auditConsistencySql, (transaction) =>
                audit.finishAgentAttemptAudit(
                  transaction,
                  fixture.owner,
                  failedRunAuthority,
                  {
                    sessionId: fixture.identity.sessionId,
                    agentRunId: failedBeforeDecisionRunId,
                    attemptId: startedAttempt.attemptId,
                    lifecycle: 'failed',
                    accepted: false,
                    stale: false,
                    interrupted: false,
                    inputTokens: 0,
                    outputTokens: 0,
                    costMicrounits: 0,
                    durationMs: 1,
                    errorCode: 'provider_timeout',
                    responseProjectionHash: null,
                    validationStatus: 'notRun',
                    usageAccounting: 'notIncurred',
                    costAccounting: 'notIncurred',
                    completedAt: new Date().toISOString(),
                  },
                ),
              ),
            ).resolves.toBe('recorded')
            attemptFinishCommitted = true
          }),
          owner: fixture.owner,
        }),
      })
      await expect(
        consistentAttemptCalls.listAttempts(failedBeforeDecisionRunId, {
          limit: 100,
          after: null,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            attemptId: startedAttempt.attemptId,
            lifecycle: 'started',
            completedAt: null,
            durationMs: null,
            errorCode: null,
            usage: {
              inputTokens: null,
              outputTokens: null,
              accounting: 'pending',
            },
          },
        ],
      })
      expect(attemptFinishCommitted).toBe(true)
      await expect(
        calls.listAttempts(failedBeforeDecisionRunId, {
          limit: 100,
          after: null,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            attemptId: startedAttempt.attemptId,
            lifecycle: 'failed',
            completedAt: expect.any(String),
            durationMs: 1,
            errorCode: 'provider_timeout',
            usage: {
              inputTokens: 0,
              outputTokens: 0,
              accounting: 'notIncurred',
            },
          },
        ],
      })

      let invocationFinishCommitted = false
      const consistentCapabilityCalls = createAgentCallQueryService({
        reader: createAgentCallQueryRepository({
          sql: afterFirstBusinessReadSql(sql, async () => {
            await expect(
              runDatabaseTransaction(auditConsistencySql, (transaction) =>
                audit.finishCapabilityInvocationAudit(
                  transaction,
                  fixture.owner,
                  failedRunAuthority,
                  {
                    sessionId: fixture.identity.sessionId,
                    agentRunId: failedBeforeDecisionRunId,
                    invocationId: reservedInvocation.invocationId,
                    capabilityName: 'coach.consistency-check',
                    capabilityVersion: 1,
                    authorized: true,
                    inputSchemaVersion: 1,
                    inputHash: '8'.repeat(64),
                    outputSchemaVersion: 1,
                    outputHash: '9'.repeat(64),
                    budgetCost: 1,
                    durationMs: 1,
                    errorCode: null,
                    completedAt: new Date().toISOString(),
                  },
                ),
              ),
            ).resolves.toBe('recorded')
            invocationFinishCommitted = true
          }),
          owner: fixture.owner,
        }),
      })
      await expect(
        consistentCapabilityCalls.listCapabilityInvocations(
          failedBeforeDecisionRunId,
          { limit: 100, after: null },
        ),
      ).resolves.toMatchObject({
        items: [
          {
            invocationId: reservedInvocation.invocationId,
            completedAt: null,
            durationMs: null,
            outputSchemaVersion: null,
            outputHash: null,
            errorCode: null,
          },
        ],
      })
      expect(invocationFinishCommitted).toBe(true)
      await expect(
        calls.listCapabilityInvocations(failedBeforeDecisionRunId, {
          limit: 100,
          after: null,
        }),
      ).resolves.toMatchObject({
        items: [
          {
            invocationId: reservedInvocation.invocationId,
            completedAt: expect.any(String),
            durationMs: 1,
            outputSchemaVersion: 1,
            outputHash: '9'.repeat(64),
            errorCode: null,
          },
        ],
      })
    } finally {
      await auditConsistencySql.end({ timeout: 0 })
    }
    const failedRunCompletedAt = new Date().toISOString()
    await expect(
      runDatabaseTransaction(sql, (transaction) =>
        runLifecycle.finalize(transaction, fixture.owner, {
          runId: failedBeforeDecisionRunId,
          authority: failedRunAuthority,
          lifecycle: 'failed',
          terminationReason: 'provider_timeout',
          completedAt: failedRunCompletedAt,
        }),
      ),
    ).resolves.toMatchObject({
      changed: true,
      run: {
        runId: failedBeforeDecisionRunId,
        lifecycle: 'failed',
        terminationReason: 'provider_timeout',
      },
    })
    const runs = await calls.listRuns(
      fixture.identity.handId,
      normalizeAgentCallListQuery(
        new URLSearchParams('limit=1'),
        'handAgentRuns',
        fixture.identity.handId,
      ),
    )
    expect(runs.hand).toMatchObject({
      handId: fixture.identity.handId,
      status: 'completed',
    })
    expect(runs.items).toHaveLength(1)
    expect(runs.items[0]).toMatchObject({ runtime: 'coach' })
    expect(runs.nextCursor).toEqual(expect.any(String))
    const nextRuns = await calls.listRuns(
      fixture.identity.handId,
      normalizeAgentCallListQuery(
        new URLSearchParams(`limit=1&cursor=${runs.nextCursor}`),
        'handAgentRuns',
        fixture.identity.handId,
      ),
    )
    expect(nextRuns.items).toHaveLength(1)
    expect(nextRuns.nextCursor).toEqual(expect.any(String))
    const finalRuns = await calls.listRuns(
      fixture.identity.handId,
      normalizeAgentCallListQuery(
        new URLSearchParams(`limit=1&cursor=${nextRuns.nextCursor}`),
        'handAgentRuns',
        fixture.identity.handId,
      ),
    )
    expect(finalRuns.items).toHaveLength(1)
    expect(finalRuns.nextCursor).toBeNull()
    expect(
      [
        runs.items[0]?.runId,
        nextRuns.items[0]?.runId,
        finalRuns.items[0]?.runId,
      ].sort(),
    ).toEqual([fixture.runId, secondRunId, failedBeforeDecisionRunId].sort())
    await expect(
      calls.readRun(failedBeforeDecisionRunId),
    ).resolves.toMatchObject({
      runId: failedBeforeDecisionRunId,
      lifecycle: 'failed',
      terminationReasonCode: 'provider_timeout',
      decision: { kind: 'none' },
      commandEventRange: null,
    })
    await expect(calls.readRun(fixture.runId)).resolves.toMatchObject({
      runId: fixture.runId,
      lifecycle: 'queued',
      decision: { kind: 'none' },
      commandEventRange: null,
    })
    await expect(
      calls.listAttempts(fixture.runId, {
        limit: 1,
        after: null,
      }),
    ).resolves.toMatchObject({ items: [], nextCursor: null })
    await expect(
      calls.listRuns(otherOwner.fixture.identity.handId, {
        limit: 1,
        after: null,
      }),
    ).rejects.toThrow()

    const concurrentSql = createDatabaseTestSqlForRole(
      runtimeUrl,
      'm55-consistency-writer',
    )
    try {
      let concurrentCancellationCommitted = false
      const consistentCalls = createAgentCallQueryService({
        reader: createAgentCallQueryRepository({
          sql: afterFirstBusinessReadSql(sql, async () => {
            await runDatabaseTransaction(concurrentSql, (transaction) =>
              createAgentRunLifecycleRepository().cancel(
                transaction,
                fixture.owner,
                {
                  runId: secondRunId,
                  reason: 'user_cancelled',
                  completedAt: new Date().toISOString(),
                },
              ),
            )
            concurrentCancellationCommitted = true
          }),
          owner: fixture.owner,
        }),
      })
      const consistentPage = await consistentCalls.listRuns(
        fixture.identity.handId,
        { limit: 100, after: null },
      )
      expect(concurrentCancellationCommitted).toBe(true)
      expect(consistentPage.items).toContainEqual(
        expect.objectContaining({ runId: secondRunId, lifecycle: 'queued' }),
      )
      await expect(
        calls.listRuns(fixture.identity.handId, {
          limit: 100,
          after: null,
        }),
      ).resolves.toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({
            runId: secondRunId,
            lifecycle: 'cancelled',
          }),
        ]),
      })

      let concurrentDeleteCommitted = false
      const concurrentCalls = createAgentCallQueryService({
        reader: createAgentCallQueryRepository({
          sql: afterFirstBusinessReadSql(sql, async () => {
            await concurrentSql`
              DELETE FROM app_private.sessions
              WHERE id = ${fixture.identity.sessionId}::uuid
            `
            concurrentDeleteCommitted = true
          }),
          owner: fixture.owner,
        }),
      })
      await expect(
        concurrentCalls.listRuns(fixture.identity.handId, {
          limit: 1,
          after: null,
        }),
      ).resolves.toMatchObject({
        items: [expect.objectContaining({ runId: expect.any(String) })],
      })
      expect(concurrentDeleteCommitted).toBe(true)
      await expect(
        calls.listRuns(fixture.identity.handId, { limit: 1, after: null }),
      ).rejects.toThrow()
    } finally {
      await concurrentSql.end({ timeout: 0 })
    }

    const checkpoint = await sql<readonly { readonly payload: unknown }[]>`
      SELECT hand_start_checkpoint_payload AS payload
      FROM app_private.hands
      WHERE id = ${ended.identity.handId}::uuid
    `
    await sql`
      UPDATE app_private.hands
      SET hand_start_checkpoint_payload = jsonb_set(
        hand_start_checkpoint_payload,
        '{checkpoint,stateBeforeStartCommand,poker,seats,0,playerId}',
        to_jsonb(${randomUUID()}::text)
      )
      WHERE id = ${ended.identity.handId}::uuid
    `
    await expect(
      sessions.list(
        normalizeSessionManagementQuery(
          new URLSearchParams('lifecycle=ended&limit=1'),
        ),
      ),
    ).rejects.toThrow()
    await sql`
      UPDATE app_private.hands
      SET hand_start_checkpoint_payload = ${sql.json(checkpoint[0]?.payload as JSONValue)}
      WHERE id = ${ended.identity.handId}::uuid
    `

    const committed = await seedM47CommittedPlayerQueryFixture(sql)
    sessionIds.push(committed.sessionId)
    await sql`
      UPDATE app_private.sessions
      SET current_hand_id = ${committed.handId}::uuid
      WHERE id = ${committed.sessionId}::uuid
    `
    const beforeRejectedRead = await sql<
      readonly { readonly updatedAt: string }[]
    >`
      SELECT updated_at::text AS "updatedAt"
      FROM app_private.sessions
      WHERE id = ${committed.sessionId}::uuid
    `
    await expect(
      sessions.list(
        normalizeSessionManagementQuery(
          new URLSearchParams('lifecycle=active&limit=100'),
        ),
      ),
    ).rejects.toThrow()
    const afterRejectedRead = await sql<
      readonly { readonly updatedAt: string }[]
    >`
      SELECT updated_at::text AS "updatedAt"
      FROM app_private.sessions
      WHERE id = ${committed.sessionId}::uuid
    `
    expect(afterRejectedRead).toEqual(beforeRejectedRead)
    const recovered = await sql.begin((transaction) =>
      productionSessionRecoveryRepository.recoverSessionForMutation(
        transaction,
        committed.owner,
        committed.sessionId,
        new Date().toISOString(),
      ),
    )
    expect(recovered).toMatchObject({
      kind: 'ready',
      pointerRepair: { from: committed.handId, to: null },
    })
    const recoveredPage = await sessions.list(
      normalizeSessionManagementQuery(
        new URLSearchParams('lifecycle=active&limit=100'),
      ),
    )
    expect(recoveredPage.items).toContainEqual(
      expect.objectContaining({
        sessionId: committed.sessionId,
        currentHandId: null,
      }),
    )
    await installCurrentDecisionQueryPayloads(sql, committed.decisionId)
    const committedCalls = createAgentCallQueryService({
      reader: createAgentCallQueryRepository({
        sql,
        owner: committed.owner,
      }),
    })
    const runPageMeasurements: SqlMeasurement[] = []
    const measuredRunCalls = createAgentCallQueryService({
      reader: createAgentCallQueryRepository({
        sql: observeReadSql(sql, async (measurement) => {
          runPageMeasurements.push(measurement)
        }),
        owner: committed.owner,
      }),
    })
    await expect(
      measuredRunCalls.listRuns(committed.handId, {
        limit: 1,
        after: null,
      }),
    ).resolves.toMatchObject({ items: [expect.any(Object)] })
    await assertBoundedPagePlan(sql, runPageMeasurements, {
      pageTable: 'app_private.agent_runs',
      excludedTables: [
        'agent_attempts',
        'agent_capability_invocations',
        'player_decisions',
        'agent_memory_revisions',
      ],
    })

    const attemptPageMeasurements: SqlMeasurement[] = []
    const measuredAttemptCalls = createAgentCallQueryService({
      reader: createAgentCallQueryRepository({
        sql: observeReadSql(sql, async (measurement) => {
          attemptPageMeasurements.push(measurement)
        }),
        owner: committed.owner,
      }),
    })
    await expect(
      measuredAttemptCalls.listAttempts(committed.runId, {
        limit: 1,
        after: null,
      }),
    ).resolves.toMatchObject({ items: [expect.any(Object)] })
    await assertBoundedPagePlan(sql, attemptPageMeasurements, {
      pageTable: 'app_private.agent_attempts',
      excludedTables: [
        'agent_capability_invocations',
        'player_decisions',
        'agent_memory_revisions',
      ],
    })

    const capabilityPageMeasurements: SqlMeasurement[] = []
    const measuredCapabilityCalls = createAgentCallQueryService({
      reader: createAgentCallQueryRepository({
        sql: observeReadSql(sql, async (measurement) => {
          capabilityPageMeasurements.push(measurement)
        }),
        owner: committed.owner,
      }),
    })
    await expect(
      measuredCapabilityCalls.listCapabilityInvocations(committed.runId, {
        limit: 1,
        after: null,
      }),
    ).resolves.toMatchObject({ items: [expect.any(Object)] })
    await assertBoundedPagePlan(sql, capabilityPageMeasurements, {
      pageTable: 'app_private.agent_capability_invocations',
      excludedTables: [
        'agent_attempts',
        'player_decisions',
        'agent_memory_revisions',
      ],
    })

    const expectedRange = await sql<
      readonly {
        readonly firstEventSeq: number
        readonly lastEventSeq: number
      }[]
    >`
      SELECT first_event_seq::int AS "firstEventSeq",
        last_event_seq::int AS "lastEventSeq"
      FROM app_private.command_ledger
      WHERE session_id = ${committed.sessionId}::uuid
        AND processing_status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `
    await expect(
      committedCalls.readRun(committed.runId),
    ).resolves.toMatchObject({
      decision: {
        kind: 'summary',
        status: 'committed',
        acceptedAttemptId: expect.any(String),
        normalizedAction: { status: 'visible' },
      },
      commandEventRange: expectedRange[0],
    })

    const attemptItems: unknown[] = []
    let attemptQuery = normalizeAgentCallListQuery(
      new URLSearchParams('limit=1'),
      'runAttempts',
      committed.runId,
    )
    for (let pageNumber = 0; pageNumber < 3; pageNumber += 1) {
      const page = await committedCalls.listAttempts(
        committed.runId,
        attemptQuery,
      )
      attemptItems.push(...page.items)
      if (page.nextCursor === null) break
      attemptQuery = normalizeAgentCallListQuery(
        new URLSearchParams(`limit=1&cursor=${page.nextCursor}`),
        'runAttempts',
        committed.runId,
      )
    }
    expect(attemptItems).toHaveLength(3)
    expect(attemptItems).toEqual([
      expect.objectContaining({
        attemptNumber: 0,
        attemptType: 'initial',
        accepted: false,
      }),
      expect.objectContaining({
        attemptNumber: 1,
        attemptType: 'correction',
        accepted: false,
      }),
      expect.objectContaining({
        attemptNumber: 2,
        attemptType: 'correction',
        accepted: true,
      }),
    ])

    const invocationItems: unknown[] = []
    let invocationQuery = normalizeAgentCallListQuery(
      new URLSearchParams('limit=1'),
      'runCapabilityInvocations',
      committed.runId,
    )
    for (let pageNumber = 0; pageNumber < 2; pageNumber += 1) {
      const page = await committedCalls.listCapabilityInvocations(
        committed.runId,
        invocationQuery,
      )
      invocationItems.push(...page.items)
      if (page.nextCursor === null) break
      invocationQuery = normalizeAgentCallListQuery(
        new URLSearchParams(`limit=1&cursor=${page.nextCursor}`),
        'runCapabilityInvocations',
        committed.runId,
      )
    }
    expect(invocationItems).toEqual([
      expect.objectContaining({ invocationNumber: 0, authorized: true }),
      expect.objectContaining({ invocationNumber: 1, authorized: true }),
    ])

    const firstAttempt = await sql<
      readonly {
        readonly attemptId: string
        readonly payloadVersion: number
      }[]
    >`
      SELECT id::text AS "attemptId",
        attempt_payload_version AS "payloadVersion"
      FROM app_private.agent_attempts
      WHERE agent_run_id = ${committed.runId}::uuid
      ORDER BY attempt_number
      LIMIT 1
    `
    if (firstAttempt[0] === undefined) {
      throw new Error('M5.5 查询夹具缺少首个 Attempt。')
    }
    await sql`
      UPDATE app_private.agent_attempts
      SET attempt_payload_version = 999
      WHERE id = ${firstAttempt[0]?.attemptId}::uuid
    `
    await expect(
      committedCalls.listAttempts(committed.runId, {
        limit: 100,
        after: null,
      }),
    ).rejects.toThrow()
    await sql`
      UPDATE app_private.agent_attempts
      SET attempt_payload_version = ${firstAttempt[0]?.payloadVersion}
      WHERE id = ${firstAttempt[0]?.attemptId}::uuid
    `

    const ledgerPayload = await sql<readonly { readonly payload: unknown }[]>`
      SELECT response_payload AS payload
      FROM app_private.command_ledger
      WHERE session_id = ${committed.sessionId}::uuid
        AND processing_status = 'completed'
      ORDER BY completed_at DESC
      LIMIT 1
    `
    if (ledgerPayload[0] === undefined) {
      throw new Error('M5.5 查询夹具缺少 completed command ledger。')
    }
    await sql`
      UPDATE app_private.command_ledger
      SET response_payload = jsonb_set(
        response_payload,
        '{snapshot,eventSeq}',
        to_jsonb(2147483647)
      )
      WHERE session_id = ${committed.sessionId}::uuid
        AND processing_status = 'completed'
    `
    await expect(committedCalls.readRun(committed.runId)).rejects.toThrow()
    await sql`
      UPDATE app_private.command_ledger
      SET response_payload = ${sql.json(ledgerPayload[0]?.payload as JSONValue)}
      WHERE session_id = ${committed.sessionId}::uuid
        AND processing_status = 'completed'
    `

    await runDatabaseTransaction(sql, (transaction) =>
      deleteEndedSessionData(transaction, ended.owner, {
        sessionId: ended.identity.sessionId,
        deletedAt: new Date().toISOString(),
      }),
    )
    await expect(
      calls.listRuns(ended.identity.handId, { limit: 1, after: null }),
    ).rejects.toThrow()

    const originalSetting = await readPlayerTimeoutSettingsRow(
      sql,
      fixture.owner.databaseOwnerId,
    )
    restoreSettings = () =>
      restorePlayerTimeoutSettingsRow({
        sql,
        owner: fixture.owner,
        original: originalSetting,
      })
    const expectedSettings = {
      attemptTimeoutSeconds: 23,
      decisionDeadlineSeconds: 97,
    } as const
    await expect(
      sql.begin((transaction) =>
        patchPlayerTimeoutSettings(
          transaction,
          fixture.owner,
          expectedSettings,
        ),
      ),
    ).resolves.toEqual(expectedSettings)
    await expect(
      readResolvedPlayerTimeoutSettings(sql, fixture.owner),
    ).resolves.toEqual(expectedSettings)
    const writtenSetting = await readPlayerTimeoutSettingsRow(
      sql,
      fixture.owner.databaseOwnerId,
    )
    expect(writtenSetting?.settingPayload).toEqual(expectedSettings)

    const preservedBefore = await sql<
      readonly {
        readonly otherSessionCount: number
      }[]
    >`
      SELECT
        count(*)::int AS "otherSessionCount"
      FROM app_private.sessions
      WHERE owner_id = ${otherOwner.otherOwnerId}::uuid
    `
    await runDatabaseTransaction(sql, (transaction) =>
      clearOwnerSessionData(transaction, fixture.owner, {
        deletedAt: new Date().toISOString(),
      }),
    )
    await expect(
      sessions.list(
        normalizeSessionManagementQuery(new URLSearchParams('limit=100')),
      ),
    ).resolves.toMatchObject({ items: [] })
    const preservedAfter = await sql<
      readonly {
        readonly otherSessionCount: number
      }[]
    >`
      SELECT
        count(*)::int AS "otherSessionCount"
      FROM app_private.sessions
      WHERE owner_id = ${otherOwner.otherOwnerId}::uuid
    `
    expect(preservedBefore[0]?.otherSessionCount).toBe(1)
    expect(preservedAfter).toEqual(preservedBefore)
    await expect(
      readPlayerTimeoutSettingsRow(sql, fixture.owner.databaseOwnerId),
    ).resolves.toEqual(writtenSetting)
    await expect(
      readResolvedPlayerTimeoutSettings(sql, fixture.owner),
    ).resolves.toEqual(expectedSettings)
  } finally {
    try {
      if (sessionIds.length > 0) {
        await sql`
          DELETE FROM app_private.sessions
          WHERE id = ANY(${sessionIds}::uuid[])
        `
      }
      if (otherOwnerId !== undefined) {
        if (otherSessionId !== undefined) {
          await sql`
            DELETE FROM app_private.sessions
            WHERE id = ${otherSessionId}::uuid
          `
        }
        await sql`DELETE FROM app_private.owners WHERE id = ${otherOwnerId}::uuid`
      }
    } finally {
      await restoreSettings?.()
    }
  }
}
