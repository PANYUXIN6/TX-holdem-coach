import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { PersistenceDataCorruptionError } from '../../src/persistence/errors.js'
import { createPublicProjectionFactsRepository } from '../../src/persistence/public-projection-repository.js'
import { encodeSnapshotV1 } from '../../src/sessions/authoritative-state/snapshot-codec-v1.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createTestPokerState } from '../poker/create-test-poker-state.js'
import { createPublicSessionQueryService } from '../../src/sessions/public-projection/public-session-query-service.js'
import { SessionReadonlyDiagnosticError } from '../../src/sessions/public-projection/errors.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'

describe('public projection repository', () => {
  test('用单条 SQL 加载并解码一致事实，不读取历史公开载荷', async () => {
    const poker = createTestPokerState()
    const state = createPrivateTableState({
      stateVersion: 0,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 2_000,
      })),
      lastCompletedHandSummary: null,
    })
    const stored = encodeSnapshotV1(state)
    const calls: string[] = []
    const sql = ((template: TemplateStringsArray) => {
      calls.push(template.join('?'))
      return Promise.resolve([
        {
          sessionId,
          lifecycleStatus: 'active',
          endedAt: null,
          stateVersion: 0,
          nextEventSeq: 1,
          currentHandId: null,
          diagnosticCode: null,
          diagnosedAt: null,
          agentRunState: 'idle',
          activePlayerRunId: null,
          activeDecisionRequestId: null,
          snapshotPayloadVersion: stored.payloadVersion,
          snapshotPayload: stored.payload,
          roster: poker.seats.map((seat) => ({
            seatNumber: seat.seatNumber,
            playerId: seat.playerId,
            participantType: seat.isUser ? 'user' : 'agent',
            displayName: seat.isUser ? null : `AI ${seat.seatNumber}`,
            avatarColor: seat.isUser ? null : '#0F766E',
          })),
          currentHandEvents: [],
        },
      ])
    }) as unknown as Sql
    const repository = createPublicProjectionFactsRepository({
      sql,
      owner: { ownerId: 'local-user', databaseOwnerId } as never,
    })

    const facts = await repository.findActive()

    expect(facts).toMatchObject({
      eventSeq: 0,
      state: { stateVersion: 0 },
      session: { sessionId, lifecycleStatus: 'active' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('session_snapshots')
    expect(calls[0]).toContain('LEFT JOIN app_private.session_snapshots')
    expect(calls[0]).toContain('private_event_payload')
    expect(calls[0]).not.toContain('public_event_payload')
  })

  test('保留缺失快照的 Session，并区分普通损坏与只读诊断', async () => {
    let lifecycleStatus: 'active' | 'readonlyDiagnostic' = 'active'
    const sql = (() =>
      Promise.resolve([
        {
          sessionId,
          lifecycleStatus,
          endedAt: null,
          stateVersion: 0,
          nextEventSeq: 1,
          currentHandId: null,
          diagnosticCode:
            lifecycleStatus === 'readonlyDiagnostic' ? 'snapshotMissing' : null,
          diagnosedAt:
            lifecycleStatus === 'readonlyDiagnostic'
              ? '2026-08-13T00:00:00.000000Z'
              : null,
          agentRunState: 'idle',
          activePlayerRunId: null,
          activeDecisionRequestId: null,
          snapshotPayloadVersion: null,
          snapshotPayload: null,
          roster: [],
          currentHandEvents: [],
        },
      ])) as unknown as Sql
    const repository = createPublicProjectionFactsRepository({
      sql,
      owner: { ownerId: 'local-user', databaseOwnerId } as never,
    })

    await expect(repository.getById(sessionId)).rejects.toBeInstanceOf(
      PersistenceDataCorruptionError,
    )

    lifecycleStatus = 'readonlyDiagnostic'
    const query = createPublicSessionQueryService(repository)
    await expect(query.getById(sessionId)).rejects.toBeInstanceOf(
      SessionReadonlyDiagnosticError,
    )
  })
})
