import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { createCompletedHandHistoryListFactsRepository } from '../../src/persistence/completed-hand-history-list-repository.js'
import {
  PersistenceDataCorruptionError,
  UnknownPayloadVersionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import type { JsonValue } from '../../src/persisted-json.js'
import type { CompletedHandHistoryListQuery } from '../../src/sessions/hand-history/completed-hand-history-list-query.js'
import { insertCommittedM27CompletedHand } from './database-repository-assertions.js'

function baseQuery(
  overrides: Partial<CompletedHandHistoryListQuery> = {},
): CompletedHandHistoryListQuery {
  return {
    from: null,
    to: null,
    sessionId: null,
    position: null,
    result: null,
    startingHand: null,
    personaId: null,
    personaVersion: null,
    personaName: null,
    configSnapshotKey: null,
    sort: 'newest',
    limit: 20,
    after: null,
    ...overrides,
  }
}

function requireRecord(
  value: unknown,
  message: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(message)
  }
  return value as Record<string, unknown>
}

function withUserResultField(
  payload: JsonValue,
  collection: 'positions' | 'seats',
  field: string,
  value: JsonValue | undefined,
): JsonValue {
  const copied = structuredClone(payload)
  const result = requireRecord(
    requireRecord(copied, 'M5.3 fixture 缺少完成结果。').result,
    'M5.3 fixture 缺少 result。',
  )
  const entries = result[collection]
  if (!Array.isArray(entries)) {
    throw new Error(`M5.3 fixture 缺少 ${collection}。`)
  }
  const user = entries
    .map((entry) =>
      requireRecord(entry, `M5.3 fixture 的 ${collection} 项无效。`),
    )
    .find((entry) => entry.seatNumber === 0)
  if (user === undefined) {
    throw new Error(`M5.3 fixture 的 ${collection} 缺少用户座位。`)
  }
  if (value === undefined) {
    delete user[field]
  } else {
    user[field] = value
  }
  return copied
}

function withSeatPlayerId(
  payload: JsonValue,
  seatPaths: readonly (readonly string[])[],
  seatNumber: number,
  playerId: string,
): JsonValue {
  const copied = structuredClone(payload)
  for (const seatPath of seatPaths) {
    let nested: unknown = copied
    for (const key of seatPath) {
      nested = requireRecord(
        nested,
        `M5.3 fixture 的 ${seatPath.join('.')} 无效。`,
      )[key]
    }
    if (!Array.isArray(nested)) {
      throw new Error(`M5.3 fixture 的 ${seatPath.join('.')} 不是数组。`)
    }
    const seat = nested
      .map((entry) =>
        requireRecord(entry, `M5.3 fixture 的 ${seatPath.join('.')} 项无效。`),
      )
      .find((entry) => entry.seatNumber === seatNumber)
    if (seat === undefined) {
      throw new Error(
        `M5.3 fixture 的 ${seatPath.join('.')} 缺少座位 ${seatNumber}。`,
      )
    }
    seat.playerId = playerId
  }
  return copied
}

async function readCheckpointPayload(
  sql: Sql,
  handId: string,
): Promise<JsonValue> {
  const rows = await sql<{ readonly payload: JsonValue }[]>`
    SELECT hand_start_checkpoint_payload AS payload
    FROM app_private.hands
    WHERE id = ${handId}::uuid
  `
  const payload = rows[0]?.payload
  if (payload === undefined)
    throw new Error('M5.3 fixture 缺少 checkpoint 载荷。')
  return payload
}

async function readCompletedResultPayload(
  sql: Sql,
  handId: string,
): Promise<JsonValue> {
  const rows = await sql<{ readonly payload: JsonValue }[]>`
    SELECT completed_result_payload AS payload
    FROM app_private.hands
    WHERE id = ${handId}::uuid
  `
  const payload = rows[0]?.payload
  if (payload === undefined) throw new Error('M5.3 fixture 缺少完成结果载荷。')
  return payload
}

async function writeCompletedResultPayload(
  sql: Sql,
  handId: string,
  payload: JsonValue,
): Promise<void> {
  await sql`
    UPDATE app_private.hands
    SET completed_result_payload = ${sql.json(payload)}
    WHERE id = ${handId}::uuid
  `
}

async function writeCheckpointPayload(
  sql: Sql,
  handId: string,
  payload: JsonValue,
): Promise<void> {
  await sql`
    UPDATE app_private.hands
    SET hand_start_checkpoint_payload = ${sql.json(payload)}
    WHERE id = ${handId}::uuid
  `
}

