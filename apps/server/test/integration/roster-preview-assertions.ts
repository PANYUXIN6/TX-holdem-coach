import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { prepareCurrentCatalogRoster } from '../../src/sessions/roster-preparation.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { insertSessionRosterSnapshot } from '../helpers/session-roster-fixture.js'
import { readLatestEndedRosterPreview } from '../../src/persistence/roster-preview-repository.js'
import { deleteEndedSessionData } from '../../src/persistence/session-deletion-repository.js'
import { createDatabaseTestSqlForRole } from './database-test-runtime.js'

export async function assertRosterPreview(sql: Sql, runtimeUrl: string) {
  const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
  const sourceIds: string[] = []
  const deletion = createDatabaseTestSqlForRole(
    runtimeUrl,
    'm23-preview-delete',
  )
  try {
    const catalog = loadAndValidatePersonaCatalog()
    for (const index of [0, 1]) {
      const prepared = prepareCurrentCatalogRoster(catalog, {
        sessionId: randomUUID(),
        userParticipantId: randomUUID(),
        agents: catalog
          .list()
          .slice(0, 5)
          .map((entry, i) => ({
            personaId: entry.personaId,
            seatNumber: i + 1,
            agentParticipantId: randomUUID(),
          })),
      })
      sourceIds.push(prepared.sessionId)
      await sql.begin(async (transaction) => {
        await insertSessionRosterSnapshot(transaction, { ...prepared, owner })
      })
      // 特意让创建时间与结束时间的顺序相反。
      await sql`UPDATE app_private.sessions SET lifecycle_status = 'ended', ended_at = clock_timestamp() - (${index} * interval '1 hour') WHERE id = ${prepared.sessionId}::uuid`
    }
    const preview = await readLatestEndedRosterPreview(sql, owner)
    expect(preview.session.id).toBe(sourceIds[0])
    expect(preview.snapshots).toHaveLength(5)
    // 在来源 SELECT 后、快照 SELECT 前，由独立连接正式删除来源。
    let deleted = false
    const intercepted = new Proxy(sql, {
      get(target, property) {
        if (property !== 'begin') return Reflect.get(target, property)
        return (operation: (transaction: TransactionSql) => Promise<unknown>) =>
          target.begin((transaction) =>
            operation(
              new Proxy(transaction, {
                apply(query, receiver, arguments_) {
                  const template = arguments_[0] as TemplateStringsArray
                  if (
                    template.join(' ').includes('WITH target_session') &&
                    !deleted
                  ) {
                    deleted = true
                    return deletion
                      .begin(async (tx) => {
                        await deleteEndedSessionData(tx, owner, {
                          sessionId: sourceIds[0]!,
                          deletedAt: '2026-09-13T00:00:00.000Z',
                        })
                      })
                      .then(() => Reflect.apply(query, receiver, arguments_))
                  }
                  return Reflect.apply(query, receiver, arguments_)
                },
              }),
            ),
          )
      },
    })
    const concurrent = await readLatestEndedRosterPreview(intercepted, owner)
    expect(deleted).toBe(true)
    expect(concurrent.session.id).toBe(sourceIds[0])
    expect(concurrent.snapshots).toEqual(preview.snapshots)
    expect((await readLatestEndedRosterPreview(sql, owner)).session.id).toBe(
      sourceIds[1],
    )
  } finally {
    await deletion.end({ timeout: 1 })
    for (const sessionId of sourceIds)
      await sql`DELETE FROM app_private.sessions WHERE id = ${sessionId}::uuid AND owner_id = ${owner.databaseOwnerId}::uuid`
  }
}
