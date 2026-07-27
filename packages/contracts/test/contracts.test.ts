import { describe, expect, it } from 'vitest'
import {
  AiSeatNumberSchema,
  AgentPersonaIdSchema,
  AgentPersonaSummarySchema,
  ChipAmountSchema,
  CardSchema,
  CommandRequestSchema,
  CommandResponseSchema,
  CreateSessionPersonaSelectionSchema,
  ErrorResponseSchema,
  LegalActionSchema,
  LegalActionsSchema,
  PersonaSnapshotFilterSchema,
  PokerActionSchema,
  ProviderCheckStatusSchema,
  ProviderHealthSummarySchema,
  ProviderIdSchema,
  ProviderPublicErrorCodeSchema,
  ProviderSettingsResponseSchema,
  PublicSessionSnapshotSchema,
  SeatNumberSchema,
  SuggestedTargetSchema,
  SseEventSchema,
  type LegalAction,
  type LegalActions,
  type SuggestedTarget,
} from '../src/index.js'

const agentPersonaSummary = {
  personaId: 'tag_pro',
  personaVersion: 1,
  name: '标签职业玩家',
  avatarColor: '#047857',
  backgroundDescription: '纪律性较强，重视位置和范围平衡。',
  teachingSummary: '练习面对标准对手的基础对抗。',
  style: {
    tightness: 70,
    aggression: 65,
    bluffTendency: 45,
    pressureCallTendency: 45,
    riskPreference: 50,
  },
}

const ids = {
  session: '2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e',
  hand: '6eafbd55-7ed7-4b75-a701-ca54c1796435',
  player: '430dd720-9f31-4d6f-bce8-76e7526d1129',
  command: 'c3887350-23c5-440f-9b12-4b8be9131a88',
  event: '0f05cae2-786d-4ee7-81b3-2050cedd88b9',
}

function createPublicSeat(seatNumber: number) {
  return {
    seatNumber,
    playerId: ids.player,
    displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
    avatarColor: '#0f766e',
    isUser: seatNumber === 0,
    stack: 1960,
    status: 'active' as const,
  }
}

const publicSnapshot = {
  protocolVersion: 1,
  sessionId: ids.session,
  stateVersion: 4,
  eventSeq: 8,
  pokerPhase: 'inHand',
  lifecycleStatus: 'active',
  agentRunState: 'idle',
  activeDecision: null,
  seats: Array.from({ length: 6 }, (_, seatNumber) =>
    createPublicSeat(seatNumber),
  ),
  hand: {
    handId: ids.hand,
    street: 'preflop',
    board: [],
    pot: 60,
    currentActorSeatNumber: 0,
    heroHoleCards: [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ],
    legalActions: [
      { type: 'fold' },
      { type: 'call', amount: 20 },
      {
        type: 'raise',
        minTarget: 60,
        maxTarget: 1959,
        suggestedTargets: [
          { kind: 'minimum', targetStreetCommitment: 60 },
          { kind: 'halfPot', targetStreetCommitment: 90 },
          { kind: 'twoThirdsPot', targetStreetCommitment: 100 },
          { kind: 'pot', targetStreetCommitment: 120 },
        ],
      },
      { type: 'allIn', target: 1960 },
    ],
  },
}

