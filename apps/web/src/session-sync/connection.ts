import type { SseEvent } from '@tx-holdem-coach/contracts'
import { ApiError } from '../api/errors.js'
import type { SessionStream } from '../api/sse.js'
export type SyncStatus =
  | 'idle'
  | 'connecting'
  | 'calibrating'
  | 'ready'
  | 'reconnecting'
  | 'suspended'
  | 'blocked'
  | 'ended'
  | 'readonly'
  | 'missing'
export const terminal = (status: SyncStatus) =>
  ['ended', 'readonly', 'missing'].includes(status)
type Ports = {
  stream: SessionStream
  cursor: () => number | undefined
  receive: (event: SseEvent, context: unknown) => 'ok' | 'gap'
  begin: () => unknown
  read: (recovery: boolean) => Promise<unknown>
  cancelRead: () => void
  notify: () => void
  handleError: (error: ApiError, context: unknown) => SyncStatus | undefined
}
/** 只保存连接元信息；快照与恢复游标均从 Query 接收边界取得。 */
export class SessionConnection {
  status: SyncStatus = 'idle'
  error: ApiError | undefined
  private controller: AbortController | undefined
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private silenceTimer: ReturnType<typeof setTimeout> | undefined
  private barrierTimer: ReturnType<typeof setTimeout> | undefined
  private round = 0
  private failures = 0
  private protocolAttempted = false
  private snapshotSeen = false
  private calibration: Promise<void> | undefined
  private gapCursor = -1
  private leases = 0
  private hidden = false
  constructor(
    readonly id: string,
    private readonly ports: Ports,
  ) {}
  set(status: SyncStatus, error?: ApiError) {
    this.status = status
    this.error = error
    this.ports.notify()
  }
  private stop(cancelRead = true) {
    this.round++
    this.controller?.abort()
    this.controller = undefined
    clearTimeout(this.retryTimer)
    clearTimeout(this.silenceTimer)
    clearTimeout(this.barrierTimer)
    this.retryTimer = undefined
    this.calibration = undefined
    this.snapshotSeen = false
    this.gapCursor = -1
    if (cancelRead) this.ports.cancelRead()
  }
  finish(status: SyncStatus, error?: ApiError, preserveRead = false) {
    this.stop(!preserveRead)
    this.set(status, error)
  }
  acquire() {
    this.leases++
    if (this.leases === 1 && !terminal(this.status)) this.restart()
    let released = false
    return () => {
      if (released) return
      released = true
      this.leases--
      if (!this.leases) this.finish('idle')
    }
  }
  hasConsumers() {
    return this.leases > 0
  }
  visibility(hidden: boolean) {
    this.hidden = hidden
    if (!this.leases || terminal(this.status)) return
    if (hidden) this.finish('suspended')
    else this.restart()
  }
  online() {
    if (this.status === 'reconnecting') this.connect()
  }
  restart() {
    this.protocolAttempted = false
    if (this.leases && !this.hidden) this.connect()
    else if (this.leases) this.finish('suspended')
  }
  private alive(round: number) {
    return (
      round === this.round &&
      !this.controller?.signal.aborted &&
      !!this.controller
    )
  }
  private deadline(round: number) {
    clearTimeout(this.barrierTimer)
    this.barrierTimer = setTimeout(() => {
      if (this.alive(round)) this.fail(new ApiError('network'))
    }, 45_000)
  }
  private connect() {
    this.stop()
    if (!this.leases || this.hidden) return
    const round = this.round
    const controller = new AbortController()
    this.controller = controller
    const context = this.ports.begin()
    this.set('connecting')
    const touch = () => {
      if (!this.alive(round)) return
      clearTimeout(this.silenceTimer)
      this.silenceTimer = setTimeout(() => {
        if (this.alive(round)) this.fail(new ApiError('network'))
      }, 45_000)
    }
    touch()
    this.deadline(round)
    void this.ports
      .stream({
        sessionId: this.id,
        cursor: this.ports.cursor(),
        signal: controller.signal,
        onOpen: () => {
          if (this.alive(round)) this.set('calibrating')
        },
        onBytes: touch,
        onEvent: (event) => {
          if (!this.alive(round)) return
          const result = this.ports.receive(event, context)
          if (!this.alive(round)) return
          if (event.type === 'snapshot') {
            this.snapshotSeen = true
            // 先取消连接屏障之前的普通 GET，再允许新一轮读取。
            this.ports.cancelRead()
            this.calibration = undefined
            void this.calibrate(true)
          } else if (result === 'gap') {
            this.gapCursor = Math.max(this.gapCursor, event.eventSeq)
            void this.calibrate(false)
          }
        },
      })
      .then(
        () => {
          if (this.alive(round)) this.fail(new ApiError('network'), context)
        },
        (error) => {
          if (this.alive(round))
            this.fail(
              error instanceof ApiError ? error : new ApiError('network'),
              context,
            )
        },
      )
  }
  calibrate(recovery = false): Promise<void> {
    if (terminal(this.status)) return Promise.resolve()
    // 在途命令可以继续校准数据，但不能改写已经关闭的连接轮次。
    if (!this.controller) {
      const round = this.round
      return this.ports
        .read(recovery)
        .then(() => {})
        .catch((error) => {
          if (round === this.round)
            this.set(
              this.status,
              error instanceof ApiError ? error : new ApiError('network'),
            )
        })
    }
    if (this.calibration) return this.calibration
    const round = this.round
    this.set('calibrating')
    this.deadline(round)
    const task = this.ports
      .read(recovery)
      .then(() => {
        if (!this.alive(round) || terminal(this.status)) return
        this.calibration = undefined
        if ((this.ports.cursor() ?? -1) < this.gapCursor) {
          this.fail(new ApiError('network'))
          return
        }
        if (this.snapshotSeen) {
          clearTimeout(this.barrierTimer)
          this.failures = 0
          this.protocolAttempted = false
          this.set('ready')
        }
      })
      .catch((error) => {
        if (this.alive(round))
          this.fail(error instanceof ApiError ? error : new ApiError('network'))
      })
    this.calibration = task
    return task
  }
  fail(error: ApiError, context = this.ports.begin()) {
    let end: SyncStatus | undefined
    try {
      end = this.ports.handleError(error, context)
    } catch {
      error = new ApiError('protocol')
    }
    if (end) {
      this.finish(end, error)
      return
    }
    this.stop()
    if (error.kind === 'protocol') {
      if (this.protocolAttempted) {
        this.set('blocked', error)
        return
      }
      this.protocolAttempted = true
      this.set('calibrating', error)
      const round = this.round
      this.barrierTimer = setTimeout(() => {
        if (round === this.round) this.finish('blocked', error)
      }, 45_000)
      void this.ports
        .read(true)
        .then(() => {
          if (round === this.round && !terminal(this.status)) this.connect()
        })
        .catch(() => {
          if (round === this.round) this.finish('blocked', error)
        })
      return
    }
    if (
      error.kind === 'http' &&
      error.status !== 503 &&
      error.status !== 429 &&
      (error.status ?? 0) < 500
    ) {
      this.set('blocked', error)
      return
    }
    this.set('reconnecting', error)
    if (this.leases && !this.hidden)
      this.retryTimer = setTimeout(
        () => this.connect(),
        Math.min(30, 2 ** Math.min(this.failures++, 5)) * 1000,
      )
  }
}
