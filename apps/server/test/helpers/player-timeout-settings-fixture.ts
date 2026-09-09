import type { JSONValue, Sql } from 'postgres'
import type { ResolvedOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  lockPlayerTimeoutSettings,
  PLAYER_TIMEOUT_SETTING_KEY,
} from '../../src/persistence/player-settings-repository.js'

export interface PlayerTimeoutSettingsRowSnapshot {
  readonly id: string
  readonly settingPayload: unknown
  readonly updatedAt: string
}

export async function readPlayerTimeoutSettingsRow(
  sql: Sql,
  databaseOwnerId: string,
): Promise<PlayerTimeoutSettingsRowSnapshot | undefined> {
  const rows = await sql<readonly PlayerTimeoutSettingsRowSnapshot[]>`
    SELECT
      id::text AS id,
      setting_payload AS "settingPayload",
      updated_at::text AS "updatedAt"
    FROM app_private.app_settings
    WHERE owner_id = ${databaseOwnerId}::uuid
      AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
  `
  if (rows.length > 1) {
    throw new Error('Player timeout 设置行不唯一。')
  }
  return rows[0]
}

export async function restorePlayerTimeoutSettingsRow(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly original: PlayerTimeoutSettingsRowSnapshot | undefined
}): Promise<void> {
  await input.sql.begin(async (transaction) => {
    await lockPlayerTimeoutSettings(transaction, input.owner)
    await transaction`
      DELETE FROM app_private.app_settings
      WHERE owner_id = ${input.owner.databaseOwnerId}::uuid
        AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
    `
    if (input.original === undefined) return
    await transaction`
      INSERT INTO app_private.app_settings (
        id, owner_id, setting_key, setting_payload, updated_at
      ) VALUES (
        ${input.original.id}::uuid,
        ${input.owner.databaseOwnerId}::uuid,
        ${PLAYER_TIMEOUT_SETTING_KEY},
        ${transaction.json(input.original.settingPayload as JSONValue)},
        ${input.original.updatedAt}::timestamptz
      )
    `
  })
}
