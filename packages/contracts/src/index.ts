import {
  OpponentRangeAnalysisSchema,
  JointEquityAnalysisSchema,
  ConditionalCallEvSchema,
  RangeSensitivitySchema,
  OpponentRangeChartSpecSchema,
  CoachRangeAnalysisSchema,
} from './coach-range.js'
export * from './coach-range.js'
import { z } from 'zod'

export const SessionIdSchema = z.uuid()
export const HandIdSchema = z.uuid()
export const PlayerIdSchema = z.uuid()
export const CommandIdSchema = z.uuid()
export const EventIdSchema = z.uuid()
export const DecisionRequestIdSchema = z.uuid()

export const ChipAmountSchema = z.number().int().nonnegative()
export const PositiveChipAmountSchema = z.number().int().positive()
export const StateVersionSchema = z.number().int().nonnegative()
export const EventSequenceSchema = z.number().int().nonnegative()
export const SeatNumberSchema = z.number().int().min(0).max(8)
export const AiSeatNumberSchema = z.number().int().min(1).max(8)

export const AGENT_PERSONA_IDS = Object.freeze([
  'nit_fish',
  'lag_rec',
  'tag_pro',
  'short_shark',
  'calling_station',
  'deep_maniac',
  'small_ball_reg',
  'trap_specialist',
] as const)

export type AgentPersonaId = (typeof AGENT_PERSONA_IDS)[number]

export const AgentPersonaIdSchema = z.enum(AGENT_PERSONA_IDS)
export const AgentPersonaStyleSchema = z.strictObject({
  tightness: z.number().int().min(0).max(100),
  aggression: z.number().int().min(0).max(100),
  bluffTendency: z.number().int().min(0).max(100),
  pressureCallTendency: z.number().int().min(0).max(100),
  riskPreference: z.number().int().min(0).max(100),
})
export const AgentPersonaSummarySchema = z.strictObject({
  personaId: AgentPersonaIdSchema,
  personaVersion: z.literal(1),
  name: z.string().min(1),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  backgroundDescription: z.string().min(1),
  teachingSummary: z.string().min(1),
  style: AgentPersonaStyleSchema,
})

export const SessionPersonaSelectionSchema = z.strictObject({
  personaId: AgentPersonaIdSchema,
  seatNumber: AiSeatNumberSchema,
})
export const CreateSessionPersonaSelectionSchema = z
  .array(SessionPersonaSelectionSchema)
  .min(5)
  .max(8)
  .superRefine((selections, context) => {
    const personaIds = new Set<string>()
    const seatNumbers = new Set<number>()

    selections.forEach((selection, index) => {
      if (personaIds.has(selection.personaId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '人物不得重复选择。',
          path: [index, 'personaId'],
        })
      }
      if (seatNumbers.has(selection.seatNumber)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AI 座位不得重复。',
          path: [index, 'seatNumber'],
        })
      }

      personaIds.add(selection.personaId)
      seatNumbers.add(selection.seatNumber)
    })
  })
export const LatestEndedRosterPreviewBindingSchema = z.strictObject({
  sourceSessionId: SessionIdSchema,
  assignments: z
    .array(
      z.strictObject({
        sourceSeatNumber: AiSeatNumberSchema,
        configSnapshotKey: z.string().regex(/^[a-f0-9]{64}$/),
        seatNumber: AiSeatNumberSchema,
      }),
    )
    .min(5)
    .max(8)
    .superRefine((items, context) => {
      for (const field of ['sourceSeatNumber', 'seatNumber'] as const) {
        if (new Set(items.map((item) => item[field])).size !== items.length) {
          context.addIssue({
            code: 'custom',
            message: '座位不得重复。',
            path: [field],
          })
        }
      }
    }),
})
export type LatestEndedRosterPreviewBinding = z.infer<
  typeof LatestEndedRosterPreviewBindingSchema
>

export const CreateSessionRosterSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('currentCatalog'),
    selections: CreateSessionPersonaSelectionSchema,
  }),
  z.strictObject({
    type: z.literal('latestEnded'),
    preview: LatestEndedRosterPreviewBindingSchema.optional(),
  }),
])
export const CreateSessionRequestSchema = z.strictObject({
  rosterSource: CreateSessionRosterSourceSchema,
})
export const CARD_RANKS = Object.freeze([
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  'T',
  'J',
  'Q',
  'K',
  'A',
] as const)
export const CARD_SUITS = Object.freeze([
  'clubs',
  'diamonds',
  'hearts',
  'spades',
] as const)

export type CardRank = (typeof CARD_RANKS)[number]
export type CardSuit = (typeof CARD_SUITS)[number]

export const CardRankSchema = z.enum(CARD_RANKS)
export const CardSuitSchema = z.enum(CARD_SUITS)
export const CardSchema = z.strictObject({
  rank: CardRankSchema,
  suit: CardSuitSchema,
})

export const PokerActionTypeSchema = z.enum([
  'fold',
  'check',
  'call',
  'bet',
  'raise',
  'allIn',
])

export const PokerActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('fold') }),
  z.strictObject({ type: z.literal('check') }),
  z.strictObject({ type: z.literal('call') }),
  z.strictObject({
    type: z.literal('bet'),
    targetStreetCommitment: PositiveChipAmountSchema,
  }),
  z.strictObject({
    type: z.literal('raise'),
    targetStreetCommitment: PositiveChipAmountSchema,
  }),
  z.strictObject({ type: z.literal('allIn') }),
])

export const SuggestedTargetSchema = z.strictObject({
  kind: z.enum(['minimum', 'halfPot', 'twoThirdsPot', 'pot']),
  targetStreetCommitment: PositiveChipAmountSchema,
})

const LegalActionBaseSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('fold') }),
  z.strictObject({ type: z.literal('check') }),
  z.strictObject({
    type: z.literal('call'),
    amount: PositiveChipAmountSchema,
  }),
  z.strictObject({
    type: z.literal('bet'),
    minTarget: PositiveChipAmountSchema,
    maxTarget: PositiveChipAmountSchema,
    suggestedTargets: z.array(SuggestedTargetSchema).min(1),
  }),
  z.strictObject({
    type: z.literal('raise'),
    minTarget: PositiveChipAmountSchema,
    maxTarget: PositiveChipAmountSchema,
    suggestedTargets: z.array(SuggestedTargetSchema).min(1),
  }),
  z.strictObject({
    type: z.literal('allIn'),
    target: PositiveChipAmountSchema,
  }),
])

const suggestedTargetKindPriority = {
  minimum: 0,
  halfPot: 1,
  twoThirdsPot: 2,
  pot: 3,
} as const

export const LegalActionSchema = LegalActionBaseSchema.superRefine(
  (action, context) => {
    if (action.type !== 'bet' && action.type !== 'raise') {
      return
    }

    if (action.minTarget > action.maxTarget) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '最小目标不得大于最大目标。',
        path: ['minTarget'],
      })
    }

    const firstTarget = action.suggestedTargets[0]
    if (
      firstTarget?.kind !== 'minimum' ||
      firstTarget.targetStreetCommitment !== action.minTarget
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '第一项快捷目标必须是等于最小目标的 minimum。',
        path: ['suggestedTargets', 0],
      })
    }

    const seenKinds = new Set<string>()
    const seenTargets = new Set<number>()
    let previousPriority = -1

    action.suggestedTargets.forEach((target, index) => {
      const priority = suggestedTargetKindPriority[target.kind]

      if (seenKinds.has(target.kind)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '快捷目标 kind 不得重复。',
          path: ['suggestedTargets', index, 'kind'],
        })
      }

      if (priority <= previousPriority) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '快捷目标必须按规范顺序排列。',
          path: ['suggestedTargets', index, 'kind'],
        })
      }

      if (seenTargets.has(target.targetStreetCommitment)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '快捷目标金额不得重复。',
          path: ['suggestedTargets', index, 'targetStreetCommitment'],
        })
      }

      if (
        target.targetStreetCommitment < action.minTarget ||
        target.targetStreetCommitment > action.maxTarget
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '快捷目标金额必须位于普通目标区间。',
          path: ['suggestedTargets', index, 'targetStreetCommitment'],
        })
      }

      seenKinds.add(target.kind)
      seenTargets.add(target.targetStreetCommitment)
      previousPriority = priority
    })
  },
)

const legalActionTypePriority = {
  fold: 0,
  check: 1,
  call: 1,
  bet: 2,
  raise: 2,
  allIn: 3,
} as const

export const LegalActionsSchema = z
  .array(LegalActionSchema)
  .superRefine((actions, context) => {
    const seenTypes = new Set<string>()
    let previousPriority = -1
    let bettingAction:
      Extract<(typeof actions)[number], { type: 'bet' | 'raise' }> | undefined
    let allInAction:
      Extract<(typeof actions)[number], { type: 'allIn' }> | undefined

    actions.forEach((action, index) => {
      const priority = legalActionTypePriority[action.type]

      if (seenTypes.has(action.type)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '同一种合法动作最多出现一次。',
          path: [index, 'type'],
        })
      }

      if (priority <= previousPriority) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '合法动作必须按规范顺序排列且互斥。',
          path: [index, 'type'],
        })
      }

      if (action.type === 'bet' || action.type === 'raise') {
        bettingAction = action
      }
      if (action.type === 'allIn') {
        allInAction = action
      }

      seenTypes.add(action.type)
      previousPriority = priority
    })

    if (
      bettingAction !== undefined &&
      allInAction !== undefined &&
      bettingAction.maxTarget + 1 !== allInAction.target
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '普通最大目标必须与独立全下目标相邻。',
        path: [actions.indexOf(allInAction), 'target'],
      })
    }
  })

const commandBaseShape = {
  sessionId: SessionIdSchema,
  commandId: CommandIdSchema,
  expectedStateVersion: StateVersionSchema,
}

export const SessionCommandSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...commandBaseShape,
    type: z.literal('playerAction'),
    payload: z.strictObject({ action: PokerActionSchema }),
  }),
  z.strictObject({
    ...commandBaseShape,
    type: z.literal('startNextHand'),
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...commandBaseShape,
    type: z.literal('rebuy'),
    payload: z.strictObject({ amount: PositiveChipAmountSchema }),
  }),
  z.strictObject({
    ...commandBaseShape,
    type: z.literal('endSession'),
    payload: z.union([
      z.strictObject({}),
      z.strictObject({ expectedPausedRunId: z.uuid() }),
    ]),
  }),
  z.strictObject({
    ...commandBaseShape,
    type: z.literal('retryAgent'),
    payload: z.union([
      z.strictObject({}),
      z.strictObject({ expectedPausedRunId: z.uuid() }),
    ]),
  }),
])

export const PokerPhaseSchema = z.enum(['betweenHands', 'inHand'])
export const SessionLifecycleSchema = z.enum([
  'active',
  'ended',
  'readonlyDiagnostic',
])
export const HandStreetSchema = z.enum([
  'postingBlinds',
  'preflop',
  'flop',
  'turn',
  'river',
  'showdown',
  'complete',
])
export const AgentRunStateSchema = z.enum(['idle', 'thinking', 'paused'])
export const PublicSeatStatusSchema = z.enum([
  'active',
  'folded',
  'allIn',
  'out',
])
export const PublicLogicalPositionSchema = z.enum([
  'UTG',
  'UTG+1',
  'MP',
  'LJ',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
])
export const PublicHandCategorySchema = z.enum([
  'highCard',
  'onePair',
  'twoPair',
  'threeOfAKind',
  'straight',
  'flush',
  'fullHouse',
  'fourOfAKind',
  'straightFlush',
])

export const ProviderIdSchema = z.enum(['deepseek'])
export const ProviderCheckStatusSchema = z.enum([
  'notConfigured',
  'notChecked',
  'available',
  'unavailable',
])
export const ProviderPublicErrorCodeSchema = z.enum([
  'provider_auth_error',
  'provider_billing_unavailable',
  'provider_network_error',
  'provider_timeout',
  'provider_rate_limited',
  'provider_service_unavailable',
  'provider_unknown_error',
])

const providerHealthSummaryShape = {
  configured: z.boolean(),
  checkStatus: ProviderCheckStatusSchema,
  lastCheckedAt: z.iso.datetime({ offset: true }).nullable(),
  errorCode: ProviderPublicErrorCodeSchema.nullable(),
}

function validateProviderHealthSummary(
  summary: {
    configured: boolean
    checkStatus: z.infer<typeof ProviderCheckStatusSchema>
    lastCheckedAt: string | null
    errorCode: z.infer<typeof ProviderPublicErrorCodeSchema> | null
  },
  context: z.RefinementCtx,
): void {
  const addIssue = (path: string, message: string) => {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message,
      path: [path],
    })
  }

  if (!summary.configured) {
    if (summary.checkStatus !== 'notConfigured') {
      addIssue('checkStatus', '未配置的供应商只能处于未配置状态。')
    }
    if (summary.lastCheckedAt !== null) {
      addIssue('lastCheckedAt', '未配置的供应商不得有检测时间。')
    }
    if (summary.errorCode !== null) {
      addIssue('errorCode', '未配置的供应商不得有错误码。')
    }

    return
  }

  if (summary.checkStatus === 'notConfigured') {
    addIssue('checkStatus', '已配置的供应商不得处于未配置状态。')
  }

  if (summary.checkStatus === 'notChecked') {
    if (summary.lastCheckedAt !== null) {
      addIssue('lastCheckedAt', '未检测的供应商不得有检测时间。')
    }
    if (summary.errorCode !== null) {
      addIssue('errorCode', '未检测的供应商不得有错误码。')
    }

    return
  }

  if (summary.lastCheckedAt === null) {
    addIssue('lastCheckedAt', '已检测的供应商必须包含检测时间。')
  }

  if (summary.checkStatus === 'available' && summary.errorCode !== null) {
    addIssue('errorCode', '可用供应商不得有错误码。')
  }

  if (summary.checkStatus === 'unavailable' && summary.errorCode === null) {
    addIssue('errorCode', '不可用供应商必须包含脱敏错误码。')
  }
}

