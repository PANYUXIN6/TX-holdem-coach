import { describe, expect, test, vi } from 'vitest'
import type postgres from 'postgres'
import type { Sql, TransactionSql } from 'postgres'
import { createCoachReadResource } from '../../src/persistence/coach-read-resource.js'

function clientFixture(stuck = false) {
  let resolveRead!: (rows: unknown[]) => void
  let rejectRead!: (error: Error) => void
  const statements: string[] = []
  let transactions = 0
  let active = 0
  const cancel = vi.fn(() => {
    if (!stuck) rejectRead(new Error('cancelled'))
  })
  const sql = Object.assign(vi.fn(), {
    options: { parsers: {}, serializers: {} },
    begin: async (operation: (tx: TransactionSql) => Promise<unknown>) => {
      transactions++
      active++
      const tx = ((strings: TemplateStringsArray) => {
        const text = strings.join('?')
        statements.push(text)
        const query = text.includes('slow')
          ? new Promise<unknown[]>((resolve, reject) => {
              resolveRead = resolve
              rejectRead = reject
            })
          : Promise.resolve([])
        return Object.assign(query, { cancel })
      }) as unknown as TransactionSql
      try {
        return await operation(tx)
      } finally {
        active--
      }
    },
    end: vi.fn(async () => {
      rejectRead?.(new Error('closed'))
    }),
  }) as unknown as Sql
  const factory = vi.fn(() => sql) as unknown as typeof postgres
  const forced = vi.fn()
  const resource = createCoachReadResource({
    databaseUrl: 'postgresql://fixture',
    admissionTimeoutMs: 5000,
    shutdownTimeoutMs: 20,
    onForcedClose: forced,
    sqlFactory: factory,
  })
  return {
    resource,
    factory,
    statements,
    cancel,
    forced,
    sql,
    resolve: () => resolveRead([]),
    get transactions() {
      return transactions
    },
    get active() {
      return active
    },
  }
}
const budget = (signal = new AbortController().signal) => ({
  signal,
  deadlineAt: Date.now() + 5000,
})
async function untilStarted(fixture: ReturnType<typeof clientFixture>) {
  await vi.waitFor(() =>
    expect(fixture.statements.some((text) => text.includes('slow'))).toBe(true),
  )
}
describe('isolated Coach read resource', () => {
  test('uses max=1; queued cancellation performs no SQL and a completed read returns its connection', async () => {
    const fixture = clientFixture()
    expect(fixture.factory).toHaveBeenCalledWith('postgresql://fixture', {
      ssl: 'require',
      prepare: false,
      max: 1,
    })
    const first = fixture.resource.read((tx) => tx`SELECT slow`, budget())
    await untilStarted(fixture)
    const abort = new AbortController()
    const queued = fixture.resource.read(
      (tx) => tx`SELECT should_not_run`,
      budget(abort.signal),
    )
    const rejected = expect(queued).rejects.toThrow('coach_read_cancelled')
    abort.abort()
    await rejected
    expect(fixture.transactions).toBe(1)
    fixture.resolve()
    await first
    expect(fixture.active).toBe(0)
    expect(fixture.statements[0]).toBe('SET TRANSACTION READ ONLY')
    await fixture.resource.close()
  })
  test.each([false, true])(
    'cancels in-flight SQL and drains before rejection (stuck=%s)',
    async (stuck) => {
      const fixture = clientFixture(stuck)
      const abort = new AbortController()
      const reading = fixture.resource.read(
        (tx) => tx`SELECT slow`,
        budget(abort.signal),
      )
      const rejected = expect(reading).rejects.toThrow()
      await untilStarted(fixture)
      abort.abort()
      await rejected
      expect(fixture.active).toBe(0)
      expect(fixture.cancel).toHaveBeenCalledOnce()
      expect(fixture.forced).toHaveBeenCalledTimes(stuck ? 1 : 0)
      if (stuck)
        await expect(
          fixture.resource.read((tx) => tx`SELECT 1`, budget()),
        ).rejects.toThrow()
      await fixture.resource.close()
      await fixture.resource.close()
      expect(fixture.sql.end).toHaveBeenCalledOnce()
    },
  )
})
