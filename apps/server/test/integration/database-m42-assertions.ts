import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { readCurrentAttemptAudit } from '../../src/agents/audit/attempt-audit-codec.js'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { AgentRunTransitionError } from '../../src/agents/foundation/agent-run-lifecycle.js'
import type { AgentRunClaimResult } from '../../src/agents/foundation/agent-run-types.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import {
  createAgentRunLifecycleRepository,
  type AgentRunLifecycleRepository,
  type ClaimNextRepositoryResult,
} from '../../src/persistence/agent-run-lifecycle-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { patchPlayerTimeoutSettings } from '../../src/persistence/player-settings-repository.js'
import {
  INITIAL_AGENT_MEMORY,
  insertSessionRosterSnapshot,
  type SessionRosterAgentInput,
} from '../helpers/session-roster-fixture.js'
import {
  createSessionFixture,
  readPrivateState,
} from './database-m33-assertions.js'
import {
  createDatabaseTestSqlForRole,
  readTransactionBackendPid,
} from './database-test-runtime.js'
import { insertCommittedM27CompletedHand } from './database-repository-assertions.js'

const noopEventPort = { publish: async () => undefined }

function coachCreationInput(
  runId: string,
  sessionId: string,
  handId: string,
  createdAt: string,
) {
  return {
    runtimeType: 'coach' as const,
    agentRunId: runId,
    sessionId,
    handId,
    triggerType: 'hand_completed',
    idempotencyKey: `m42/coach/${runId}`,
    supersedesRunId: null,
    dataDependencies: [],
    createdAt,
  }
}

function attemptInput(sessionId: string, runId: string) {
  return {
    sessionId,
    agentRunId: runId,
    stage: 'model_selection',
    provider: 'openai',
    model: 'gpt-5.6',
    attemptType: 'primary',
    routingReasonCode: 'primary_route',
    actualTimeoutMs: 30_000,
    remainingDeadlineMsAtStart: 120_000,
    requestProjectionHash: 'a'.repeat(64),
    startedAt: new Date().toISOString(),
  }
}

function playerCreationInput(input: {
  readonly runId: string
  readonly sessionId: string
  readonly handId: string
  readonly participantId: string
  readonly sourceStateVersion: number
  readonly decisionRequestId: string
  readonly createdAt: string
}) {
  return {
    runtimeType: 'player' as const,
    agentRunId: input.runId,
    sessionId: input.sessionId,
    handId: input.handId,
    actorParticipantId: input.participantId,
    sourceStateVersion: input.sourceStateVersion,
    decisionRequestId: input.decisionRequestId,
    triggerType: 'action_required',
    idempotencyKey: `m42/player/${input.runId}`,
    supersedesRunId: null,
    dataDependencies: [],
    createdAt: input.createdAt,
  }
}

