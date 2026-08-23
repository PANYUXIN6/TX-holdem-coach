import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'
import { createAgentFoundationAuditRepository } from '../../src/persistence/agent-foundation-audit-repository.js'
import { createDatabaseCapabilityExecutionControl } from '../../src/persistence/agent-capability-execution-control.js'
import { createDatabaseModelAttemptControl } from '../../src/persistence/agent-model-attempt-control.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { insertCommittedM27CompletedHand } from './database-repository-assertions.js'

const eventPort = { publish: async () => undefined }

export async function assertM43ModelAttemptControl(sql: Sql): Promise<void> {
  const sessionId = randomUUID()
  const handId = randomUUID()
  const runId = randomUUID()
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
    await sql.begin(async (transaction) => {
      const auditStartedAt = new Date().toISOString()
      await repository.appendCapabilityInvocationAudit(
        transaction,
        resolvedOwner,
        claim.authority,
        {
          sessionId,
          agentRunId: runId,
          capabilityName: 'coach.compute-decision-metrics',
          capabilityVersion: 1,
          authorized: false,
          inputSchemaVersion: 1,
          inputHash: '1'.repeat(64),
          outputSchemaVersion: null,
          outputHash: null,
          budgetCost: 1,
          durationMs: 0,
          errorCode: 'capability_not_authorized',
          startedAt: auditStartedAt,
          completedAt: auditStartedAt,
        },
      )
      await repository.appendCapabilityInvocationAudit(
        transaction,
        resolvedOwner,
        claim.authority,
        {
          sessionId,
          agentRunId: runId,
          capabilityName: 'coach.compute-decision-metrics',
          capabilityVersion: 1,
          authorized: true,
          inputSchemaVersion: 1,
          inputHash: '2'.repeat(64),
          outputSchemaVersion: 1,
          outputHash: '3'.repeat(64),
          budgetCost: 0,
          durationMs: 0,
          errorCode: null,
          startedAt: auditStartedAt,
          completedAt: auditStartedAt,
        },
      )
    })
    const capabilities = [
      { id: 'coach.compute-decision-metrics', version: 1 },
      { id: 'coach.lookup-strategy-baseline', version: 1 },
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

    for (const [index, hashCharacter] of ['c', 'd', 'e'].entries()) {
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
        }),
      ).resolves.toBe('recorded')
    }
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
  } finally {
    await sql`
      DELETE FROM app_private.sessions
      WHERE id = ${sessionId}::uuid
    `
  }
}
