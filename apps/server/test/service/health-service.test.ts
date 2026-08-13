import type { PendingQuery, Row, Sql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { createHealthService } from '../../src/http/health-service.js'
import { DatabaseOperationError } from '../../src/persistence/errors.js'

describe('health service', () => {
  test('cancels a stalled readiness query at its deadline', async () => {
    const cancel = vi.fn(() => Promise.reject(new Error('cancel failed')))
    const query = Object.assign(new Promise<never>(() => {}), {
      cancel,
    }) as unknown as PendingQuery<Row[]>
    const sql = (() => query) as unknown as Sql
    const service = createHealthService(sql, { timeoutMs: 10 })

    await expect(service.read()).rejects.toBeInstanceOf(DatabaseOperationError)
    expect(cancel).toHaveBeenCalledOnce()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})