async function waitForBlockingRelationship(
  sql: Sql,
  blockerPid: number,
  blockedPid: number,
  failureMessage = 'M4.2 设置写入与 Player 创建未形成预期锁等待。',
): Promise<void> {
  const deadline = Date.now() + 5_000
  for (;;) {
    const rows = await sql<{ readonly blocked: boolean }[]>`
      SELECT ${blockerPid}::int = ANY(pg_blocking_pids(${blockedPid}::int)) AS blocked
    `
    if (rows[0]?.blocked === true) return
    if (Date.now() >= deadline) {
      throw new Error(failureMessage)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function assertM42PlayerSettingsCapacityAndRecovery(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const settingsSql = createDatabaseTestSqlForRole(runtimeUrl, 'm42-settings')
  const workerSql = createDatabaseTestSqlForRole(runtimeUrl, 'm42-player')
  const identity = await createSessionFixture(sql, 7)
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const workerOwner = await resolveOwnerScope(workerSql, {
    ownerId: 'local-user',
  })
  const coordinator = createAgentRunCoordinator({
    sql,
    owner,
    eventPort: noopEventPort,
  })
  const workerCoordinator = createAgentRunCoordinator({
    sql: workerSql,
    owner: workerOwner,
    eventPort: noopEventPort,
  })
  const actor = identity.agentParticipants[0]
  if (actor === undefined) throw new Error('M4.2 Player fixture 缺少 AI。')
  const state = await readPrivateState(sql, identity.sessionId)
  const firstRunId = randomUUID()
  const firstDecisionRequestId = randomUUID()
  const firstCreatedAt = new Date().toISOString()
  let releaseSettings!: () => void
  const settingsGate = new Promise<void>((resolve) => {
    releaseSettings = resolve
  })
  let reportSettingsReady!: (pid: number) => void
  const settingsReady = new Promise<number>((resolve) => {
    reportSettingsReady = resolve
  })
  let reportCreatorPid!: (pid: number) => void
  const creatorPid = new Promise<number>((resolve) => {
    reportCreatorPid = resolve
  })
  let settingsWrite: Promise<unknown> | undefined
  let creation: Promise<unknown> | undefined

  try {
    await sql.begin((transaction) =>
      patchPlayerTimeoutSettings(transaction, owner, {
        attemptTimeoutSeconds: 5,
        decisionDeadlineSeconds: 15,
      }),
    )
    settingsWrite = settingsSql.begin(async (transaction) => {
      await patchPlayerTimeoutSettings(transaction, owner, {
        attemptTimeoutSeconds: 30,
        decisionDeadlineSeconds: 120,
      })
      reportSettingsReady(await readTransactionBackendPid(transaction))
      await settingsGate
    })
    const settingsPid = await settingsReady
    creation = workerSql.begin(async (transaction) => {
      reportCreatorPid(await readTransactionBackendPid(transaction))
      const result = await workerCoordinator.createOrReuse(
        transaction,
        playerCreationInput({
          runId: firstRunId,
          sessionId: identity.sessionId,
          handId: identity.handId,
          participantId: actor.participantId,
          sourceStateVersion: state.stateVersion,
          decisionRequestId: firstDecisionRequestId,
          createdAt: firstCreatedAt,
        }),
      )
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'thinking',
            active_player_run_id = ${firstRunId}::uuid,
            active_decision_request_id = ${firstDecisionRequestId}::uuid
        WHERE id = ${identity.sessionId}::uuid
      `
      return result
    })
    await waitForBlockingRelationship(sql, settingsPid, await creatorPid)
    releaseSettings()
    await settingsWrite
    const firstCreated = (await creation) as Awaited<
      ReturnType<typeof coordinator.createOrReuse>
    >
    expect(firstCreated.run.budget).toMatchObject({
      attemptTimeoutMs: 30_000,
      maxWallClockMs: 120_000,
    })
    expect(
      Date.parse(firstCreated.run.deadlineAt) - Date.parse(firstCreatedAt),
    ).toBe(120_000)

    await expect(
      sql.begin((transaction) =>
        coordinator.createOrReuse(
          transaction,
          playerCreationInput({
            runId: randomUUID(),
            sessionId: identity.sessionId,
            handId: identity.handId,
            participantId: actor.participantId,
            sourceStateVersion: state.stateVersion,
            decisionRequestId: randomUUID(),
            createdAt: new Date().toISOString(),
          }),
        ),
      ),
    ).rejects.toMatchObject({ failure: 'active_player_run_conflict' })

    const firstClaim = await workerCoordinator.workerControl.claimNext({
      runtimeType: 'player',
      leaseOwner: 'm42-player-primary:player:0',
    })
    expect(firstClaim.kind).toBe('claimed')
    if (firstClaim.kind !== 'claimed') {
      throw new Error('M4.2 Player fixture 未领取。')
    }
    await workerCoordinator.workerControl.markRunning(firstClaim.authority)
    await sql`
      UPDATE app_private.agent_runs
      SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${firstRunId}::uuid
    `
    await expect(
      coordinator.workerControl.claimNext({
        runtimeType: 'player',
        leaseOwner: 'm42-player-secondary:player:0',
      }),
    ).resolves.toMatchObject({
      kind: 'none',
      diagnostics: expect.arrayContaining(['agent_run_recovery_rejected']),
    })

    await sql.begin(async (transaction) => {
      await coordinator.cancel(transaction, {
        runId: firstRunId,
        reason: 'process_restart',
        completedAt: new Date().toISOString(),
      })
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'idle',
            active_player_run_id = NULL,
            active_decision_request_id = NULL
        WHERE id = ${identity.sessionId}::uuid
      `
    })
    await expect(
      sql.begin((transaction) =>
        coordinator.cancel(transaction, {
          runId: firstRunId,
          reason: 'process_restart',
          completedAt: new Date().toISOString(),
        }),
      ),
    ).resolves.toMatchObject({
      changed: false,
      committedEffects: [],
      run: { lifecycle: 'cancelled', terminationReason: 'process_restart' },
    })
    await expect(
      sql.begin((transaction) =>
        coordinator.cancel(transaction, {
          runId: firstRunId,
          reason: 'user_cancelled',
          completedAt: new Date().toISOString(),
        }),
      ),
    ).rejects.toMatchObject({
      name: AgentRunTransitionError.name,
      failure: 'agent_run_already_terminal',
    })
    await sql.begin((transaction) =>
      patchPlayerTimeoutSettings(transaction, owner, {
        attemptTimeoutSeconds: 5,
        decisionDeadlineSeconds: 15,
      }),
    )
    const secondRunId = randomUUID()
    const secondDecisionRequestId = randomUUID()
    const secondCreatedAt = new Date().toISOString()
    const secondCreated = await sql.begin(async (transaction) => {
      const result = await coordinator.createOrReuse(
        transaction,
        playerCreationInput({
          runId: secondRunId,
          sessionId: identity.sessionId,
          handId: identity.handId,
          participantId: actor.participantId,
          sourceStateVersion: state.stateVersion,
          decisionRequestId: secondDecisionRequestId,
          createdAt: secondCreatedAt,
        }),
      )
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'thinking',
            active_player_run_id = ${secondRunId}::uuid,
            active_decision_request_id = ${secondDecisionRequestId}::uuid
        WHERE id = ${identity.sessionId}::uuid
      `
      return result
    })
    expect(firstCreated.run.budget).toMatchObject({
      attemptTimeoutMs: 30_000,
      maxWallClockMs: 120_000,
    })
    expect(secondCreated.run.budget).toMatchObject({
      attemptTimeoutMs: 5_000,
      maxWallClockMs: 15_000,
    })
  } finally {
    releaseSettings?.()
    await Promise.allSettled(
      [settingsWrite, creation].filter(
        (promise): promise is Promise<unknown> => promise !== undefined,
      ),
    )
    await Promise.allSettled([
      settingsSql.end({ timeout: 0 }),
      workerSql.end({ timeout: 0 }),
    ])
    await sql`
      DELETE FROM app_private.sessions WHERE id = ${identity.sessionId}::uuid
    `
  }
}

async function assertM42RuntimeCapacityIsolation(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const playerRunId = randomUUID()
  const decisionRequestId = randomUUID()
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm42-capacity')
  try {
    const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId)
    const secondOwner = await resolveOwnerScope(secondSql, {
      ownerId: 'local-user',
    })
    const participantRows = await sql<
      { readonly participantId: string; readonly stateVersion: number }[]
    >`
      SELECT agent.participant_id::text AS "participantId",
             session.state_version::float8 AS "stateVersion"
      FROM app_private.session_agents AS agent
      JOIN app_private.sessions AS session ON session.id = agent.session_id
      WHERE agent.session_id = ${sessionId}::uuid
      ORDER BY agent.participant_id
      LIMIT 1
    `
    const participant = participantRows[0]
    if (participant === undefined) {
      throw new Error('M4.2 capacity fixture 缺少 AI。')
    }
    const coordinator = createAgentRunCoordinator({
      sql,
      owner,
      eventPort: noopEventPort,
    })
    const secondCoordinator = createAgentRunCoordinator({
      sql: secondSql,
      owner: secondOwner,
      eventPort: noopEventPort,
    })
    await sql.begin(async (transaction) => {
      await coordinator.createOrReuse(
        transaction,
        playerCreationInput({
          runId: playerRunId,
          sessionId,
          handId,
          participantId: participant.participantId,
          sourceStateVersion: participant.stateVersion,
          decisionRequestId,
          createdAt: new Date().toISOString(),
        }),
      )
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'thinking',
            active_player_run_id = ${playerRunId}::uuid,
            active_decision_request_id = ${decisionRequestId}::uuid
        WHERE id = ${sessionId}::uuid
      `
    })
    for (const coachRunId of [randomUUID(), randomUUID()]) {
      await sql.begin((transaction) =>
        coordinator.createOrReuse(
          transaction,
          coachCreationInput(
            coachRunId,
            sessionId,
            handId,
            new Date().toISOString(),
          ),
        ),
      )
    }
    const [playerClaim, coachClaim] = await Promise.all([
      coordinator.workerControl.claimNext({
        runtimeType: 'player',
        leaseOwner: 'm42-capacity:player:0',
      }),
      secondCoordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'm42-capacity:coach:0',
      }),
    ])
    expect(playerClaim.kind).toBe('claimed')
    expect(coachClaim.kind).toBe('claimed')
    await expect(
      coordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'm42-capacity-second:coach:0',
      }),
    ).resolves.toMatchObject({
      kind: 'none',
      diagnostics: expect.arrayContaining(['agent_run_capacity_unavailable']),
    })
  } finally {
    await secondSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

async function assertM42SystemCapacityAcrossOwnersAndBudgets(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const firstSessionId = randomUUID()
  const firstHandId = randomUUID()
  const firstRunId = randomUUID()
  const secondOwnerId = randomUUID()
  const secondSessionId = randomUUID()
  const secondHandId = randomUUID()
  const secondRunId = randomUUID()
  const concurrentFirstRunId = randomUUID()
  const concurrentSecondRunId = randomUUID()
  const firstTemporaryIdentity = `m42-system-first-${randomUUID()}`
  const secondTemporaryIdentity = `m42-system-second-${randomUUID()}`
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm42-system')
  const firstClaimSql = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm42-system-first',
  )
  let releaseConcurrentFirstClaim: (() => void) | undefined
  let firstConcurrentClaim: Promise<AgentRunClaimResult> | undefined
  let secondConcurrentClaim: Promise<AgentRunClaimResult> | undefined
  const firstOwner = await insertCommittedM27CompletedHand(
    sql,
    firstSessionId,
    firstHandId,
  )
  try {
    await sql`
      UPDATE app_private.owners
      SET identity_key = ${firstTemporaryIdentity}
      WHERE id = ${firstOwner.databaseOwnerId}::uuid
    `
    await sql`
      INSERT INTO app_private.owners (id, identity_key)
      VALUES (${secondOwnerId}::uuid, 'local-user')
    `
    const secondOwner = await resolveOwnerScope(sql, {
      ownerId: 'local-user',
    })
    await sql`
      UPDATE app_private.owners
      SET identity_key = ${secondTemporaryIdentity}
      WHERE id = ${secondOwner.databaseOwnerId}::uuid
    `
    await sql`
      UPDATE app_private.owners
      SET identity_key = 'local-user'
      WHERE id = ${firstOwner.databaseOwnerId}::uuid
    `
    const sourceAgents = await sql<
      Array<
        Omit<SessionRosterAgentInput, 'agentParticipantId' | 'initialMemory'>
      >
    >`
      SELECT participant.seat_number AS "seatNumber",
             agent.display_name AS "displayName",
             agent.avatar_color AS "avatarColor",
             agent.persona_id AS "personaId",
             agent.persona_version AS "personaVersion",
             agent.config_snapshot_key AS "configSnapshotKey",
             agent.config_payload_version AS "configPayloadVersion",
             agent.config_payload AS "configPayload"
      FROM app_private.session_agents AS agent
      JOIN app_private.session_participants AS participant
        ON participant.id = agent.participant_id
      WHERE agent.session_id = ${firstSessionId}::uuid
      ORDER BY participant.seat_number
    `
    await sql.begin((transaction) =>
      insertSessionRosterSnapshot(transaction, {
        owner: secondOwner,
        sessionId: secondSessionId,
        userParticipantId: randomUUID(),
        agents: sourceAgents.map((agent) => ({
          ...agent,
          agentParticipantId: randomUUID(),
          initialMemory: INITIAL_AGENT_MEMORY,
        })),
      }),
    )
    await sql`
      INSERT INTO app_private.hands (
        id, session_id, owner_id, hand_number, status,
        hand_start_checkpoint_payload_version, hand_start_checkpoint_payload,
        completed_result_payload_version, completed_result_payload,
        abort_reason, aborted_by_agent_run_id, button_seat, participant_seats,
        started_at, completed_at, aborted_at, updated_at
      )
      SELECT ${secondHandId}::uuid, ${secondSessionId}::uuid,
             ${secondOwnerId}::uuid, hand_number, status,
             hand_start_checkpoint_payload_version,
             hand_start_checkpoint_payload,
             completed_result_payload_version, completed_result_payload,
             abort_reason, aborted_by_agent_run_id, button_seat,
             participant_seats, started_at, completed_at, aborted_at, updated_at
      FROM app_private.hands
      WHERE id = ${firstHandId}::uuid
    `

    const firstCoordinator = createAgentRunCoordinator({
      sql,
      owner: firstOwner,
      eventPort: noopEventPort,
    })
    const secondCoordinator = createAgentRunCoordinator({
      sql: secondSql,
      owner: secondOwner,
      eventPort: noopEventPort,
    })
    const firstCreated = await sql.begin((transaction) =>
      firstCoordinator.createOrReuse(
        transaction,
        coachCreationInput(
          firstRunId,
          firstSessionId,
          firstHandId,
          new Date().toISOString(),
        ),
      ),
    )
    const secondCreated = await secondSql.begin((transaction) =>
      secondCoordinator.createOrReuse(
        transaction,
        coachCreationInput(
          secondRunId,
          secondSessionId,
          secondHandId,
          new Date().toISOString(),
        ),
      ),
    )
    expect(firstCreated.run.budget.maxSystemConcurrentRuns).toBe(2)
    expect(secondCreated.run.budget.maxSystemConcurrentRuns).toBe(2)
    await sql`
      UPDATE app_private.agent_runs
      SET budget_payload = jsonb_set(
        jsonb_set(
          budget_payload,
          '{budget,maxOwnerConcurrentRuns}',
          '1'::jsonb
        ),
        '{budget,maxSystemConcurrentRuns}',
        '1'::jsonb
      )
      WHERE id = ${firstRunId}::uuid
    `
    const firstClaim = await firstCoordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-system-first:coach:0',
    })
    expect(firstClaim).toMatchObject({
      kind: 'claimed',
      run: {
        runId: firstRunId,
        budget: {
          maxOwnerConcurrentRuns: 1,
          maxSystemConcurrentRuns: 1,
        },
      },
    })

    await expect(
      secondCoordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'm42-system-second:coach:0',
      }),
    ).resolves.toMatchObject({
      kind: 'none',
      diagnostics: expect.arrayContaining(['agent_run_capacity_unavailable']),
    })

    await sql.begin((transaction) =>
      firstCoordinator.cancel(transaction, {
        runId: firstRunId,
        reason: 'user_cancelled',
        completedAt: new Date().toISOString(),
      }),
    )
    await secondSql.begin((transaction) =>
      secondCoordinator.cancel(transaction, {
        runId: secondRunId,
        reason: 'user_cancelled',
        completedAt: new Date().toISOString(),
      }),
    )
    await sql.begin((transaction) =>
      firstCoordinator.createOrReuse(
        transaction,
        coachCreationInput(
          concurrentFirstRunId,
          firstSessionId,
          firstHandId,
          new Date().toISOString(),
        ),
      ),
    )
    await secondSql.begin((transaction) =>
      secondCoordinator.createOrReuse(
        transaction,
        coachCreationInput(
          concurrentSecondRunId,
          secondSessionId,
          secondHandId,
          new Date().toISOString(),
        ),
      ),
    )
    await sql`
      UPDATE app_private.agent_runs
      SET budget_payload = jsonb_set(
        jsonb_set(
          budget_payload,
          '{budget,maxOwnerConcurrentRuns}',
          '1'::jsonb
        ),
        '{budget,maxSystemConcurrentRuns}',
        '1'::jsonb
      )
      WHERE id = ANY(
        ${[concurrentFirstRunId, concurrentSecondRunId]}::uuid[]
      )
    `
    const concurrentBudgetRows = await sql<{ readonly systemLimit: number }[]>`
      SELECT (budget_payload->'budget'->>'maxSystemConcurrentRuns')::int
               AS "systemLimit"
      FROM app_private.agent_runs
      WHERE id = ANY(
        ${[concurrentFirstRunId, concurrentSecondRunId]}::uuid[]
      )
      ORDER BY id
    `
    expect(concurrentBudgetRows).toEqual([
      { systemLimit: 1 },
      { systemLimit: 1 },
    ])

    let reportFirstClaim!: (input: {
      readonly pid: number
      readonly result: ClaimNextRepositoryResult
    }) => void
    const firstClaimInsideTransaction = new Promise<{
      readonly pid: number
      readonly result: ClaimNextRepositoryResult
    }>((resolve) => {
      reportFirstClaim = resolve
    })
    let reportSecondPid!: (pid: number) => void
    const secondClaimStarted = new Promise<number>((resolve) => {
      reportSecondPid = resolve
    })
    let releaseFirstClaim!: () => void
    const firstClaimGate = new Promise<void>((resolve) => {
      releaseFirstClaim = resolve
      releaseConcurrentFirstClaim = resolve
    })
    const repository = createAgentRunLifecycleRepository()
    const firstRepository: AgentRunLifecycleRepository = {
      ...repository,
      async claimNext(transaction, claimOwner, input, validate) {
        const pid = await readTransactionBackendPid(transaction)
        const result = await repository.claimNext(
          transaction,
          claimOwner,
          input,
          validate,
        )
        reportFirstClaim({ pid, result })
        await firstClaimGate
        return result
      },
    }
    const secondRepository: AgentRunLifecycleRepository = {
      ...repository,
      async claimNext(transaction, claimOwner, input, validate) {
        reportSecondPid(await readTransactionBackendPid(transaction))
        return repository.claimNext(transaction, claimOwner, input, validate)
      },
    }
    const concurrentFirstCoordinator = createAgentRunCoordinator({
      sql: firstClaimSql,
      owner: firstOwner,
      repository: firstRepository,
      eventPort: noopEventPort,
    })
    const concurrentSecondCoordinator = createAgentRunCoordinator({
      sql: secondSql,
      owner: secondOwner,
      repository: secondRepository,
      eventPort: noopEventPort,
    })
    firstConcurrentClaim = concurrentFirstCoordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-system-race-first:coach:0',
    })
    const firstInside = await firstClaimInsideTransaction
    expect(firstInside.result.kind).toBe('claimed')
    secondConcurrentClaim = concurrentSecondCoordinator.workerControl.claimNext(
      {
        runtimeType: 'coach',
        leaseOwner: 'm42-system-race-second:coach:0',
      },
    )
    const secondPid = await secondClaimStarted
    await waitForBlockingRelationship(
      sql,
      firstInside.pid,
      secondPid,
      'M4.2 不同 Owner 的 Coach 领取未被 Runtime advisory lock 串行化。',
    )
    releaseFirstClaim()
    const concurrentResults = await Promise.all([
      firstConcurrentClaim,
      secondConcurrentClaim,
    ])
    expect(
      concurrentResults.filter((result) => result.kind === 'claimed'),
    ).toHaveLength(1)
    expect(
      concurrentResults.filter((result) => result.kind === 'none'),
    ).toEqual([
      expect.objectContaining({
        diagnostics: expect.arrayContaining(['agent_run_capacity_unavailable']),
      }),
    ])
  } finally {
    releaseConcurrentFirstClaim?.()
    await Promise.allSettled(
      [firstConcurrentClaim, secondConcurrentClaim].filter(
        (claim): claim is Promise<AgentRunClaimResult> => claim !== undefined,
      ),
    )
    await Promise.allSettled([
      firstClaimSql.end({ timeout: 0 }),
      secondSql.end({ timeout: 0 }),
    ])
    await sql`
      DELETE FROM app_private.sessions
      WHERE id IN (${firstSessionId}::uuid, ${secondSessionId}::uuid)
    `
    await sql`
      DELETE FROM app_private.owners
      WHERE id = ${secondOwnerId}::uuid
    `
    await sql`
      UPDATE app_private.owners
      SET identity_key = 'local-user'
      WHERE id = ${firstOwner.databaseOwnerId}::uuid
    `
  }
}