export async function assertM53CompletedHandHistoryList(
  sql: Sql,
): Promise<void> {
  const sessions = [randomUUID(), randomUUID(), randomUUID()]
  const hands = [randomUUID(), randomUUID(), randomUUID()]
  const startedAts = [
    '2026-09-03T12:00:00.123456Z',
    '2026-09-03T12:00:00.123456Z',
    '2026-09-03T11:00:00.123456Z',
  ] as const
  try {
    for (const [index, sessionId] of sessions.entries()) {
      const handId = hands[index]
      const startedAt = startedAts[index]
      if (handId === undefined || startedAt === undefined) {
        throw new Error('M5.3 fixture 缺少 Hand ID 或时间。')
      }
      await insertCommittedM27CompletedHand(sql, sessionId, handId, {
        playerIds: Array.from({ length: 6 }, () => randomUUID()),
      })
      await sql`
        UPDATE app_private.hands
        SET started_at = ${startedAt}::timestamptz,
            completed_at = ${startedAt}::timestamptz + interval '1 minute'
        WHERE id = ${handId}::uuid
      `
      await sql`
        UPDATE app_private.sessions
        SET lifecycle_status = 'ended',
            ended_at = ${startedAt}::timestamptz + interval '2 minutes'
        WHERE id = ${sessionId}::uuid
      `
    }
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const reader = createCompletedHandHistoryListFactsRepository({ sql, owner })
    const expectedNewest = [...hands].sort((left, right) => {
      const leftIndex = hands.indexOf(left)
      const rightIndex = hands.indexOf(right)
      const byTime = startedAts[rightIndex]!.localeCompare(
        startedAts[leftIndex]!,
      )
      return byTime === 0 ? right.localeCompare(left) : byTime
    })

    const firstPage = await reader.listCompletedHandHistoryFacts(
      baseQuery({ limit: 1 }),
    )
    expect(firstPage.map((fact) => fact.handId)).toEqual(
      expectedNewest.slice(0, 2),
    )
    const first = firstPage[0]
    if (first === undefined) throw new Error('M5.3 fixture 未返回首页。')
    const secondPage = await reader.listCompletedHandHistoryFacts(
      baseQuery({
        limit: 1,
        after: { startedAt: first.startedAt, handId: first.handId },
      }),
    )
    expect(secondPage.map((fact) => fact.handId)).toEqual(
      expectedNewest.slice(1, 3),
    )

    const userSeat = first.result.seats.find((seat) => seat.seatNumber === 0)
    const userPosition = first.result.positions.find(
      (position) => position.seatNumber === 0,
    )
    const persona = first.aiParticipants[0]
    if (
      userSeat === undefined ||
      userPosition === undefined ||
      persona === undefined
    ) {
      throw new Error('M5.3 fixture 缺少用户或历史人物事实。')
    }
    expect(first).not.toHaveProperty('checkpoint')
    expect(persona).not.toHaveProperty('playerId')
    const result =
      userSeat.netChange > 0
        ? 'profit'
        : userSeat.netChange < 0
          ? 'loss'
          : 'even'
    const combined = await reader.listCompletedHandHistoryFacts(
      baseQuery({
        sessionId: first.sessionId,
        from: first.startedAt,
        to: '2026-09-04T00:00:00.000000Z',
        position: userPosition.position,
        result,
        startingHand: userSeat.startingHandCategory,
        personaId: persona.personaId,
        personaVersion: persona.personaVersion,
        personaName: persona.displayName,
        configSnapshotKey: persona.configSnapshotKey,
      }),
    )
    expect(combined.map((fact) => fact.handId)).toEqual([first.handId])

    const pairPattern = await sql<
      {
        readonly aa: boolean
        readonly kk: boolean
        readonly aks: boolean
      }[]
    >`
      SELECT
        'AA' ~ '^([2-9TJQKA])\\1$' AS aa,
        'KK' ~ '^([2-9TJQKA])\\1$' AS kk,
        'AKs' ~ '^([2-9TJQKA])\\1$' AS aks
    `
    expect(pairPattern).toEqual([{ aa: true, kk: true, aks: false }])

    const aiSeat = first.result.seats.find((seat) => !seat.isUser)
    if (aiSeat === undefined) {
      throw new Error('M5.3 fixture 缺少 AI 座位。')
    }
    const firstCheckpointPayload = await readCheckpointPayload(
      sql,
      first.handId,
    )
    const firstResultPayload = await readCompletedResultPayload(
      sql,
      first.handId,
    )
    const mismatchedCheckpoint = withSeatPlayerId(
      firstCheckpointPayload,
      [['checkpoint', 'stateBeforeStartCommand', 'poker', 'seats']],
      aiSeat.seatNumber,
      randomUUID(),
    )
    await writeCheckpointPayload(sql, first.handId, mismatchedCheckpoint)
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({ sessionId: first.sessionId }),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
    await writeCheckpointPayload(sql, first.handId, firstCheckpointPayload)

    const mismatchedRosterPlayerId = randomUUID()
    await writeCheckpointPayload(
      sql,
      first.handId,
      withSeatPlayerId(
        firstCheckpointPayload,
        [['checkpoint', 'stateBeforeStartCommand', 'poker', 'seats']],
        aiSeat.seatNumber,
        mismatchedRosterPlayerId,
      ),
    )
    await writeCompletedResultPayload(
      sql,
      first.handId,
      withSeatPlayerId(
        firstResultPayload,
        [
          ['result', 'seats'],
          ['result', 'summary', 'seats'],
        ],
        aiSeat.seatNumber,
        mismatchedRosterPlayerId,
      ),
    )
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({ sessionId: first.sessionId }),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
    await writeCheckpointPayload(sql, first.handId, firstCheckpointPayload)
    await writeCompletedResultPayload(sql, first.handId, firstResultPayload)

    const protectedHandId = hands[0]
    const protectedSessionId = sessions[0]
    if (protectedHandId === undefined || protectedSessionId === undefined) {
      throw new Error('M5.3 fixture 缺少受保护 Hand。')
    }
    const protectedPayload = await readCompletedResultPayload(
      sql,
      protectedHandId,
    )
    const nonMatchingStartingHand =
      userSeat.startingHandCategory === 'AA' ? 'KK' : 'AA'
    await sql`
      UPDATE app_private.hands
      SET completed_result_payload_version = 999
      WHERE id = ${protectedHandId}::uuid
    `
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({
          sessionId: protectedSessionId,
          startingHand: nonMatchingStartingHand,
        }),
      ),
    ).rejects.toBeInstanceOf(UnknownPayloadVersionError)
    await sql`
      UPDATE app_private.hands
      SET completed_result_payload_version = 1
      WHERE id = ${protectedHandId}::uuid
    `

    await writeCompletedResultPayload(
      sql,
      protectedHandId,
      withUserResultField(protectedPayload, 'positions', 'position', undefined),
    )
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({ sessionId: protectedSessionId, position: 'UTG' }),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
    await writeCompletedResultPayload(sql, protectedHandId, protectedPayload)

    await writeCompletedResultPayload(
      sql,
      protectedHandId,
      withUserResultField(
        protectedPayload,
        'seats',
        'startingHandCategory',
        undefined,
      ),
    )
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({
          sessionId: protectedSessionId,
          startingHand: nonMatchingStartingHand,
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
    await writeCompletedResultPayload(sql, protectedHandId, protectedPayload)

    await writeCompletedResultPayload(
      sql,
      protectedHandId,
      withUserResultField(protectedPayload, 'seats', 'netChange', undefined),
    )
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({ sessionId: protectedSessionId, result: 'profit' }),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
    await writeCompletedResultPayload(sql, protectedHandId, protectedPayload)

    await sql`
      UPDATE app_private.hands
      SET completed_result_payload = jsonb_set(
        completed_result_payload,
        '{result,seats}',
        (
          SELECT jsonb_agg(
            CASE
              WHEN seat.value ->> 'seatNumber' = '0' THEN jsonb_set(
                seat.value,
                '{startingHandCategory}',
                to_jsonb('invalid'::text)
              )
              ELSE seat.value
            END
            ORDER BY seat.ordinality
          )
          FROM jsonb_array_elements(
            completed_result_payload -> 'result' -> 'seats'
          ) WITH ORDINALITY AS seat(value, ordinality)
        )
      )
      WHERE id = ${first.handId}::uuid
    `
    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({
          sessionId: first.sessionId,
          startingHand: userSeat.startingHandCategory,
        }),
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)

    await expect(
      reader.listCompletedHandHistoryFacts(
        baseQuery({ sessionId: randomUUID() }),
      ),
    ).resolves.toEqual([])
  } finally {
    for (const sessionId of sessions) {
      await sql`
        DELETE FROM app_private.sessions
        WHERE id = ${sessionId}::uuid
      `
    }
  }
}