export const ProviderHealthSummarySchema = z
  .strictObject(providerHealthSummaryShape)
  .superRefine(validateProviderHealthSummary)

const DeepSeekProviderSettingsSchema = z
  .strictObject({
    ...providerHealthSummaryShape,
    canCreateSession: z.boolean(),
  })
  .superRefine((provider, context) => {
    validateProviderHealthSummary(provider, context)

    if (provider.canCreateSession !== provider.configured) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '创建场次能力必须与 DeepSeek 配置状态一致。',
        path: ['canCreateSession'],
      })
    }
  })

export const ProviderSettingsResponseSchema = z.strictObject({
  deepSeek: DeepSeekProviderSettingsSchema,
})

export const HealthResponseSchema = z.strictObject({
  status: z.literal('ok'),
  database: z.literal('available'),
})

export const ProviderPathParamsSchema = z.strictObject({
  provider: ProviderIdSchema,
})

export const ProviderCheckRequestSchema = z.strictObject({})

export const PlayerAgentSettingsSchema = z
  .strictObject({
    attemptTimeoutSeconds: z.number().int().min(5).max(30),
    decisionDeadlineSeconds: z.number().int().min(15).max(120),
  })
  .superRefine((settings, context) => {
    if (settings.decisionDeadlineSeconds < settings.attemptTimeoutSeconds) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['decisionDeadlineSeconds'],
        message: '完整决策 deadline 不得小于单次尝试超时。',
      })
    }
  })

export const PlayerAgentSettingsPatchRequestSchema = z.strictObject({
  settings: z
    .strictObject({
      attemptTimeoutSeconds: z.number().int().min(5).max(30).optional(),
      decisionDeadlineSeconds: z.number().int().min(15).max(120).optional(),
    })
    .refine((settings) => Object.keys(settings).length > 0, {
      message: '至少需要修改一个设置字段。',
    }),
})

export const PlayerAgentSettingsResponseSchema = z.strictObject({
  settings: PlayerAgentSettingsSchema,
})

export const AgentPersonaPathParamsSchema = z.strictObject({
  personaId: AgentPersonaIdSchema,
})

export const AgentPersonaListResponseSchema = z.strictObject({
  personas: z
    .array(AgentPersonaSummarySchema)
    .refine(
      (personas) =>
        new Set(personas.map((persona) => persona.personaId)).size ===
        personas.length,
      '人物不得重复。',
    ),
})

export const AgentPersonaDetailResponseSchema = z.strictObject({
  persona: AgentPersonaSummarySchema,
})

export const PublicSeatSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  playerId: PlayerIdSchema,
  displayName: z.string().min(1),
  avatarColor: z.string().min(1),
  isUser: z.boolean(),
  stack: ChipAmountSchema,
  status: PublicSeatStatusSchema,
})

export const AgentDecisionSummarySchema = z.strictObject({
  decisionRequestId: DecisionRequestIdSchema,
  actorSeatNumber: SeatNumberSchema,
})

export const PublicActionSeatStateSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  status: PublicSeatStatusSchema,
  stack: ChipAmountSchema,
  streetContribution: ChipAmountSchema,
  totalContribution: ChipAmountSchema,
})
export const PublicActionTimelineEntrySchema = z.strictObject({
  actionDisplay: z
    .strictObject({
      committedAmount: ChipAmountSchema,
      streetContributionAfterAction: ChipAmountSchema,
    })
    .optional(),
  eventSeq: EventSequenceSchema,
  handId: HandIdSchema,
  streetBefore: HandStreetSchema,
  actorSeatNumber: SeatNumberSchema,
  action: PokerActionSchema,
  streetAfter: HandStreetSchema,
  boardAfter: z.array(CardSchema).max(5),
  seatStatesAfter: z.array(PublicActionSeatStateSchema),
  potAfter: ChipAmountSchema,
  currentActorSeatNumberAfter: SeatNumberSchema.nullable(),
})

export const PublicPotAwardSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  amount: PositiveChipAmountSchema,
})
export const PublicSettledPotSchema = z.strictObject({
  potIndex: z.number().int().nonnegative(),
  kind: z.enum(['main', 'side']),
  amount: PositiveChipAmountSchema,
  winningSeatNumbers: z.array(SeatNumberSchema).min(1),
  awards: z.array(PublicPotAwardSchema).min(1),
})
export const PublicHandEvaluationSchema = z.strictObject({
  category: PublicHandCategorySchema,
  bestFive: z.tuple([
    CardSchema,
    CardSchema,
    CardSchema,
    CardSchema,
    CardSchema,
  ]),
})
export const PublicRevealedHandSchema = z
  .strictObject({
    seatNumber: SeatNumberSchema,
    holeCards: z.tuple([CardSchema, CardSchema]).nullable(),
    handEvaluation: PublicHandEvaluationSchema.nullable(),
  })
  .superRefine((hand, context) => {
    if (hand.handEvaluation !== null && hand.holeCards === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '公开牌型必须同时公开底牌。',
        path: ['handEvaluation'],
      })
    }
  })
export const PublicCompletedHandSeatResultSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  startingStack: ChipAmountSchema,
  endingStack: ChipAmountSchema,
  totalContribution: ChipAmountSchema,
  netChange: z.number().int(),
})
export const PublicCompletedHandSummarySchema = z
  .strictObject({
    handId: HandIdSchema,
    terminationReason: z.enum(['showdown', 'complete']),
    participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
    buttonSeatNumber: SeatNumberSchema,
    smallBlindSeatNumber: SeatNumberSchema,
    bigBlindSeatNumber: SeatNumberSchema,
    positions: z.array(
      z.strictObject({
        seatNumber: SeatNumberSchema,
        position: PublicLogicalPositionSchema,
      }),
    ),
    board: z.array(CardSchema).max(5),
    seatResults: z.array(PublicCompletedHandSeatResultSchema),
    uncalledBetReturns: z
      .array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          amount: PositiveChipAmountSchema,
        }),
      )
      .max(1),
    pots: z.array(PublicSettledPotSchema).min(1),
    revealedHands: z.array(PublicRevealedHandSchema),
  })
  .superRefine((summary, context) => {
    const participants = summary.participantSeatNumbers
    const participantSet = new Set(participants)
    const isAscending = (values: readonly number[]) =>
      values.every((value, index) => index === 0 || value > values[index - 1]!)
    const exactSeats = (
      values: readonly { seatNumber: number }[],
      path: string,
    ) => {
      if (
        values.length !== participants.length ||
        new Set(values.map((value) => value.seatNumber)).size !==
          participants.length ||
        values.some((value) => !participantSet.has(value.seatNumber))
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '座位集合必须与参与者完全一致。',
          path: [path],
        })
    }
    if (new Set(participants).size !== participants.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '参与座位不得重复。',
        path: ['participantSeatNumbers'],
      })
    if (!isAscending(participants))
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '参与座位必须按座位号升序。',
        path: ['participantSeatNumbers'],
      })
    exactSeats(summary.positions, 'positions')
    exactSeats(summary.seatResults, 'seatResults')
    exactSeats(summary.revealedHands, 'revealedHands')
    if (
      new Set(summary.uncalledBetReturns.map((item) => item.seatNumber))
        .size !== summary.uncalledBetReturns.length ||
      summary.uncalledBetReturns.some(
        (item) => !participantSet.has(item.seatNumber),
      )
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '未跟注返还必须是参与座位的无重复子集。',
        path: ['uncalledBetReturns'],
      })
    for (const [path, values] of [
      ['positions', summary.positions],
      ['seatResults', summary.seatResults],
      ['revealedHands', summary.revealedHands],
      ['uncalledBetReturns', summary.uncalledBetReturns],
    ] as const) {
      if (!isAscending(values.map((value) => value.seatNumber)))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '座位数组必须按座位号升序。',
          path: [path],
        })
    }
    if (
      new Set([
        summary.buttonSeatNumber,
        summary.smallBlindSeatNumber,
        summary.bigBlindSeatNumber,
      ]).size !== 3 ||
      ![
        summary.buttonSeatNumber,
        summary.smallBlindSeatNumber,
        summary.bigBlindSeatNumber,
      ].every((seat) => participantSet.has(seat))
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '按钮和庄盲必须是不同参与座位。',
        path: ['buttonSeatNumber'],
      })
    summary.pots.forEach((pot, index) => {
      if (
        pot.potIndex !== index ||
        pot.kind !== (index === 0 ? 'main' : 'side')
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '公开底池顺序必须规范。',
          path: ['pots', index],
        })
      if (!isAscending(pot.winningSeatNumbers))
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '赢家座位必须按座位号升序。',
          path: ['pots', index, 'winningSeatNumbers'],
        })
      const clockwiseWinners = [
        ...participants.filter((seat) => seat > summary.buttonSeatNumber),
        ...participants.filter((seat) => seat <= summary.buttonSeatNumber),
      ].filter((seat) => pot.winningSeatNumbers.includes(seat))
      if (
        pot.awards.some(
          (award, awardIndex) =>
            award.seatNumber !== clockwiseWinners[awardIndex],
        )
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '派奖必须按按钮左侧顺时针排序。',
          path: ['pots', index, 'awards'],
        })
      if (
        new Set(pot.winningSeatNumbers).size !==
          pot.winningSeatNumbers.length ||
        pot.winningSeatNumbers.some((seat) => !participantSet.has(seat)) ||
        new Set(pot.awards.map((award) => award.seatNumber)).size !==
          pot.winningSeatNumbers.length ||
        !pot.awards.every((award) =>
          pot.winningSeatNumbers.includes(award.seatNumber),
        ) ||
        pot.awards.reduce((total, award) => total + award.amount, 0) !==
          pot.amount
      )
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '公开派奖必须与赢家和池金额一致。',
          path: ['pots', index],
        })
    })
  })

export const HandHistoryViewSchema = z.enum(['public', 'auditReveal'])

export const HandHistoryPathParamsSchema = z.strictObject({
  handId: HandIdSchema,
})

export const HandHistoryQuerySchema = z.strictObject({
  view: HandHistoryViewSchema.default('public'),
})

export const HandHistoryListSortSchema = z.enum(['newest', 'oldest'])
export const HandHistoryListResultSchema = z.enum(['profit', 'loss', 'even'])

function isStartingHandCategory(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = /^([2-9TJQKA])([2-9TJQKA])([so])?$/.exec(value)
  if (match === null) return false
  const firstRank = match[1]
  const secondRank = match[2]
  const suffix = match[3]
  if (firstRank === undefined || secondRank === undefined) return false
  const firstStrength = CARD_RANKS.indexOf(firstRank as CardRank)
  const secondStrength = CARD_RANKS.indexOf(secondRank as CardRank)
  return firstRank === secondRank
    ? suffix === undefined
    : suffix !== undefined && firstStrength > secondStrength
}

/** 标准 169 种起手牌类别，不接受具体花色牌或反序表示。 */
export const StartingHandCategorySchema = z.custom<string>(
  isStartingHandCategory,
)

function isCanonicalHistoricalTimestamp(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(value)
  ) {
    return false
  }
  const date = new Date(`${value.slice(0, 19)}.${value.slice(20, 23)}Z`)
  return (
    !Number.isNaN(date.valueOf()) &&
    date.toISOString().slice(0, 19) === value.slice(0, 19)
  )
}

const CanonicalHistoricalTimestampSchema = z.custom<string>(
  isCanonicalHistoricalTimestamp,
)
const HistoricalPersonaIdSchema = z.string().min(1)
const HistoricalPersonaQueryIdSchema = HistoricalPersonaIdSchema.max(128)
const HistoricalPersonaVersionSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647)
const HistoricalConfigSnapshotKeySchema = z.string().regex(/^[a-f0-9]{64}$/)

export const HandHistoryListQuerySchema = z
  .strictObject({
    from: CanonicalHistoricalTimestampSchema.nullable(),
    to: CanonicalHistoricalTimestampSchema.nullable(),
    sessionId: SessionIdSchema.nullable(),
    position: PublicLogicalPositionSchema.nullable(),
    result: HandHistoryListResultSchema.nullable(),
    startingHand: StartingHandCategorySchema.nullable(),
    personaId: HistoricalPersonaQueryIdSchema.nullable(),
    personaVersion: HistoricalPersonaVersionSchema.nullable(),
    personaName: z.string().min(1).max(256).nullable(),
    configSnapshotKey: HistoricalConfigSnapshotKeySchema.nullable(),
    sort: HandHistoryListSortSchema,
    limit: z.number().int().min(1).max(100),
  })
  .superRefine((query, context) => {
    if (query.from !== null && query.to !== null && query.from >= query.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '结束时间必须晚于开始时间。',
      })
    }
    if (query.personaVersion !== null && query.personaId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['personaVersion'],
        message: '人物版本必须与人物 ID 一同提供。',
      })
    }
  })

export const LatestEndedRosterPreviewResponseSchema = z.strictObject({
  sourceSessionId: SessionIdSchema,
  endedAt: z.iso.datetime({ precision: 6 }),
  agents: z
    .array(
      z.strictObject({
        sourceSeatNumber: AiSeatNumberSchema,
        configSnapshotKey: HistoricalConfigSnapshotKeySchema,
        personaId: HistoricalPersonaIdSchema,
        personaVersion: HistoricalPersonaVersionSchema,
        name: AgentPersonaSummarySchema.shape.name,
        avatarColor: AgentPersonaSummarySchema.shape.avatarColor,
        backgroundDescription:
          AgentPersonaSummarySchema.shape.backgroundDescription,
        teachingSummary: AgentPersonaSummarySchema.shape.teachingSummary,
        style: AgentPersonaStyleSchema,
      }),
    )
    .min(5)
    .max(8)
    .superRefine((agents, context) => {
      if (
        new Set(agents.map((a) => a.personaId)).size !== agents.length ||
        agents.some(
          (a, i) =>
            i > 0 && a.sourceSeatNumber <= agents[i - 1]!.sourceSeatNumber,
        )
      ) {
        context.addIssue({
          code: 'custom',
          message: '人物须唯一，来源座位须唯一且升序。',
        })
      }
    }),
})
export type LatestEndedRosterPreviewResponse = z.infer<
  typeof LatestEndedRosterPreviewResponseSchema
