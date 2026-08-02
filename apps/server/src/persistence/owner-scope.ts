import type { Sql } from 'postgres'
import { z } from 'zod'
import {
  DatabaseOperationError,
  OwnerScopeResolutionError,
  RepositoryInputValidationError,
} from './errors.js'

export const OwnerScopeSchema = z.strictObject({
  ownerId: z.literal('local-user'),
})

export type OwnerScope = z.infer<typeof OwnerScopeSchema>

declare const resolvedOwnerScopeBrand: unique symbol

export interface ResolvedOwnerScope {
  readonly ownerId: 'local-user'
  readonly databaseOwnerId: string
  readonly [resolvedOwnerScopeBrand]: never
}

const resolvedOwnerScopes = new WeakSet<object>()

const DatabaseOwnerIdSchema = z.string().uuid()

export function isResolvedOwnerScope(
  value: unknown,
): value is ResolvedOwnerScope {
  return (
    typeof value === 'object' &&
    value !== null &&
    resolvedOwnerScopes.has(value)
  )
}

export async function resolveOwnerScope(
  sql: Sql,
  ownerScope: OwnerScope,
): Promise<ResolvedOwnerScope> {
  const parsedScope = OwnerScopeSchema.safeParse(ownerScope)
  if (!parsedScope.success) {
    throw new RepositoryInputValidationError()
  }

  let rows: readonly { readonly databaseOwnerId: string }[]
  try {
    rows = await sql<{ readonly databaseOwnerId: string }[]>`
      SELECT id::text AS "databaseOwnerId"
      FROM app_private.owners
      WHERE identity_key = ${parsedScope.data.ownerId}
    `
  } catch {
    throw new DatabaseOperationError()
  }

  if (rows.length !== 1) {
    throw new OwnerScopeResolutionError()
  }

  const databaseOwnerId = DatabaseOwnerIdSchema.safeParse(
    rows[0]?.databaseOwnerId,
  )
  if (!databaseOwnerId.success) {
    throw new OwnerScopeResolutionError()
  }

  const resolvedOwnerScope = Object.freeze({
    ownerId: parsedScope.data.ownerId,
    databaseOwnerId: databaseOwnerId.data,
  }) as ResolvedOwnerScope
  resolvedOwnerScopes.add(resolvedOwnerScope)
  return resolvedOwnerScope
}