async function assertM42TerminalRace(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const runId = randomUUID()
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm42-terminal')
  try {
    const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId)
    const secondOwner = await resolveOwnerScope(secondSql, {
      ownerId: 'local-user',
    })
    const coordinator = createAgentRunCoordinator({
      sql,
      owner,
      eventPort: noopEventPort,
    })
    const secondCoordinator = createAgentRunCoordinator({
      sql: secondSql,
      owner: secondOwner,
      eventPort: noopEventPort,
    })
    await sql.begin((transaction) =>
      coordinator.createOrReuse(
        transaction,
        coachCreationInput(runId, sessionId, handId, new Date().toISOString()),
      ),
    )
    const claimed = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-terminal:coach:0',
    })
    if (claimed.kind !== 'claimed') {
      throw new Error('M4.2 terminal race fixture 未领取。')
    }
    await coordinator.workerControl.markRunning(claimed.authority)
    const completedAt = new Date().toISOString()
    const results = await Promise.allSettled([
      sql.begin((transaction) =>
        coordinator.finalize(transaction, {
          runId,
          authority: claimed.authority,
          lifecycle: 'completed',
          terminationReason: null,
          completedAt,
        }),
      ),
      secondSql.begin((transaction) =>
        secondCoordinator.cancel(transaction, {
          runId,
          reason: 'user_cancelled',
          completedAt,
        }),
      ),
    ])
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    )
    const rows = await sql<{ readonly lifecycle: string }[]>`
      SELECT lifecycle FROM app_private.agent_runs WHERE id = ${runId}::uuid
    `
    expect(['completed', 'cancelled']).toContain(rows[0]?.lifecycle)
  } finally {
    await secondSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
}