>

export const HistoricalPersonaSnapshotSummarySchema = z.strictObject({
  seatNumber: AiSeatNumberSchema,
  personaId: HistoricalPersonaIdSchema,
  personaVersion: HistoricalPersonaVersionSchema,
  displayName: z.string().min(1),
  avatarColor: z.string().min(1),
  configSnapshotKey: HistoricalConfigSnapshotKeySchema,
})

export const HandHistoryListItemSchema = z
  .strictObject({
    handId: HandIdSchema,
    sessionId: SessionIdSchema,
    handNumber: z.number().int().positive(),
    startedAt: CanonicalHistoricalTimestampSchema,
    completedAt: CanonicalHistoricalTimestampSchema,
    user: z.strictObject({
      position: PublicLogicalPositionSchema,
      holeCards: z.tuple([CardSchema, CardSchema]),
      startingHandCategory: StartingHandCategorySchema,
      netChange: z.number().int(),
    }),
    board: z.array(CardSchema).max(5),
    result: z.strictObject({
      terminationReason: z.enum(['complete', 'showdown']),
      winnerSeatNumbers: z.array(SeatNumberSchema).min(1),
      userAwardAmount: ChipAmountSchema,
    }),
    aiParticipants: z
      .array(HistoricalPersonaSnapshotSummarySchema)
      .min(5)
      .max(8),
  })
  .superRefine((item, context) => {
    const cardKeys = [...item.user.holeCards, ...item.board].map(
      (card) => `${card.rank}:${card.suit}`,
    )
    if (new Set(cardKeys).size !== cardKeys.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['board'],
        message: '用户底牌与公共牌不得重复。',
      })
    }
    const aiSeats = item.aiParticipants.map(({ seatNumber }) => seatNumber)
    if (
      aiSeats.some((seatNumber, index) =>
        index === 0 ? false : seatNumber <= aiSeats[index - 1]!,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['aiParticipants'],
        message: '历史 AI 必须按座位号严格升序。',
      })
    }
    const winners = item.result.winnerSeatNumbers
    if (
      winners.some((seatNumber, index) =>
        index === 0 ? false : seatNumber <= winners[index - 1]!,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['result', 'winnerSeatNumbers'],
        message: '获奖座位必须唯一且升序。',
      })
    }
  })

export const HandHistoryListResponseSchema = z.strictObject({
  items: z.array(HandHistoryListItemSchema),
  nextCursor: z.string().min(1).nullable(),
})

const ManagementSafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
const ManagementSafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)
export const PUBLIC_AGENT_AUDIT_CODES = [
  'capability_authority_lost',
  'capability_budget_exhausted',
  'capability_cancelled',
  'capability_deadline_exhausted',
  'capability_execution_failed',
  'capability_schema_rejected',
  'capability_timeout',
  'content_correction',
  'content_correction_exhausted',
  'execution_budget_exhausted',
  'execution_deadline_exhausted',
  'lease_replaced',
  'local_persistence_error',
  'player_commit_authority_lost',
  'player_commit_decision_stale',
  'player_commit_resource_missing',
  'player_decision_authority_lost',
  'player_dependency_unavailable',
  'player_internal_failure',
  'player_runtime_contract_rejected',
  'process_restart',
  'provider_auth_error',
  'provider_billing_unavailable',
  'provider_network_error',
  'provider_rate_limited',
  'provider_service_unavailable',
  'provider_timeout',
  'provider_unknown_error',
  'provider_usage_unavailable',
  'response_parse_error',
  'response_schema_error',
  'response_semantic_invalid',
  'runtime_authority_lost',
  'runtime_cancelled',
  'sensitive_projection_rejected',
  'session_data_deleted',
  'technical_error',
  'user_cancelled',
] as const
export const AgentAuditPublicCodeSchema = z.enum(PUBLIC_AGENT_AUDIT_CODES)
const AuditReferenceIdSchema = z.string().trim().min(1).max(128)
const AuditModelSchema = z.string().trim().min(1).max(256)
const AuditDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)

export const SessionManagementLifecycleFilterSchema = z.enum([
  'all',
  'active',
  'ended',
  'readonlyDiagnostic',
])
export const SessionManagementListQuerySchema = z
  .strictObject({
    lifecycle: SessionManagementLifecycleFilterSchema,
    from: CanonicalHistoricalTimestampSchema.nullable(),
    to: CanonicalHistoricalTimestampSchema.nullable(),
    sort: HandHistoryListSortSchema,
    limit: z.number().int().min(1).max(100),
  })
  .superRefine((query, context) => {
    if (query.from !== null && query.to !== null && query.from >= query.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '结束时间必须晚于开始时间。',
      })
    }
  })

export const SessionManagementRosterEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('user'),
    participantId: PlayerIdSchema,
    seatNumber: z.literal(0),
  }),
  z.strictObject({
    kind: z.literal('ai'),
    participantId: PlayerIdSchema,
    seatNumber: AiSeatNumberSchema,
    personaId: HistoricalPersonaIdSchema,
    personaVersion: HistoricalPersonaVersionSchema,
    displayName: z.string().min(1),
    avatarColor: z.string().min(1),
    configSnapshotKey: HistoricalConfigSnapshotKeySchema,
  }),
])

export const AvailableSessionAccountingSeatSchema = z.strictObject({
  participantId: PlayerIdSchema,
  seatNumber: SeatNumberSchema,
  initialChips: ManagementSafeNonnegativeIntegerSchema,
  currentChips: ManagementSafeNonnegativeIntegerSchema,
  cumulativeBuyIn: ManagementSafeNonnegativeIntegerSchema,
  finalChips: ManagementSafeNonnegativeIntegerSchema.nullable(),
  sessionNetChange: ManagementSafeIntegerSchema.nullable(),
})

export const SessionManagementAccountingSchema = z.discriminatedUnion(
  'status',
  [
    z.strictObject({
      status: z.literal('available'),
      stateVersion: StateVersionSchema.max(Number.MAX_SAFE_INTEGER),
      seats: z.array(AvailableSessionAccountingSeatSchema).min(6).max(9),
    }),
    z.strictObject({
      status: z.literal('unavailable'),
      reason: z.literal('readonlyDiagnostic'),
    }),
  ],
)

export const SessionManagementItemSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    lifecycle: SessionLifecycleSchema,
    createdAt: CanonicalHistoricalTimestampSchema,
    endedAt: CanonicalHistoricalTimestampSchema.nullable(),
    completedHandCount: ManagementSafeNonnegativeIntegerSchema,
    currentHandId: HandIdSchema.nullable(),
    roster: z.array(SessionManagementRosterEntrySchema).min(6).max(9),
    accounting: SessionManagementAccountingSchema,
  })
  .superRefine((item, context) => {
    const seats = item.roster.map(({ seatNumber }) => seatNumber)
    if (
      seats.some((seat, index) => index > 0 && seat <= seats[index - 1]!) ||
      item.roster.filter(({ kind }) => kind === 'user').length !== 1
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['roster'],
        message: '场次阵容必须唯一并按座位升序。',
      })
    }
    if (
      (item.lifecycle === 'active' && item.endedAt !== null) ||
      (item.lifecycle === 'ended' && item.endedAt === null) ||
      (item.lifecycle === 'readonlyDiagnostic') !==
        (item.accounting.status === 'unavailable')
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '场次生命周期与结束时间、账务状态不一致。',
      })
    }
    if (item.accounting.status === 'available') {
      const accountingSeats = item.accounting.seats.map(
        ({ seatNumber }) => seatNumber,
      )
      if (
        accountingSeats.length !== seats.length ||
        accountingSeats.some((seat, index) => seat !== seats[index]) ||
        item.accounting.seats.some((seat, index) => {
          const roster = item.roster[index]
          return (
            roster?.participantId !== seat.participantId ||
            (item.lifecycle === 'active'
              ? seat.finalChips !== null || seat.sessionNetChange !== null
              : seat.finalChips !== seat.currentChips ||
                seat.sessionNetChange !==
                  seat.currentChips - seat.cumulativeBuyIn)
          )
        })
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['accounting', 'seats'],
          message: '场次账务必须与阵容及生命周期一致。',
        })
      }
    }
  })

export const SessionManagementListResponseSchema = z.strictObject({
  query: SessionManagementListQuerySchema,
  timeBasis: z.literal('sessionCreatedAt'),
  items: z.array(SessionManagementItemSchema),
  nextCursor: z.string().min(1).nullable(),
})

export const AgentRunRuntimeSchema = z.enum(['player', 'coach'])
export const AgentRunExecutionModeSchema = z.enum([
  'live',
  'historicalReexecution',
])
export const AgentRunLifecycleSchema = z.enum([
  'queued',
  'leased',
  'running',
  'completed',
  'failed',
  'cancelled',
  'stale',
])
export const AgentCallListQuerySchema = z.strictObject({
  limit: z.number().int().min(1).max(100),
})
export const AgentRunPathParamsSchema = z.strictObject({ runId: z.uuid() })

export const AgentRunSummarySchema = z
  .strictObject({
    runId: z.uuid(),
    sessionId: SessionIdSchema,
    handId: HandIdSchema,
    runtime: AgentRunRuntimeSchema,
    executionMode: AgentRunExecutionModeSchema,
    lifecycle: AgentRunLifecycleSchema,
    participantId: PlayerIdSchema.nullable(),
    seatNumber: AiSeatNumberSchema.nullable(),
    sourceStateVersion: StateVersionSchema.max(
      Number.MAX_SAFE_INTEGER,
    ).nullable(),
    decisionRequestId: DecisionRequestIdSchema.nullable(),
    createdAt: CanonicalHistoricalTimestampSchema,
    startedAt: CanonicalHistoricalTimestampSchema.nullable(),
    completedAt: CanonicalHistoricalTimestampSchema.nullable(),
    terminationReasonCode: AgentAuditPublicCodeSchema.nullable(),
  })
  .superRefine((run, context) => {
    const playerFields = [
      run.participantId,
      run.seatNumber,
      run.sourceStateVersion,
      run.decisionRequestId,
    ]
    if (
      (run.runtime === 'player' &&
        playerFields.some((value) => value === null)) ||
      (run.runtime === 'coach' && playerFields.some((value) => value !== null))
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Agent Run 身份字段与 Runtime 不一致。',
      })
    }
  })

export const AgentCallHandSummarySchema = z.discriminatedUnion('status', [
  z.strictObject({
    handId: HandIdSchema,
    sessionId: SessionIdSchema,
    handNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.enum(['inProgress', 'completed']),
  }),
  z.strictObject({
    handId: HandIdSchema,
    sessionId: SessionIdSchema,
    handNumber: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    status: z.literal('aborted'),
    abortedAt: CanonicalHistoricalTimestampSchema,
    abortReasonCode: AgentAuditPublicCodeSchema,
    abortedByAgentRunId: z.uuid(),
  }),
])

export const HandAgentCallsResponseSchema = z.strictObject({
  query: AgentCallListQuerySchema,
  hand: AgentCallHandSummarySchema,
  items: z.array(AgentRunSummarySchema),
  nextCursor: z.string().min(1).nullable(),
})

export const PublicNormalizedActionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('notSelected') }),
  z.strictObject({ status: z.literal('withheld') }),
  z.strictObject({ status: z.literal('visible'), action: PokerActionSchema }),
])
export const AgentRunDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('none') }),
  z.strictObject({
    kind: z.literal('summary'),
    decisionId: z.uuid(),
    status: z.enum(['auditPrepared', 'modelPrepared', 'selected', 'committed']),
    terminalOutcome: z.enum(['failed', 'stale', 'cancelled']).nullable(),
    terminalReasonCode: AgentAuditPublicCodeSchema.nullable(),
    acceptedAttemptId: z.uuid().nullable(),
    commandLedgerId: z.uuid().nullable(),
    sourceDecisionId: z.uuid().nullable(),
    normalizedAction: PublicNormalizedActionSchema,
  }),
])
export const AgentRunDetailResponseSchema = AgentRunSummarySchema.and(
  z.strictObject({
    parentRunId: z.uuid().nullable(),
    replacementRunId: z.uuid().nullable(),
    reexecutionSourceRunId: z.uuid().nullable(),
    decision: AgentRunDecisionSchema,
    commandEventRange: z
      .strictObject({
        firstEventSeq: EventSequenceSchema.max(Number.MAX_SAFE_INTEGER),
        lastEventSeq: EventSequenceSchema.max(Number.MAX_SAFE_INTEGER),
      })
      .refine((range) => range.firstEventSeq <= range.lastEventSeq)
      .nullable(),
    contentAvailability: z.strictObject({
      requestBody: z.literal('notExposed'),
      rawResponse: z.literal('notRecorded'),
      validationDetails: z.literal('notRecorded'),
    }),
  }),
)

