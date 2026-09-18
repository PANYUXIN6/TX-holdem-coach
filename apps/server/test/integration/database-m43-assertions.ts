import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { createDatabaseCapabilityExecutionControl } from '../../src/persistence/agent-capability-execution-control.js'
import { createDatabaseModelAttemptControl } from '../../src/persistence/agent-model-attempt-control.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createDatabaseTestSqlForRole } from './database-test-runtime.js'
import { insertCommittedM27CompletedHand } from './database-repository-assertions.js'

const eventPort = { publish: async () => undefined }

async function insertHistoricalCapabilityBudgetFixtures(
  sql: Sql,
  input: {
    readonly ownerId: string
    readonly sessionId: string
    readonly runId: string
    readonly fencingToken: number
  },
): Promise<void> {
  // 旧版本可写出当前协议已禁止的行；直接冻结存量数据的聚合兼容契约。
  const startedAt = new Date().toISOString()
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
      error_category,
      started_at,
      completed_at,
      created_at
    ) VALUES
      (
        ${randomUUID()}::uuid,
        ${input.runId}::uuid,
        ${input.ownerId}::uuid,
        ${input.sessionId}::uuid,
        0,
        ${input.fencingToken}::bigint,
        'coach.compute-decision-metrics',
        1,
        false,
        1,
        ${'1'.repeat(64)},
        NULL,
        NULL,
        1,
        0,
        'capability_not_authorized',
        ${startedAt}::timestamptz,
        ${startedAt}::timestamptz,
        ${startedAt}::timestamptz
      ),
      (
        ${randomUUID()}::uuid,
        ${input.runId}::uuid,
        ${input.ownerId}::uuid,
        ${input.sessionId}::uuid,
        1,
        ${input.fencingToken}::bigint,
        'coach.compute-decision-metrics',
        1,
        true,
        1,
        ${'2'.repeat(64)},
        1,
        ${'3'.repeat(64)},
        0,
        0,
        NULL,
        ${startedAt}::timestamptz,
        ${startedAt}::timestamptz,
        ${startedAt}::timestamptz
      )
  `
}

export async function assertM43ModelAttemptControl(
  sql: Sql,
  runtimeUrl: string,
): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const runId = randomUUID()
  const secondSql = createDatabaseTestSqlForRole(runtimeUrl, 'm43-secondary')
  const coachCapabilityManifest = productionRuntimeRegistry.resolveExact(
    'coach',
    1,
  ).capabilityManifest
  try {
    const owner = await insertCommittedM27CompletedHand(sql, sessionId, handId)
    const coordinator = createAgentRunCoordinator({ sql, owner, eventPort })
    const createdAt = new Date().toISOString()
    await sql.begin((transaction) =>
      coordinator.createOrReuse(transaction, {
        runtimeType: 'coach',
        agentRunId: runId,
        sessionId,
        handId,
        triggerType: 'hand_completed',
        idempotencyKey: `m43/coach/${runId}`,
        supersedesRunId: null,
        dataDependencies: [],
        createdAt,
      }),
    )
    const claim = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm43-primary:coach:0',
    })
    if (claim.kind !== 'claimed' || claim.run.runId !== runId) {
      throw new Error('M4.3 无法领取目标 Coach Run。')
    }
    await coordinator.workerControl.markRunning(claim.authority)
    const repository = createAgentFoundationAuditRepository()
    const resolvedOwner = await resolveOwnerScope(sql, {
      ownerId: 'local-user',
    })
    const secondOwner = await resolveOwnerScope(secondSql, {
      ownerId: 'local-user',
    })
    const secondCoordinator = createAgentRunCoordinator({
      sql: secondSql,
      owner: secondOwner,
      eventPort,
    })
    const capabilityControl = createDatabaseCapabilityExecutionControl({
      sql,
      repository,
      owner: resolvedOwner,
      authority: claim.authority,
      manifest: coachCapabilityManifest,
      sessionId,
      agentRunId: runId,
    })
    await coordinator.workerControl.renewLease(claim.authority)
    await insertHistoricalCapabilityBudgetFixtures(sql, {
      ownerId: resolvedOwner.databaseOwnerId,
      sessionId,
      runId,
      fencingToken: claim.authority.fencingToken,
    })
    const capabilities = [
      { id: 'coach.compute-decision-metrics', version: 1 },
      { id: 'coach.analyze-opponent-ranges', version: 1 },
      { id: 'coach.get-opponent-evidence', version: 1 },
      { id: 'coach.compute-decision-metrics', version: 1 },
    ] as const
    const reservations = await Promise.all(
      capabilities.map(async (capability) => ({
        capability,
        reservation: await capabilityControl.reserveInvocation({
          capability,
          inputSchemaVersion: 1,
          inputHash: '7'.repeat(64),
        }),
      })),
    )
    expect(
      reservations.filter(({ reservation }) => reservation.kind === 'reserved'),
    ).toHaveLength(3)
    expect(
      reservations.filter(
        ({ reservation }) => reservation.kind === 'budgetExhausted',
      ),
    ).toHaveLength(1)
    for (const { capability, reservation } of reservations) {
      if (reservation.kind !== 'reserved') continue
      await coordinator.workerControl.renewLease(claim.authority)
      await expect(
        capabilityControl.finishInvocation({
          reservationId: reservation.reservationId,
          audit: {
            capability,
            authorized: true,
            inputSchemaVersion: 1,
            inputHash: '7'.repeat(64),
            outputSchemaVersion: 1,
            outputHash: '6'.repeat(64),
            budgetCost: 1,
            durationMs: 1,
            errorCode: null,
          },
        }),
      ).resolves.toBe('recorded')
    }

    const control = createDatabaseModelAttemptControl({
      sql,
      repository,
      owner: resolvedOwner,
      authority: claim.authority,
      sessionId,
      agentRunId: runId,
    })
    const secondControl = createDatabaseModelAttemptControl({
      sql: secondSql,
      repository: createAgentFoundationAuditRepository(),
      owner: secondOwner,
      authority: claim.authority,
      sessionId,
      agentRunId: runId,
    })
    const start = await control.startAttempt({
      attemptType: 'initial',
      routingReasonCode: null,
      stage: 'decision_analysis',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      estimatedInputTokens: 100,
      requestedMaximumOutputTokens: 256,
      reservedCostMicrounits: 612,
      requestProjectionHash: 'a'.repeat(64),
    })
    expect(start).toMatchObject({
      kind: 'started',
      maximumOutputTokens: 256,
    })
    if (start.kind !== 'started') {
      throw new Error('M4.3 Attempt 未通过数据库启动裁决。')
    }
    const startedRows = await sql<
      {
        readonly lifecycle: string
        readonly payload: {
          readonly reservedInputTokens?: number
          readonly reservedOutputTokens?: number
          readonly reservedCostMicrounits?: number
          readonly usageAccounting?: string
        }
      }[]
    >`
      SELECT lifecycle, attempt_payload AS payload
      FROM app_private.agent_attempts
      WHERE id = ${start.attemptId}::uuid
    `
    expect(startedRows[0]).toMatchObject({
      lifecycle: 'started',
      payload: {
        reservedInputTokens: 100,
        reservedOutputTokens: 256,
        reservedCostMicrounits: 612,
        usageAccounting: 'pending',
      },
    })
    await expect(
      control.finishAttempt({
        attemptId: start.attemptId,
        lifecycle: 'completed',
        accepted: true,
        inputTokens: 101,
        outputTokens: 20,
        costMicrounits: 130,
        durationMs: 50,
        errorCode: null,
        responseProjectionHash: 'b'.repeat(64),
        validationStatus: 'valid',
        usageAccounting: 'providerReported',
        costAccounting: 'allInputAtCacheMiss',
        validatedOutput: { accepted: true },
      }),
    ).resolves.toBe('budgetExceeded')

    const terminalRows = await sql<
      {
        readonly lifecycle: string
        readonly inputTokens: number
        readonly outputTokens: number
        readonly accepted: boolean
      }[]
    >`
      SELECT lifecycle, input_tokens::float8 AS "inputTokens",
             output_tokens::float8 AS "outputTokens", accepted
      FROM app_private.agent_attempts
      WHERE id = ${start.attemptId}::uuid
    `
    expect(terminalRows[0]).toEqual({
      lifecycle: 'completed',
      inputTokens: 101,
      outputTokens: 20,
      accepted: false,
    })

    for (const [index, hashCharacter] of ['c', 'd'].entries()) {
      await coordinator.workerControl.renewLease(claim.authority)
      const correction = await control.startAttempt({
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        stage: 'decision_analysis',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        estimatedInputTokens: 100,
        requestedMaximumOutputTokens: 256,
        reservedCostMicrounits: 612,
        requestProjectionHash: hashCharacter.repeat(64),
      })
      if (correction.kind !== 'started') {
        throw new Error(
          `M4.3 第 ${index + 2} 次 Attempt 被过早拒绝：${correction.failure}。`,
        )
      }
      await coordinator.workerControl.renewLease(claim.authority)
      await expect(
        control.finishAttempt({
          attemptId: correction.attemptId,
          lifecycle: 'completed',
          accepted: false,
          inputTokens: 90,
          outputTokens: 20,
          costMicrounits: 130,
          durationMs: 50,
          errorCode: null,
          responseProjectionHash: String(index + 3).repeat(64),
          validationStatus: 'invalid',
          usageAccounting: 'providerReported',
          costAccounting: 'allInputAtCacheMiss',
          validatedOutput: null,
        }),
      ).resolves.toBe('recorded')
    }
    await coordinator.workerControl.renewLease(claim.authority)
    const competingStarts = await Promise.all([
      control.startAttempt({
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        stage: 'decision_analysis',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        estimatedInputTokens: 100,
        requestedMaximumOutputTokens: 256,
        reservedCostMicrounits: 612,
        requestProjectionHash: 'e'.repeat(64),
      }),
      secondControl.startAttempt({
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        stage: 'decision_analysis',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        estimatedInputTokens: 100,
        requestedMaximumOutputTokens: 256,
        reservedCostMicrounits: 612,
        requestProjectionHash: 'f'.repeat(64),
      }),
    ])
    const winningStart = competingStarts.find(
      (candidate) => candidate.kind === 'started',
    )
    expect(
      competingStarts.filter((candidate) => candidate.kind === 'started'),
    ).toHaveLength(1)
    expect(
      competingStarts.filter(
        (candidate) =>
          candidate.kind === 'rejected' &&
          candidate.failure === 'execution_budget_exhausted',
      ),
    ).toHaveLength(1)
    if (winningStart?.kind !== 'started') {
      throw new Error('M4.3 双连接 Attempt 竞争没有产生唯一胜者。')
    }
    await coordinator.workerControl.renewLease(claim.authority)
    await expect(
      control.finishAttempt({
        attemptId: winningStart.attemptId,
        lifecycle: 'completed',
        accepted: false,
        inputTokens: 90,
        outputTokens: 20,
        costMicrounits: 130,
        durationMs: 50,
        errorCode: null,
        responseProjectionHash: '7'.repeat(64),
        validationStatus: 'invalid',
        usageAccounting: 'providerReported',
        costAccounting: 'allInputAtCacheMiss',
        validatedOutput: null,
      }),
    ).resolves.toBe('recorded')
    await coordinator.workerControl.renewLease(claim.authority)
    await expect(
      control.startAttempt({
        attemptType: 'correction',
        routingReasonCode: 'content_correction',
        stage: 'decision_analysis',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        estimatedInputTokens: 100,
        requestedMaximumOutputTokens: 256,
        reservedCostMicrounits: 612,
        requestProjectionHash: 'f'.repeat(64),
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      failure: 'execution_budget_exhausted',
    })

    await coordinator.workerControl.renewLease(claim.authority)
    await sql.begin((transaction) =>
      coordinator.finalize(transaction, {
        runId,
        authority: claim.authority,
        lifecycle: 'completed',
        terminationReason: null,
        completedAt: new Date().toISOString(),
      }),
    )

    const createStartedAttemptFixture = async (label: string) => {
      const fixtureRunId = randomUUID()
      await sql.begin((transaction) =>
        coordinator.createOrReuse(transaction, {
          runtimeType: 'coach',
          agentRunId: fixtureRunId,
          sessionId,
          handId,
          triggerType: 'hand_completed',
          idempotencyKey: `m43/coach/${label}/${fixtureRunId}`,
          supersedesRunId: null,
          dataDependencies: [],
          createdAt: new Date().toISOString(),
        }),
      )
      const fixtureClaim = await coordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: `m43-${label}:coach:0`,
      })
      if (
        fixtureClaim.kind !== 'claimed' ||
        fixtureClaim.run.runId !== fixtureRunId
      ) {
        throw new Error(`M4.3 ${label} 竞争测试 Run 未领取。`)
      }
      await coordinator.workerControl.markRunning(fixtureClaim.authority)
      const primaryControl = createDatabaseModelAttemptControl({
        sql,
        repository: createAgentFoundationAuditRepository(),
        owner: resolvedOwner,
        authority: fixtureClaim.authority,
        sessionId,
        agentRunId: fixtureRunId,
      })
      const secondaryControl = createDatabaseModelAttemptControl({
        sql: secondSql,
        repository: createAgentFoundationAuditRepository(),
        owner: secondOwner,
        authority: fixtureClaim.authority,
        sessionId,
        agentRunId: fixtureRunId,
      })
      const fixtureStart = await primaryControl.startAttempt({
        attemptType: 'initial',
        routingReasonCode: null,
        stage: 'hindsight',
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        estimatedInputTokens: 100,
        requestedMaximumOutputTokens: 256,
        reservedCostMicrounits: 612,
        requestProjectionHash: '1'.repeat(64),
      })
      if (fixtureStart.kind !== 'started') {
        throw new Error(`M4.3 ${label} 竞争测试 Attempt 未启动。`)
      }
      return {
        runId: fixtureRunId,
        claim: fixtureClaim,
        primaryControl,
        secondaryControl,
        attemptId: fixtureStart.attemptId,
      }
    }

    const finishAcceptedAttempt = (attemptId: string) => ({
      attemptId,
      lifecycle: 'completed' as const,
      accepted: true,
      inputTokens: 90,
      outputTokens: 20,
      costMicrounits: 130,
      durationMs: 50,
      errorCode: null,
      responseProjectionHash: '8'.repeat(64),
      validationStatus: 'valid' as const,
      usageAccounting: 'providerReported' as const,
      costAccounting: 'allInputAtCacheMiss' as const,
      validatedOutput: { accepted: true } as const,
    })

    const fencingFixture = await createStartedAttemptFixture('fencing')
    await sql`
      UPDATE app_private.agent_runs
      SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${fencingFixture.runId}::uuid
    `
    const [replacementClaim, oldWriterResult] = await Promise.all([
      coordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: fencingFixture.claim.authority.leaseOwner,
      }),
      fencingFixture.secondaryControl.finishAttempt(
        finishAcceptedAttempt(fencingFixture.attemptId),
      ),
    ])
    expect(replacementClaim).toMatchObject({
      kind: 'claimed',
      run: {
        runId: fencingFixture.runId,
        fencingToken: fencingFixture.claim.authority.fencingToken + 1,
      },
    })
    expect(oldWriterResult).toBe('authorityLost')
    if (replacementClaim.kind !== 'claimed') {
      throw new Error('M4.3 新 fencing token 竞争未产生新 authority。')
    }
    await coordinator.workerControl.markRunning(replacementClaim.authority)
    await sql.begin((transaction) =>
      coordinator.finalize(transaction, {
        runId: fencingFixture.runId,
        authority: replacementClaim.authority,
        lifecycle: 'completed',
        terminationReason: null,
        completedAt: new Date().toISOString(),
      }),
    )
    const fencedAttemptRows = await sql<{ readonly lifecycle: string }[]>`
      SELECT lifecycle
      FROM app_private.agent_attempts
      WHERE id = ${fencingFixture.attemptId}::uuid
    `
    expect(fencedAttemptRows[0]?.lifecycle).toBe('stale')

    const cancellationFixture =
      await createStartedAttemptFixture('cancellation')
    let releaseCancellation!: () => void
    let settleCancellationReadiness!: (
      readiness:
        | { readonly kind: 'ready' }
        | { readonly kind: 'failed'; readonly error: unknown },
    ) => void
    const cancellationHold = new Promise<void>((resolve) => {
      releaseCancellation = resolve
    })
    const cancellationReady = new Promise<
      | { readonly kind: 'ready' }
      | { readonly kind: 'failed'; readonly error: unknown }
    >((resolve) => {
      settleCancellationReadiness = resolve
    })
    const cancellation = secondSql.begin(async (transaction) => {
      try {
        const result = await secondCoordinator.cancel(transaction, {
          runId: cancellationFixture.runId,
          reason: 'user_cancelled',
          completedAt: new Date().toISOString(),
        })
        settleCancellationReadiness({ kind: 'ready' })
        await cancellationHold
        return result
      } catch (error) {
        settleCancellationReadiness({ kind: 'failed', error })
        throw error
      }
    })
    void cancellation.catch((error: unknown) =>
      settleCancellationReadiness({ kind: 'failed', error }),
    )
    const cancellationReadiness = await cancellationReady
    if (cancellationReadiness.kind === 'failed') {
      releaseCancellation()
      await Promise.allSettled([cancellation])
      throw cancellationReadiness.error
    }
    const cancelledWriter = Promise.resolve().then(() =>
      cancellationFixture.primaryControl.finishAttempt(
        finishAcceptedAttempt(cancellationFixture.attemptId),
      ),
    )
    try {
      await new Promise<void>((resolve) => setImmediate(resolve))
    } finally {
      releaseCancellation()
    }
    await expect(cancellation).resolves.toMatchObject({
      run: { lifecycle: 'cancelled' },
    })
    await expect(cancelledWriter).resolves.toBe('authorityLost')
    const cancelledAttemptRows = await sql<{ readonly lifecycle: string }[]>`
      SELECT lifecycle
      FROM app_private.agent_attempts
      WHERE id = ${cancellationFixture.attemptId}::uuid
    `
    expect(cancelledAttemptRows[0]?.lifecycle).toBe('cancelled')

    const staleRunId = randomUUID()
    await sql.begin((transaction) =>
      coordinator.createOrReuse(transaction, {
        runtimeType: 'coach',
        agentRunId: staleRunId,
        sessionId,
        handId,
        triggerType: 'hand_completed',
        idempotencyKey: `m43/coach/${staleRunId}`,
        supersedesRunId: null,
        dataDependencies: [],
        createdAt: new Date().toISOString(),
      }),
    )
    const staleClaim = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm43-stale:coach:0',
    })
    if (staleClaim.kind !== 'claimed' || staleClaim.run.runId !== staleRunId) {
      throw new Error('M4.3 无法领取 deadline 测试 Run。')
    }
    await coordinator.workerControl.markRunning(staleClaim.authority)
    const staleCapabilityControl = createDatabaseCapabilityExecutionControl({
      sql,
      repository: createAgentFoundationAuditRepository(),
      owner,
      authority: staleClaim.authority,
      manifest: coachCapabilityManifest,
      sessionId,
      agentRunId: staleRunId,
    })
    const staleReservation = await staleCapabilityControl.reserveInvocation({
      capability: { id: 'coach.compute-decision-metrics', version: 1 },
      inputSchemaVersion: 1,
      inputHash: '5'.repeat(64),
    })
    if (staleReservation.kind !== 'reserved') {
      throw new Error('M4.3 deadline 测试 Capability 未预留。')
    }
    const staleControl = createDatabaseModelAttemptControl({
      sql,
      repository: createAgentFoundationAuditRepository(),
      owner,
      authority: staleClaim.authority,
      sessionId,
      agentRunId: staleRunId,
    })
    await coordinator.workerControl.renewLease(staleClaim.authority)
    const staleStart = await staleControl.startAttempt({
      attemptType: 'initial',
      routingReasonCode: null,
      stage: 'hindsight',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      estimatedInputTokens: 100,
      requestedMaximumOutputTokens: 256,
      reservedCostMicrounits: 612,
      requestProjectionHash: '9'.repeat(64),
    })
    if (staleStart.kind !== 'started') {
      throw new Error('M4.3 deadline 测试 Attempt 未启动。')
    }
    await coordinator.workerControl.renewLease(staleClaim.authority)
    await sql`
      UPDATE app_private.agent_runs
      SET deadline_at = created_at + interval '1 millisecond'
      WHERE id = ${staleRunId}::uuid
    `
    await expect(
      staleControl.finishAttempt({
        attemptId: staleStart.attemptId,
        lifecycle: 'completed',
        accepted: true,
        inputTokens: 90,
        outputTokens: 20,
        costMicrounits: 130,
        durationMs: 50,
        errorCode: null,
        responseProjectionHash: '8'.repeat(64),
        validationStatus: 'valid',
        usageAccounting: 'providerReported',
        costAccounting: 'allInputAtCacheMiss',
        validatedOutput: { accepted: true },
      }),
    ).resolves.toBe('stale')
    await expect(
      staleCapabilityControl.finishInvocation({
        reservationId: staleReservation.reservationId,
        audit: {
          capability: {
            id: 'coach.compute-decision-metrics',
            version: 1,
          },
          authorized: true,
          inputSchemaVersion: 1,
          inputHash: '5'.repeat(64),
          outputSchemaVersion: 1,
          outputHash: '4'.repeat(64),
          budgetCost: 1,
          durationMs: 10,
          errorCode: null,
        },
      }),
    ).resolves.toBe('stale')
    const staleAttemptRows = await sql<
      { readonly lifecycle: string; readonly accepted: boolean }[]
    >`
      SELECT lifecycle, accepted
      FROM app_private.agent_attempts
      WHERE id = ${staleStart.attemptId}::uuid
    `
    expect(staleAttemptRows[0]).toEqual({
      lifecycle: 'stale',
      accepted: false,
    })
    const staleInvocationRows = await sql<
      {
        readonly outputSchemaVersion: number | null
        readonly outputHash: string | null
        readonly errorCategory: string | null
      }[]
    >`
      SELECT output_schema_version AS "outputSchemaVersion",
             output_hash AS "outputHash",
             error_category AS "errorCategory"
      FROM app_private.agent_capability_invocations
      WHERE id = ${staleReservation.reservationId}::uuid
    `
    expect(staleInvocationRows[0]).toEqual({
      outputSchemaVersion: null,
      outputHash: null,
      errorCategory: 'capability_deadline_exhausted',
    })
    await sql.begin((transaction) =>
      coordinator.cancel(transaction, {
        runId: staleRunId,
        reason: 'process_restart',
        completedAt: new Date().toISOString(),
      }),
    )

    const expiredFixture = await createStartedAttemptFixture('expired-lease')
    await sql`
      UPDATE app_private.agent_runs
      SET lease_expires_at = clock_timestamp() - interval '1 millisecond'
      WHERE id = ${expiredFixture.runId}::uuid
    `
    await expect(
      expiredFixture.secondaryControl.finishAttempt(
        finishAcceptedAttempt(expiredFixture.attemptId),
      ),
    ).resolves.toBe('authorityLost')
    const expiredAttemptRows = await sql<{ readonly lifecycle: string }[]>`
      SELECT lifecycle
      FROM app_private.agent_attempts
      WHERE id = ${expiredFixture.attemptId}::uuid
    `
    expect(expiredAttemptRows[0]?.lifecycle).toBe('started')
  } finally {
    try {
      await secondSql.end({ timeout: 0 })
    } finally {
      await sql`
        DELETE FROM app_private.sessions
        WHERE id = ${sessionId}::uuid
      `
    }
  }
}
