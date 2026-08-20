import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { coachRuntimeDefinition } from '../../src/agents/coach/foundation-definition.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import type {
  AgentRunClaimInput,
  AgentRunCancellationInput,
  LeasedAgentRun,
  PersistedAgentRun,
} from '../../src/agents/foundation/agent-run-types.js'
import { AgentRunTransitionError } from '../../src/agents/foundation/agent-run-lifecycle.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import type { PersistedAgentRunEvent } from '../../src/agents/foundation/runtime-ports.js'
import type {
  ClaimCandidateDecision,
  AgentRunLifecycleRepository,
  PreparedAgentRunInsert,
  ClaimNextRepositoryResult,
} from '../../src/persistence/agent-run-lifecycle-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const handId = '33333333-3333-4333-8333-333333333333'
const runId = '44444444-4444-4444-8444-444444444444'
const participantId = '55555555-5555-4555-8555-555555555555'
const requestId = '66666666-6666-4666-8666-666666666666'
const noopEventPort = { publish: async () => undefined }

async function owner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function transaction(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  const query = (() =>
    Promise.resolve(pending.shift() ?? [])) as unknown as TransactionSql
  Object.assign(query, {
    json: (value: unknown) => value,
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

function playerPreparedRun(): PreparedAgentRunInsert {
  return {
    agentRunId: runId,
    runtimeType: 'player',
    sessionId,
    handId,
    participantId,
    sourceStateVersion: 9,
    decisionRequestId: requestId,
    triggerType: 'action_required',
    idempotencyKey: 'player/recovery/1',
    parentRunId: null,
    deadlineAt: '2099-01-01T00:02:00.000Z',
    runtimeDefinitionVersion: 1,
    runConfiguration: {
      runtime: 'player',
      runtimeDefinitionVersion: 1,
      contextSchemaVersion: playerRuntimeDefinition.contextSchemaVersion,
      promptModules: playerRuntimeDefinition.promptModules,
      capabilityManifest: {
        id: 'player.capability-manifest',
        version: playerRuntimeDefinition.capabilityManifest.manifestVersion,
      },
      capabilities: playerRuntimeDefinition.capabilityManifest.grants.map(
        ({ capability }) => capability,
      ),
      routePolicy: playerRuntimeDefinition.routePolicy,
      outputSchema: playerRuntimeDefinition.outputSchema,
      validator: playerRuntimeDefinition.validator,
      commitGate: {
        id: playerRuntimeDefinition.commitGate.id,
        version: playerRuntimeDefinition.commitGate.version,
      },
      recoveryPolicy: playerRuntimeDefinition.recoveryPolicy,
      dataDependencies: [],
    },
    budget: playerRuntimeDefinition.budgetPolicy.createSnapshot({
      runtimeType: 'player',
      attemptTimeoutSeconds: 15,
      decisionDeadlineSeconds: 45,
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
      eventPort: noopEventPort,
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
      eventPort: noopEventPort,
    })
    const result = await coordinator.createOrReuse(transaction([]), {
      runtimeType: 'coach',
      agentRunId: runId,
      sessionId,
      handId,
      triggerType: 'hand_completed',
      idempotencyKey: 'coach/review/1',
      supersedesRunId: null,
      dataDependencies: [],
      createdAt: '2026-08-17T00:00:00.000Z',
    })
    expect(result).toMatchObject({ kind: 'existing', committedEffects: [] })
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

  test('cancels process_restart rejected run during claimNext', async () => {
    const resolvedOwner = await owner()
    const candidate = {
      ...persistedRun(coachPreparedRun()),
      lifecycle: 'running' as const,
      leaseOwner: 'm42-foreign:coach:0',
      leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
    }
    let canceledRunId: string | undefined
    const publishedEvents: PersistedAgentRunEvent[] = []
    const repository = {
      async claimNext(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        _input: AgentRunClaimInput,
        validate: (candidate: PersistedAgentRun) => ClaimCandidateDecision,
      ): Promise<ClaimNextRepositoryResult> {
        const decision = validate(candidate)
        return Object.freeze({
          kind: 'none' as const,
          diagnostics:
            decision.kind === 'rejected' ? [decision.diagnostic] : [],
        })
      },
      async cancel(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        input: AgentRunCancellationInput,
      ) {
        canceledRunId = input.runId
        return Object.freeze({
          run: {
            ...candidate,
            lifecycle: 'cancelled',
            terminationReason: input.reason,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: input.completedAt,
          },
          changed: true,
        })
      },
    } as unknown as AgentRunLifecycleRepository
    const sql = Object.assign((() => undefined) as unknown as Sql, {
      begin: (callback: (transaction: TransactionSql) => unknown) =>
        callback(transaction([])),
    })
    const coordinator = createAgentRunCoordinator({
      sql,
      owner: resolvedOwner,
      repository,
      eventPort: {
        async publish(events) {
          publishedEvents.push(...events)
        },
      },
    })

    const result = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-local:coach:0',
    })

    expect(result).toMatchObject({
      kind: 'none',
      diagnostics: ['agent_run_recovery_rejected'],
    })
    expect(canceledRunId).toBe(runId)
    expect(publishedEvents).toMatchObject([
      { runtimeType: 'coach', kind: 'cancelled', runId },
    ])
  })

  test('cancels recovery-rejected runs even when a runnable run is claimed', async () => {
    const resolvedOwner = await owner()
    const rejectedCandidate = {
      ...persistedRun(coachPreparedRun()),
      lifecycle: 'running' as const,
      leaseOwner: 'm42-foreign:coach:0',
      leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
    }
    const claimableRunId = '77777777-7777-4777-8777-777777777777'
    const claimableCandidate = {
      ...persistedRun({ ...coachPreparedRun(), agentRunId: claimableRunId }),
      lifecycle: 'queued' as const,
      leaseOwner: null,
      leaseExpiresAt: null,
    }
    const claimedRun = {
      ...claimableCandidate,
      lifecycle: 'leased' as const,
      leaseOwner: 'm42-local:coach:0',
      leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
      fencingToken: 2,
    } as LeasedAgentRun
    const canceledRunIds: string[] = []
    const publishedEvents: PersistedAgentRunEvent[] = []
    const repository = {
      async claimNext(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        claimInput: AgentRunClaimInput,
        validate: (candidate: PersistedAgentRun) => ClaimCandidateDecision,
      ): Promise<ClaimNextRepositoryResult> {
        validate(rejectedCandidate)
        validate(claimableCandidate)
        expect(claimInput.runtimeType).toBe('coach')
        return {
          kind: 'claimed' as const,
          value: { run: claimedRun },
        }
      },
      async cancel(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        input: AgentRunCancellationInput,
      ) {
        canceledRunIds.push(input.runId)
        return Object.freeze({
          run: {
            ...rejectedCandidate,
            lifecycle: 'cancelled',
            terminationReason: input.reason,
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: input.completedAt,
          },
          changed: true,
        })
      },
    } as unknown as AgentRunLifecycleRepository
    const sql = Object.assign((() => undefined) as unknown as Sql, {
      begin: (callback: (transaction: TransactionSql) => unknown) =>
        callback(transaction([])),
    })
    const coordinator = createAgentRunCoordinator({
      sql,
      owner: resolvedOwner,
      repository,
      eventPort: {
        async publish(events) {
          publishedEvents.push(...events)
        },
      },
    })

    const result = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-local:coach:0',
    })

    expect(result).toMatchObject({
      kind: 'claimed',
      run: { runId: claimableRunId },
    })
    expect(canceledRunIds).toEqual([runId])
    expect(publishedEvents).toEqual([
      { runtimeType: 'coach', kind: 'cancelled', runId },
      { runtimeType: 'coach', kind: 'leased', runId: claimableRunId },
    ])
  })

  test('does not auto-cancel recovery-rejected Player runs', async () => {
    const resolvedOwner = await owner()
    const playerCandidate = {
      ...persistedRun(playerPreparedRun()),
      lifecycle: 'running' as const,
      leaseOwner: 'm42-foreign:player:0',
      leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
    }
    let cancelCalled = false
    const repository = {
      async claimNext(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        _input: AgentRunClaimInput,
        validate: (candidate: PersistedAgentRun) => ClaimCandidateDecision,
      ): Promise<ClaimNextRepositoryResult> {
        const decision = validate(playerCandidate)
        return Object.freeze({
          kind: 'none' as const,
          diagnostics:
            decision.kind === 'rejected' ? [decision.diagnostic] : [],
        })
      },
      async cancel() {
        cancelCalled = true
        return Object.freeze({
          run: {
            ...playerCandidate,
            lifecycle: 'cancelled' as const,
            terminationReason: 'process_restart',
            leaseOwner: null,
            leaseExpiresAt: null,
            completedAt: '2026-08-17T00:00:00.000000Z',
          },
          changed: true,
        })
      },
    } as unknown as AgentRunLifecycleRepository
    const sql = Object.assign((() => undefined) as unknown as Sql, {
      begin: (callback: (transaction: TransactionSql) => unknown) =>
        callback(transaction([])),
    })
    const coordinator = createAgentRunCoordinator({
      sql,
      owner: resolvedOwner,
      repository,
      eventPort: {
        async publish() {
          throw new Error('should not publish')
        },
      },
    })

    const result = await coordinator.workerControl.claimNext({
      runtimeType: 'player',
      leaseOwner: 'm42-local:player:0',
    })

    expect(result).toMatchObject({
      kind: 'none',
      diagnostics: ['agent_run_recovery_rejected'],
    })
    expect(cancelCalled).toBe(false)
  })

  test('treats already terminal recovery cancellation as converged', async () => {
    const resolvedOwner = await owner()
    const candidate = {
      ...persistedRun(coachPreparedRun()),
      lifecycle: 'running' as const,
      leaseOwner: 'm42-foreign:coach:0',
      leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
    }
    let cancelInvocations = 0
    const publishedEvents: PersistedAgentRunEvent[] = []
    const repository = {
      async claimNext(
        _transaction: TransactionSql,
        _owner: typeof resolvedOwner,
        _input: AgentRunClaimInput,
        validate: (candidate: PersistedAgentRun) => ClaimCandidateDecision,
      ): Promise<ClaimNextRepositoryResult> {
        const decision = validate(candidate)
        return Object.freeze({
          kind: 'none' as const,
          diagnostics:
            decision.kind === 'rejected' ? [decision.diagnostic] : [],
        })
      },
      async cancel() {
        cancelInvocations += 1
        throw new AgentRunTransitionError('agent_run_already_terminal')
      },
    } as unknown as AgentRunLifecycleRepository
    const sql = Object.assign((() => undefined) as unknown as Sql, {
      begin: (callback: (transaction: TransactionSql) => unknown) =>
        callback(transaction([])),
    })
    const coordinator = createAgentRunCoordinator({
      sql,
      owner: resolvedOwner,
      repository,
      eventPort: {
        async publish(events) {
          publishedEvents.push(...events)
        },
      },
    })

    const result = await coordinator.workerControl.claimNext({
      runtimeType: 'coach',
      leaseOwner: 'm42-local:coach:0',
    })

    expect(result).toMatchObject({
      kind: 'none',
      diagnostics: ['agent_run_recovery_rejected'],
    })
    expect(cancelInvocations).toBe(1)
    expect(publishedEvents).toEqual([])
  })
})
