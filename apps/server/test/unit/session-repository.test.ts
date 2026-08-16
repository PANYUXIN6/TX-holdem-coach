import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../../src/personas/config.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
} from '../../src/persistence/errors.js'
import {
  isResolvedOwnerScope,
  resolveOwnerScope,
} from '../../src/persistence/owner-scope.js'
import {
  HistoricalSessionCursorSchema,
  HistoricalSessionPageRequestSchema,
  listHistoricalSessions,
  readSessionAgentSnapshots,
} from '../../src/persistence/session-repository.js'

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

function agentParticipantId(index: number): string {
  return `44444444-4444-4444-8444-${index.toString().padStart(12, '0')}`
}

function sessionRow(
  id: string,
  updatedAt: string,
  lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic' = 'ended',
) {
  return {
    id,
    lifecycleStatus,
    stateVersion: 1,
    nextEventSeq: 2,
    currentHandId: null,
    agentRunState: 'idle',
    activePlayerRunId: null,
    activeDecisionRequestId: null,
    createdAt: '2026-08-01T00:00:00.000001Z',
    endedAt: lifecycleStatus === 'ended' ? '2026-08-01T00:01:00.000001Z' : null,
    updatedAt,
  }
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

  test.each([0, 101, 1.5])(
    'rejects invalid history limit %s',
    async (limit) => {
      const { sql, calls } = createSqlMock([])
      await expect(
        listHistoricalSessions(sql, ownerScope, { limit }),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      expect(calls).toHaveLength(0)
    },
  )

  test.each([1, 100])('accepts history limit %s', (limit) => {
    expect(
      HistoricalSessionPageRequestSchema.safeParse({ limit }).success,
    ).toBe(true)
  })

  test('does not expose the original Zod validation failure through cause', async () => {
    const { sql } = createSqlMock([])

    let failure: unknown
    try {
      await listHistoricalSessions(sql, ownerScope, { limit: 0 })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(RepositoryInputValidationError)
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  test('does not expose the original database failure through cause', async () => {
    const original = Object.assign(new Error('raw database failure'), {
      query: 'SELECT private_payload FROM app_private.sessions',
      parameters: ['secret-parameter'],
      databaseUrl: 'postgres://user:password@example.invalid/database',
    })
    const { sql } = createSqlMock([[{ databaseOwnerId }], original])

    let failure: unknown
    try {
      await listHistoricalSessions(sql, ownerScope, { limit: 1 })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(DatabaseOperationError)
    expect(Object.hasOwn(failure as object, 'cause')).toBe(false)
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined()
  })

  test('strictly validates six-digit UTC keyset cursors', () => {
    expect(
      HistoricalSessionCursorSchema.safeParse({
        updatedAt: '2026-08-01T12:34:56.123456Z',
        id: sessionId,
      }).success,
    ).toBe(true)
    for (const updatedAt of [
      '2026-08-01T12:34:56.123Z',
      '2026-08-01T12:34:60.123456Z',
      '2026-02-30T12:34:56.123456Z',
      '2026-08-01T12:34:56.123456+00:00',
    ]) {
      expect(
        HistoricalSessionCursorSchema.safeParse({ updatedAt, id: sessionId })
          .success,
      ).toBe(false)
    }
  })

  test('uses database microseconds for stable keyset pagination', async () => {
    const firstId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const secondId = '99999999-9999-4999-8999-999999999999'
    const { sql } = createSqlMock([
      [{ databaseOwnerId }],
      [
        sessionRow(firstId, '2026-08-01T00:00:00.123456Z'),
        sessionRow(secondId, '2026-08-01T00:00:00.123455Z'),
      ],
    ])

    const page = await listHistoricalSessions(sql, ownerScope, { limit: 1 })

    expect(page.sessions.map((session) => session.id)).toEqual([firstId])
    expect(page.nextCursor).toEqual({
      updatedAt: '2026-08-01T00:00:00.123456Z',
      id: firstId,
    })

    const next = createSqlMock([[{ databaseOwnerId }], []])
    await listHistoricalSessions(next.sql, ownerScope, {
      limit: 1,
      cursor: page.nextCursor ?? undefined,
    })
    expect(next.calls[1]?.text).toContain('updated_at < ?::text::timestamptz')
    expect(next.calls[1]?.text).toContain('updated_at = ?::text::timestamptz')
    expect(next.calls[1]?.parameters).toContain('2026-08-01T00:00:00.123456Z')
  })

  test('reads complete owner-scoped snapshots and rejects mirror corruption', async () => {
    const rows = snapshotRows()
    const valid = createSqlMock([[{ databaseOwnerId }], rows])
    const snapshots = await readSessionAgentSnapshots(
      valid.sql,
      ownerScope,
      sessionId,
    )
    expect(snapshots).toHaveLength(5)
    expect(snapshots.map((snapshot) => snapshot.seatNumber)).toEqual([
      1, 2, 3, 4, 5,
    ])
    expect(valid.calls[1]?.text).toContain('owner_id = ?::uuid')

    const corruptRows = structuredClone(rows)
    if (corruptRows[0] !== undefined) {
      corruptRows[0].displayName = 'tampered'
    }
    const corrupt = createSqlMock([[{ databaseOwnerId }], corruptRows])
    await expect(
      readSessionAgentSnapshots(corrupt.sql, ownerScope, sessionId),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)

    const hashRows = structuredClone(rows)
    if (hashRows[0] !== undefined) {
      hashRows[0].configSnapshotKey = '0'.repeat(64)
    }
    const invalidHash = createSqlMock([[{ databaseOwnerId }], hashRows])
    await expect(
      readSessionAgentSnapshots(invalidHash.sql, ownerScope, sessionId),
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
    const { sql } = createSqlMock([[{ databaseOwnerId }], corruptRows])

    await expect(
      readSessionAgentSnapshots(sql, ownerScope, sessionId),
    ).rejects.toMatchObject({ corruption: 'invalidRoster' })
  })

  test('does not distinguish a cross-owner session from a missing session', async () => {
    const { sql } = createSqlMock([[{ databaseOwnerId }], []])
    await expect(
      readSessionAgentSnapshots(sql, ownerScope, sessionId),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })
})
