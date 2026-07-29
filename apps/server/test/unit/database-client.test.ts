import { describe, expect, test, vi } from 'vitest'
import postgres from 'postgres'
import type { Sql } from 'postgres'
import { createDatabaseClient } from '../../src/db/client.js'

describe('database client', () => {
  test('uses TLS and disables prepared statements for the transaction pooler', async () => {
    const end = vi.fn(async () => undefined)
    const sql = Object.assign(vi.fn(), {
      end,
      options: {
        parsers: {},
        serializers: {},
      },
    }) as unknown as Sql
    const sqlFactory = vi.fn(() => sql) as unknown as typeof postgres

    const client = createDatabaseClient('postgresql://runtime-url', sqlFactory)

    expect(sqlFactory).toHaveBeenCalledWith('postgresql://runtime-url', {
      ssl: 'require',
      prepare: false,
    })

    await client.close()

    expect(end).toHaveBeenCalledOnce()
  })
})