export const AgentAttemptUsageSchema = z.discriminatedUnion('accounting', [
  z.strictObject({
    inputTokens: z.null(),
    outputTokens: z.null(),
    accounting: z.literal('pending'),
  }),
  z.strictObject({
    inputTokens: ManagementSafeNonnegativeIntegerSchema,
    outputTokens: ManagementSafeNonnegativeIntegerSchema,
    accounting: z.enum(['providerReported', 'reservedUpperBound']),
  }),
  z.strictObject({
    inputTokens: z.literal(0),
    outputTokens: z.literal(0),
    accounting: z.literal('notIncurred'),
  }),
])
export const AgentAttemptSummarySchema = z.strictObject({
  attemptId: z.uuid(),
  attemptNumber: z.number().int().nonnegative().max(2_147_483_647),
  stage: AuditReferenceIdSchema,
  lifecycle: z.enum(['started', 'completed', 'failed', 'cancelled', 'stale']),
  provider: AuditReferenceIdSchema,
  model: AuditModelSchema,
  attemptType: AuditReferenceIdSchema,
  routingReasonCode: AgentAuditPublicCodeSchema.nullable(),
  startedAt: CanonicalHistoricalTimestampSchema,
  completedAt: CanonicalHistoricalTimestampSchema.nullable(),
  durationMs: ManagementSafeNonnegativeIntegerSchema.nullable(),
  accepted: z.boolean(),
  stale: z.boolean(),
  interrupted: z.boolean(),
  validationStatus: z.enum(['notRun', 'valid', 'invalid']),
  errorCode: AgentAuditPublicCodeSchema.nullable(),
  requestProjectionHash: AuditDigestSchema,
  responseProjectionHash: AuditDigestSchema.nullable(),
  usage: AgentAttemptUsageSchema,
})
export const AgentCapabilityInvocationSummarySchema = z.strictObject({
  invocationId: z.uuid(),
  invocationNumber: z.number().int().nonnegative().max(2_147_483_647),
  capabilityName: AuditReferenceIdSchema,
  capabilityVersion: z.number().int().positive().max(2_147_483_647),
  authorized: z.boolean(),
  startedAt: CanonicalHistoricalTimestampSchema,
  completedAt: CanonicalHistoricalTimestampSchema.nullable(),
  durationMs: ManagementSafeNonnegativeIntegerSchema.nullable(),
  inputSchemaVersion: z.number().int().positive().max(2_147_483_647),
  outputSchemaVersion: z
    .number()
    .int()
    .positive()
    .max(2_147_483_647)
    .nullable(),
  inputHash: AuditDigestSchema,
  outputHash: AuditDigestSchema.nullable(),
  errorCode: AgentAuditPublicCodeSchema.nullable(),
})
export const AgentRunAttemptsResponseSchema = z.strictObject({
  query: AgentCallListQuerySchema,
  runId: z.uuid(),
  items: z.array(AgentAttemptSummarySchema),
  nextCursor: z.string().min(1).nullable(),
})
export const AgentRunCapabilityInvocationsResponseSchema = z.strictObject({
  query: AgentCallListQuerySchema,
  runId: z.uuid(),
  items: z.array(AgentCapabilityInvocationSummarySchema),
  nextCursor: z.string().min(1).nullable(),
})

export const StatisticsScopeSchema = z.enum(['hands', 'sessions'])
export const StatisticsSubjectSchema = z.enum(['user', 'ai'])
export const StatisticsGroupBySchema = z.enum(['none', 'position'])

const StatisticsSafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
const StatisticsSafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER)

const StatisticsQueryFields = {
  subject: StatisticsSubjectSchema,
  from: CanonicalHistoricalTimestampSchema.nullable(),
  to: CanonicalHistoricalTimestampSchema.nullable(),
  sessionId: SessionIdSchema.nullable(),
  personaId: HistoricalPersonaQueryIdSchema.nullable(),
  personaVersion: HistoricalPersonaVersionSchema.nullable(),
  personaName: z
    .string()
    .min(1)
    .max(256)
    .refine((value) => value.trim().length > 0)
    .nullable(),
  configSnapshotKey: HistoricalConfigSnapshotKeySchema.nullable(),
} as const

export const HandStatisticsQuerySchema = z.strictObject({
  scope: z.literal('hands'),
  ...StatisticsQueryFields,
  position: PublicLogicalPositionSchema.nullable(),
  groupBy: z.enum(['none', 'position']),
})

export const SessionStatisticsQuerySchema = z.strictObject({
  scope: z.literal('sessions'),
  ...StatisticsQueryFields,
  groupBy: z.literal('none'),
})

export const StatisticsQuerySchema = z
  .discriminatedUnion('scope', [
    HandStatisticsQuerySchema,
    SessionStatisticsQuerySchema,
  ])
  .superRefine((query, context) => {
    if (query.from !== null && query.to !== null && query.from >= query.to) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['to'],
        message: '结束时间必须晚于开始时间。',
      })
    }
    if (query.personaVersion !== null && query.personaId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['personaVersion'],
        message: '人物版本必须与人物 ID 一同提供。',
      })
    }
  })

function expectedStatisticsPercentage(
  numerator: number,
  denominator: number,
): number | null {
  if (denominator === 0) return null
  const hundredths =
    (BigInt(numerator) * 10_000n + BigInt(denominator) / 2n) /
    BigInt(denominator)
  return Number(hundredths) / 100
}

export const StatisticsRateSchema = z
  .strictObject({
    numerator: StatisticsSafeNonnegativeIntegerSchema,
    denominator: StatisticsSafeNonnegativeIntegerSchema,
    percentage: z.number().min(0).max(100).nullable(),
  })
  .superRefine((rate, context) => {
    if (
      rate.numerator > rate.denominator ||
      rate.percentage !==
        expectedStatisticsPercentage(rate.numerator, rate.denominator)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '统计比率的分子、分母和百分比必须一致。',
      })
    }
  })

export const HandStatisticsMetricsSchema = z.strictObject({
  handCount: StatisticsSafeNonnegativeIntegerSchema,
  distinctHandCount: StatisticsSafeNonnegativeIntegerSchema,
  handNetChange: StatisticsSafeIntegerSchema,
  vpip: StatisticsRateSchema,
  pfr: StatisticsRateSchema,
  threeBet: StatisticsRateSchema,
  wtsd: StatisticsRateSchema,
  wsd: StatisticsRateSchema,
})

const StatisticsPositionMetricsSchema = z.strictObject({
  position: PublicLogicalPositionSchema,
  metrics: HandStatisticsMetricsSchema,
})

const STATISTICS_POSITION_ORDER = [
  'UTG',
  'UTG+1',
  'MP',
  'LJ',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
] as const

export const HandStatisticsResponseSchema = z
  .strictObject({
    scope: z.literal('hands'),
    query: HandStatisticsQuerySchema,
    timeBasis: z.literal('handStartedAt'),
    totals: HandStatisticsMetricsSchema,
    byPosition: z.array(StatisticsPositionMetricsSchema).max(9),
  })
  .superRefine((response, context) => {
    const positions = response.byPosition.map((bucket) => bucket.position)
    const expectedPositions =
      response.query.groupBy === 'position' ? STATISTICS_POSITION_ORDER : []
    if (
      positions.length !== expectedPositions.length ||
      positions.some((position, index) => position !== expectedPositions[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['byPosition'],
        message: '位置分组必须与查询条件一致且使用固定顺序。',
      })
    }
  })

export const SessionStatisticsTotalsSchema = z.strictObject({
  sessionCount: StatisticsSafeNonnegativeIntegerSchema,
  participantSessionCount: StatisticsSafeNonnegativeIntegerSchema,
  finalChips: StatisticsSafeNonnegativeIntegerSchema,
  cumulativeBuyIn: StatisticsSafeNonnegativeIntegerSchema,
  sessionNetChange: StatisticsSafeIntegerSchema,
})

export const SessionStatisticsResponseSchema = z.strictObject({
  scope: z.literal('sessions'),
  query: SessionStatisticsQuerySchema,
  timeBasis: z.literal('sessionEndedAt'),
  totals: SessionStatisticsTotalsSchema,
})

export const StatisticsResponseSchema = z.discriminatedUnion('scope', [
  HandStatisticsResponseSchema,
  SessionStatisticsResponseSchema,
])

/** M5.4 固定统计的中文定义由共享协议持有，前端不得另行推导公式。 */
export const StatisticsMetricDefinitions = Object.freeze({
  vpip: '翻前自愿投入筹码的参与者手数占比。',
  pfr: '翻前主动加注的参与者手数占比。',
  threeBet: '在合法 3-bet 机会中完成翻前完整再加注的次数占比。',
  wtsd: '看到翻牌的参与者中进入摊牌的手数占比。',
  wsd: '进入摊牌的参与者中获得正派奖的手数占比。',
} as const)

export const HandHistoryParticipantSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  playerId: PlayerIdSchema,
  isUser: z.boolean(),
  displayName: z.string().min(1),
  avatarColor: z.string().min(1),
  position: PublicLogicalPositionSchema,
  startingStack: ChipAmountSchema,
  endingStack: ChipAmountSchema,
  totalContribution: ChipAmountSchema,
  netChange: z.number().int(),
})

export const HandHistoryActionSchema = z.strictObject({
  actionNumber: z.number().int().positive(),
  eventSeq: EventSequenceSchema,
  actorSeatNumber: SeatNumberSchema,
  playerId: PlayerIdSchema,
  position: PublicLogicalPositionSchema,
  action: PokerActionSchema,
  committedAmount: ChipAmountSchema,
  streetContributionAfterAction: ChipAmountSchema,
  stackAfterAction: ChipAmountSchema,
  potBeforeAction: ChipAmountSchema,
  potAfterAction: ChipAmountSchema,
})

const HandHistoryBettingPhaseSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    phase: z.literal('preflop'),
    communityCards: z.tuple([]),
    actions: z.array(HandHistoryActionSchema),
  }),
  z.strictObject({
    phase: z.literal('flop'),
    communityCards: z.tuple([CardSchema, CardSchema, CardSchema]),
    actions: z.array(HandHistoryActionSchema),
  }),
  z.strictObject({
    phase: z.literal('turn'),
    communityCards: z.tuple([CardSchema, CardSchema, CardSchema, CardSchema]),
    actions: z.array(HandHistoryActionSchema),
  }),
  z.strictObject({
    phase: z.literal('river'),
    communityCards: z.tuple([
      CardSchema,
      CardSchema,
      CardSchema,
      CardSchema,
      CardSchema,
    ]),
    actions: z.array(HandHistoryActionSchema),
  }),
])

export const HandHistoryUncalledBetReturnSchema = z.strictObject({
  eventSeq: EventSequenceSchema,
  seatNumber: SeatNumberSchema,
  amount: PositiveChipAmountSchema,
})

export const HandHistoryResultPhaseSchema = z.strictObject({
  phase: z.literal('showdown'),
  terminationReason: z.enum(['showdown', 'complete']),
  handCompletedEventSeq: EventSequenceSchema,
  communityCards: z.array(CardSchema).max(5),
  uncalledBetReturns: z.array(HandHistoryUncalledBetReturnSchema),
  revealedHands: z.array(PublicRevealedHandSchema),
  pots: z.array(PublicSettledPotSchema).min(1),
})

const HandHistoryPhaseSchema = z.discriminatedUnion('phase', [
  HandHistoryBettingPhaseSchema,
  HandHistoryResultPhaseSchema,
])

function isStrictlyAscending(values: readonly number[]): boolean {
  return values.every(
    (value, index) => index === 0 || value > values[index - 1]!,
  )
}

