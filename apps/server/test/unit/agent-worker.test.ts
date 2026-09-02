import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  AGENT_WORKER_STOP_GRACE_MS,
  createAgentWorker,
} from '../../src/agents/foundation/agent-worker.js'
import type { LeasedAgentRun } from '../../src/agents/foundation/agent-run-types.js'
import type { AgentRunWorkerControl } from '../../src/agents/foundation/agent-worker-ports.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'

function leasedCoachRun(): LeasedAgentRun<'coach'> {
  const runId = randomUUID()
  return {
    runId,
    runtimeType: 'coach',
    leaseOwner: `${randomUUID()}:coach:0`,
    fencingToken: 1,
  } as LeasedAgentRun<'coach'>
}

afterEach(() => {
  vi.useRealTimers()
})

describe('agent worker', () => {
  test('only starts installed Player lane and rejects an empty executor map', async () => {
    vi.useFakeTimers()
    const claimedRuntimeTypes: string[] = []
    const worker = createAgentWorker({
      control: {
        async claimNext({ runtimeType }) {
          claimedRuntimeTypes.push(runtimeType)
          return { kind: 'none', diagnostics: [] }
        },
        async markRunning() {
          throw new Error('should not mark a run as running')
        },
        async renewLease() {
          throw new Error('should not renew a lease')
        },
        async inspectSettlement() {
          return 'terminal'
        },
        classifyExecutionSettlement() {
          return 'terminal'
        },
      },
      executors: { player: { runtimeType: 'player', async execute() {} } },
    })

    await worker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(claimedRuntimeTypes).toEqual(['player'])
    await worker.stop()

    expect(() =>
      createAgentWorker({
        control: {} as AgentRunWorkerControl,
        executors: {},
      }),
    ).toThrow()
  })

  test('stop 的宽限期是真实上界，即使 executor 忽略 abort 也会返回', async () => {
    vi.useFakeTimers()
    const run = leasedCoachRun()
    let claimed = false
    let executorSignal: AbortSignal | undefined
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        if (runtimeType === 'player' || claimed) {
          return { kind: 'none', diagnostics: [] }
        }
        claimed = true
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
        return 'activeUnsettled'
      },
      classifyExecutionSettlement() {
        return 'runtimeSettlementRequired'
      },
    }
    const worker = createAgentWorker({
      control,
      executors: {
        player: { runtimeType: 'player', async execute() {} },
        coach: {
          runtimeType: 'coach',
          execute(_run, signal) {
            executorSignal = signal
            return new Promise(() => undefined)
          },
        },
      },
    })

    await worker.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(executorSignal).toBeDefined()

    let stopped = false
    const stopping = worker.stop().then(() => {
      stopped = true
    })
    expect(executorSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(AGENT_WORKER_STOP_GRACE_MS - 1)
    expect(stopped).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await stopping
    expect(stopped).toBe(true)
  })

  test.each(['resolved', 'rejected'] as const)(
    'stop 返回后 executor 才 %s 时不再访问控制端口且不遗留 heartbeat timer',
    async (executorOutcome) => {
      vi.useFakeTimers()
      const run = leasedCoachRun()
      let claimed = false
      let releaseExecution!: () => void
      const execution = new Promise<void>((resolve, reject) => {
        releaseExecution = () => {
          if (executorOutcome === 'resolved') resolve()
          else reject(new Error('executor failed after stop'))
        }
      })
      const inspectSettlement = vi.fn(async () => 'activeUnsettled' as const)
      const classifyExecutionSettlement = vi.fn(
        () => 'runtimeSettlementRequired' as const,
      )
      const onDisposition = vi.fn()
      const control: AgentRunWorkerControl = {
        async claimNext({ runtimeType }) {
          if (runtimeType === 'player' || claimed) {
            return { kind: 'none', diagnostics: [] }
          }
          claimed = true
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
        inspectSettlement,
        classifyExecutionSettlement,
      }
      const worker = createAgentWorker({
        control,
        executors: {
          player: { runtimeType: 'player', async execute() {} },
          coach: {
            runtimeType: 'coach',
            async execute() {
              await execution
            },
          },
        },
        onDisposition,
      })

      await worker.start()
      await vi.advanceTimersByTimeAsync(0)
      const stopping = worker.stop()
      await vi.advanceTimersByTimeAsync(AGENT_WORKER_STOP_GRACE_MS)
      await stopping
      expect(vi.getTimerCount()).toBe(0)

      releaseExecution()
      await vi.advanceTimersByTimeAsync(0)

      expect(inspectSettlement).not.toHaveBeenCalled()
      expect(classifyExecutionSettlement).not.toHaveBeenCalled()
      expect(onDisposition).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  test('合作 executor 在 abort 后退出时可提前完成停机', async () => {
    vi.useFakeTimers()
    const run = leasedCoachRun()
    let claimed = false
    let executionStarted!: () => void
    const started = new Promise<void>((resolve) => {
      executionStarted = resolve
    })
    const control: AgentRunWorkerControl = {
      async claimNext({ runtimeType }) {
        if (runtimeType === 'player' || claimed) {
          return { kind: 'none', diagnostics: [] }
        }
        claimed = true
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
        return 'activeUnsettled'
      },
      classifyExecutionSettlement() {
        return 'runtimeSettlementRequired'
      },
    }
    const worker = createAgentWorker({
      control,
      executors: {
        player: { runtimeType: 'player', async execute() {} },
        coach: {
          runtimeType: 'coach',
          async execute(_run, signal) {
            executionStarted()
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            )
          },
        },
      },
    })

    await worker.start()
    await started
    await expect(worker.stop()).resolves.toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)
  })

  test.each(['resolved', 'rejected'] as const)(
    'executor %s 后复验持久化终态且不触发 lane fatal',
    async (executorOutcome) => {
      const run = leasedCoachRun()
      let claimed = false
      const authority = issueRuntimeCommitAuthority({
        runtimeType: 'coach',
        runId: run.runId,
        leaseOwner: run.leaseOwner,
        fencingToken: run.fencingToken,
      })
      const inspectSettlement = vi.fn(async () => 'activeUnsettled' as const)
      const classifyExecutionSettlement = vi.fn(
        () => 'runtimeSettlementRequired' as const,
      )
      const control: AgentRunWorkerControl = {
        async claimNext({ runtimeType }) {
          if (runtimeType === 'player' || claimed) {
            return { kind: 'none', diagnostics: [] }
          }
          claimed = true
          return { kind: 'claimed', run, authority }
        },
        async markRunning() {
          return { ...run, lifecycle: 'running' }
        },
        async renewLease() {
          return run
        },
        inspectSettlement,
        classifyExecutionSettlement,
      }
      let reportDisposition!: (value: string) => void
      const dispositionReported = new Promise<string>((resolve) => {
        reportDisposition = resolve
      })
      const worker = createAgentWorker({
        control,
        executors: {
          player: { runtimeType: 'player', async execute() {} },
          coach: {
            runtimeType: 'coach',
            async execute() {
              if (executorOutcome === 'rejected') {
                throw new Error('executor failed')
              }
            },
          },
        },
        onDisposition: ({ disposition }) => reportDisposition(disposition),
      })

      await worker.start()
      await expect(
        Promise.race([
          dispositionReported,
          worker.fatal.then(({ category }) => `fatal:${category}`),
        ]),
      ).resolves.toBe('runtimeSettlementRequired')
      expect(inspectSettlement).toHaveBeenCalledOnce()
      expect(inspectSettlement).toHaveBeenCalledWith(authority)
      expect(classifyExecutionSettlement).toHaveBeenCalledWith({
        runtimeType: 'coach',
        executorOutcome,
        persisted: 'activeUnsettled',
      })
      await worker.stop()
    },
  )
})
