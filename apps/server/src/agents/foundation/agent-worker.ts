import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { DatabaseOperationError } from '../../persistence/errors.js'
import {
  AgentRunTransitionError,
  AgentWorkerError,
} from './agent-run-lifecycle.js'
import type { LeasedAgentRun } from './agent-run-types.js'
import type {
  AgentRunWorkerControl,
  AgentWorkerFatal,
  AgentWorkerLifecyclePort,
  RuntimeExecutionPort,
} from './agent-worker-ports.js'
import type { RuntimeCommitAuthority } from './runtime-ports.js'
import type { RuntimeType } from './runtime-definition.js'

export const AGENT_RUN_HEARTBEAT_MS = 5_000
export const AGENT_WORKER_POLL_MS = 1_000
export const AGENT_WORKER_STOP_GRACE_MS = 10_000
export const AGENT_WORKER_MAX_CONSECUTIVE_DATABASE_ERRORS = 5

interface LaneSignal {
  readonly wait: (milliseconds: number) => Promise<void>
  readonly notify: () => void
}

function createLaneSignal(): LaneSignal {
  let waiter: (() => void) | null = null
  return {
    wait(milliseconds) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          if (waiter === wake) waiter = null
          resolve()
        }, milliseconds)
        const wake = (): void => {
          clearTimeout(timer)
          if (waiter === wake) waiter = null
          resolve()
        }
        waiter = wake
      })
    },
    notify() {
      const current = waiter
      waiter = null
      current?.()
    },
  }
}

function waitForHeartbeatInterval(
  milliseconds: number,
  execution: Promise<void>,
  forceStopSignal: AbortSignal,
): Promise<void> {
  if (forceStopSignal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      forceStopSignal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    forceStopSignal.addEventListener('abort', finish, { once: true })
    void execution.then(finish)
  })
}

function waitForCompletionOrTimeout(
  completion: Promise<unknown>,
  milliseconds: number,
): Promise<void> {
  return new Promise((resolve) => {
    let finished = false
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    void completion.then(finish, finish)
  })
}

function isRecoverableLaneError(error: unknown): boolean {
  return (
    error instanceof DatabaseOperationError ||
    (error instanceof AgentRunTransitionError &&
      error.failure === 'agent_run_fencing_rejected')
  )
}

export interface AgentWorker extends AgentWorkerLifecyclePort {}

export interface AgentWorkerExecutors {
  readonly player?: RuntimeExecutionPort<'player'>
  readonly coach?: RuntimeExecutionPort<'coach'>
}

