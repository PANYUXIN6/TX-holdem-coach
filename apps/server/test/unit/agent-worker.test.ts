import { randomUUID } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import {
  AGENT_WORKER_MAX_CONSECUTIVE_DATABASE_ERRORS,
  createAgentWorker,
} from '../../src/agents/foundation/agent-worker.js'
import type { LeasedAgentRun } from '../../src/agents/foundation/agent-run-types.js'
import type { AgentRunWorkerControl } from '../../src/agents/foundation/agent-worker-ports.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { coachRuntimeDefinition } from '../../src/agents/coach/foundation-definition.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { DatabaseOperationError } from '../../src/persistence/errors.js'

function leased(runtimeType: 'player' | 'coach'): LeasedAgentRun {
  const runId = randomUUID()
  const leaseOwner = `worker-test:${runtimeType}:0`
  const definition =
    runtimeType === 'player' ? playerRuntimeDefinition : coachRuntimeDefinition
  const budget =
    runtimeType === 'player'
      ? playerRuntimeDefinition.budgetPolicy.createSnapshot({
          runtimeType: 'player',
          attemptTimeoutSeconds: 15,
          decisionDeadlineSeconds: 45,
        })
      : coachRuntimeDefinition.budgetPolicy.createSnapshot({
          runtimeType: 'coach',
        })
  return {
    ownerId: 'local-user',
    runId,
    runtimeType,
    sessionId: randomUUID(),
    handId: randomUUID(),
    triggerType: 'test_run',
    lifecycle: 'leased',
    idempotencyKey: `test/${runId}`,
    parentRunId: null,
    replacementRunId: null,
    leaseOwner,
    leaseExpiresAt: '2099-01-01T00:00:00.000000Z',
    fencingToken: 1,
    deadlineAt: '2099-01-01T00:00:00.000000Z',
    runtimeDefinitionVersion: 1,
    terminationReason: null,
    runConfiguration: {
      runtime: runtimeType,
      runtimeDefinitionVersion: 1,
      contextSchemaVersion: 1,
      promptModules: [],
      capabilityManifest: {
        id: `${runtimeType}.capability-manifest`,
        version: 1,
      },
      capabilities: [],
      routePolicy: definition.routePolicy,
      outputSchema: definition.outputSchema,
      validator: definition.validator,
      commitGate: definition.commitGate,
      recoveryPolicy: definition.recoveryPolicy,
      dataDependencies: [],
    },
    budget,
    checkpointPayloadVersion: null,
    checkpointPayload: null,
    resultPayloadVersion: null,
    resultPayload: null,
    createdAt: '2026-08-17T00:00:00.000000Z',
    startedAt: null,
    completedAt: null,
    updatedAt: '2026-08-17T00:00:00.000000Z',
    participantId: runtimeType === 'player' ? randomUUID() : null,
    sourceStateVersion: runtimeType === 'player' ? 1 : null,
    decisionRequestId: runtimeType === 'player' ? randomUUID() : null,
  } as LeasedAgentRun
}

