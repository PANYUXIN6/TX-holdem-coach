import { z } from 'zod'
import type { AgentWorkerLifecyclePort } from '../foundation/agent-worker-ports.js'
import type { ActiveSessionCandidateReader } from '../../sessions/active-session-candidate-reader.js'

export const PLAYER_TURN_DISPATCHER_POLL_MS = 1_000
export const PLAYER_TURN_DISPATCHER_MAX_CONSECUTIVE_ERRORS = 5

export type ReconcileCurrentPlayerTurnInput = {
  readonly sessionId: string
  readonly trigger: 'sessionCommitted' | 'startupRepair' | 'periodicRepair'
  readonly observedAt: string
}

export interface PlayerCurrentTurnCoordinator {
  reconcileCurrentTurn(
    input: ReconcileCurrentPlayerTurnInput,
  ): Promise<
    | { readonly kind: 'started'; readonly runId: string }
    | { readonly kind: 'alreadyActive'; readonly runId: string }
    | { readonly kind: 'userTurn' | 'paused' | 'noTarget' }
  >
}

export interface PlayerTurnHintPort {
  notify(sessionId: string): void
}

export interface PlayerTurnDispatcherFatal {
  readonly category: 'playerTurnDispatcherTerminatedUnexpectedly'
}

export interface PlayerTurnDispatcherLifecycle extends PlayerTurnHintPort {
  readonly fatal: Promise<PlayerTurnDispatcherFatal>
  start(): Promise<void>
  reconcileStartup(sessionIds: readonly string[]): Promise<readonly string[]>
  stop(): Promise<void>
}

interface DispatcherSignal {
  wait(milliseconds: number): Promise<void>
  notify(): void
}

function createDispatcherSignal(): DispatcherSignal {
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

function asCanonicalSessionIds(input: readonly string[]): readonly string[] {
  const parsed = z.array(z.uuid()).safeParse(input)
  if (!parsed.success)
    throw new TypeError('Player Turn Dispatcher 场次 ID 无效。')
  return Object.freeze([...new Set(parsed.data)].sort())
}

export function createPlayerTurnDispatcher(input: {
  readonly currentTurnCoordinator: PlayerCurrentTurnCoordinator
  readonly candidateReader: ActiveSessionCandidateReader
  readonly worker: Pick<AgentWorkerLifecyclePort, 'wake'>
  readonly now?: () => string
  readonly pollMs?: number
  readonly onDiagnostic?: (input: {
    readonly category:
      'player_turn_hint_rejected' | 'player_turn_dispatch_failed'
  }) => void
}): PlayerTurnDispatcherLifecycle {
  if (
    typeof input.currentTurnCoordinator.reconcileCurrentTurn !== 'function' ||
    typeof input.candidateReader.listActiveSessionIds !== 'function' ||
    typeof input.worker.wake !== 'function'
  ) {
    throw new TypeError('Player Turn Dispatcher 依赖无效。')
  }
  const now = input.now ?? (() => new Date().toISOString())
  const pollMs = input.pollMs ?? PLAYER_TURN_DISPATCHER_POLL_MS
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) {
    throw new TypeError('Player Turn Dispatcher 轮询周期无效。')
  }

  let state: 'stopped' | 'running' | 'stopping' | 'fatal' = 'stopped'
  let loopPromise: Promise<void> | null = null
  let stopPromise: Promise<void> | null = null
  let immediateWork = Promise.resolve()
  const hints = new Set<string>()
  const signal = createDispatcherSignal()
  let fatalSettled = false
  let resolveFatal!: (value: PlayerTurnDispatcherFatal) => void
  const fatal = new Promise<PlayerTurnDispatcherFatal>((resolve) => {
    resolveFatal = resolve
  })

  function diagnose(
    category: 'player_turn_hint_rejected' | 'player_turn_dispatch_failed',
  ): void {
    try {
      input.onDiagnostic?.({ category })
    } catch {
      // Diagnostics never change durable Player scheduling facts.
    }
  }

  function settleFatal(): void {
    if (fatalSettled || state === 'stopping' || state === 'stopped') return
    fatalSettled = true
    state = 'fatal'
    resolveFatal({ category: 'playerTurnDispatcherTerminatedUnexpectedly' })
    signal.notify()
  }

  async function reconcileOne(
    sessionId: string,
    trigger: ReconcileCurrentPlayerTurnInput['trigger'],
    wake: boolean,
  ): Promise<string | null> {
    const result = await input.currentTurnCoordinator.reconcileCurrentTurn({
      sessionId,
      trigger,
      observedAt: now(),
    })
    if (result.kind !== 'started' && result.kind !== 'alreadyActive')
      return null
    if (wake) {
      try {
        input.worker.wake('player', [result.runId])
      } catch {
        diagnose('player_turn_dispatch_failed')
      }
    }
    return result.kind === 'started' ? result.runId : null
  }

  async function reconcileMany(inputValue: {
    readonly sessionIds: readonly string[]
    readonly trigger: ReconcileCurrentPlayerTurnInput['trigger']
    readonly wake: boolean
  }): Promise<readonly string[]> {
    const queuedRunIds: string[] = []
    for (const sessionId of asCanonicalSessionIds(inputValue.sessionIds)) {
      const queuedRunId = await reconcileOne(
        sessionId,
        inputValue.trigger,
        inputValue.wake,
      )
      if (queuedRunId !== null) queuedRunIds.push(queuedRunId)
    }
    return Object.freeze(queuedRunIds)
  }

  async function drainHints(): Promise<void> {
    if (hints.size === 0) return
    const sessionIds = [...hints]
    hints.clear()
    await reconcileMany({
      sessionIds,
      trigger: 'sessionCommitted',
      wake: true,
    })
  }

  async function runPeriodicLoop(): Promise<void> {
    let consecutiveErrors = 0
    while (state === 'running') {
      await signal.wait(pollMs)
      if (state !== 'running') return
      try {
        await drainHints()
        const sessionIds = await input.candidateReader.listActiveSessionIds()
        await reconcileMany({
          sessionIds,
          trigger: 'periodicRepair',
          wake: true,
        })
        consecutiveErrors = 0
      } catch {
        diagnose('player_turn_dispatch_failed')
        consecutiveErrors += 1
        if (
          consecutiveErrors >= PLAYER_TURN_DISPATCHER_MAX_CONSECUTIVE_ERRORS
        ) {
          settleFatal()
          return
        }
      }
    }
  }

  return Object.freeze({
    fatal,
    notify(sessionId: string) {
      if (!z.uuid().safeParse(sessionId).success) {
        diagnose('player_turn_hint_rejected')
        return
      }
      hints.add(sessionId)
      if (state !== 'running') return
      immediateWork = immediateWork
        .then(() => drainHints())
        .catch(() => {
          diagnose('player_turn_dispatch_failed')
        })
    },
    async reconcileStartup(sessionIds: readonly string[]) {
      if (state !== 'stopped') {
        throw new TypeError('Player Turn Dispatcher 启动修复状态无效。')
      }
      return reconcileMany({
        sessionIds,
        trigger: 'startupRepair',
        wake: false,
      })
    },
    async start() {
      if (state !== 'stopped') {
        throw new TypeError('Player Turn Dispatcher 已启动。')
      }
      state = 'running'
      loopPromise = runPeriodicLoop()
    },
    async stop() {
      if (stopPromise !== null) return stopPromise
      if (state === 'stopped') return
      stopPromise = (async () => {
        if (state !== 'fatal') state = 'stopping'
        signal.notify()
        await Promise.allSettled([loopPromise, immediateWork])
        state = 'stopped'
      })()
      return stopPromise
    },
  })
}
