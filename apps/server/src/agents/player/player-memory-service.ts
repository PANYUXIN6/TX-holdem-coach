import type { DatabaseClient } from '../../db/client.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import type {
  CertifiedPlayerMemoryRevisionV1,
  PlayerMemoryRepository,
} from '../../persistence/player-memory-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { LeasedAgentRun } from '../foundation/agent-run-types.js'
import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import type { PlayerVisibleState } from '../../sessions/authoritative-state/player-visible-state.js'

export interface PlayerMemoryService {
  materializeForRun(input: {
    readonly owner: ResolvedOwnerScope
    readonly run: LeasedAgentRun<'player'>
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly observation: PlayerVisibleState
  }): Promise<CertifiedPlayerMemoryRevisionV1>
}

export function createPlayerMemoryService(input: {
  readonly database: DatabaseClient
  readonly repository: PlayerMemoryRepository
}): PlayerMemoryService {
  const service: PlayerMemoryService = {
    materializeForRun: ({ owner, run, authority, observation }) => {
      if (run.runId !== authority.runId) {
        throw new RangeError('Player Memory Run 与 authority 不一致。')
      }
      return runDatabaseTransaction(input.database.sql, (transaction) =>
        input.repository.materializeForRun(
          transaction,
          owner,
          authority,
          observation,
        ),
      )
    },
  }
  return Object.freeze(service)
}
