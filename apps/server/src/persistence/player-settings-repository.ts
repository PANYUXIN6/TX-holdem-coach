import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { z } from 'zod'
import { deepFreeze } from '../personas/config.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  UnknownPayloadVersionError,
} from './errors.js'
import { resolveOwnerScope, type OwnerScope } from './owner-scope.js'

export const PLAYER_TIMEOUT_SETTING_KEY = 'player-timeouts'
export const SETTING_PAYLOAD_VERSION = 1
const POSTGRES_TEXT_OID = 25

export const PlayerTimeoutSettingsPayloadV1Schema = z
  .strictObject({
    attemptTimeoutSeconds: z.number().int().min(5).max(30),
    decisionDeadlineSeconds: z.number().int().min(15).max(120),
  })
  .superRefine((settings, context) => {
    if (settings.decisionDeadlineSeconds < settings.attemptTimeoutSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['decisionDeadlineSeconds'],
        message: '完整决策 deadline 不得小于单次尝试超时。',
      })
    }
  })

export type PlayerTimeoutSettings = Readonly<
  z.infer<typeof PlayerTimeoutSettingsPayloadV1Schema>
>

export const DEFAULT_PLAYER_TIMEOUT_SETTINGS: PlayerTimeoutSettings =
  deepFreeze({
    attemptTimeoutSeconds: 15,
    decisionDeadlineSeconds: 45,
  })

interface PlayerTimeoutSettingsRow {
  readonly settingPayloadVersion: number
  readonly settingPayload: unknown
}

function parsePersistedSettings(
  row: PlayerTimeoutSettingsRow,
): PlayerTimeoutSettings {
  if (row.settingPayloadVersion !== SETTING_PAYLOAD_VERSION) {
    throw new UnknownPayloadVersionError('playerTimeoutSettings')
  }

  const result = PlayerTimeoutSettingsPayloadV1Schema.safeParse(
    row.settingPayload,
  )
  if (!result.success) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }

  return deepFreeze(result.data)
}

export async function readPlayerTimeoutSettings(
  sql: Sql,
  ownerScope: OwnerScope,
): Promise<PlayerTimeoutSettings> {
  const resolvedOwner = await resolveOwnerScope(sql, ownerScope)
  let rows: readonly PlayerTimeoutSettingsRow[]

  try {
    rows = await sql<PlayerTimeoutSettingsRow[]>`
      SELECT
        setting_payload_version AS "settingPayloadVersion",
        setting_payload AS "settingPayload"
      FROM app_private.app_settings
      WHERE owner_id = ${resolvedOwner.databaseOwnerId}::uuid
        AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
    `
  } catch {
    throw new DatabaseOperationError()
  }

  if (rows.length === 0) {
    return DEFAULT_PLAYER_TIMEOUT_SETTINGS
  }
  if (rows.length !== 1 || rows[0] === undefined) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }

  return parsePersistedSettings(rows[0])
}

export async function writePlayerTimeoutSettings(
  sql: Sql,
  ownerScope: OwnerScope,
  settings: PlayerTimeoutSettings,
): Promise<PlayerTimeoutSettings> {
  const result = PlayerTimeoutSettingsPayloadV1Schema.safeParse(settings)
  if (!result.success) {
    throw new RepositoryInputValidationError()
  }

  const resolvedOwner = await resolveOwnerScope(sql, ownerScope)
  const settingPayload = sql.typed(
    JSON.stringify(result.data),
    POSTGRES_TEXT_OID,
  )
  try {
    await sql`
      INSERT INTO app_private.app_settings (
        id,
        owner_id,
        setting_key,
        setting_payload_version,
        setting_payload,
        updated_at
      ) VALUES (
        ${randomUUID()}::uuid,
        ${resolvedOwner.databaseOwnerId}::uuid,
        ${PLAYER_TIMEOUT_SETTING_KEY},
        ${SETTING_PAYLOAD_VERSION},
        ${settingPayload}::jsonb,
        clock_timestamp()
      )
      ON CONFLICT (owner_id, setting_key) DO UPDATE SET
        setting_payload_version = EXCLUDED.setting_payload_version,
        setting_payload = EXCLUDED.setting_payload,
        updated_at = EXCLUDED.updated_at
    `
  } catch {
    throw new DatabaseOperationError()
  }

  return deepFreeze(result.data)
}
