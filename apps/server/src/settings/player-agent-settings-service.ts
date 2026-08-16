import {
  PlayerAgentSettingsPatchRequestSchema,
  PlayerAgentSettingsResponseSchema,
  type PlayerAgentSettingsResponse,
} from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import {
  patchPlayerTimeoutSettings,
  readResolvedPlayerTimeoutSettings,
} from '../persistence/player-settings-repository.js'
import type { ResolvedOwnerScope } from '../persistence/owner-scope.js'
import {
  DatabaseOperationError,
  isRepositoryDomainError,
} from '../persistence/errors.js'

export interface PlayerAgentSettingsService {
  read(): Promise<PlayerAgentSettingsResponse>
  update(request: unknown): Promise<PlayerAgentSettingsResponse>
}

export function createPlayerAgentSettingsService(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
}): PlayerAgentSettingsService {
  const { sql, owner } = input
  return Object.freeze({
    async read(): Promise<PlayerAgentSettingsResponse> {
      const settings = await readResolvedPlayerTimeoutSettings(sql, owner)
      return PlayerAgentSettingsResponseSchema.parse({
        settings,
      })
    },
    async update(request: unknown): Promise<PlayerAgentSettingsResponse> {
      const parsed = PlayerAgentSettingsPatchRequestSchema.parse(request)
      let settings
      try {
        settings = await sql.begin((transaction) =>
          patchPlayerTimeoutSettings(transaction, owner, parsed.settings),
        )
      } catch (error) {
        if (isRepositoryDomainError(error)) throw error
        throw new DatabaseOperationError()
      }
      return PlayerAgentSettingsResponseSchema.parse({
        settings,
      })
    },
  })
}