export const HandHistoryResponseSchema = z
  .strictObject({
    protocolVersion: z.literal(1),
    view: HandHistoryViewSchema,
    history: z.strictObject({
      sessionId: SessionIdSchema,
      handId: HandIdSchema,
      handNumber: z.number().int().positive(),
      startedAt: z.iso.datetime(),
      completedAt: z.iso.datetime(),
      participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
      buttonSeatNumber: SeatNumberSchema,
      smallBlindSeatNumber: SeatNumberSchema,
      bigBlindSeatNumber: SeatNumberSchema,
      participants: z.array(HandHistoryParticipantSchema).min(6).max(9),
      phases: z.array(HandHistoryPhaseSchema).min(2),
    }),
  })
  .superRefine((response, context) => {
    const { history } = response
    const participantSeats = history.participantSeatNumbers
    const participantSet = new Set(participantSeats)
    const participantEntries = history.participants
    const terminal = history.phases.at(-1)
    const addIssue = (path: readonly (string | number)[], message: string) =>
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path],
        message,
      })

    if (
      participantSet.size !== participantSeats.length ||
      !isStrictlyAscending(participantSeats)
    ) {
      addIssue(
        ['history', 'participantSeatNumbers'],
        '参与座位必须唯一且升序。',
      )
    }
    if (
      participantEntries.length !== participantSeats.length ||
      participantEntries.some(
        (participant, index) =>
          participant.seatNumber !== participantSeats[index],
      )
    ) {
      addIssue(
        ['history', 'participants'],
        '参与者必须与座位集合一一对应且升序。',
      )
    }
    const users = participantEntries.filter((participant) => participant.isUser)
    if (users.length !== 1 || users[0]?.seatNumber !== 0) {
      addIssue(
        ['history', 'participants'],
        '完成手历史必须恰好包含座位 0 的用户。',
      )
    }
    if (
      new Set([
        history.buttonSeatNumber,
        history.smallBlindSeatNumber,
        history.bigBlindSeatNumber,
      ]).size !== 3 ||
      ![
        history.buttonSeatNumber,
        history.smallBlindSeatNumber,
        history.bigBlindSeatNumber,
      ].every((seat) => participantSet.has(seat))
    ) {
      addIssue(
        ['history', 'buttonSeatNumber'],
        '按钮和庄盲必须是不同参与座位。',
      )
    }
    if (
      history.phases[0]?.phase !== 'preflop' ||
      terminal?.phase !== 'showdown'
    ) {
      addIssue(
        ['history', 'phases'],
        '完成手历史必须以翻前开始并以终局分组结束。',
      )
      return
    }

    const phaseOrder = ['preflop', 'flop', 'turn', 'river'] as const
    let previousPhaseIndex = -1
    let previousEventSeq = -1
    for (const [phaseIndex, phase] of history.phases.entries()) {
      if (phase.phase === 'showdown') {
        if (phaseIndex !== history.phases.length - 1) {
          addIssue(
            ['history', 'phases', phaseIndex],
            '终局分组必须是最后一项。',
          )
        }
        continue
      }
      const order = phaseOrder.indexOf(phase.phase)
      if (order !== previousPhaseIndex + 1) {
        addIssue(
          ['history', 'phases', phaseIndex, 'phase'],
          '下注街必须单调且连续。',
        )
      }
      previousPhaseIndex = order
      for (const action of phase.actions) {
        if (
          !participantSet.has(action.actorSeatNumber) ||
          !participantEntries.some(
            (participant) =>
              participant.seatNumber === action.actorSeatNumber &&
              participant.playerId === action.playerId &&
              participant.position === action.position,
          )
        ) {
          addIssue(
            ['history', 'phases', phaseIndex, 'actions'],
            '行动必须引用参与者。',
          )
        }
        if (action.eventSeq <= previousEventSeq) {
          addIssue(
            ['history', 'phases', phaseIndex, 'actions'],
            '行动事件序号必须严格递增。',
          )
        }
        previousEventSeq = action.eventSeq
      }
    }

    const revealedSeats = terminal.revealedHands.map((hand) => hand.seatNumber)
    if (
      revealedSeats.length !== participantSeats.length ||
      revealedSeats.some((seat, index) => seat !== participantSeats[index])
    ) {
      addIssue(
        ['history', 'phases', history.phases.length - 1, 'revealedHands'],
        '亮牌必须与参与座位一一对应且升序。',
      )
    }
    if (
      terminal.uncalledBetReturns.some(
        (returned) => !participantSet.has(returned.seatNumber),
      )
    ) {
      addIssue(
        ['history', 'phases', history.phases.length - 1, 'uncalledBetReturns'],
        '返还必须引用参与座位。',
      )
    }
    if (
      terminal.pots.some(
        (pot, potIndex) =>
          pot.potIndex !== potIndex ||
          pot.kind !== (potIndex === 0 ? 'main' : 'side') ||
          pot.winningSeatNumbers.some((seat) => !participantSet.has(seat)) ||
          pot.awards.some((award) => !participantSet.has(award.seatNumber)),
      )
    ) {
      addIssue(
        ['history', 'phases', history.phases.length - 1, 'pots'],
        '逐池结果必须引用参与座位并保持规范顺序。',
      )
    }
    if (
      terminal.terminationReason === 'complete' &&
      terminal.revealedHands.some((hand) => hand.handEvaluation !== null)
    ) {
      addIssue(
        ['history', 'phases', history.phases.length - 1, 'revealedHands'],
        '直接获胜终局不得携带牌型。',
      )
    }
    if (
      response.view === 'auditReveal' &&
      terminal.revealedHands.some((hand) => hand.holeCards === null)
    ) {
      addIssue(
        ['history', 'phases', history.phases.length - 1, 'revealedHands'],
        '审计视图必须显示全部底牌。',
      )
    }
    if (response.view === 'public') {
      const userHand = terminal.revealedHands.find(
        (hand) => hand.seatNumber === 0,
      )
      if (userHand?.holeCards === null || userHand === undefined) {
        addIssue(
          ['history', 'phases', history.phases.length - 1, 'revealedHands'],
          '公开视图必须显示用户底牌。',
        )
      }
      if (
        terminal.terminationReason === 'complete' &&
        terminal.revealedHands.some(
          (hand) => hand.seatNumber !== 0 && hand.holeCards !== null,
        )
      ) {
        addIssue(
          ['history', 'phases', history.phases.length - 1, 'revealedHands'],
          '直接获胜时不得显示其他座位底牌。',
        )
      }
      if (
        terminal.terminationReason === 'showdown' &&
        terminal.revealedHands.some(
          (hand) =>
            hand.seatNumber !== 0 &&
            hand.holeCards !== null &&
            hand.handEvaluation === null,
        )
      ) {
        addIssue(
          ['history', 'phases', history.phases.length - 1, 'revealedHands'],
          '公开 AI 底牌必须伴随真实牌型。',
        )
      }
    }
  })

export const PublicHandSnapshotSchema = z.strictObject({
  handId: HandIdSchema,
  street: HandStreetSchema,
  board: z.array(CardSchema).max(5),
  pot: ChipAmountSchema,
  currentActorSeatNumber: SeatNumberSchema.nullable(),
  heroHoleCards: z.array(CardSchema).length(2).nullable(),
  legalActions: LegalActionsSchema,
  actionTimeline: z.array(PublicActionTimelineEntrySchema),
})

export const PublicTableDisplaySchema = z.strictObject({
  completedHandCount: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  blinds: z.strictObject({
    smallBlind: z.literal(10),
    bigBlind: z.literal(20),
  }),
  hand: z
    .strictObject({
      handId: HandIdSchema,
      buttonSeatNumber: SeatNumberSchema,
      seats: z
        .array(
          z.strictObject({
            seatNumber: SeatNumberSchema,
            position: PublicLogicalPositionSchema,
            streetContribution: ChipAmountSchema,
          }),
        )
        .min(6)
        .max(9),
      potBreakdown: z.strictObject({
        pots: z
          .array(
            z.strictObject({
              potIndex: z.number().int().nonnegative(),
              kind: z.enum(['main', 'side']),
              amount: ChipAmountSchema.refine((value) => value > 0),
            }),
          )
          .max(9),
        unmatchedContribution: z
          .strictObject({
            seatNumber: SeatNumberSchema,
            amount: ChipAmountSchema.refine((value) => value > 0),
          })
          .nullable(),
      }),
    })
    .nullable(),
})
export type PublicTableDisplay = z.infer<typeof PublicTableDisplaySchema>

export const PublicSessionSnapshotSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    stateVersion: StateVersionSchema,
    eventSeq: EventSequenceSchema,
    pokerPhase: PokerPhaseSchema,
    lifecycleStatus: SessionLifecycleSchema,
    agentRunState: AgentRunStateSchema,
    activeDecision: AgentDecisionSummarySchema.nullable(),
    tableDisplay: PublicTableDisplaySchema.optional(),
    seats: z.array(PublicSeatSchema).min(6).max(9),
    hand: PublicHandSnapshotSchema.nullable(),
    lastCompletedHandSummary: PublicCompletedHandSummarySchema.nullable(),
  })
  .superRefine((snapshot, context) => {
    const display = snapshot.tableDisplay
    if (display !== undefined) {
      const hand = display.hand
      const invalid = () =>
        context.addIssue({
          code: 'custom',
          path: ['tableDisplay'],
          message: '牌桌展示必须与同手座位、庄家及底池一致。',
        })
      if ((hand === null) !== (snapshot.hand === null)) invalid()
      if (hand !== null) {
        const expected = snapshot.seats.filter((seat) => seat.status !== 'out')
        const unmatched = hand.potBreakdown.unmatchedContribution
        const total = hand.potBreakdown.pots.reduce(
          (sum, pot) => sum + pot.amount,
          unmatched?.amount ?? 0,
        )
        if (
          hand.handId !== snapshot.hand?.handId ||
          hand.seats.length !== expected.length ||
          hand.seats.some(
            (seat, index) => seat.seatNumber !== expected[index]?.seatNumber,
          ) ||
          new Set(hand.seats.map((seat) => seat.position)).size !==
            hand.seats.length ||
          hand.seats.find((seat) => seat.position === 'BTN')?.seatNumber !==
            hand.buttonSeatNumber ||
          !hand.seats.some((seat) => seat.position === 'SB') ||
          !hand.seats.some((seat) => seat.position === 'BB') ||
          (unmatched !== null &&
            !hand.seats.some(
              (seat) => seat.seatNumber === unmatched.seatNumber,
            )) ||
          hand.potBreakdown.pots.some(
            (pot, index) =>
              pot.potIndex !== index ||
              pot.kind !== (index === 0 ? 'main' : 'side'),
          ) ||
          !Number.isSafeInteger(total) ||
          total !== snapshot.hand?.pot
        )
          invalid()
      }
    }
    const seatNumbers = new Set<number>()
    let userCount = 0

    snapshot.seats.forEach((seat, index) => {
      if (
        index > 0 &&
        seat.seatNumber <= snapshot.seats[index - 1]!.seatNumber
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '公开座位必须按座位号严格升序。',
          path: ['seats', index, 'seatNumber'],
        })
      }
      if (seatNumbers.has(seat.seatNumber)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '公开座位号不得重复。',
          path: ['seats', index, 'seatNumber'],
        })
      }

      seatNumbers.add(seat.seatNumber)

      if (seat.isUser) {
        userCount += 1

        if (seat.seatNumber !== 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '本地用户必须固定在座位 0。',
            path: ['seats', index, 'seatNumber'],
          })
        }
      } else if (seat.seatNumber === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'AI 不得占用座位 0。',
          path: ['seats', index, 'seatNumber'],
        })
      }
    })

    if (userCount !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '公开快照必须恰好包含一个本地用户。',
        path: ['seats'],
      })
    }
    const hasActiveDecision = snapshot.activeDecision !== null
    if ((snapshot.agentRunState === 'thinking') !== hasActiveDecision) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '思考态必须且只能携带活动决策摘要。',
        path: ['activeDecision'],
      })
    }
    if (snapshot.activeDecision !== null) {
      const actorSeat = snapshot.seats.find(
        (seat) => seat.seatNumber === snapshot.activeDecision?.actorSeatNumber,
      )
      if (
        actorSeat === undefined ||
        actorSeat.isUser ||
        snapshot.hand?.currentActorSeatNumber !==
          snapshot.activeDecision.actorSeatNumber
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '活动决策必须指向当前行动的 AI 座位。',
          path: ['activeDecision', 'actorSeatNumber'],
        })
      }
    }
    if (
      snapshot.lifecycleStatus === 'ended' &&
      (snapshot.pokerPhase !== 'betweenHands' ||
        snapshot.hand !== null ||
        snapshot.agentRunState !== 'idle' ||
        snapshot.activeDecision !== null)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '已结束场次必须处于空闲的两手之间状态。',
        path: ['lifecycleStatus'],
      })
    }
    if (
      (snapshot.pokerPhase === 'inHand' &&
        (snapshot.hand === null ||
          snapshot.lastCompletedHandSummary !== null)) ||
      (snapshot.pokerPhase === 'betweenHands' && snapshot.hand !== null)
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '公开阶段、当前手牌与最近摘要必须一致。',
        path: ['pokerPhase'],
      })
    if (snapshot.hand !== null) {
      const userCanAct =
        snapshot.lifecycleStatus === 'active' &&
        snapshot.agentRunState === 'idle' &&
        snapshot.hand.currentActorSeatNumber === 0
      if (
        snapshot.hand.heroHoleCards === null ||
        (userCanAct && snapshot.hand.legalActions.length === 0) ||
        (!userCanAct && snapshot.hand.legalActions.length !== 0)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: '当前手的用户底牌和合法动作必须与行动权一致。',
          path: ['hand'],
        })
      }
      let previous = -1
      const publicSeatNumbers = new Set(
        snapshot.seats.map((seat) => seat.seatNumber),
      )
      snapshot.hand.actionTimeline.forEach((entry, index) => {
        if (
          entry.eventSeq <= previous ||
          entry.eventSeq > snapshot.eventSeq ||
          entry.handId !== snapshot.hand?.handId
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '公开行动时间线必须属于当前手且严格递增。',
            path: ['hand', 'actionTimeline', index],
          })
        previous = entry.eventSeq
        if (
          entry.seatStatesAfter.length !== publicSeatNumbers.size ||
          entry.seatStatesAfter.some(
            (seat, seatIndex) =>
              !publicSeatNumbers.has(seat.seatNumber) ||
              (seatIndex > 0 &&
                seat.seatNumber <=
                  entry.seatStatesAfter[seatIndex - 1]!.seatNumber),
          )
        )
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: '行动后座位必须与公开座位按座位号一一对应。',
            path: ['hand', 'actionTimeline', index, 'seatStatesAfter'],
          })
      })
    }
  })

export const CreateSessionResponseSchema = z.strictObject({
  snapshot: PublicSessionSnapshotSchema,
})

export const SseEventTypeSchema = z.enum([
  'snapshot',
  'sessionCreated',
  'handStarted',
  'uncalledBetReturned',
  'userRebuy',
  'aiAutoRebuy',
  'actionCommitted',
  'agentStarted',
  'agentRepairAttempted',
  'agentPaused',
  'handAborted',
  'handCompleted',
  'sessionEnded',
])

export const SseEventSchema = z
  .strictObject({
    eventId: EventIdSchema,
    sessionId: SessionIdSchema,
    eventSeq: EventSequenceSchema,
    stateVersion: StateVersionSchema,
    type: SseEventTypeSchema,
    payload: z.strictObject({ snapshot: PublicSessionSnapshotSchema }),
  })
  .superRefine((event, context) => {
    if (
      event.sessionId !== event.payload.snapshot.sessionId ||
      event.eventSeq !== event.payload.snapshot.eventSeq ||
      event.stateVersion !== event.payload.snapshot.stateVersion
    )
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'SSE 信封游标必须与快照一致。',
        path: ['payload', 'snapshot'],
      })
  })

export const CommandRequestSchema = z.strictObject({
  command: SessionCommandSchema,
})

export const CommandResponseSchema = z.strictObject({
  snapshot: PublicSessionSnapshotSchema,
})

export const SessionPathParamsSchema = z.strictObject({
  sessionId: SessionIdSchema,
})

export const SessionSnapshotResponseSchema = z.strictObject({
  snapshot: PublicSessionSnapshotSchema,
})

export const DeleteSessionRequestSchema = z.strictObject({
  confirmation: z.literal('永久删除本场'),
})

export const DeleteSessionResponseSchema = z.strictObject({
  deletedSessionId: SessionIdSchema,
  invalidatedRunCount: z.number().int().nonnegative(),
})

export const ClearDataRequestSchema = z.strictObject({
  confirmation: z.literal('永久清空全部数据'),
})

export const ClearDataResponseSchema = z.strictObject({
  deletedSessionCount: z.number().int().nonnegative(),
  invalidatedRunCount: z.number().int().nonnegative(),
})

export const FieldErrorSchema = z.strictObject({
  path: z.array(z.string()),
  message: z.string().min(1),
})

export const ErrorResponseSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  fieldErrors: z.array(FieldErrorSchema).optional(),
  latestSnapshot: PublicSessionSnapshotSchema.optional(),
})