describe('共享外部协议', () => {
  it('可解析所有主 Schema 的代表性合法数据', () => {
    const commandRequest = {
      protocolVersion: 1,
      command: {
        sessionId: ids.session,
        commandId: ids.command,
        expectedStateVersion: 4,
        type: 'playerAction',
        payload: {
          action: { type: 'raise', targetStreetCommitment: 60 },
        },
      },
    }
    const sseEvent = {
      protocolVersion: 1,
      eventId: ids.event,
      sessionId: ids.session,
      eventSeq: 8,
      stateVersion: 4,
      type: 'actionCommitted',
      payload: { snapshot: publicSnapshot },
    }
    const errorResponse = {
      protocolVersion: 1,
      code: 'state_conflict',
      message: '场次状态已变化，请刷新后重试。',
      fieldErrors: [
        { path: ['expectedStateVersion'], message: '状态版本已过期。' },
      ],
      latestSnapshot: publicSnapshot,
    }

    expect(PokerActionSchema.safeParse({ type: 'allIn' }).success).toBe(true)
    expect(
      LegalActionSchema.safeParse({ type: 'call', amount: 20 }).success,
    ).toBe(true)
    expect(PublicSessionSnapshotSchema.safeParse(publicSnapshot).success).toBe(
      true,
    )
    expect(CommandRequestSchema.safeParse(commandRequest).success).toBe(true)
    expect(
      CommandResponseSchema.safeParse({
        protocolVersion: 1,
        snapshot: publicSnapshot,
      }).success,
    ).toBe(true)
    expect(SseEventSchema.safeParse(sseEvent).success).toBe(true)
    expect(ErrorResponseSchema.safeParse(errorResponse).success).toBe(true)
  })

  it('拒绝负数和非整数筹码', () => {
    expect(ChipAmountSchema.safeParse(-1).success).toBe(false)
    expect(ChipAmountSchema.safeParse(10.5).success).toBe(false)
  })

  it('拒绝未知扑克动作', () => {
    expect(PokerActionSchema.safeParse({ type: 'bluff' }).success).toBe(false)
  })

  it('以本街目标总投入表达下注和加注，并拒绝金额同义字段', () => {
    expect(
      PokerActionSchema.safeParse({
        type: 'bet',
        targetStreetCommitment: 40,
      }).success,
    ).toBe(true)
    expect(
      PokerActionSchema.safeParse({
        type: 'raise',
        targetStreetCommitment: 120,
      }).success,
    ).toBe(true)

    for (const action of [
      { type: 'bet', target: 40 },
      { type: 'raise', target: 120 },
      { type: 'bet', amount: 40 },
      { type: 'raise', delta: 100 },
      { type: 'raise', total: 120 },
      { type: 'call', targetStreetCommitment: 20 },
      { type: 'fold', amount: 1 },
      { type: 'check', delta: 1 },
      { type: 'allIn', total: 2000 },
      { type: 'bet', targetStreetCommitment: 0 },
      { type: 'raise', targetStreetCommitment: 120.5 },
    ]) {
      expect(PokerActionSchema.safeParse(action).success).toBe(false)
    }
  })

  it('使用结构化快捷目标并导出合法动作类型', () => {
    const target: SuggestedTarget = {
      kind: 'halfPot',
      targetStreetCommitment: 90,
    }
    const action: LegalAction = {
      type: 'raise',
      minTarget: 60,
      maxTarget: 1959,
      suggestedTargets: [
        { kind: 'minimum', targetStreetCommitment: 60 },
        target,
      ],
    }
    const actions: LegalActions = [
      { type: 'fold' },
      { type: 'call', amount: 20 },
      action,
      { type: 'allIn', target: 1960 },
    ]

    expect(SuggestedTargetSchema.parse(target)).toEqual(target)
    expect(LegalActionsSchema.parse(actions)).toEqual(actions)
  })

  it('拒绝违反合法动作数组级不变量的协议数据', () => {
    const validRaise = {
      type: 'raise',
      minTarget: 60,
      maxTarget: 199,
      suggestedTargets: [
        { kind: 'minimum', targetStreetCommitment: 60 },
        { kind: 'halfPot', targetStreetCommitment: 90 },
        { kind: 'twoThirdsPot', targetStreetCommitment: 100 },
        { kind: 'pot', targetStreetCommitment: 120 },
      ],
    } as const

    const invalidActions = [
      [{ type: 'allIn', target: 200 }, { type: 'fold' }],
      [{ type: 'fold' }, { type: 'fold' }],
      [{ type: 'check' }, { type: 'call', amount: 20 }],
      [
        {
          type: 'bet',
          minTarget: 20,
          maxTarget: 199,
          suggestedTargets: [{ kind: 'minimum', targetStreetCommitment: 20 }],
        },
        validRaise,
      ],
      [{ ...validRaise, minTarget: 200 }],
      [
        {
          ...validRaise,
          suggestedTargets: [{ kind: 'halfPot', targetStreetCommitment: 90 }],
        },
      ],
      [
        {
          ...validRaise,
          suggestedTargets: [{ kind: 'minimum', targetStreetCommitment: 61 }],
        },
      ],
      [
        {
          ...validRaise,
          suggestedTargets: [
            { kind: 'minimum', targetStreetCommitment: 60 },
            { kind: 'halfPot', targetStreetCommitment: 90 },
            { kind: 'halfPot', targetStreetCommitment: 100 },
          ],
        },
      ],
      [
        {
          ...validRaise,
          suggestedTargets: [
            { kind: 'minimum', targetStreetCommitment: 60 },
            { kind: 'pot', targetStreetCommitment: 120 },
            { kind: 'twoThirdsPot', targetStreetCommitment: 100 },
          ],
        },
      ],
      [
        {
          ...validRaise,
          suggestedTargets: [
            { kind: 'minimum', targetStreetCommitment: 60 },
            { kind: 'halfPot', targetStreetCommitment: 90 },
            { kind: 'pot', targetStreetCommitment: 90 },
          ],
        },
      ],
      [
        {
          ...validRaise,
          suggestedTargets: [
            { kind: 'minimum', targetStreetCommitment: 60 },
            { kind: 'pot', targetStreetCommitment: 220 },
          ],
        },
      ],
      [validRaise, { type: 'allIn', target: 250 }],
      [
        {
          ...validRaise,
          suggestedTargets: [
            { kind: 'minimum', targetStreetCommitment: 60, label: '最小' },
          ],
        },
      ],
      [
        {
          ...validRaise,
          suggestedTargets: [
            { kind: 'quarterPot', targetStreetCommitment: 80 },
          ],
        },
      ],
    ]

    for (const actions of invalidActions) {
      expect(LegalActionsSchema.safeParse(actions).success).toBe(false)
    }
  })

  it('保持 Card 协议的点数和花色字面量', () => {
    expect(CardSchema.safeParse({ rank: 'T', suit: 'clubs' }).success).toBe(
      true,
    )
    expect(CardSchema.safeParse({ rank: '10', suit: 'clubs' }).success).toBe(
      false,
    )
    expect(CardSchema.safeParse({ rank: 'T', suit: 'club' }).success).toBe(
      false,
    )
  })

  it('拒绝未知 SSE 协议版本', () => {
    expect(
      SseEventSchema.safeParse({
        protocolVersion: 2,
        eventId: ids.event,
        sessionId: ids.session,
        eventSeq: 8,
        stateVersion: 4,
        type: 'snapshot',
        payload: { snapshot: publicSnapshot },
      }).success,
    ).toBe(false)
  })

  it('可解析手牌中止事件及回退后的结束快照', () => {
    const abortedSnapshot = {
      ...publicSnapshot,
      stateVersion: 5,
      eventSeq: 9,
      pokerPhase: 'betweenHands',
      lifecycleStatus: 'ended',
      agentRunState: 'idle',
      activeDecision: null,
      hand: null,
    }

    expect(
      SseEventSchema.safeParse({
        protocolVersion: 1,
        eventId: ids.event,
        sessionId: ids.session,
        eventSeq: 9,
        stateVersion: 5,
        type: 'handAborted',
        payload: { snapshot: abortedSnapshot },
      }).success,
    ).toBe(true)
  })

  it('拒绝快照和 SSE 负载中的敏感额外字段', () => {
    expect(
      PublicSessionSnapshotSchema.safeParse({
        ...publicSnapshot,
        deck: [{ rank: 'A', suit: 'spades' }],
      }).success,
    ).toBe(false)
    expect(
      SseEventSchema.safeParse({
        protocolVersion: 1,
        eventId: ids.event,
        sessionId: ids.session,
        eventSeq: 8,
        stateVersion: 4,
        type: 'snapshot',
        payload: {
          snapshot: publicSnapshot,
          apiKey: 'must-not-be-public',
        },
      }).success,
    ).toBe(false)
  })

  it('可解析公开人物摘要、创建选择和快照筛选条件', () => {
    expect(
      AgentPersonaSummarySchema.safeParse(agentPersonaSummary).success,
    ).toBe(true)
    expect(
      CreateSessionPersonaSelectionSchema.safeParse([
        { personaId: 'nit_fish', seatNumber: 1 },
        { personaId: 'tag_pro', seatNumber: 2 },
        { personaId: 'lag_rec', seatNumber: 3 },
        { personaId: 'short_shark', seatNumber: 4 },
        { personaId: 'calling_station', seatNumber: 5 },
      ]).success,
    ).toBe(true)
    expect(
      PersonaSnapshotFilterSchema.safeParse({
        personaId: 'tag_pro',
        personaVersion: 1,
      }).success,
    ).toBe(true)
    expect(
      PersonaSnapshotFilterSchema.safeParse({ personaId: 'tag_pro' }).success,
    ).toBe(true)
  })

  it('只接受五到八个不同人物的创建选择', () => {
    const selections = [
      { personaId: 'nit_fish', seatNumber: 1 },
      { personaId: 'lag_rec', seatNumber: 2 },
      { personaId: 'tag_pro', seatNumber: 3 },
      { personaId: 'short_shark', seatNumber: 4 },
      { personaId: 'calling_station', seatNumber: 5 },
      { personaId: 'deep_maniac', seatNumber: 6 },
      { personaId: 'small_ball_reg', seatNumber: 7 },
      { personaId: 'trap_specialist', seatNumber: 8 },
    ]

    expect(
      CreateSessionPersonaSelectionSchema.safeParse(selections.slice(0, 5))
        .success,
    ).toBe(true)
    expect(
      CreateSessionPersonaSelectionSchema.safeParse(selections).success,
    ).toBe(true)
    expect(CreateSessionPersonaSelectionSchema.safeParse([]).success).toBe(
      false,
    )
    expect(
      CreateSessionPersonaSelectionSchema.safeParse(selections.slice(0, 4))
        .success,
    ).toBe(false)
    const tooManySelections = CreateSessionPersonaSelectionSchema.safeParse([
      ...selections,
      { personaId: 'nit_fish', seatNumber: 1 },
    ])

    expect(tooManySelections.success).toBe(false)
    if (!tooManySelections.success) {
      expect(tooManySelections.error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'too_big',
            origin: 'array',
            maximum: 8,
          }),
        ]),
      )
    }
  })

  it('拒绝重复人物和重复座位的创建选择', () => {
    const selections = [
      { personaId: 'nit_fish', seatNumber: 1 },
      { personaId: 'lag_rec', seatNumber: 2 },
      { personaId: 'tag_pro', seatNumber: 3 },
      { personaId: 'short_shark', seatNumber: 4 },
      { personaId: 'calling_station', seatNumber: 5 },
    ]

    expect(
      CreateSessionPersonaSelectionSchema.safeParse([
        ...selections,
        { personaId: 'tag_pro', seatNumber: 6 },
      ]).success,
    ).toBe(false)
    expect(
      CreateSessionPersonaSelectionSchema.safeParse([
        ...selections,
        { personaId: 'deep_maniac', seatNumber: 5 },
      ]).success,
    ).toBe(false)
  })

  it('将通用座位号限制为零到八，并将 AI 座位限制为一到八', () => {
    expect(SeatNumberSchema.safeParse(0).success).toBe(true)
    expect(SeatNumberSchema.safeParse(8).success).toBe(true)
    expect(SeatNumberSchema.safeParse(-1).success).toBe(false)
    expect(SeatNumberSchema.safeParse(9).success).toBe(false)
    expect(AiSeatNumberSchema.safeParse(1).success).toBe(true)
    expect(AiSeatNumberSchema.safeParse(8).success).toBe(true)
    expect(AiSeatNumberSchema.safeParse(0).success).toBe(false)
    expect(AiSeatNumberSchema.safeParse(9).success).toBe(false)
    expect(
      CreateSessionPersonaSelectionSchema.safeParse([
        { personaId: 'nit_fish', seatNumber: 0 },
        { personaId: 'lag_rec', seatNumber: 1 },
        { personaId: 'tag_pro', seatNumber: 2 },
        { personaId: 'short_shark', seatNumber: 3 },
        { personaId: 'calling_station', seatNumber: 4 },
      ]).success,
    ).toBe(false)
  })

  it('要求公开快照的唯一用户固定在座位零，且座位不可重复', () => {
    const userSwappedWithAi = {
      ...publicSnapshot,
      seats: publicSnapshot.seats.map((seat) => ({
        ...seat,
        isUser: seat.seatNumber === 1,
      })),
    }
    const duplicateAiSeat = {
      ...publicSnapshot,
      seats: publicSnapshot.seats.map((seat) =>
        seat.seatNumber === 5 ? { ...seat, seatNumber: 1 } : seat,
      ),
    }

    expect(PublicSessionSnapshotSchema.safeParse(publicSnapshot).success).toBe(
      true,
    )
    expect(
      PublicSessionSnapshotSchema.safeParse(userSwappedWithAi).success,
    ).toBe(false)
    expect(PublicSessionSnapshotSchema.safeParse(duplicateAiSeat).success).toBe(
      false,
    )
  })

  it('以严格且状态一致的 Provider 设置协议表达健康摘要', () => {
    const checkedAt = '2026-07-26T00:00:00.000Z'
    const summaries = [
      {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
      },
      {
        configured: true,
        checkStatus: 'notChecked',
        lastCheckedAt: null,
        errorCode: null,
      },
      {
        configured: true,
        checkStatus: 'available',
        lastCheckedAt: checkedAt,
        errorCode: null,
      },
      {
        configured: true,
        checkStatus: 'unavailable',
        lastCheckedAt: checkedAt,
        errorCode: 'provider_timeout',
      },
    ]

    expect(ProviderIdSchema.safeParse('deepseek').success).toBe(true)
    expect(ProviderIdSchema.safeParse('kimi').success).toBe(true)
    expect(ProviderIdSchema.safeParse('other').success).toBe(false)
    expect(ProviderCheckStatusSchema.safeParse('available').success).toBe(true)
    expect(ProviderCheckStatusSchema.safeParse('checking').success).toBe(false)
    expect(
      ProviderPublicErrorCodeSchema.safeParse('provider_timeout').success,
    ).toBe(true)
    expect(
      ProviderPublicErrorCodeSchema.safeParse('raw_provider_error').success,
    ).toBe(false)
    expect(
      summaries.every(
        (summary) => ProviderHealthSummarySchema.safeParse(summary).success,
      ),
    ).toBe(true)
    expect(
      ProviderHealthSummarySchema.safeParse({
        ...summaries[0],
        lastCheckedAt: checkedAt,
      }).success,
    ).toBe(false)
    expect(
      ProviderHealthSummarySchema.safeParse({
        ...summaries[2],
        errorCode: 'provider_timeout',
      }).success,
    ).toBe(false)
    expect(
      ProviderHealthSummarySchema.safeParse({
        ...summaries[3],
        errorCode: null,
      }).success,
    ).toBe(false)

    const response = {
      protocolVersion: 1,
      deepSeek: { ...summaries[1], canCreateSession: true },
      kimi: { ...summaries[0], canFallback: false },
    }

    expect(ProviderSettingsResponseSchema.safeParse(response).success).toBe(
      true,
    )
    expect(
      ProviderSettingsResponseSchema.safeParse({
        ...response,
        deepSeek: { ...response.deepSeek, canCreateSession: false },
      }).success,
    ).toBe(false)
    expect(
      ProviderSettingsResponseSchema.safeParse({
        ...response,
        deepSeek: { ...response.deepSeek, apiKey: 'must-not-be-public' },
      }).success,
    ).toBe(false)
    expect(
      ProviderSettingsResponseSchema.safeParse({
        ...response,
        kimi: { ...response.kimi, model: 'must-not-be-public' },
      }).success,
    ).toBe(false)
  })

  it('只接受六到九个公开座位', () => {
    expect(PublicSessionSnapshotSchema.safeParse(publicSnapshot).success).toBe(
      true,
    )
    expect(
      PublicSessionSnapshotSchema.safeParse({
        ...publicSnapshot,
        seats: Array.from({ length: 9 }, (_, seatNumber) =>
          createPublicSeat(seatNumber),
        ),
      }).success,
    ).toBe(true)
    expect(
      PublicSessionSnapshotSchema.safeParse({
        ...publicSnapshot,
        seats: Array.from({ length: 5 }, (_, seatNumber) =>
          createPublicSeat(seatNumber),
        ),
      }).success,
    ).toBe(false)
    expect(
      PublicSessionSnapshotSchema.safeParse({
        ...publicSnapshot,
        seats: Array.from({ length: 10 }, (_, index) =>
          createPublicSeat(index % 9),
        ),
      }).success,
    ).toBe(false)
  })

  it('允许新增人物标识并拒绝未知人物', () => {
    expect(AgentPersonaIdSchema.safeParse('small_ball_reg').success).toBe(true)
    expect(AgentPersonaIdSchema.safeParse('trap_specialist').success).toBe(true)
    expect(AgentPersonaIdSchema.safeParse('unknown_persona').success).toBe(
      false,
    )
  })

  it('拒绝人物公开摘要中的敏感额外字段', () => {
    expect(
      AgentPersonaSummarySchema.safeParse({
        ...agentPersonaSummary,
        prompt: 'must-not-be-public',
      }).success,
    ).toBe(false)
    expect(
      AgentPersonaSummarySchema.safeParse({
        ...agentPersonaSummary,
        modelConfig: { apiKey: 'must-not-be-public' },
      }).success,
    ).toBe(false)
  })
})
