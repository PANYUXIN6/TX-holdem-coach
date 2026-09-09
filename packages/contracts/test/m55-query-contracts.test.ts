import { describe, expect, it } from 'vitest'
import {
  AgentRunDetailResponseSchema,
  AgentRunAttemptsResponseSchema,
  HandAgentCallsResponseSchema,
  SessionManagementListResponseSchema,
} from '../src/index.js'

const ids = {
  session: '10000000-0000-4000-8000-000000000001',
  hand: '10000000-0000-4000-8000-000000000002',
  run: '10000000-0000-4000-8000-000000000003',
  participant: '10000000-0000-4000-8000-000000000004',
  decisionRequest: '10000000-0000-4000-8000-000000000005',
  attempt: '10000000-0000-4000-8000-000000000006',
}

const timestamp = '2026-09-07T00:00:00.000000Z'

const runSummary = {
  runId: ids.run,
  sessionId: ids.session,
  handId: ids.hand,
  runtime: 'player' as const,
  executionMode: 'live' as const,
  lifecycle: 'completed' as const,
  participantId: ids.participant,
  seatNumber: 1,
  sourceStateVersion: 4,
  decisionRequestId: ids.decisionRequest,
  createdAt: timestamp,
  startedAt: timestamp,
  completedAt: timestamp,
  terminationReasonCode: null,
}

describe('M5.5 查询协议', () => {
  it('冻结场次阵容、账务和分页 envelope', () => {
    const response = {
      query: {
        lifecycle: 'all',
        from: null,
        to: null,
        sort: 'newest',
        limit: 20,
      },
      timeBasis: 'sessionCreatedAt',
      items: [
        {
          sessionId: ids.session,
          lifecycle: 'ended',
          createdAt: timestamp,
          endedAt: timestamp,
          completedHandCount: 1,
          currentHandId: null,
          roster: [
            {
              kind: 'user',
              participantId: ids.participant,
              seatNumber: 0,
            },
            ...Array.from({ length: 5 }, (_, index) => ({
              kind: 'ai' as const,
              participantId: `20000000-0000-4000-8000-00000000000${index + 1}`,
              seatNumber: index + 1,
              personaId: `historical-${index}`,
              personaVersion: 1,
              displayName: `AI ${index}`,
              avatarColor: '#123456',
              configSnapshotKey: 'a'.repeat(64),
            })),
          ],
          accounting: {
            status: 'available',
            stateVersion: 4,
            seats: Array.from({ length: 6 }, (_, seatNumber) => ({
              participantId:
                seatNumber === 0
                  ? ids.participant
                  : `20000000-0000-4000-8000-00000000000${seatNumber}`,
              seatNumber,
              initialChips: 2000,
              currentChips: seatNumber === 0 ? 3700 : 2060,
              cumulativeBuyIn: seatNumber === 0 ? 4000 : 2000,
              finalChips: seatNumber === 0 ? 3700 : 2060,
              sessionNetChange: seatNumber === 0 ? -300 : 60,
            })),
          },
        },
      ],
      nextCursor: null,
    }

    expect(
      SessionManagementListResponseSchema.safeParse(response).success,
    ).toBe(true)
    expect(
      SessionManagementListResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            accounting: {
              ...response.items[0]!.accounting,
              seats: response.items[0]!.accounting.seats?.map((seat) => ({
                ...seat,
                privateCards: [],
              })),
            },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('冻结 Hand 调用列表和 Run 详情的必填事件范围', () => {
    expect(
      HandAgentCallsResponseSchema.safeParse({
        query: { limit: 20 },
        hand: {
          handId: ids.hand,
          sessionId: ids.session,
          handNumber: 1,
          status: 'completed',
        },
        items: [runSummary],
        nextCursor: null,
      }).success,
    ).toBe(true)

    const detail = {
      ...runSummary,
      parentRunId: null,
      replacementRunId: null,
      reexecutionSourceRunId: null,
      commandEventRange: { firstEventSeq: 10, lastEventSeq: 11 },
      decision: {
        kind: 'summary',
        decisionId: '10000000-0000-4000-8000-000000000007',
        status: 'committed',
        terminalOutcome: null,
        terminalReasonCode: null,
        acceptedAttemptId: ids.attempt,
        commandLedgerId: '10000000-0000-4000-8000-000000000008',
        sourceDecisionId: null,
        normalizedAction: { status: 'visible', action: { type: 'check' } },
      },
      contentAvailability: {
        requestBody: 'notExposed',
        rawResponse: 'notRecorded',
        validationDetails: 'notRecorded',
      },
    }
    expect(AgentRunDetailResponseSchema.safeParse(detail).success).toBe(true)
    const { commandEventRange: _omitted, ...withoutRange } = detail
    expect(AgentRunDetailResponseSchema.safeParse(withoutRange).success).toBe(
      false,
    )
  })

  it('区分 Attempt 的 pending、实际和预留 Token 语义', () => {
    const response = {
      query: { limit: 20 },
      runId: ids.run,
      items: [
        {
          attemptId: ids.attempt,
          attemptNumber: 0,
          stage: 'player.bounded-choice',
          lifecycle: 'started',
          provider: 'deepseek',
          model: 'deepseek-chat',
          attemptType: 'initial',
          routingReasonCode: null,
          startedAt: timestamp,
          completedAt: null,
          durationMs: null,
          accepted: false,
          stale: false,
          interrupted: false,
          validationStatus: 'notRun',
          errorCode: null,
          requestProjectionHash: 'a'.repeat(64),
          responseProjectionHash: null,
          usage: {
            inputTokens: null,
            outputTokens: null,
            accounting: 'pending',
          },
        },
      ],
      nextCursor: null,
    }
    expect(AgentRunAttemptsResponseSchema.safeParse(response).success).toBe(
      true,
    )
    expect(
      AgentRunAttemptsResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            usage: { inputTokens: 0, outputTokens: 0, accounting: 'pending' },
          },
        ],
      }).success,
    ).toBe(false)

    expect(
      AgentRunAttemptsResponseSchema.safeParse({
        ...response,
        items: [
          {
            ...response.items[0],
            lifecycle: 'failed',
            completedAt: timestamp,
            durationMs: 1,
            errorCode: 'provider_timeout',
            usage: {
              inputTokens: 99,
              outputTokens: 42,
              accounting: 'notIncurred',
            },
          },
        ],
      }).success,
    ).toBe(false)
  })

  it('审计原因仅接受显式公开白名单', () => {
    expect(
      HandAgentCallsResponseSchema.safeParse({
        query: { limit: 20 },
        hand: {
          handId: ids.hand,
          sessionId: ids.session,
          handNumber: 1,
          status: 'completed',
        },
        items: [
          {
            ...runSummary,
            lifecycle: 'failed',
            terminationReasonCode: 'internal_debug_probe',
          },
        ],
        nextCursor: null,
      }).success,
    ).toBe(false)
  })
})