export type Card = z.infer<typeof CardSchema>
export type AiSeatNumber = z.infer<typeof AiSeatNumberSchema>
export type AgentPersonaStyle = z.infer<typeof AgentPersonaStyleSchema>
export type AgentPersonaSummary = z.infer<typeof AgentPersonaSummarySchema>
export type SessionPersonaSelection = z.infer<
  typeof SessionPersonaSelectionSchema
>
export type CreateSessionPersonaSelection = z.infer<
  typeof CreateSessionPersonaSelectionSchema
>
export type CreateSessionRosterSource = z.infer<
  typeof CreateSessionRosterSourceSchema
>
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>
export type PokerAction = z.infer<typeof PokerActionSchema>
export type SuggestedTarget = z.infer<typeof SuggestedTargetSchema>
export type LegalAction = z.infer<typeof LegalActionSchema>
export type LegalActions = z.infer<typeof LegalActionsSchema>
export type ProviderId = z.infer<typeof ProviderIdSchema>
export type ProviderCheckStatus = z.infer<typeof ProviderCheckStatusSchema>
export type ProviderPublicErrorCode = z.infer<
  typeof ProviderPublicErrorCodeSchema
>
export type ProviderHealthSummary = z.infer<typeof ProviderHealthSummarySchema>
export type ProviderSettingsResponse = z.infer<
  typeof ProviderSettingsResponseSchema
>
export type HealthResponse = z.infer<typeof HealthResponseSchema>
export type ProviderPathParams = z.infer<typeof ProviderPathParamsSchema>
export type ProviderCheckRequest = z.infer<typeof ProviderCheckRequestSchema>
export type PlayerAgentSettings = z.infer<typeof PlayerAgentSettingsSchema>
export type PlayerAgentSettingsPatchRequest = z.infer<
  typeof PlayerAgentSettingsPatchRequestSchema
>
export type PlayerAgentSettingsResponse = z.infer<
  typeof PlayerAgentSettingsResponseSchema
>
export type AgentPersonaPathParams = z.infer<
  typeof AgentPersonaPathParamsSchema
>
export type AgentPersonaListResponse = z.infer<
  typeof AgentPersonaListResponseSchema
>
export type AgentPersonaDetailResponse = z.infer<
  typeof AgentPersonaDetailResponseSchema
>
export type SessionCommand = z.infer<typeof SessionCommandSchema>
export type PublicSeat = z.infer<typeof PublicSeatSchema>
export type PublicActionTimelineEntry = z.infer<
  typeof PublicActionTimelineEntrySchema
>
export type PublicCompletedHandSummary = z.infer<
  typeof PublicCompletedHandSummarySchema
>
export type PublicHandEvaluation = z.infer<typeof PublicHandEvaluationSchema>
export type PublicRevealedHand = z.infer<typeof PublicRevealedHandSchema>
export type PublicSettledPot = z.infer<typeof PublicSettledPotSchema>
export type HandHistoryView = z.infer<typeof HandHistoryViewSchema>
export type HandHistoryPathParams = z.infer<typeof HandHistoryPathParamsSchema>
export type HandHistoryQuery = z.infer<typeof HandHistoryQuerySchema>
export type HandHistoryListSort = z.infer<typeof HandHistoryListSortSchema>
export type HandHistoryListResult = z.infer<typeof HandHistoryListResultSchema>
export type HandHistoryListQuery = z.infer<typeof HandHistoryListQuerySchema>
export type HistoricalPersonaSnapshotSummary = z.infer<
  typeof HistoricalPersonaSnapshotSummarySchema
>
export type HandHistoryListItem = z.infer<typeof HandHistoryListItemSchema>
export type HandHistoryListResponse = z.infer<
  typeof HandHistoryListResponseSchema
>
export type SessionManagementListQuery = z.infer<
  typeof SessionManagementListQuerySchema
>
export type SessionManagementRosterEntry = z.infer<
  typeof SessionManagementRosterEntrySchema
>
export type SessionManagementItem = z.infer<typeof SessionManagementItemSchema>
export type SessionManagementListResponse = z.infer<
  typeof SessionManagementListResponseSchema
>
export type AgentCallListQuery = z.infer<typeof AgentCallListQuerySchema>
export type AgentRunSummary = z.infer<typeof AgentRunSummarySchema>
export type AgentCallHandSummary = z.infer<typeof AgentCallHandSummarySchema>
export type HandAgentCallsResponse = z.infer<
  typeof HandAgentCallsResponseSchema
>
export type AgentRunDecision = z.infer<typeof AgentRunDecisionSchema>
export type AgentRunDetailResponse = z.infer<
  typeof AgentRunDetailResponseSchema
>
export type AgentAttemptSummary = z.infer<typeof AgentAttemptSummarySchema>
export type AgentCapabilityInvocationSummary = z.infer<
  typeof AgentCapabilityInvocationSummarySchema
>
export type AgentRunAttemptsResponse = z.infer<
  typeof AgentRunAttemptsResponseSchema
>
export type AgentRunCapabilityInvocationsResponse = z.infer<
  typeof AgentRunCapabilityInvocationsResponseSchema
>
export type StatisticsScope = z.infer<typeof StatisticsScopeSchema>
export type StatisticsSubject = z.infer<typeof StatisticsSubjectSchema>
export type StatisticsGroupBy = z.infer<typeof StatisticsGroupBySchema>
export type HandStatisticsQuery = z.infer<typeof HandStatisticsQuerySchema>
export type SessionStatisticsQuery = z.infer<
  typeof SessionStatisticsQuerySchema
>
export type StatisticsQuery = z.infer<typeof StatisticsQuerySchema>
export type StatisticsRate = z.infer<typeof StatisticsRateSchema>
export type HandStatisticsMetrics = z.infer<typeof HandStatisticsMetricsSchema>
export type HandStatisticsResponse = z.infer<
  typeof HandStatisticsResponseSchema
>
export type SessionStatisticsTotals = z.infer<
  typeof SessionStatisticsTotalsSchema
>
export type SessionStatisticsResponse = z.infer<
  typeof SessionStatisticsResponseSchema
>
export type StatisticsResponse = z.infer<typeof StatisticsResponseSchema>
export type HandHistoryParticipant = z.infer<
  typeof HandHistoryParticipantSchema
>
export type HandHistoryAction = z.infer<typeof HandHistoryActionSchema>
export type HandHistoryUncalledBetReturn = z.infer<
  typeof HandHistoryUncalledBetReturnSchema
>
export type HandHistoryResultPhase = z.infer<
  typeof HandHistoryResultPhaseSchema
>
export type HandHistoryResponse = z.infer<typeof HandHistoryResponseSchema>
export type PublicHandSnapshot = z.infer<typeof PublicHandSnapshotSchema>
export type PublicSessionSnapshot = z.infer<typeof PublicSessionSnapshotSchema>
export type SseEvent = z.infer<typeof SseEventSchema>
export type CommandRequest = z.infer<typeof CommandRequestSchema>
export type CommandResponse = z.infer<typeof CommandResponseSchema>
export type SessionPathParams = z.infer<typeof SessionPathParamsSchema>
export type SessionSnapshotResponse = z.infer<
  typeof SessionSnapshotResponseSchema
>
export type DeleteSessionRequest = z.infer<typeof DeleteSessionRequestSchema>
export type DeleteSessionResponse = z.infer<typeof DeleteSessionResponseSchema>
export type ClearDataRequest = z.infer<typeof ClearDataRequestSchema>
export type ClearDataResponse = z.infer<typeof ClearDataResponseSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>

/** HTTP 分页输入；游标内容只由服务端解释。 */
export const OpaquePageCursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/)
export const HandHistoryPageRequestSchema = z.strictObject({
  query: HandHistoryListQuerySchema,
  cursor: OpaquePageCursorSchema.nullable(),
})
export const SessionManagementPageRequestSchema = z.strictObject({
  query: SessionManagementListQuerySchema,
  cursor: OpaquePageCursorSchema.nullable(),
})
export const AgentCallPageRequestSchema = z.strictObject({
  query: AgentCallListQuerySchema,
  cursor: OpaquePageCursorSchema.nullable(),
})
export type HandHistoryPageRequest = z.infer<
  typeof HandHistoryPageRequestSchema
>
export type SessionManagementPageRequest = z.infer<
  typeof SessionManagementPageRequestSchema
>
export type AgentCallPageRequest = z.infer<typeof AgentCallPageRequestSchema>

export const CurrentPlayerRunSchema = z.strictObject({
  runId: z.uuid(),
  decisionRequestId: z.uuid(),
  participantId: PlayerIdSchema,
  actorSeatNumber: AiSeatNumberSchema,
  sourceStateVersion: StateVersionSchema,
  trigger: z.enum([
    'initial',
    'manualRetry',
    'staleReplacement',
    'processRestart',
  ]),
  parentRunId: z.uuid().nullable(),
})

export const SessionAiStatusResponseSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    stateVersion: StateVersionSchema,
    eventSeq: EventSequenceSchema,
    lifecycleStatus: z.enum(['active', 'ended']),
    handId: HandIdSchema.nullable(),
    personas: z
      .array(
        z.strictObject({
          participantId: PlayerIdSchema,
          seatNumber: AiSeatNumberSchema,
          personaId: HistoricalPersonaIdSchema,
          personaVersion: HistoricalPersonaVersionSchema,
          configSnapshotKey: HistoricalConfigSnapshotKeySchema,
          displayName: z.string().min(1),
          avatarColor: z.string().min(1),
          backgroundDescription: z.string().min(1),
          teachingSummary: z.string().min(1),
          style: AgentPersonaStyleSchema,
        }),
      )
      .min(5)
      .max(8),
    coordination: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('idle') }),
      z.strictObject({
        state: z.literal('thinking'),
        run: CurrentPlayerRunSchema,
      }),
      z.strictObject({
        state: z.literal('paused'),
        run: CurrentPlayerRunSchema,
        reasonCode: AgentAuditPublicCodeSchema,
      }),
    ]),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.personas.map((p) => p.participantId)).size !==
        value.personas.length ||
      value.personas.some(
        (p, i) => i > 0 && p.seatNumber <= value.personas[i - 1]!.seatNumber,
      )
    ) {
      context.addIssue({
        code: 'custom',
        path: ['personas'],
        message: '人物必须按唯一座位升序排列。',
      })
    }
    if (value.coordination.state !== 'idle') {
      const run = value.coordination.run
      if (
        value.lifecycleStatus !== 'active' ||
        value.handId === null ||
        run.sourceStateVersion !== value.stateVersion ||
        !value.personas.some(
          (p) =>
            p.participantId === run.participantId &&
            p.seatNumber === run.actorSeatNumber,
        )
      ) {
        context.addIssue({
          code: 'custom',
          path: ['coordination'],
          message: '当前请求必须与场次和人物一致。',
        })
      }
    }
  })
export type SessionAiStatusResponse = z.infer<
  typeof SessionAiStatusResponseSchema
>
export type CurrentPlayerRun = z.infer<typeof CurrentPlayerRunSchema>

// M8.1: public Coach contracts. Private candidates and hand comparison tuples
// belong exclusively to the server; every object below is a closed projection.
export const COACH_NUMERIC_TOLERANCE = 1e-6
export const CoachReviewIdSchema = z.uuid()
export const CoachReviewRequestIdSchema = z.uuid()
export const CoachStreetSchema = z.enum(['preflop', 'flop', 'turn', 'river'])
export const CoachDecisionIdSchema = z.string().refine((value) => {
  const [hand, street, sequence, extra] = value.split(':')
  return (
    extra === undefined &&
    HandIdSchema.safeParse(hand).success &&
    CoachStreetSchema.safeParse(street).success &&
    /^(0|[1-9][0-9]*)$/.test(sequence ?? '') &&
    Number.isSafeInteger(Number(sequence))
  )
}, 'Invalid authoritative decision identity')
const CoachInteger = z.number().int().nonnegative().safe()
const CoachVersion = z.number().int().positive().safe()
const CoachRef = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/)
const CoachText = z.string().trim().min(1).max(2000)
const CoachLesson = z.string().trim().min(1).max(500)
export const CoachReasonCodeSchema = z.enum([
  'noComparableEv',
  'noOpponents',
  'uncoveredScenario',
  'emptyRange',
  'unmodeledAction',
  'futureActionsUnmodeled',
  'noAlternativeScenarios',
  'noContestablePot',
  'noLegalJointStates',
  'insufficientAcceptedSamples',
  'noLegalCall',
  'noDecisions',
  'insufficientEvidence',
  'noDataset',
  'scenarioNotCovered',
  'unsupportedVersion',
  'notApplicable',
  'missingStreetStart',
  'evUnavailable',
  'incompatibleMethods',
  'unavailable',
])
const CoachFrequency = z.number().min(0).max(1)
export const CoachExplanationSchema = z.strictObject({
  text: CoachText,
  factRefs: z.array(CoachRef).min(1),
})
export const CoachBetSizeSchema = z
  .strictObject({
    kind: z.literal('potFraction'),
    value: z.number().positive(),
    ratioKind: z.literal('targetStreetCommitmentToPotBefore'),
  })
  .nullable()
function coachUnique(values: readonly unknown[]): boolean {
  return new Set(values).size === values.length
}
export const COACH_RANGE_RANK_ORDER = Object.freeze([
  'A',
  'K',
  'Q',
  'J',
  'T',
  '9',
  '8',
  '7',
  '6',
  '5',
  '4',
  '3',
  '2',
] as const)
const coachHandClasses = new Set(
  COACH_RANGE_RANK_ORDER.flatMap((a, i) =>
    COACH_RANGE_RANK_ORDER.map((b, j) =>
      i === j ? a + b : i < j ? a + b + 's' : b + a + 'o',
    ),
  ),
)
export const CoachHandClassSchema = z
  .string()
  .refine((v) => coachHandClasses.has(v), 'Invalid canonical hand class')