export async function assertM42AgentRunLifecycle(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const runId = randomUUID()
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm42-secondary')

  try {
    const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId)
    const secondOwner = await resolveOwnerScope(secondSql, {
      ownerId: 'local-user',
    })
    const lifecycleRepository = createAgentRunLifecycleRepository()
    const coordinator = createAgentRunCoordinator({
      sql,
      owner,
      repository: lifecycleRepository,
      eventPort: noopEventPort,
    })
    const secondCoordinator = createAgentRunCoordinator({
      sql: secondSql,
      owner: secondOwner,
      repository: lifecycleRepository,
      eventPort: noopEventPort,
    })
    const createdAt = new Date().toISOString()
    const creationInput = coachCreationInput(
      runId,
      sessionId,
      handId,
      createdAt,
    )
    const creationResults = await Promise.all([
      sql.begin((transaction) =>
        coordinator.createOrReuse(transaction, creationInput),
      ),
      secondSql.begin((transaction) =>
        secondCoordinator.createOrReuse(transaction, creationInput),
      ),
    ])
    const created = creationResults.find((result) => result.kind === 'created')
    const existing = creationResults.find(
      (result) => result.kind === 'existing',
    )
    expect(creationResults.map(({ kind }) => kind).sort()).toEqual([
      'created',
      'existing',
    ])
    expect(created).toMatchObject({
      kind: 'created',
      run: {
        runId,
        runtimeType: 'coach',
        lifecycle: 'queued',
        fencingToken: 0,
        budget: {
          maxAttempts: 4,
          maxOwnerConcurrentRuns: 1,
          maxSystemConcurrentRuns: 2,
          attemptTimeoutMs: 30_000,
          maxWallClockMs: 120_000,
        },
      },
    })
    expect(existing).toMatchObject({
      kind: 'existing',
      committedEffects: [],
      run: { runId },
    })
    expect(existing?.run).toEqual(created?.run)

    const claims = await Promise.all([
      coordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'm42-primary:coach:0',
      }),
      secondCoordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'm42-secondary:coach:0',
      }),
    ])
    const winners = claims.filter((claim) => claim.kind === 'claimed')
    expect(winners).toHaveLength(1)
    const firstClaim = winners[0]
    if (firstClaim?.kind !== 'claimed') {
      throw new Error('M4.2 领取竞争缺少胜出者。')
    }
    expect(firstClaim.run).toMatchObject({ runId, fencingToken: 1 })
    const activeCoordinator = firstClaim.run.leaseOwner.startsWith(
      'm42-primary',
    )
      ? coordinator
      : secondCoordinator
    const running = await activeCoordinator.workerControl.markRunning(
      firstClaim.authority,
    )
    expect(running.lifecycle).toBe('running')
    const renewed = await activeCoordinator.workerControl.renewLease(
      firstClaim.authority,
    )
    expect(Date.parse(renewed.leaseExpiresAt)).toBeGreaterThan(
      Date.parse(firstClaim.run.leaseExpiresAt),
    )

    const auditRepository = createAgentFoundationAuditRepository()
    const firstAttempt = await sql.begin((transaction) =>
      auditRepository.startAgentAttemptAudit(
        transaction,
        owner,
        firstClaim.authority,
        attemptInput(sessionId, runId),
      ),
    )
    expect(firstAttempt.attemptNumber).toBe(0)

    await sql`
      UPDATE app_private.agent_runs
      SET lease_expires_at = updated_at + interval '1 millisecond'
      WHERE id = ${runId}::uuid
    `
    const replacementClaim = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-replacement:coach:0',
    })
    expect(replacementClaim).toMatchObject({
      kind: 'none',
      diagnostics: expect.arrayContaining(['agent_run_recovery_rejected']),
    })
    const rejectedRunRows = await sql<
      {
        readonly runId: string
        readonly lifecycle: string
        readonly terminationReason: string | null
      }[]
    >`
      SELECT id::text AS "runId", lifecycle, termination_reason AS "terminationReason"
      FROM app_private.agent_runs
      WHERE id = ${runId}::uuid
    `
    expect(rejectedRunRows[0]).toMatchObject({
      runId,
      lifecycle: 'cancelled',
      terminationReason: 'process_restart',
    })
    if (replacementClaim.kind !== 'none') {
      throw new Error('M4.2 Coach 过期租约未被拒绝。')
    }
    await expect(
      sql.begin((transaction) =>
        auditRepository.startAgentAttemptAudit(
          transaction,
          owner,
          firstClaim.authority,
          attemptInput(sessionId, runId),
        ),
      ),
    ).rejects.toMatchObject({
      name: AgentRunTransitionError.name,
      failure: 'agent_run_fencing_rejected',
    })
    const staleRows = await sql<
      {
        readonly lifecycle: string
        readonly payloadVersion: number
        readonly payload: unknown
      }[]
    >`
      SELECT lifecycle, attempt_payload_version AS "payloadVersion",
             attempt_payload AS "payload"
      FROM app_private.agent_attempts
      WHERE id = ${firstAttempt.attemptId}::uuid
    `
    expect(staleRows[0]).toMatchObject({ lifecycle: 'cancelled' })
    const staleAttempt = readCurrentAttemptAudit(
      staleRows[0]?.lifecycle,
      staleRows[0]?.payloadVersion,
      staleRows[0]?.payload,
    )
    expect(staleAttempt).toMatchObject({
      kind: 'decoded',
      value: {
        lifecycle: 'cancelled',
        responseProjectionHash: null,
        validationStatus: 'notRun',
      },
    })

    await expect(
      sql.begin((transaction) =>
        coordinator.finalize(transaction, {
          runId,
          authority: firstClaim.authority,
          lifecycle: 'failed',
          terminationReason: 'runtime_failed',
          completedAt: new Date().toISOString(),
        } as const),
      ),
    ).rejects.toMatchObject({
      name: AgentRunTransitionError.name,
      failure: 'agent_run_already_terminal',
    })

    const baseTime = Date.now()
    const poisonRunIds: string[] = []
    for (let index = 0; index < 17; index += 1) {
      const candidateRunId = randomUUID()
      if (index < 16) poisonRunIds.push(candidateRunId)
      await sql.begin((transaction) =>
        coordinator.createOrReuse(
          transaction,
          coachCreationInput(
            candidateRunId,
            sessionId,
            handId,
            new Date(baseTime + index).toISOString(),
          ),
        ),
      )
    }
    await sql`
      UPDATE app_private.agent_runs
      SET trigger_type = 'CORRUPT'
      WHERE id = ANY(${poisonRunIds}::uuid[])
    `
    const validRows = await sql<{ readonly runId: string }[]>`
      SELECT id::text AS "runId"
      FROM app_private.agent_runs
      WHERE session_id = ${sessionId}::uuid
        AND lifecycle = 'queued'
        AND trigger_type <> 'CORRUPT'
      ORDER BY created_at DESC
      LIMIT 1
    `
    const scanResult = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-scan:coach:0',
    })
    expect(scanResult).toMatchObject({
      kind: 'claimed',
      run: { runId: validRows[0]?.runId },
    })
  } finally {
    await secondSql.end({ timeout: 0 })
    await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid`
  }
  await assertM42PlayerSettingsCapacityAndRecovery(sql, runtimeUrl)
  await assertM42RuntimeCapacityIsolation(sql, runtimeUrl)
  await assertM42SystemCapacityAcrossOwnersAndBudgets(sql, runtimeUrl)
  await assertM42TerminalRace(sql, runtimeUrl)
}
