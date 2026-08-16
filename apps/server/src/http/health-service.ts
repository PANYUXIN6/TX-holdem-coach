import {
  HealthResponseSchema,
  type HealthResponse,
} from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import { DatabaseOperationError } from '../persistence/errors.js'

export interface HealthService {
  read(): Promise<HealthResponse>
}

export function createHealthService(
  sql: Sql,
  options: { readonly timeoutMs?: number } = {},
): HealthService {
  const timeoutMs = options.timeoutMs ?? 2_000
  return Object.freeze({
    async read(): Promise<HealthResponse> {
      const query = sql`SELECT 1`
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          query,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => {
              try {
                const cancellation = query.cancel()
                void Promise.resolve(cancellation).catch(() => undefined)
              } catch {
                // The readiness result remains a sanitized database failure.
              } finally {
                reject(new DatabaseOperationError())
              }
            }, timeoutMs)
          }),
        ])
      } catch {
        throw new DatabaseOperationError()
      } finally {
        if (timeout !== undefined) clearTimeout(timeout)
      }
      return HealthResponseSchema.parse({
        status: 'ok',
        database: 'available',
      })
    },
  })
}
