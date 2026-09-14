import { describe, expect, test, vi } from 'vitest'
import {
  createDatabaseTestSql,
  runAbortableDatabasePhase,
  runDatabaseTestWithCleanup,
} from '../integration/database-test-runtime.js'

const { clients } = vi.hoisted(() => ({
  clients: [] as { closed: boolean; queries: string[] }[],
}))

vi.mock('postgres', () => ({
  default: (
    _url: string,
    options: { connection: { application_name: string } },
  ) => {
    const client = { closed: false, queries: [] as string[] }
    clients.push(client)
    const query = async (strings: TemplateStringsArray) => {
      if (client.closed) throw new Error('CONNECTION_ENDED')
      client.queries.push(strings.join('?'))
      return [{ completed: true }]
    }
    const tx = Object.assign(query, {
      unsafe: () => ({
        simple: async () => [
          [],
          [],
          [],
          [{ application_name: options.connection.application_name }],
          [{ statement_timeout: '90s' }],
          [{ idle_in_transaction_session_timeout: '1min' }],
        ],
      }),
    })
    return Object.assign(query, {
      begin: async (callback: (transaction: typeof tx) => unknown) => {
        if (client.closed) throw new Error('CONNECTION_ENDED')
        return callback(tx)
      },
      end: async () => {
        client.closed = true
      },
    })
  },
}))

describe('database fixture cleanup connections', () => {
  test.each(['abort', 'connection failure'])(
    'restores fixtures through a fresh protected connection after %s',
    async (failureKind) => {
      clients.length = 0
      const controller = new AbortController()
      const failure = new Error(failureKind)
      let reportStarted!: () => void
      const started = new Promise<void>((resolve) => {
        reportStarted = resolve
      })
      const cleanup = vi.fn()
      const phase = runAbortableDatabasePhase(
        'cleanup recovery',
        controller.signal,
        async () => {
          const sql = createDatabaseTestSql(
            'unused-offline-url',
            '0123456789abcdef',
            'fixture',
          )
          await runDatabaseTestWithCleanup(
            async () => {
              if (failureKind === 'connection failure') {
                await sql.end()
                throw failure
              }
              await sql.begin(async () => {
                reportStarted()
                await new Promise<void>(() => undefined)
              })
            },
            async () => {
              expect(clients[0]?.closed).toBe(true)
              const rows = await sql.begin((tx) => tx`SELECT 'restore fixture'`)
              cleanup(rows)
            },
          )
        },
        { now: () => 0, write: () => undefined },
      )
      if (failureKind === 'abort') {
        await started
        controller.abort(failure)
      }
      await expect(phase).rejects.toBe(failure)
      expect(cleanup).toHaveBeenCalledWith([{ completed: true }])
      expect(clients).toHaveLength(2)
      expect(clients.every((client) => client.closed)).toBe(true)
      expect(clients[1]?.queries).toEqual(["SELECT 'restore fixture'"])
    },
  )
})