export function createAgentWorker(input: {
  readonly control: AgentRunWorkerControl
  readonly executors: AgentWorkerExecutors
  readonly onDisposition?: (input: {
    readonly runtimeType: RuntimeType
    readonly runId: string
    readonly disposition:
      'terminal' | 'authorityLost' | 'runtimeSettlementRequired'
  }) => void
}): AgentWorker {
  const runtimeTypes = (Object.keys(input.executors) as RuntimeType[]).filter(
    (runtimeType) => input.executors[runtimeType] !== undefined,
  )
  if (
    runtimeTypes.length === 0 ||
    runtimeTypes.some(
      (runtimeType) =>
        input.executors[runtimeType]?.runtimeType !== runtimeType,
    )
  ) {
    throw new AgentWorkerError('worker_start_failed')
  }
  const processInstanceId = randomUUID()

  let state: 'stopped' | 'starting' | 'running' | 'stopping' | 'fatal' =
    'stopped'
  let hasStarted = false
  let stopPromise: Promise<void> | null = null
  let forceStop = false
  const forceStopController = new AbortController()
  let fatalSettled = false
  let resolveFatal!: (fatal: AgentWorkerFatal) => void
  const fatal = new Promise<AgentWorkerFatal>((resolve) => {
    resolveFatal = resolve
  })
  const signals = Object.freeze(
    Object.fromEntries(
      runtimeTypes.map((runtimeType) => [runtimeType, createLaneSignal()]),
    ) as Record<RuntimeType, LaneSignal>,
  )
  const activeControllers: Partial<Record<RuntimeType, AbortController>> = {}
  let lanePromises: readonly Promise<void>[] = []

  function settleFatal(runtimeType: RuntimeType): void {
    if (fatalSettled || state === 'stopping' || state === 'stopped') return
    fatalSettled = true
    state = 'fatal'
    resolveFatal({
      category:
        runtimeType === 'player'
          ? 'playerWorkerTerminatedUnexpectedly'
          : 'coachWorkerTerminatedUnexpectedly',
    })
    for (const runtimeType of runtimeTypes) {
      activeControllers[runtimeType]?.abort()
      signals[runtimeType].notify()
    }
  }

  async function heartbeat(
    authority: RuntimeCommitAuthority,
    controller: AbortController,
    executionSettled: () => boolean,
    execution: Promise<void>,
  ): Promise<void> {
    while (!executionSettled() && !forceStop) {
      await waitForHeartbeatInterval(
        AGENT_RUN_HEARTBEAT_MS,
        execution,
        forceStopController.signal,
      )
      if (executionSettled() || forceStop) return
      try {
        await input.control.renewLease(authority)
      } catch (error) {
        if (isRecoverableLaneError(error)) {
          controller.abort()
          return
        }
        throw error
      }
    }
  }

  async function executeClaimed(
    runtimeType: RuntimeType,
    claimed: Extract<
      Awaited<ReturnType<AgentRunWorkerControl['claimNext']>>,
      { readonly kind: 'claimed' }
    >,
  ): Promise<void> {
    if (state !== 'running') return
    let running: LeasedAgentRun
    try {
      running = await input.control.markRunning(claimed.authority)
    } catch (error) {
      if (isRecoverableLaneError(error)) return
      throw error
    }
    if (state !== 'running') return
    const controller = new AbortController()
    activeControllers[runtimeType] = controller
    let settled = false
    let executorOutcome: 'resolved' | 'rejected' = 'resolved'
    const executor = input.executors[runtimeType]
    if (executor === undefined) {
      throw new AgentWorkerError('worker_start_failed')
    }
    const execution = executor
      .execute(running as never, controller.signal)
      .catch(() => {
        executorOutcome = 'rejected'
      })
      .finally(() => {
        settled = true
      })
    const heartbeatOutcome = heartbeat(
      claimed.authority,
      controller,
      () => settled,
      execution,
    ).then(
      () => ({ kind: 'resolved' as const }),
      (error: unknown) => {
        controller.abort()
        settleFatal(runtimeType)
        return { kind: 'rejected' as const, error }
      },
    )
    await execution
    const heartbeatResult = await heartbeatOutcome
    if (activeControllers[runtimeType] === controller) {
      delete activeControllers[runtimeType]
    }
    if (heartbeatResult.kind === 'rejected') throw heartbeatResult.error
    if (hasForcedStopCompleted()) return
    const persisted = await input.control.inspectSettlement(claimed.authority)
    if (hasForcedStopCompleted()) return
    const disposition = input.control.classifyExecutionSettlement({
      runtimeType,
      executorOutcome,
      persisted,
    })
    input.onDisposition?.({ runtimeType, runId: running.runId, disposition })
  }

  async function lane(runtimeType: RuntimeType): Promise<void> {
    const leaseOwner = `${processInstanceId}:${runtimeType}:0`
    let consecutiveDatabaseErrors = 0
    while (state === 'running' || state === 'stopping') {
      if (state === 'stopping') return
      try {
        const claimed = await input.control.claimNext({
          runtimeType,
          leaseOwner,
        })
        if (claimed.kind === 'none') {
          consecutiveDatabaseErrors = 0
          await signals[runtimeType].wait(AGENT_WORKER_POLL_MS)
          continue
        }
        await executeClaimed(runtimeType, claimed)
        consecutiveDatabaseErrors = 0
      } catch (error) {
        if (hasStopBeenRequested()) return
        if (isRecoverableLaneError(error)) {
          if (error instanceof DatabaseOperationError) {
            consecutiveDatabaseErrors += 1
            if (
              consecutiveDatabaseErrors >=
              AGENT_WORKER_MAX_CONSECUTIVE_DATABASE_ERRORS
            ) {
              throw new AgentWorkerError(
                runtimeType === 'player'
                  ? 'player_worker_terminated_unexpectedly'
                  : 'coach_worker_terminated_unexpectedly',
              )
            }
          }
          await signals[runtimeType].wait(
            Math.min(
              AGENT_WORKER_POLL_MS * Math.max(consecutiveDatabaseErrors, 1),
              AGENT_WORKER_POLL_MS *
                AGENT_WORKER_MAX_CONSECUTIVE_DATABASE_ERRORS,
            ),
          )
          continue
        }
        throw error
      }
    }
  }

  function runLane(runtimeType: RuntimeType): Promise<void> {
    return lane(runtimeType).catch(() => {
      settleFatal(runtimeType)
    })
  }

  function hasStopBeenRequested(): boolean {
    return state === 'stopping' || state === 'stopped'
  }

  function hasForcedStopCompleted(): boolean {
    return forceStop || state === 'stopped'
  }

  const worker: AgentWorker = {
    fatal,
    async start() {
      if (state !== 'stopped' || hasStarted) {
        throw new AgentWorkerError('worker_already_started')
      }
      state = 'starting'
      hasStarted = true
      forceStop = false
      try {
        state = 'running'
        lanePromises = runtimeTypes.map((runtimeType) => runLane(runtimeType))
      } catch {
        state = 'stopped'
        throw new AgentWorkerError('worker_start_failed')
      }
    },
    wake(runtimeType, runIds) {
      if (state !== 'running') return
      if (
        !runtimeTypes.includes(runtimeType) ||
        !z.array(z.uuid()).safeParse([...new Set(runIds)]).success
      ) {
        return
      }
      signals[runtimeType].notify()
    },
    async stop() {
      if (stopPromise !== null) return stopPromise
      if (state === 'stopped') return
      stopPromise = (async () => {
        state = 'stopping'
        for (const runtimeType of runtimeTypes) {
          activeControllers[runtimeType]?.abort()
          signals[runtimeType].notify()
        }
        await waitForCompletionOrTimeout(
          Promise.allSettled(lanePromises),
          AGENT_WORKER_STOP_GRACE_MS,
        )
        forceStop = true
        forceStopController.abort()
        for (const runtimeType of runtimeTypes) signals[runtimeType].notify()
        state = 'stopped'
      })()
      return stopPromise
    },
  }
  return Object.freeze(worker)
}
