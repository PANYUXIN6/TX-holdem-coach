import { expect, it } from 'vitest'
import type { Sql, TransactionSql } from 'postgres'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { createConfigSnapshotKey } from '../../src/personas/config.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createSessionAiStatusRepository } from '../../src/persistence/session-ai-status-repository.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createTestBettingPokerState } from '../poker/create-test-poker-state.js'
import { initializePokerTable } from '../../src/poker/poker-engine.js'

const sessionId = '20000000-0000-4000-8000-000000000001'
const ownerId = '10000000-0000-4000-8000-000000000001'
const runId = '40000000-0000-4000-8000-000000000001'
const requestId = '50000000-0000-4000-8000-000000000001'
async function fixture() {
  const owner = await resolveOwnerScope(
    (() => Promise.resolve([{ databaseOwnerId: ownerId }])) as unknown as Sql,
    { ownerId: 'local-user' },
  )
  const poker = createTestBettingPokerState({
    hand: { currentActorSeatNumber: 1 },
  })
  const state = createPrivateTableState({
    stateVersion: 7,
    poker,
    completedHandCount: 0,
    seatAccounting: poker.seats.map((s) => ({
      seatNumber: s.seatNumber,
      cumulativeBuyIn: 2000,
    })),
    lastCompletedHandSummary: null,
  })
  const snapshot = encodeSnapshot(state)
  const row = {
    sessionId,
    stateVersion: 7,
    nextEventSeq: 10,
    currentHandId: poker.hand!.handId,
    handStatus: 'inProgress',
    lifecycleStatus: 'active',
    agentRunState: 'paused',
    activePlayerRunId: null as string | null,
    activeDecisionRequestId: null as string | null,
    snapshotVersion: Number(snapshot.payloadVersion),
    snapshot: snapshot.payload,
    participants: poker.seats.map((s) => ({
      id: s.playerId,
      seat: s.seatNumber,
      type: s.isUser ? 'user' : 'agent',
    })),
  }
  const roster = loadAndValidatePersonaCatalog()
    .list()
    .slice(0, 5)
    .map((payload, index) => ({
      hasAgent: true,
      participantId: poker.seats[index + 1]!.playerId,
      seatNumber: index + 1,
      displayName: payload.name,
      avatarColor: payload.avatarColor,
      personaId: payload.personaId,
      personaVersion: payload.personaVersion,
      configSnapshotKey: createConfigSnapshotKey(1, payload),
      configPayloadVersion: 1,
      configPayload: payload,
    }))
  const run = {
    runId,
    sessionId,
    handId: poker.hand!.handId,
    participantId: poker.seats[1]!.playerId,
    sourceStateVersion: 7,
    decisionRequestId: requestId,
    triggerType: 'manual_retry',
    parentRunId: requestId,
    replacementRunId: null,
    runtime: 'player',
    executionMode: 'live',
    lifecycle: 'failed',
    reason: 'private-error-body',
  }
  const statements: string[] = []
  const results: unknown[][] = [[row], roster, [run]]
  const transaction = ((strings: TemplateStringsArray) => {
    const statement = strings.join('?')
    statements.push(statement)
    return Promise.resolve(
      /SET TRANSACTION/.test(statement) ? [] : results.shift()!,
    )
  }) as unknown as TransactionSql
  const sql = Object.assign(
    () => {
      throw new Error('transaction required')
    },
    {
      begin: (callback: (tx: TransactionSql) => unknown) =>
        callback(transaction),
    },
  ) as unknown as Sql
  return {
    reader: createSessionAiStatusRepository({ sql, owner }),
    row,
    roster,
    run,
    results,
    statements,
  }
}
it('固化人物只投影公开字段，暂停精确定位失败叶并白名单映射错误', async () => {
  const f = await fixture()
  const result = await f.reader.getById(sessionId)
  expect(result).toMatchObject({
    stateVersion: 7,
    eventSeq: 9,
    coordination: {
      state: 'paused',
      reasonCode: 'technical_error',
      run: { runId, trigger: 'manualRetry' },
    },
  })
  expect(result?.personas).toHaveLength(5)
  expect(result?.personas[0]?.displayName).toBe(f.roster[0]?.configPayload.name)
  expect(JSON.stringify(result)).not.toMatch(
    /strategyDescription|models|private-error-body|configPayload/,
  )
  expect(f.statements).toHaveLength(4)
  expect(f.statements[0]).toMatch(/REPEATABLE READ, READ ONLY/)
})
it('错 actor、失效指针和多条失败叶拒绝返回部分状态', async () => {
  const wrong = await fixture()
  wrong.run.participantId = sessionId
  await expect(wrong.reader.getById(sessionId)).rejects.toMatchObject({
    name: 'PersistenceDataCorruptionError',
  })
  const duplicate = await fixture()
  duplicate.results[2]!.push({ ...duplicate.run, runId: requestId })
  await expect(duplicate.reader.getById(sessionId)).rejects.toMatchObject({
    name: 'PersistenceDataCorruptionError',
  })
  const thinking = await fixture()
  thinking.row.agentRunState = 'thinking'
  thinking.row.activePlayerRunId = runId
  thinking.row.activeDecisionRequestId = requestId
  await expect(thinking.reader.getById(sessionId)).rejects.toMatchObject({
    name: 'PersistenceDataCorruptionError',
  })
})
it('未知 Codec 及不一致配置键拒绝，idle 不查最近运行', async () => {
  const unknown = await fixture()
  unknown.row.snapshotVersion = 2
  await expect(unknown.reader.getById(sessionId)).rejects.toMatchObject({
    name: 'UnknownPayloadVersionError',
  })
  const badKey = await fixture()
  badKey.roster[0]!.configSnapshotKey = 'b'.repeat(64)
  await expect(badKey.reader.getById(sessionId)).rejects.toMatchObject({
    name: 'PersistenceDataCorruptionError',
  })
  const idle = await fixture()
  idle.row.agentRunState = 'idle'
  expect((await idle.reader.getById(sessionId))?.coordination).toEqual({
    state: 'idle',
  })
  expect(idle.statements).toHaveLength(3)
})
it('零事件的诊断场次返回诊断错误，普通场次仍拒绝缺失事件', async () => {
  const diagnostic = await fixture()
  diagnostic.row.nextEventSeq = 0
  diagnostic.row.lifecycleStatus = 'readonlyDiagnostic'
  await expect(diagnostic.reader.getById(sessionId)).rejects.toMatchObject({
    code: 'SESSION_READONLY_DIAGNOSTIC',
  })
  const invalid = await fixture()
  invalid.row.nextEventSeq = 0
  await expect(invalid.reader.getById(sessionId)).rejects.toMatchObject({
    name: 'PersistenceDataCorruptionError',
  })
})
it('八名 AI 的固化人物仍使用两次业务读取', async () => {
  const f = await fixture()
  const poker = initializePokerTable(
    Array.from({ length: 9 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `00000000-0000-4000-8000-${String(seatNumber + 1).padStart(12, '0')}`,
      isUser: seatNumber === 0,
      stack: 2000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    { nextInt: () => 0 },
  )
  const snapshot = encodeSnapshot(
    createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((s) => ({
        seatNumber: s.seatNumber,
        cumulativeBuyIn: 2000,
      })),
      lastCompletedHandSummary: null,
    }),
  )
  Object.assign(f.row, {
    currentHandId: null,
    handStatus: null,
    agentRunState: 'idle',
    snapshot: snapshot.payload,
    participants: poker.seats.map((s) => ({
      id: s.playerId,
      seat: s.seatNumber,
      type: s.isUser ? 'user' : 'agent',
    })),
  })
  f.roster.splice(
    0,
    f.roster.length,
    ...loadAndValidatePersonaCatalog()
      .list()
      .slice(0, 8)
      .map((payload, index) => ({
        hasAgent: true,
        participantId: poker.seats[index + 1]!.playerId,
        seatNumber: index + 1,
        displayName: payload.name,
        avatarColor: payload.avatarColor,
        personaId: payload.personaId,
        personaVersion: payload.personaVersion,
        configSnapshotKey: createConfigSnapshotKey(1, payload),
        configPayloadVersion: 1,
        configPayload: payload,
      })),
  )
  expect((await f.reader.getById(sessionId))?.personas).toHaveLength(8)
  expect(f.statements).toHaveLength(3)
})