export const CoachOpponentEvidenceSchema = z
  .strictObject({
    evidenceId: CoachRef,
    metric: z.enum(['vpip', 'pfr', 'threeBet', 'wtsd', 'wsd']),
    numerator: CoachInteger,
    denominator: CoachInteger,
    value: CoachFrequency.nullable(),
    filters: z.strictObject({
      tableSize: z.number().int().min(6).max(9),
      logicalPosition: PublicLogicalPositionSchema,
      opportunityType: z.enum(['vpip', 'pfr', 'threeBet', 'wtsd', 'wsd']),
      potType: z.enum(['headsUp', 'multiway']),
      personaSnapshotId: CoachRef,
    }),
    confidence: z.enum(['insufficient', 'sufficient']),
    usableForExploit: z.boolean(),
    policyVersion: CoachVersion,
    asOfEventSeq: CoachInteger,
  })
  .refine(
    (e) =>
      e.metric === e.filters.opportunityType &&
      e.numerator <= e.denominator &&
      (e.denominator === 0
        ? e.value === null &&
          !e.usableForExploit &&
          e.confidence === 'insufficient'
        : e.value !== null &&
          Math.abs(e.value - e.numerator / e.denominator) <=
            COACH_NUMERIC_TOLERANCE) &&
      (!e.usableForExploit || e.confidence === 'sufficient'),
    'Invalid statistical evidence',
  )
export const CoachPublicSourceRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('event'),
    sessionId: SessionIdSchema,
    handId: HandIdSchema,
    eventSeq: CoachInteger,
  }),
  z.strictObject({
    kind: z.literal('rule'),
    pokerRuleSetVersion: z.literal('nlhe-cash-6to9-10-20-v1'),
  }),
  z.strictObject({
    kind: z.literal('algorithm'),
    algorithmId: CoachRef,
    version: CoachVersion,
  }),
  z.strictObject({
    kind: z.literal('rangeModel'),
    datasetId: CoachRef,
    datasetVersion: CoachRef,
    recordId: CoachRef.nullable(),
  }),
  z.strictObject({
    kind: z.literal('statistics'),
    evidenceId: CoachRef,
    policyVersion: CoachVersion,
  }),
  z.strictObject({ kind: z.literal('fact'), factId: CoachRef }),
])
export const CoachDeviationCodeSchema = z.enum([
  'action_selection_error',
  'sizing_error',
  'range_construction_error',
  'overfold',
  'overcall',
  'missed_value',
  'unsupported_bluff',
  'stack_depth_adaptation_error',
])
export const CoachAssessmentFieldsSchema = z
  .strictObject({
    assessment: z.enum(['sound', 'questionable', 'likelyMistake', 'unrated']),
    assessmentBasis: z.enum([
      'ruleInvariant',
      'rangeModel',
      'conditionalCallEv',
      'heuristicPolicy',
      'insufficientEvidence',
    ]),
    epistemicStatus: z.enum([
      'objective',
      'modelBased',
      'heuristic',
      'unrated',
    ]),
    conditionalConclusion: z.enum([
      'favorableAcrossModeledRanges',
      'unfavorableAcrossModeledRanges',
      'rangeSensitive',
      'insufficientEvidence',
    ]),
    conditionalConclusionPolicyVersion: CoachVersion,
    primaryDeviationCode: CoachDeviationCodeSchema.nullable(),
    observedDeviationTags: z.array(
      z.strictObject({
        code: CoachDeviationCodeSchema,
        evidenceRefs: z.array(CoachRef).min(1),
      }),
    ),
    mistakeTaxonomyVersion: z.literal(1),
    teachingHypotheses: z.array(
      z.strictObject({
        explanation: CoachText,
        evidenceRefs: z.array(CoachRef).min(1),
      }),
    ),
    severity: z.enum(['low', 'medium', 'high', 'unavailable']),
    severityBasis: z.enum(['rulePolicy', 'unavailable']),
    severityPolicyVersion: CoachVersion,
    evidenceRefs: z.array(CoachRef),
  })
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    if ((v.severity === 'unavailable') !== (v.severityBasis === 'unavailable'))
      fail('Severity basis mismatch')
    if (v.severityBasis === 'rulePolicy' && v.evidenceRefs.length === 0)
      fail('Rule evidence required')
    if (
      v.assessment === 'likelyMistake' &&
      [
        'rangeModel',
        'conditionalCallEv',
        'heuristicPolicy',
        'insufficientEvidence',
      ].includes(v.assessmentBasis)
    )
      fail('Objective evidence required')
    if (
      !coachUnique(v.observedDeviationTags.map((t) => t.code)) ||
      (v.primaryDeviationCode !== null &&
        !v.observedDeviationTags.some((t) => t.code === v.primaryDeviationCode))
    )
      fail('Deviation evidence mismatch')
    if (
      (v.assessment === 'unrated') !==
        (v.assessmentBasis === 'insufficientEvidence') ||
      (v.assessment === 'unrated') !== (v.epistemicStatus === 'unrated')
    )
      fail('Unrated evidence mismatch')
  })
const CoachRationalSchema = z.strictObject({
  numerator: z.number().int().safe(),
  denominator: CoachVersion,
})
export const CoachLegalActionSchema = z
  .strictObject({
    action: PokerActionTypeSchema,
    minimumTarget: CoachInteger.nullable(),
    maximumTarget: CoachInteger.nullable(),
  })
  .refine(
    (v) =>
      (v.minimumTarget === null) === (v.maximumTarget === null) &&
      (v.minimumTarget === null || v.minimumTarget <= v.maximumTarget!),
  )
export const CoachSeatStateSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  logicalPosition: PublicLogicalPositionSchema,
  stack: CoachInteger,
  streetCommitment: CoachInteger,
  totalCommitment: CoachInteger,
  status: z.enum(['active', 'folded', 'allIn', 'out']),
})
export const CoachPublicActionFactSchema = z.strictObject({
  eventSeq: CoachInteger,
  street: CoachStreetSchema,
  seatNumber: SeatNumberSchema,
  action: PokerActionSchema,
})
// Values have named semantics, never generic numeric bags or encoded private results.
const CoachPublicValueSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('decisionIdentity'),
    tableSize: z.number().int().min(6).max(9),
    heroSeat: SeatNumberSchema,
    positions: z.array(
      z.strictObject({
        seatNumber: SeatNumberSchema,
        logicalPosition: PublicLogicalPositionSchema,
      }),
    ),
    actionOrder: z.array(SeatNumberSchema),
  }),
  z.strictObject({
    kind: z.literal('legalActions'),
    actions: z.array(CoachLegalActionSchema),
  }),
  z.strictObject({
    kind: z.literal('actualAction'),
    action: PokerActionSchema,
  }),
  z.strictObject({
    kind: z.literal('stacks'),
    seats: z.array(CoachSeatStateSchema),
  }),
  z.strictObject({
    kind: z.literal('chips'),
    metric: z.enum([
      'nominalSmallBlind',
      'nominalBigBlind',
      'actualSmallBlind',
      'actualBigBlind',
      'effectiveStack',
      'totalPot',
      'contestablePot',
      'callCost',
      'minimumTarget',
      'maximumTarget',
    ]),
    seatNumber: SeatNumberSchema.nullable(),
    value: CoachInteger,
  }),
  z.strictObject({
    kind: z.literal('ratio'),
    metric: z.enum([
      'potOdds',
      'currentSpr',
      'streetStartSpr',
      'targetStreetCommitmentToPotBefore',
    ]),
    value: CoachRationalSchema.refine((v) => v.numerator >= 0),
  }),
  z.strictObject({
    kind: z.literal('bigBlinds'),
    metric: z.enum(['effectiveStack', 'pot', 'callCost']),
    value: z.number().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('count'),
    metric: z.enum(['activePlayers', 'opportunities', 'samples']),
    value: CoachInteger,
  }),
  z.strictObject({
    kind: z.literal('boolean'),
    metric: z.enum(['inPosition', 'hasFlushDraw', 'hasStraightDraw']),
    value: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('cards'),
    metric: z.enum(['heroHoleCards', 'board', 'actualRunout']),
    cards: z.array(CardSchema).max(5),
  }),
  z.strictObject({
    kind: z.literal('handClass'),
    handClass: CoachHandClassSchema,
  }),
  z.strictObject({
    kind: z.literal('handCategory'),
    seatNumber: SeatNumberSchema,
    category: PublicHandCategorySchema,
    description: CoachText,
  }),
  z.strictObject({ kind: z.literal('teachingConclusion'), text: CoachText }),
  z.strictObject({
    kind: z.literal('opponentRangeAnalysis'),
    opponentRangeAnalysis: OpponentRangeAnalysisSchema,
  }),
  z.strictObject({
    kind: z.literal('jointEquityAnalysis'),
    jointEquityAnalysis: JointEquityAnalysisSchema,
  }),
  z.strictObject({
    kind: z.literal('conditionalCallEv'),
    conditionalCallEv: ConditionalCallEvSchema,
  }),
  z.strictObject({
    kind: z.literal('rangeSensitivity'),
    rangeSensitivity: RangeSensitivitySchema,
  }),
  z.strictObject({
    kind: z.literal('opponentEvidence'),
    evidence: CoachOpponentEvidenceSchema,
  }),
  z.strictObject({
    kind: z.literal('assessment'),
    assessment: CoachAssessmentFieldsSchema,
  }),
  z.strictObject({
    kind: z.literal('potAward'),
    potId: CoachRef,
    eligibleSeats: z.array(SeatNumberSchema).min(1),
    winnerSeats: z.array(SeatNumberSchema).min(1),
    awards: z
      .array(
        z.strictObject({ seatNumber: SeatNumberSchema, chips: CoachInteger }),
      )
      .min(1),
  }),
  z.strictObject({
    kind: z.literal('uncalledReturn'),
    seatNumber: SeatNumberSchema,
    chips: CoachInteger,
  }),
  z.strictObject({
    kind: z.literal('heroNetChips'),
    value: z.number().int().safe(),
  }),
  z.strictObject({
    kind: z.literal('actualContinuation'),
    actions: z.array(CoachPublicActionFactSchema),
  }),
])
const coachFactShape = {
  factId: CoachRef,
  scope: z.enum(['decision', 'hindsight']),
  epistemicKind: z.enum([
    'ruleFact',
    'formulaFact',
    'rangeAssumption',
    'statisticalEvidence',
    'heuristicJudgment',
    'modelGeneratedText',
  ]),
  sourceRefs: z.array(CoachPublicSourceRefSchema).min(1),
  schemaVersion: z.literal(1),
  algorithmVersion: CoachRef.nullable(),
  dataVersion: CoachRef.nullable(),
  asOfEventSeq: CoachInteger,
  assumptions: z.array(CoachText),
}
export const CoachPublicFactSchema = z
  .discriminatedUnion('status', [
    z.strictObject({
      ...coachFactShape,
      status: z.literal('available'),
      value: CoachPublicValueSchema,
    }),
    z.strictObject({
      ...coachFactShape,
      status: z.enum(['unavailable', 'notApplicable']),
      kind: z.enum([
        'decisionIdentity',
        'legalActions',
        'actualAction',
        'stacks',
        'chips',
        'ratio',
        'bigBlinds',
        'count',
        'boolean',
        'cards',
        'handClass',
        'handCategory',
        'teachingConclusion',
        'opponentRangeAnalysis',
        'jointEquityAnalysis',
        'conditionalCallEv',
        'rangeSensitivity',
        'opponentEvidence',
        'assessment',
        'potAward',
        'uncalledReturn',
        'heroNetChips',
        'actualContinuation',
      ]),
      reasonCode: CoachReasonCodeSchema,
    }),
  ])
  .refine(
    (f) =>
      f.status !== 'available' ||
      !(
        [
          'potAward',
          'uncalledReturn',
          'heroNetChips',
          'actualContinuation',
        ].includes(f.value.kind) ||
        (f.value.kind === 'cards' && f.value.metric === 'actualRunout')
      ) ||
      f.scope === 'hindsight',
    'Future fact requires hindsight scope',
  )
