import postgres, {
  type PendingQuery,
  type Row,
  type TransactionSql,
} from 'postgres'
import { createDatabaseClient } from '../db/client.js'
import type { ReviewReadBudget } from '../sessions/hand-history/completed-hand-review-source.js'

export interface CoachReadResource {
  readonly signal: AbortSignal
  read(
    statement: (transaction: TransactionSql) => PendingQuery<Row[]>,
    budget: ReviewReadBudget,
  ): Promise<readonly unknown[]>
  close(): Promise<void>
}

/** One service-owned pool; queueing is cancellable without borrowing a gameplay connection. */
export function createCoachReadResource(input: {
  readonly databaseUrl: string
  readonly admissionTimeoutMs: number
  readonly shutdownTimeoutMs: number
  readonly onForcedClose: () => void
  readonly sqlFactory?: typeof postgres
}): CoachReadResource {
  for (const limit of [input.admissionTimeoutMs, input.shutdownTimeoutMs]) {
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 2_147_483_647)
      throw new TypeError('invalid_coach_read_limit')
  }
  const client = createDatabaseClient(input.databaseUrl, input.sqlFactory, {
    max: 1,
  })
  const stopped = new AbortController()
  let tail: Promise<void> = Promise.resolve()
  let closing: Promise<void> | undefined
  function close(): Promise<void> {
    if (!closing) {
      stopped.abort(new Error('coach_service_stopped'))
      closing = client.sql.end({ timeout: 0 })
    }
    return closing
  }
  return Object.freeze({
    signal: stopped.signal,
    close,
    async read(
      statement: (transaction: TransactionSql) => PendingQuery<Row[]>,
      budget: ReviewReadBudget,
    ) {
      if (!Number.isFinite(budget.deadlineAt))
        throw new TypeError('invalid_coach_read_deadline')
      const deadline = Math.min(
        budget.deadlineAt,
        Date.now() + input.admissionTimeoutMs,
      )
      const request = new AbortController()
      let active = false
      let query: PendingQuery<Row[]> | undefined
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const abort = () => {
        if (request.signal.aborted) return
        request.abort(new Error('coach_read_cancelled'))
        query?.cancel()
        if (active && !stopped.signal.aborted)
          forceTimer = setTimeout(() => {
            // Lock the entire Coach service before releasing a stuck client.
            const closed = close()
            input.onForcedClose()
            void closed.catch(() => undefined)
          }, input.shutdownTimeoutMs)
      }
      const timeout = setTimeout(abort, Math.max(0, deadline - Date.now()))
      budget.signal.addEventListener('abort', abort, { once: true })
      stopped.signal.addEventListener('abort', abort, { once: true })
      if (
        budget.signal.aborted ||
        stopped.signal.aborted ||
        deadline <= Date.now()
      )
        abort()
      const previous = tail
      let release!: () => void
      const slot = new Promise<void>((resolve) => {
        release = resolve
      })
      tail = previous.then(() => slot)
      const cancelled = new Promise<never>((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else
          request.signal.addEventListener(
            'abort',
            () => reject(request.signal.reason),
            { once: true },
          )
      })
      try {
        await Promise.race([previous, cancelled])
        request.signal.throwIfAborted()
        active = true
        const rows = await client.sql.begin(async (transaction) => {
          request.signal.throwIfAborted()
          const execute = async (pending: PendingQuery<Row[]>) => {
            request.signal.throwIfAborted()
            query = pending
            try {
              return await pending
            } finally {
              query = undefined
            }
          }
          await execute(transaction`SET TRANSACTION READ ONLY`)
          const remaining = Math.max(1, Math.floor(deadline - Date.now()))
          await execute(
            transaction`SELECT set_config('statement_timeout', ${String(remaining)}, true), set_config('lock_timeout', ${String(remaining)}, true), set_config('idle_in_transaction_session_timeout', ${String(remaining)}, true)`,
          )
          return await execute(statement(transaction))
        })
        request.signal.throwIfAborted()
        return rows as readonly unknown[]
      } finally {
        active = false
        clearTimeout(timeout)
        if (forceTimer) clearTimeout(forceTimer)
        budget.signal.removeEventListener('abort', abort)
        stopped.signal.removeEventListener('abort', abort)
        release()
      }
    },
  })
}