async function eventually(assertion: () => void): Promise<void> {
  const deadline = Date.now() + 500
  for (;;) {
    try {
      assertion()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  }
}

describe('agent worker', () => {
  test('starts explicit isolated lanes and never converts executor resolution into completion', async () => {
    const runs = { player: leased('player'), coach: leased('coach') }
    const claims = { player: 0, coach: 0 }
    const dispositions: string[] = []
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        claims[runtimeType] += 1
        if (claims[runtimeType] > 1) return { kind: 'none', diagnostics: [] }
        const run = runs[runtimeType]
        return {
          kind: 'claimed',
          run,
          authority: issueRuntimeCommitAuthority({
            runtimeType,
            runId: run.runId,
            leaseOwner: run.leaseOwner,
            fencingToken: run.fencingToken,
          }),
        }
      },
      async markRunning(authority) {
        return { ...runs[authority.runtimeType], lifecycle: 'running' }
      },
      async renewLease(authority) {
        return runs[authority.runtimeType]
      },
      async inspectSettlement() {
        return 'activeUnsettled'
      },
      classifyExecutionSettlement() {
        return 'runtimeSettlementRequired'
      },
    }
    const executed: Runtime[] = []
    type Runtime = 'player' | 'coach'
    const worker = createAgentWorker({
      control,
      playerExecutor: {
        runtimeType: 'player',
        async execute() {
          executed.push('player')
        },
      },
      coachExecutor: {
        runtimeType: 'coach',
        async execute() {
          executed.push('coach')
        },
      },
      timing: { heartbeatMs: 10, pollMs: 10, stopGraceMs: 20 },
      onDisposition: ({ disposition }) => dispositions.push(disposition),
    })

    expect(claims).toEqual({ player: 0, coach: 0 })
    await worker.start()
    await eventually(() => {
      expect(executed.sort()).toEqual(['coach', 'player'])
      expect(dispositions).toEqual([
        'runtimeSettlementRequired',
        'runtimeSettlementRequired',
      ])
    })
    await expect(worker.start()).rejects.toMatchObject({
      failure: 'worker_already_started',
    })
    await worker.stop()
    await worker.stop()
    await expect(
      Promise.race([
        worker.fatal.then(() => 'fatal' as const),
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 20),
        ),
      ]),
    ).resolves.toBe('pending')
  })

  test('resolves one stable lane fatal after the supervised database error threshold', async () => {
    const claims = { player: 0, coach: 0 }
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        claims[runtimeType] += 1
        if (runtimeType === 'player') throw new DatabaseOperationError()
        return { kind: 'none', diagnostics: [] }
      },
      async markRunning() {
        throw new Error('unreachable')
      },
      async renewLease() {
        throw new Error('unreachable')
      },
      async inspectSettlement() {
        return 'authorityLost'
      },
      classifyExecutionSettlement() {
        return 'authorityLost'
      },
    }
    const worker = createAgentWorker({
      control,
      playerExecutor: {
        runtimeType: 'player',
        async execute() {},
      },
      coachExecutor: {
        runtimeType: 'coach',
        async execute() {},
      },
      timing: { heartbeatMs: 1, pollMs: 1, stopGraceMs: 5 },
    })

    await worker.start()
    await expect(worker.fatal).resolves.toEqual({
      category: 'playerWorkerTerminatedUnexpectedly',
    })
    expect(claims.player).toBe(AGENT_WORKER_MAX_CONSECUTIVE_DATABASE_ERRORS)
    await worker.stop()
  })

  test('does not resolve stop before an executor and its settlement inspection exit', async () => {
    const run = leased('coach')
    let releaseExecution!: () => void
    const execution = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    let inspected = false
    let stopSettled = false
    let coachClaimed = false
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        if (runtimeType === 'player' || coachClaimed) {
          return { kind: 'none', diagnostics: [] }
        }
        coachClaimed = true
        return {
          kind: 'claimed',
          run,
          authority: issueRuntimeCommitAuthority({
            runtimeType: 'coach',
            runId: run.runId,
            leaseOwner: run.leaseOwner,
            fencingToken: run.fencingToken,
          }),
        }
      },
      async markRunning() {
        return { ...run, lifecycle: 'running' }
      },
      async renewLease() {
        return run
      },
      async inspectSettlement() {
        inspected = true
        return 'activeUnsettled'
      },
      classifyExecutionSettlement() {
        return 'runtimeSettlementRequired'
      },
    }
    const worker = createAgentWorker({
      control,
      playerExecutor: { runtimeType: 'player', async execute() {} },
      coachExecutor: {
        runtimeType: 'coach',
        async execute() {
          await execution
        },
      },
      timing: { heartbeatMs: 5, pollMs: 5, stopGraceMs: 10 },
    })

    await worker.start()
    await eventually(() => expect(coachClaimed).toBe(true))
    const stopping = worker.stop().then(() => {
      stopSettled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopSettled).toBe(false)
    expect(inspected).toBe(false)

    releaseExecution()
    await stopping
    expect(inspected).toBe(true)
  })

  test('does not start an executor when stop is requested while markRunning is pending', async () => {
    const run = leased('coach')
    let releaseMarkRunning!: () => void
    const markRunningGate = new Promise<void>((resolve) => {
      releaseMarkRunning = resolve
    })
    let reportMarkRunning!: () => void
    const markRunningStarted = new Promise<void>((resolve) => {
      reportMarkRunning = resolve
    })
    let coachClaimed = false
    let executions = 0
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        if (runtimeType === 'player' || coachClaimed) {
          return { kind: 'none', diagnostics: [] }
        }
        coachClaimed = true
        return {
          kind: 'claimed',
          run,
          authority: issueRuntimeCommitAuthority({
            runtimeType: 'coach',
            runId: run.runId,
            leaseOwner: run.leaseOwner,
            fencingToken: run.fencingToken,
          }),
        }
      },
      async markRunning() {
        reportMarkRunning()
        await markRunningGate
        return { ...run, lifecycle: 'running' }
      },
      async renewLease() {
        return run
      },
      async inspectSettlement() {
        return 'activeUnsettled'
      },
      classifyExecutionSettlement() {
        return 'runtimeSettlementRequired'
      },
    }
    const worker = createAgentWorker({
      control,
      playerExecutor: { runtimeType: 'player', async execute() {} },
      coachExecutor: {
        runtimeType: 'coach',
        async execute() {
          executions += 1
        },
      },
      timing: { heartbeatMs: 5, pollMs: 5, stopGraceMs: 5 },
    })

    await worker.start()
    await markRunningStarted
    const stopping = worker.stop()
    await new Promise((resolve) => setTimeout(resolve, 10))
    releaseMarkRunning()
    await stopping

    expect(executions).toBe(0)
    await expect(
      Promise.race([
        worker.fatal.then(() => 'fatal' as const),
        new Promise<'pending'>((resolve) =>
          setTimeout(() => resolve('pending'), 10),
        ),
      ]),
    ).resolves.toBe('pending')
  })

  test('supervises a heartbeat failure immediately and aborts a pending executor', async () => {
    const run = leased('coach')
    let releaseExecution!: () => void
    const executionGate = new Promise<void>((resolve) => {
      releaseExecution = resolve
    })
    let reportExecutionStarted!: () => void
    const executionStarted = new Promise<void>((resolve) => {
      reportExecutionStarted = resolve
    })
    let coachClaimed = false
    let executorSignal: AbortSignal | undefined
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        if (runtimeType === 'player' || coachClaimed) {
          return { kind: 'none', diagnostics: [] }
        }
        coachClaimed = true
        return {
          kind: 'claimed',
          run,
          authority: issueRuntimeCommitAuthority({
            runtimeType: 'coach',
            runId: run.runId,
            leaseOwner: run.leaseOwner,
            fencingToken: run.fencingToken,
          }),
        }
      },
      async markRunning() {
        return { ...run, lifecycle: 'running' }
      },
      async renewLease() {
        throw new Error('heartbeat failed')
      },
      async inspectSettlement() {
        return 'activeUnsettled'
      },
      classifyExecutionSettlement() {
        return 'runtimeSettlementRequired'
      },
    }
    const worker = createAgentWorker({
      control,
      playerExecutor: { runtimeType: 'player', async execute() {} },
      coachExecutor: {
        runtimeType: 'coach',
        async execute(_run, signal) {
          executorSignal = signal
          reportExecutionStarted()
          await executionGate
        },
      },
      timing: { heartbeatMs: 1, pollMs: 5, stopGraceMs: 5 },
    })

    await worker.start()
    await executionStarted
    await expect(
      Promise.race([
        worker.fatal,
        new Promise<'timeout'>((resolve) =>
          setTimeout(() => resolve('timeout'), 100),
        ),
      ]),
    ).resolves.toEqual({ category: 'coachWorkerTerminatedUnexpectedly' })
    expect(executorSignal?.aborted).toBe(true)

    const stopping = worker.stop()
    releaseExecution()
    await stopping
  })
})
