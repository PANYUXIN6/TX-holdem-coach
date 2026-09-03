import type { Sql } from 'postgres'
import { z } from 'zod'
import type { ActiveSessionCandidateReader } from '../sessions/active-session-candidate-reader.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
} from './errors.js'
import type { ResolvedOwnerScope } from './owner-scope.js'

const CandidateRowSchema = z.strictObject({ sessionId: z.uuid() })

/**
 * 只提供 Owner 范围内的活动场次候选。当前私有状态和 Player Run 必须由
 * 后续 Session-first 事务重新读取，不能从扫描结果派生。
 */
export function createActiveSessionCandidateRepository(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): ActiveSessionCandidateReader {
  return Object.freeze({
    async listActiveSessionIds() {
      let rows: readonly unknown[]
      try {
        rows = await input.sql`
          SELECT id::text AS "sessionId"
          FROM app_private.sessions
          WHERE owner_id = ${input.owner.databaseOwnerId}::uuid
            AND lifecycle_status = 'active'
          ORDER BY id ASC
        `
      } catch {
        throw new DatabaseOperationError()
      }
      const parsed = z.array(CandidateRowSchema).safeParse(rows)
      if (!parsed.success) {
        throw new PersistenceDataCorruptionError('invalidSessionMutationState')
      }
      const sessionIds = parsed.data.map((row) => row.sessionId)
      if (
        new Set(sessionIds).size !== sessionIds.length ||
        sessionIds.some(
          (sessionId, index) =>
            index > 0 && sessionIds[index - 1]!.localeCompare(sessionId) >= 0,
        )
      ) {
        throw new PersistenceDataCorruptionError('invalidSessionMutationState')
      }
      return Object.freeze(sessionIds)
    },
  })
}