export const CoachDecisionReviewSchema = z
  .strictObject({
    ...CoachAssessmentFieldsSchema.shape,
    decisionId: CoachDecisionIdSchema,
    street: CoachStreetSchema,
    boardContext: z.strictObject({
      cards: z.array(CardSchema).max(5),
      factRefs: z.array(CoachRef).min(1),
    }),
    actualAction: PokerActionSchema,
    factManifest: z.array(CoachPublicFactSchema),
    jointEquityAnalysis: JointEquityAnalysisSchema,
    conditionalCallEv: ConditionalCallEvSchema,
    rangeSensitivity: RangeSensitivitySchema,
    rangeLayer: z.strictObject({
      opponentRangeAnalysis: OpponentRangeAnalysisSchema,
      explanation: CoachExplanationSchema,
      rangeChartIds: z.array(CoachRef),
    }),
    situationLayer: z.strictObject({
      factRefs: z.array(CoachRef),
      explanation: CoachExplanationSchema,
    }),
    exploitLayer: z.strictObject({
      status: z.enum(['evidenceSupported', 'insufficientEvidence']),
      evidence: z.array(CoachOpponentEvidenceSchema),
      explanation: CoachExplanationSchema,
      deviationExplanation: CoachExplanationSchema.nullable(),
    }),
    alternatives: z.array(CoachExplanationSchema),
    hindsightExplanation: CoachExplanationSchema,
  })
  .superRefine((v, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const assessment = CoachAssessmentFieldsSchema.safeParse(
      Object.fromEntries(
        Object.keys(CoachAssessmentFieldsSchema.shape).map((k) => [
          k,
          v[k as keyof typeof v],
        ]),
      ),
    )
    if (!assessment.success)
      for (const issue of assessment.error.issues) ctx.addIssue({ ...issue })
    const [hand, street, seq] = v.decisionId.split(':')
    if (
      street !== v.street ||
      v.boardContext.cards.length !==
        { preflop: 0, flop: 3, turn: 4, river: 5 }[v.street]
    )
      fail('Decision board identity mismatch')
    if (!coachUnique(v.boardContext.cards.map((c) => c.rank + c.suit)))
      fail('Duplicate cards')
    const facts = new Map(v.factManifest.map((f) => [f.factId, f]))
    if (facts.size !== v.factManifest.length) fail('Duplicate facts')
    const checkRefs = (
      refs: readonly string[],
      decisionOnly: boolean,
      deterministic = false,
    ) => {
      for (const id of refs) {
        const visited = new Set<string>()
        const visit = (ref: string): void => {
          const f = facts.get(ref)
          if (
            !f ||
            (decisionOnly && f.scope !== 'decision') ||
            (deterministic && f.epistemicKind === 'modelGeneratedText')
          ) {
            fail('Invalid fact reference')
            return
          }
          if (visited.has(ref)) {
            fail('Cyclic fact reference')
            return
          }
          visited.add(ref)
          for (const source of f.sourceRefs)
            if (source.kind === 'fact') visit(source.factId)
          visited.delete(ref)
        }
        visit(id)
      }
    }
    for (const f of v.factManifest) {
      if (f.scope === 'decision' && f.asOfEventSeq >= Number(seq))
        fail('Future decision evidence')
      for (const source of f.sourceRefs) {
        if (source.kind === 'fact') {
          checkRefs([source.factId], f.scope === 'decision')
          if (
            (facts.get(source.factId)?.asOfEventSeq ?? Infinity) >
            f.asOfEventSeq
          )
            fail('Future source reference')
        }
        if (
          source.kind === 'event' &&
          (source.handId !== hand || source.eventSeq > f.asOfEventSeq)
        )
          fail('Invalid event source')
      }
    }
    checkRefs(v.boardContext.factRefs, true, true)
    checkRefs(v.evidenceRefs, true, true)
    for (const t of [...v.observedDeviationTags, ...v.teachingHypotheses])
      checkRefs(t.evidenceRefs, true, true)
    for (const e of [
      v.rangeLayer.explanation,
      v.situationLayer.explanation,
      v.exploitLayer.explanation,
      ...v.alternatives,
      ...(v.exploitLayer.deviationExplanation
        ? [v.exploitLayer.deviationExplanation]
        : []),
    ])
      checkRefs(e.factRefs, true)
    checkRefs(v.situationLayer.factRefs, true, true)
    checkRefs(v.hindsightExplanation.factRefs, false)
    const b = v.rangeLayer.opponentRangeAnalysis
    for (const fact of v.factManifest)
      if (fact.status === 'available') {
        const value = fact.value
        if (
          value.kind === 'opponentRangeAnalysis' &&
          JSON.stringify(value.opponentRangeAnalysis) !== JSON.stringify(b)
        )
          fail('Range fact mismatch')
        if (
          value.kind === 'assessment' &&
          assessment.success &&
          JSON.stringify(value.assessment) !== JSON.stringify(assessment.data)
        )
          fail('Assessment fact mismatch')
        if (
          value.kind === 'opponentEvidence' &&
          !v.exploitLayer.evidence.some(
            (e) => JSON.stringify(e) === JSON.stringify(value.evidence),
          )
        )
          fail('Evidence fact mismatch')
        if (
          value.kind === 'cards' &&
          value.metric === 'board' &&
          JSON.stringify(value.cards) !== JSON.stringify(v.boardContext.cards)
        )
          fail('Board fact mismatch')
        if (
          value.kind === 'actualAction' &&
          JSON.stringify(value.action) !== JSON.stringify(v.actualAction)
        )
          fail('Action fact mismatch')
      }
    if (
      [b, v.jointEquityAnalysis, v.conditionalCallEv, v.rangeSensitivity].some(
        (x) => x.decisionId !== v.decisionId,
      )
    )
      fail('Range decision mismatch')
    if (v.conditionalConclusion !== 'insufficientEvidence') {
      const sensitivity = v.rangeSensitivity,
        ev = v.conditionalCallEv
      if (sensitivity.status !== 'available' || ev.status !== 'available')
        fail('Missing conclusion evidence')
      else {
        if (
          v.conditionalConclusion === 'rangeSensitive'
            ? sensitivity.signStable !== false ||
              !ev.scenarios.some((s) => s.callEvVersusFold < 0) ||
              !ev.scenarios.some((s) => s.callEvVersusFold > 0)
            : sensitivity.signStable !== true
        )
          fail('Conclusion sensitivity mismatch')
        if (
          v.conditionalConclusion === 'favorableAcrossModeledRanges' &&
          ev.scenarios.some(
            (s) => (s.confidenceInterval?.lower ?? s.callEvVersusFold) <= 0,
          )
        )
          fail('Conclusion sign mismatch')
        if (
          v.conditionalConclusion === 'unfavorableAcrossModeledRanges' &&
          ev.scenarios.some(
            (s) => (s.confidenceInterval?.upper ?? s.callEvVersusFold) >= 0,
          )
        )
          fail('Conclusion sign mismatch')
      }
    }

    if (
      v.exploitLayer.status === 'insufficientEvidence' &&
      v.exploitLayer.deviationExplanation !== null
    )
      fail('Unsupported exploit')
    if (
      v.exploitLayer.status === 'evidenceSupported' &&
      !v.exploitLayer.evidence.some((e) => e.usableForExploit)
    )
      fail('Exploit evidence required')
    if (v.exploitLayer.evidence.some((e) => e.asOfEventSeq >= Number(seq)))
      fail('Future opponent evidence')
    if (
      v.severityBasis === 'rulePolicy' &&
      !v.evidenceRefs.some((id) =>
        facts.get(id)?.sourceRefs.some((s) => s.kind === 'rule'),
      )
    )
      fail('Rule severity needs rule source')
  })
const CoachStreetCountsSchema = z.strictObject({
  street: CoachStreetSchema,
  sound: CoachInteger,
  questionable: CoachInteger,
  likelyMistake: CoachInteger,
  unrated: CoachInteger,
})
export const CoachTeachingProjectionSchema = z.strictObject({
  coreDecisionId: CoachDecisionIdSchema.nullable(),
  secondaryDecisionIds: z.array(CoachDecisionIdSchema).max(2),
  compactDecisionIds: z.array(CoachDecisionIdSchema),
  primaryLesson: CoachLesson.nullable(),
  primaryPracticeSuggestion: CoachLesson.nullable(),
  projectionPolicyVersion: CoachVersion,
})
export const CoachReviewSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    coachReviewId: CoachReviewIdSchema,
    handId: HandIdSchema,
    overview: CoachText,
    decisionPrioritySummary: z.strictObject({
      assessmentCountsByStreet: z.array(CoachStreetCountsSchema).length(4),
      severityCounts: z.strictObject({
        low: CoachInteger,
        medium: CoachInteger,
        high: CoachInteger,
        unavailable: CoachInteger,
      }),
      conditionalConclusionCounts: z.strictObject({
        favorableAcrossModeledRanges: CoachInteger,
        unfavorableAcrossModeledRanges: CoachInteger,
        rangeSensitive: CoachInteger,
        insufficientEvidence: CoachInteger,
      }),
    }),
    teachingProjection: CoachTeachingProjectionSchema,
    decisionReviews: z.array(CoachDecisionReviewSchema),
    keyLessons: z.array(CoachLesson).max(3),
    practiceSuggestions: z.array(CoachLesson).max(3),
    rangeCharts: z.array(OpponentRangeChartSpecSchema),
  })
  .superRefine((r, ctx) => {
    const fail = (message: string) => ctx.addIssue({ code: 'custom', message })
    const ids = r.decisionReviews.map((d) => d.decisionId),
      p = r.teachingProjection
    if (!coachUnique(ids) || ids.some((id) => id.split(':')[0] !== r.handId))
      fail('Invalid decision identity')
    if (
      ids.some(
        (id, i) =>
          i > 0 &&
          Number(id.split(':')[2]) <= Number(ids[i - 1]!.split(':')[2]),
      )
    )
      fail('Decision order mismatch')
    const partition = [
      ...(p.coreDecisionId ? [p.coreDecisionId] : []),
      ...p.secondaryDecisionIds,
      ...p.compactDecisionIds,
    ]
    if (
      !coachUnique(partition) ||
      partition.length !== ids.length ||
      partition.some((id) => !ids.includes(id))
    )
      fail('Invalid teaching partition')
    if (
      p.coreDecisionId === null &&
      (p.secondaryDecisionIds.length > 0 ||
        r.decisionReviews.some((d) => d.assessment !== 'unrated'))
    )
      fail('Missing core decision')
    if (
      p.coreDecisionId !== null &&
      r.decisionReviews.some((d) => d.assessment !== 'unrated') &&
      r.decisionReviews.find((d) => d.decisionId === p.coreDecisionId)
        ?.assessment === 'unrated'
    )
      fail('Unrated core with rated decisions')
    if (
      (p.primaryLesson !== null && !r.keyLessons.includes(p.primaryLesson)) ||
      (p.primaryPracticeSuggestion !== null &&
        !r.practiceSuggestions.includes(p.primaryPracticeSuggestion))
    )
      fail('Primary teaching text mismatch')
    for (const severity of ['low', 'medium', 'high', 'unavailable'] as const)
      if (
        r.decisionPrioritySummary.severityCounts[severity] !==
        r.decisionReviews.filter((d) => d.severity === severity).length
      )
        fail('Severity count mismatch')
    for (const conclusion of [
      'favorableAcrossModeledRanges',
      'unfavorableAcrossModeledRanges',
      'rangeSensitive',
      'insufficientEvidence',
    ] as const)
      if (
        r.decisionPrioritySummary.conditionalConclusionCounts[conclusion] !==
        r.decisionReviews.filter((d) => d.conditionalConclusion === conclusion)
          .length
      )
        fail('Conclusion count mismatch')
    const counts = r.decisionPrioritySummary.assessmentCountsByStreet
    if (!coachUnique(counts.map((c) => c.street)))
      fail('Duplicate street counts')
    for (const c of counts)
      for (const assessment of [
        'sound',
        'questionable',
        'likelyMistake',
        'unrated',
      ] as const)
        if (
          c[assessment] !==
          r.decisionReviews.filter(
            (d) => d.street === c.street && d.assessment === assessment,
          ).length
        )
          fail('Assessment count mismatch')
    if (!coachUnique(r.rangeCharts.map((c) => c.chartId)))
      fail('Duplicate charts')
    for (const d of r.decisionReviews) {
      const charts = r.rangeCharts.filter((c) => c.decisionId === d.decisionId)
      if (
        !coachUnique(d.rangeLayer.rangeChartIds) ||
        charts.length !== d.rangeLayer.rangeChartIds.length ||
        charts.some((c) => !d.rangeLayer.rangeChartIds.includes(c.chartId))
      )
        fail('Chart reference mismatch')
      const result = CoachRangeAnalysisSchema.safeParse({
        opponentRangeAnalysis: d.rangeLayer.opponentRangeAnalysis,
        jointEquityAnalysis: d.jointEquityAnalysis,
        conditionalCallEv: d.conditionalCallEv,
        rangeSensitivity: d.rangeSensitivity,
        rangeCharts: charts,
      })
      if (!result.success) fail('Range analysis mismatch')
    }
    if (r.rangeCharts.some((c) => !ids.includes(c.decisionId)))
      fail('Unknown chart decision')
    if (
      ids.length === 0 &&
      (r.rangeCharts.length > 0 ||
        p.primaryLesson !== null ||
        p.primaryPracticeSuggestion !== null)
    )
      fail('Invalid empty review')
  })
export const CreateCoachReviewRequestSchema = z.strictObject({
  requestId: CoachReviewRequestIdSchema,
})
const coachStateShape = {
  coachReviewId: CoachReviewIdSchema,
  handId: HandIdSchema,
  requestId: CoachReviewRequestIdSchema,
  createdAt: z.iso.datetime(),
}
export const CoachReviewRequestStateSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ ...coachStateShape, status: z.literal('pending') }),
    z.strictObject({
      ...coachStateShape,
      status: z.literal('running'),
      startedAt: z.iso.datetime(),
    }),
    z.strictObject({
      ...coachStateShape,
      status: z.literal('completed'),
      startedAt: z.iso.datetime(),
      completedAt: z.iso.datetime(),
      review: CoachReviewSchema,
    }),
    z.strictObject({
      ...coachStateShape,
      status: z.literal('failed'),
      startedAt: z.iso.datetime().nullable(),
      failedAt: z.iso.datetime(),
      failureCode: z.enum([
        'inputUnavailable',
        'unsupportedVersion',
        'providerUnavailable',
        'budgetExceeded',
        'invalidOutput',
        'interrupted',
        'internalError',
      ]),
    }),
  ])
  .superRefine((s, ctx) => {
    const start =
      'startedAt' in s && s.startedAt !== null
        ? Date.parse(s.startedAt)
        : Date.parse(s.createdAt)
    const end =
      s.status === 'completed'
        ? Date.parse(s.completedAt)
        : s.status === 'failed'
          ? Date.parse(s.failedAt)
          : start
    if (start < Date.parse(s.createdAt) || end < start)
      ctx.addIssue({ code: 'custom', message: 'Invalid request times' })
    if (
      s.status === 'completed' &&
      (s.coachReviewId !== s.review.coachReviewId ||
        s.handId !== s.review.handId)
    )
      ctx.addIssue({ code: 'custom', message: 'Report identity mismatch' })
  })
export type CoachReview = z.infer<typeof CoachReviewSchema>
export type CoachDecisionReview = z.infer<typeof CoachDecisionReviewSchema>
export type CoachPublicFact = z.infer<typeof CoachPublicFactSchema>
export type CoachReviewRequestState = z.infer<
  typeof CoachReviewRequestStateSchema
>
export type CoachDecisionId = z.infer<typeof CoachDecisionIdSchema>
export type CoachReviewId = z.infer<typeof CoachReviewIdSchema>
export type CoachReviewRequestId = z.infer<typeof CoachReviewRequestIdSchema>
