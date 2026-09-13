import type { Sql } from 'postgres'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  findLatestEndedSessionForRosterReuse,
  readSessionAgentSnapshots,
} from './session-repository.js'
import type { ResolvedOwnerScope } from './owner-scope.js'
import { ResourceNotFoundError } from './errors.js'

export function readLatestEndedRosterPreview(
  sql: Sql,
  owner: ResolvedOwnerScope,
) {
  return runDatabaseTransaction(sql, async (transaction) => {
    await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`
    const session = await findLatestEndedSessionForRosterReuse(
      transaction,
      owner,
    )
    if (session === null) throw new ResourceNotFoundError()
    const snapshots = await readSessionAgentSnapshots(
      transaction,
      owner,
      session.id,
    )
    return { session, snapshots }
  })
}
