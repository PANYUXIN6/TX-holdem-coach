import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import { deepFreeze } from '../personas/config.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import {
  isResolvedOwnerScope,
  resolveOwnerScope,
  type OwnerScope,
  type ResolvedOwnerScope,
} from './owner-scope.js'

export const PLAYER_TIMEOUT_SETTING_KEY = 'player-timeouts'
const POSTGRES_TEXT_OID = 25
const PLAYER_TIMEOUT_ADVISORY_NAMESPACE = 1_296_312_404

const PlayerTimeoutSettingsBaseSchema = z.strictObject({
  attemptTimeoutSeconds: z.number().int().min(5).max(30),
  decisionDeadlineSeconds: z.number().int().min(15).max(120),
})

export const PlayerTimeoutSettingsSchema =
  PlayerTimeoutSettingsBaseSchema.superRefine((settings, context) => {
    if (settings.decisionDeadlineSeconds < settings.attemptTimeoutSeconds) {
      context.addIssue({
        code: 'custom',
        path: ['decisionDeadlineSeconds'],
        message: '完整决策 deadline 不得小于单次尝试超时。',
      })
    }
  })

export type PlayerTimeoutSettings = Readonly<
  z.infer<typeof PlayerTimeoutSettingsSchema>
>

export const DEFAULT_PLAYER_TIMEOUT_SETTINGS: PlayerTimeoutSettings =
  deepFreeze({
    attemptTimeoutSeconds: 15,
    decisionDeadlineSeconds: 45,
  })

interface PlayerTimeoutSettingsRow {
  readonly settingPayload: unknown
}

const PlayerTimeoutSettingsPatchSchema =
  PlayerTimeoutSettingsBaseSchema.partial().refine(
    (patch) => Object.keys(patch).length > 0,
  )

export type PlayerTimeoutSettingsPatch = Readonly<
  z.infer<typeof PlayerTimeoutSettingsPatchSchema>
>

function parsePersistedSettings(
  row: PlayerTimeoutSettingsRow,
): PlayerTimeoutSettings {
  const result = PlayerTimeoutSettingsSchema.safeParse(row.settingPayload)
  if (!result.success) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }

  return deepFreeze(result.data)
}

export async function lockPlayerTimeoutSettings(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
): Promise<void> {
  if (typeof transaction !== 'function' || !isResolvedOwnerScope(owner)) {
    throw new RepositoryInputValidationError()
  }
  try {
    await transaction`
      SELECT pg_advisory_xact_lock(
        hashtext(${owner.databaseOwnerId}),
        ${PLAYER_TIMEOUT_ADVISORY_NAMESPACE}
      )
    `
  } catch {
    throw new DatabaseOperationError()
  }
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

export async function readResolvedPlayerTimeoutSettings(
  sql: Sql | TransactionSql,
  owner: ResolvedOwnerScope,
): Promise<PlayerTimeoutSettings> {
  if (!isResolvedOwnerScope(owner)) {
    throw new RepositoryInputValidationError()
  }

  let rows: readonly PlayerTimeoutSettingsRow[]
  try {
    rows = await sql<PlayerTimeoutSettingsRow[]>`
      SELECT
        setting_payload AS "settingPayload"
      FROM app_private.app_settings
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
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

export async function patchPlayerTimeoutSettings(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  patch: PlayerTimeoutSettingsPatch,
): Promise<PlayerTimeoutSettings> {
  const parsedPatch = PlayerTimeoutSettingsPatchSchema.safeParse(patch)
  if (
    typeof transaction !== 'function' ||
    !isResolvedOwnerScope(owner) ||
    !parsedPatch.success
  ) {
    throw new RepositoryInputValidationError()
  }

  await lockPlayerTimeoutSettings(transaction, owner)

  const defaultPayload = transaction.typed(
    JSON.stringify(DEFAULT_PLAYER_TIMEOUT_SETTINGS),
    POSTGRES_TEXT_OID,
  )
  try {
    await transaction`
      INSERT INTO app_private.app_settings (
        id,
        owner_id,
        setting_key,
        setting_payload,
        updated_at
      ) VALUES (
        ${randomUUID()}::uuid,
        ${owner.databaseOwnerId}::uuid,
        ${PLAYER_TIMEOUT_SETTING_KEY},
        ${defaultPayload}::jsonb,
        clock_timestamp()
      )
      ON CONFLICT (owner_id, setting_key) DO NOTHING
    `
  } catch {
    throw new DatabaseOperationError()
  }

  let lockedRows: readonly PlayerTimeoutSettingsRow[]
  try {
    lockedRows = await transaction<PlayerTimeoutSettingsRow[]>`
      SELECT
        setting_payload AS "settingPayload"
      FROM app_private.app_settings
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
      FOR UPDATE
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (lockedRows.length !== 1 || lockedRows[0] === undefined) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }

  const current = parsePersistedSettings(lockedRows[0])
  const merged = PlayerTimeoutSettingsSchema.safeParse({
    ...current,
    ...parsedPatch.data,
  })
  if (!merged.success) {
    throw new RepositoryInputValidationError()
  }

  const settingPayload = transaction.typed(
    JSON.stringify(merged.data),
    POSTGRES_TEXT_OID,
  )
  let updatedRows: readonly PlayerTimeoutSettingsRow[]
  try {
    updatedRows = await transaction<PlayerTimeoutSettingsRow[]>`
      UPDATE app_private.app_settings
      SET setting_payload = ${settingPayload}::jsonb,
          updated_at = clock_timestamp()
      WHERE owner_id = ${owner.databaseOwnerId}::uuid
        AND setting_key = ${PLAYER_TIMEOUT_SETTING_KEY}
      RETURNING
        setting_payload AS "settingPayload"
    `
  } catch {
    throw new DatabaseOperationError()
  }
  if (updatedRows.length !== 1 || updatedRows[0] === undefined) {
    throw new PersistenceDataCorruptionError('invalidPayload')
  }

  return parsePersistedSettings(updatedRows[0])
}

export async function writePlayerTimeoutSettings(
  sql: Sql | TransactionSql,
  ownerScope: OwnerScope,
  settings: PlayerTimeoutSettings,
): Promise<PlayerTimeoutSettings> {
  const result = PlayerTimeoutSettingsSchema.safeParse(settings)
  if (!result.success) {
    throw new RepositoryInputValidationError()
  }

  const resolvedOwner = await resolveOwnerScope(sql, ownerScope)
  const write = async (transaction: TransactionSql): Promise<void> => {
    await lockPlayerTimeoutSettings(transaction, resolvedOwner)
    const settingPayload = transaction.typed(
      JSON.stringify(result.data),
      POSTGRES_TEXT_OID,
    )
    await transaction`
      INSERT INTO app_private.app_settings (
        id,
        owner_id,
        setting_key,
        setting_payload,
        updated_at
      ) VALUES (
        ${randomUUID()}::uuid,
        ${resolvedOwner.databaseOwnerId}::uuid,
        ${PLAYER_TIMEOUT_SETTING_KEY},
        ${settingPayload}::jsonb,
        clock_timestamp()
      )
      ON CONFLICT (owner_id, setting_key) DO UPDATE SET
        setting_payload = EXCLUDED.setting_payload,
        updated_at = EXCLUDED.updated_at
    `
  }
  try {
    if ('begin' in sql && typeof sql.begin === 'function') {
      await sql.begin(write)
    } else {
      await write(sql as TransactionSql)
    }
  } catch {
    throw new DatabaseOperationError()
  }

  return deepFreeze(result.data)
}
