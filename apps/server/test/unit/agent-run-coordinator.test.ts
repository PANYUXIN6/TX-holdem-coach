import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { coachRuntimeDefinition } from '../../src/agents/coach/foundation-definition.js'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import type { PersistedAgentRun } from '../../src/agents/foundation/agent-run-types.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import type {
  AgentRunLifecycleRepository,
  PreparedAgentRunInsert,
} from '../../src/persistence/agent-run-lifecycle-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const handId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const participantId = '55555555-5555-4555-8555-555555555555'
const requestId = '66666666-6666-4666-8666-666666666666'

async function owner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function transaction(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  const query = (() =>
    Promise.resolve(pending.shift() ?? [])) as unknown as TransactionSql
  Object.assign(query, {
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return query
}

function persistedRun(input: PreparedAgentRunInsert): PersistedAgentRun {
  const base = {
    ownerId: 'local-user' as const,
    runId: input.agentRunId,
    runtimeType: input.runtimeType,
    sessionId: input.sessionId,
    handId: input.handId,
    triggerType: input.triggerType,
    lifecycle: 'queued' as const,
    idempotencyKey: input.idempotencyKey,
    parentRunId: input.parentRunId,
    replacementRunId: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fencingToken: 0,
    deadlineAt: input.deadlineAt,
    runtimeDefinitionVersion: input.runtimeDefinitionVersion,
    terminationReason: null,
    runConfiguration:
      input.runConfiguration as PersistedAgentRun['runConfiguration'],
    budget: input.budget as PersistedAgentRun['budget'],
    checkpointPayloadVersion: null,
    checkpointPayload: null,
    resultPayloadVersion: null,
    resultPayload: null,
    createdAt: input.createdAt,
    startedAt: null,
    completedAt: null,
    updatedAt: input.createdAt,
  }
  return input.runtimeType === 'player'
    ? ({
        ...base,
        runtimeType: 'player',
        participantId: input.participantId!,
        sourceStateVersion: input.sourceStateVersion!,
        decisionRequestId: input.decisionRequestId!,
      } as PersistedAgentRun<'player'>)
    : ({
        ...base,
        runtimeType: 'coach',
        participantId: null,
        sourceStateVersion: null,
        decisionRequestId: null,
      } as PersistedAgentRun<'coach'>)
}

function coachPreparedRun(): PreparedAgentRunInsert {
  return {
    agentRunId: runId,
    runtimeType: 'coach',
    sessionId,
    handId,
    participantId: null,
    sourceStateVersion: null,
    decisionRequestId: null,
    triggerType: 'hand_completed',
    idempotencyKey: 'coach/recovery/1',
    parentRunId: null,
    deadlineAt: '2099-01-01T00:02:00.000Z',
    runtimeDefinitionVersion: 1,
    runConfiguration: {
      runtime: 'coach',
      runtimeDefinitionVersion: 1,
      contextSchemaVersion: coachRuntimeDefinition.contextSchemaVersion,
      promptModules: coachRuntimeDefinition.promptModules,
      capabilityManifest: {
        id: 'coach.capability-manifest',
        version: coachRuntimeDefinition.capabilityManifest.manifestVersion,
      },
      capabilities: coachRuntimeDefinition.capabilityManifest.grants.map(
        ({ capability }) => capability,
      ),
      routePolicy: coachRuntimeDefinition.routePolicy,
      outputSchema: coachRuntimeDefinition.outputSchema,
      validator: coachRuntimeDefinition.validator,
      commitGate: {
        id: coachRuntimeDefinition.commitGate.id,
        version: coachRuntimeDefinition.commitGate.version,
      },
      recoveryPolicy: coachRuntimeDefinition.recoveryPolicy,
      dataDependencies: [],
    },
    budget: coachRuntimeDefinition.budgetPolicy.createSnapshot({
      runtimeType: 'coach',
    }),
    createdAt: '2099-01-01T00:00:00.000Z',
  }
}

describe('agent run coordinator', () => {
  test('freezes the current Player definition and transaction-visible timeout settings', async () => {
    const resolvedOwner = await owner()
    let prepared: PreparedAgentRunInsert | undefined
    const repository = {
      async createOrReuse(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        input: PreparedAgentRunInsert,
      ) {
        prepared = input
        return { kind: 'created' as const, run: persistedRun(input) }
      },
    } as unknown as AgentRunLifecycleRepository
    const coordinator = createAgentRunCoordinator({
      sql: (() => undefined) as unknown as Sql,
      owner: resolvedOwner,
      repository,
    })

    const result = await coordinator.createOrReuse(
      transaction([
        [],
        [
          {
            settingPayload: {
              attemptTimeoutSeconds: 7,
              decisionDeadlineSeconds: 21,
            },
          },
        ],
      ]),
      resolvedOwner,
      {
        runtimeType: 'player',
        agentRunId: runId,
        sessionId,
        handId,
        actorParticipantId: participantId,
        sourceStateVersion: 9,
        decisionRequestId: requestId,
        triggerType: 'action_required',
        idempotencyKey: 'player/decision/9',
        supersedesRunId: null,
        dataDependencies: [],
        createdAt: '2026-08-17T00:00:00.000Z',
      },
    )

    expect(result.kind).toBe('created')
    expect(result.committedEffects).toHaveLength(1)
    expect(prepared?.budget).toMatchObject({
      attemptTimeoutMs: 7_000,
      maxWallClockMs: 21_000,
      maxAttempts: 3,
      maxOwnerConcurrentRuns: 2,
      maxSystemConcurrentRuns: 4,
    })
    expect(prepared?.deadlineAt).toBe('2026-08-17T00:00:21.000Z')
    expect(prepared?.runConfiguration).toMatchObject({
      runtime: 'player',
      runtimeDefinitionVersion: 1,
      capabilityManifest: {
        id: 'player.capability-manifest',
        version: 1,
      },
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.run.budget)).toBe(true)
  })

  test('returns no duplicate queued effect when persistence reuses the winner', async () => {
    const resolvedOwner = await owner()
    const repository = {
      async createOrReuse(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        input: PreparedAgentRunInsert,
      ) {
        return { kind: 'existing' as const, run: persistedRun(input) }
      },
    } as unknown as AgentRunLifecycleRepository
    const coordinator = createAgentRunCoordinator({
      sql: (() => undefined) as unknown as Sql,
      owner: resolvedOwner,
      repository,
    })
    const result = await coordinator.createOrReuse(
      transaction([]),
      resolvedOwner,
      {
        runtimeType: 'coach',
        agentRunId: runId,
        sessionId,
        handId,
        triggerType: 'hand_completed',
        idempotencyKey: 'coach/review/1',
        supersedesRunId: null,
        dataDependencies: [],
        createdAt: '2026-08-17T00:00:00.000Z',
      },
    )
    expect(result).toMatchObject({ kind: 'existing', committedEffects: [] })
  })

  test('validates a same-owner Coach checkpoint before reclaiming an expired run', async () => {
    const resolvedOwner = await owner()
    const prepared = coachPreparedRun()
    const candidate = {
      ...persistedRun(prepared),
      lifecycle: 'running' as const,
      leaseOwner: 'same-process:coach:0',
      leaseExpiresAt: '2000-01-01T00:00:00.000000Z',
      fencingToken: 1,
      checkpointPayloadVersion: 1,
      checkpointPayload: { phase: 'analysis' },
    } as PersistedAgentRun<'coach'>
    const repository = {
      async claimNext(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        _input: unknown,
        validate: (
          run: PersistedAgentRun,
        ) =>
          | { readonly kind: 'eligible' }
          | { readonly kind: 'rejected'; readonly diagnostic: string },
      ) {
        const decision = validate(candidate)
        return decision.kind === 'rejected'
          ? { kind: 'none' as const, diagnostics: [decision.diagnostic] }
          : { kind: 'none' as const, diagnostics: [] }
      },
    } as unknown as AgentRunLifecycleRepository
    let checkpointChecks = 0
    const sql = Object.assign((() => undefined) as unknown as Sql, {
      begin: (callback: (transaction: TransactionSql) => unknown) =>
        callback(transaction([])),
    })
    const coordinator = createAgentRunCoordinator({
      sql,
      owner: resolvedOwner,
      repository,
      isRecoveryCheckpointCompatible() {
        checkpointChecks += 1
        return false
      },
    })

    await expect(
      coordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'same-process:coach:0',
      }),
    ).resolves.toEqual({
      kind: 'none',
      diagnostics: ['agent_run_recovery_rejected'],
    })
    expect(checkpointChecks).toBe(1)
  })

  test('keeps committed markRunning successful when event delivery and its error callback both fail', async () => {
    const resolvedOwner = await owner()
    const leaseOwner = 'worker-test:coach:0'
    const run = {
      ...persistedRun(coachPreparedRun()),
      lifecycle: 'running' as const,
      leaseOwner,
      leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
      fencingToken: 1,
      startedAt: '2026-08-17T00:00:01.000000Z',
    } as PersistedAgentRun<'coach'>
    const repository = {
      async markRunning() {
        return run
      },
    } as unknown as AgentRunLifecycleRepository
    const sql = Object.assign((() => undefined) as unknown as Sql, {
      begin: (callback: (transaction: TransactionSql) => unknown) =>
        callback(transaction([])),
    })
    let deliveryErrors = 0
    const coordinator = createAgentRunCoordinator({
      sql,
      owner: resolvedOwner,
      repository,
      eventPort: {
        async publish() {
          throw new Error('event delivery failed')
        },
      },
      onEventDeliveryError() {
        deliveryErrors += 1
        throw new Error('event error recorder failed')
      },
    })
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'coach',
      runId: run.runId,
      leaseOwner,
      fencingToken: run.fencingToken,
    })

    await expect(
      coordinator.workerControl.markRunning(authority),
    ).resolves.toEqual(run)
    expect(deliveryErrors).toBe(1)
  })
})
