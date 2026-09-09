import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, it } from 'vitest'
import { encodeAttemptAudit } from '../../src/agents/audit/attempt-audit-codec.js'
import { createAgentCallQueryRepository } from '../../src/persistence/agent-call-query-repository.js'
import { AgentRunQueryNotFoundError } from '../../src/agents/audit/query-errors.js'
import { PersistenceDataCorruptionError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const ownerId = '10000000-0000-4000-8000-000000000001'
const sessionId = '10000000-0000-4000-8000-000000000002'
const handId = '10000000-0000-4000-8000-000000000003'
const runId = '10000000-0000-4000-8000-000000000004'
const timestamp = '2026-09-08T00:00:00.000000Z'

function sqlMock(input?: {
  readonly taggedResponses?: readonly unknown[]
  readonly unsafeResponses?: readonly unknown[]
}): Sql {
  const taggedResponses: unknown[] = [
    ...(input?.taggedResponses ?? [
      [{ databaseOwnerId: ownerId }],
      [],
      [
        {
          runId,
          sessionId,
          handId,
          lifecycle: 'queued',
          handStatus: 'completed',
          abortedByAgentRunId: null,
        },
      ],
    ]),
  ]
  const unsafeResponses: unknown[] = [
    ...(input?.unsafeResponses ?? [
      [
        {
          runId,
          sessionId,
          handId,
          runtime: 'coach',
          executionMode: 'live',
          lifecycle: 'queued',
          participantId: null,
          seatNumber: null,
          sourceStateVersion: null,
          decisionRequestId: null,
          createdAt: timestamp,
          startedAt: null,
          completedAt: null,
          terminationReason: null,
          parentRunId: null,
          replacementRunId: null,
          reexecutionSourceRunId: null,
          handStatus: 'completed',
          decisionId: null,
          decisionStatus: null,
          terminalOutcome: null,
          terminalReason: null,
          acceptedAttemptId: null,
          commandLedgerId: null,
          sourceDecisionId: null,
          candidatePayloadVersion: null,
          candidatePayload: null,
          choicePayloadVersion: null,
          choicePayload: null,
          validatorPayloadVersion: null,
          validatorPayload: null,
          ledgerId: null,
          ledgerStatus: null,
          ledgerFinalStateVersion: null,
          firstEventSeq: null,
          lastEventSeq: null,
          ledgerResponsePayloadVersion: null,
          ledgerResponsePayload: null,
        },
      ],
    ]),
  ]
  const tag = (() => Promise.resolve(taggedResponses.shift())) as unknown as Sql
  Object.assign(tag, {
    begin: <Result>(
      callback: (transaction: TransactionSql) => Promise<Result>,
    ) => callback(tag as unknown as TransactionSql),
    unsafe: () => Promise.resolve(unsafeResponses.shift()),
  })
  return tag
}

describe('M5.5 Agent 调用查询 Repository', () => {
  it('详情显式复用 Run 摘要白名单且允许合法附加字段', async () => {
    const sql = sqlMock()
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createAgentCallQueryRepository({ sql, owner })

    await expect(repository.readRun(runId)).resolves.toMatchObject({
      runId,
      runtime: 'coach',
      decision: { kind: 'none' },
      commandEventRange: null,
    })
  })

  it('未知存储原因码统一投影为 technical_error', async () => {
    const sql = sqlMock({
      unsafeResponses: [
        [
          {
            runId,
            sessionId,
            handId,
            runtime: 'coach',
            executionMode: 'live',
            lifecycle: 'failed',
            participantId: null,
            seatNumber: null,
            sourceStateVersion: null,
            decisionRequestId: null,
            createdAt: timestamp,
            startedAt: timestamp,
            completedAt: timestamp,
            terminationReason: 'internal_debug_probe',
            parentRunId: null,
            replacementRunId: null,
            reexecutionSourceRunId: null,
            handStatus: 'completed',
            decisionId: null,
            decisionStatus: null,
            terminalOutcome: null,
            terminalReason: null,
            acceptedAttemptId: null,
            commandLedgerId: null,
            sourceDecisionId: null,
            candidatePayloadVersion: null,
            candidatePayload: null,
            choicePayloadVersion: null,
            choicePayload: null,
            validatorPayloadVersion: null,
            validatorPayload: null,
            ledgerId: null,
            ledgerStatus: null,
            ledgerFinalStateVersion: null,
            firstEventSeq: null,
            lastEventSeq: null,
            ledgerResponsePayloadVersion: null,
            ledgerResponsePayload: null,
          },
        ],
      ],
    })
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createAgentCallQueryRepository({ sql, owner })

    await expect(repository.readRun(runId)).resolves.toMatchObject({
      terminationReasonCode: 'technical_error',
    })
  })

  it('中止 Hand 的指针必须关联同 Hand 的 failed Run', async () => {
    const sql = sqlMock({
      taggedResponses: [
        [{ databaseOwnerId: ownerId }],
        [],
        [
          {
            handId,
            sessionId,
            handNumber: 1,
            status: 'aborted',
            abortedAt: timestamp,
            abortReason: 'provider_timeout',
            abortedByAgentRunId: runId,
          },
        ],
        [
          {
            runId,
            sessionId,
            handId: '10000000-0000-4000-8000-000000000099',
            lifecycle: 'failed',
          },
        ],
      ],
      unsafeResponses: [[]],
    })
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createAgentCallQueryRepository({ sql, owner })

    await expect(
      repository.listRuns({ handId, query: { limit: 1, after: null } }),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })

  it('中止 Hand 的非指针历史 Run 对直接查询隐藏为不存在', async () => {
    const abortedRunId = '10000000-0000-4000-8000-000000000005'
    const sql = sqlMock({
      taggedResponses: [
        [{ databaseOwnerId: ownerId }],
        [],
        [
          {
            runId,
            sessionId,
            handId,
            lifecycle: 'failed',
            handStatus: 'aborted',
            abortedByAgentRunId: abortedRunId,
          },
        ],
        [
          {
            runId: abortedRunId,
            sessionId,
            handId,
            lifecycle: 'failed',
          },
        ],
      ],
      unsafeResponses: [],
    })
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createAgentCallQueryRepository({ sql, owner })

    await expect(repository.readRun(runId)).rejects.toBeInstanceOf(
      AgentRunQueryNotFoundError,
    )
  })

  it('中止 Hand 的直接查询必须先拒绝损坏指针再隐藏历史 Run', async () => {
    const abortedRunId = '10000000-0000-4000-8000-000000000005'
    const sql = sqlMock({
      taggedResponses: [
        [{ databaseOwnerId: ownerId }],
        [],
        [
          {
            runId,
            sessionId,
            handId,
            lifecycle: 'failed',
            handStatus: 'aborted',
            abortedByAgentRunId: abortedRunId,
          },
        ],
        [
          {
            runId: abortedRunId,
            sessionId,
            handId: '10000000-0000-4000-8000-000000000099',
            lifecycle: 'failed',
          },
        ],
      ],
      unsafeResponses: [],
    })
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createAgentCallQueryRepository({ sql, owner })

    await expect(repository.readRun(runId)).rejects.toBeInstanceOf(
      PersistenceDataCorruptionError,
    )
  })

  it('notIncurred 必须与持久化零 Token 一致', async () => {
    const audit = encodeAttemptAudit({
      lifecycle: 'failed',
      actualTimeoutMs: 1_000,
      remainingDeadlineMsAtStart: 2_000,
      requestProjectionHash: 'a'.repeat(64),
      reservedInputTokens: 100,
      reservedOutputTokens: 50,
      reservedCostMicrounits: 10,
      responseProjectionHash: null,
      validationStatus: 'notRun',
      usageAccounting: 'notIncurred',
      costAccounting: 'notIncurred',
    })
    const sql = sqlMock({
      taggedResponses: [
        [{ databaseOwnerId: ownerId }],
        [],
        [
          {
            runId,
            sessionId,
            handId,
            lifecycle: 'failed',
            handStatus: 'completed',
            abortedByAgentRunId: null,
          },
        ],
        [
          {
            attemptId: '10000000-0000-4000-8000-000000000005',
            attemptNumber: 0,
            stage: 'player.bounded-choice',
            lifecycle: 'failed',
            provider: 'deepseek',
            model: 'deepseek-chat',
            attemptType: 'initial',
            routingReason: null,
            startedAt: timestamp,
            completedAt: timestamp,
            durationMs: 1,
            accepted: false,
            stale: false,
            interrupted: false,
            inputTokens: 99,
            outputTokens: 42,
            errorCategory: 'provider_timeout',
            payloadVersion: audit.payloadVersion,
            payload: audit.payload,
          },
        ],
      ],
      unsafeResponses: [],
    })
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const repository = createAgentCallQueryRepository({ sql, owner })

    await expect(
      repository.listAttempts({ runId, query: { limit: 1, after: null } }),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })
})
