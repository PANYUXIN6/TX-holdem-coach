import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../../src/personas/config.js'
import {
  PersistenceDataCorruptionError,
  ResourceNotFoundError,
} from '../../src/persistence/errors.js'
import {
  isResolvedOwnerScope,
  resolveOwnerScope,
} from '../../src/persistence/owner-scope.js'
import { readSessionAgentSnapshots } from '../../src/persistence/session-repository.js'

interface SqlCall {
  readonly text: string
  readonly parameters: readonly unknown[]
}

function createSqlMock(responses: readonly unknown[]): {
  readonly sql: Sql
  readonly calls: SqlCall[]
} {
  const pending = [...responses]
  const calls: SqlCall[] = []
  const tag = ((template: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = template.join('?')
    if (!text.includes('SELECT') && text.includes('state_version::float8')) {
      return { text, parameters }
    }
    calls.push({ text, parameters })
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as Sql
  Object.assign(tag, { json: (value: unknown) => value })
  return { sql: tag, calls }
}

const ownerScope = { ownerId: 'local-user' } as const
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'

async function resolvedOwner() {
  const { sql } = createSqlMock([[{ databaseOwnerId }]])
  return resolveOwnerScope(sql, ownerScope)
}

function agentParticipantId(index: number): string {
  return `44444444-4444-4444-8444-${index.toString().padStart(12, '0')}`
}

function snapshotRows() {
  const entries = loadAndValidatePersonaCatalog().list().slice(0, 5)
  return entries.map((entry, index) => {
    const payload = PersonaConfigPayloadSchema.parse({
      ...entry,
      personaVersion: 1,
    })
    return {
      hasAgent: true,
      participantId: agentParticipantId(index + 1),
      seatNumber: index + 1,
      displayName: payload.name,
      avatarColor: payload.avatarColor,
      personaId: payload.personaId,
      personaVersion: payload.personaVersion,
      configSnapshotKey: createConfigSnapshotKey(
        PERSONA_CONFIG_PAYLOAD_VERSION,
        payload,
      ),
      configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
      configPayload: payload,
    }
  })
}

describe('session repository', () => {
  test('accepts only resolver-produced owner capabilities by object identity', async () => {
    const { sql } = createSqlMock([[{ databaseOwnerId }]])
    const resolved = await resolveOwnerScope(sql, ownerScope)
    const forged = {
      ...resolved,
      databaseOwnerId: '99999999-9999-4999-8999-999999999999',
    }

    expect(isResolvedOwnerScope(resolved)).toBe(true)
    expect(isResolvedOwnerScope(forged)).toBe(false)
    expect(Reflect.ownKeys(resolved)).toEqual(['ownerId', 'databaseOwnerId'])
  })

  test('reads complete owner-scoped snapshots and rejects mirror corruption', async () => {
    const rows = snapshotRows()
    const valid = createSqlMock([rows])
    const snapshots = await readSessionAgentSnapshots(
      valid.sql,
      await resolvedOwner(),
      sessionId,
    )
    expect(snapshots).toHaveLength(5)
    expect(snapshots.map((snapshot) => snapshot.seatNumber)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(valid.calls[0]?.text).toContain('owner_id = ?::uuid')

    const corruptRows = structuredClone(rows)
    if (corruptRows[0] !== undefined) {
      corruptRows[0].displayName = 'tampered'
    }
    const corrupt = createSqlMock([corruptRows])
    await expect(
      readSessionAgentSnapshots(corrupt.sql, await resolvedOwner(), sessionId),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)

    const hashRows = structuredClone(rows)
    if (hashRows[0] !== undefined) {
      hashRows[0].configSnapshotKey = '0'.repeat(64)
    }
    const invalidHash = createSqlMock([hashRows])
    await expect(
      readSessionAgentSnapshots(
        invalidHash.sql,
        await resolvedOwner(),
        sessionId,
      ),
    ).rejects.toMatchObject({ corruption: 'snapshotKeyMismatch' })
  })

  test('classifies a missing session_agents child row as roster corruption', async () => {
    const rows = snapshotRows()
    const corruptRows = structuredClone(rows)
    if (corruptRows[0] !== undefined) {
      Object.assign(corruptRows[0], {
        hasAgent: false,
        displayName: null,
        avatarColor: null,
        personaId: null,
        personaVersion: null,
        configSnapshotKey: null,
        configPayloadVersion: null,
        configPayload: null,
      })
    }
    const { sql } = createSqlMock([corruptRows])

    await expect(
      readSessionAgentSnapshots(sql, await resolvedOwner(), sessionId),
    ).rejects.toMatchObject({ corruption: 'invalidRoster' })
  })

  test('does not distinguish a cross-owner session from a missing session', async () => {
    const { sql } = createSqlMock([[]])
    await expect(
      readSessionAgentSnapshots(sql, await resolvedOwner(), sessionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })
})
