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
export const CreateSessionRosterSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('currentCatalog'),
    selections: CreateSessionPersonaSelectionSchema,
  }),
  z.strictObject({
    type: z.literal('latestEnded'),
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
    payload: z.strictObject({}),
  }),
  z.strictObject({
    ...commandBaseShape,
    type: z.literal('retryAgent'),
    payload: z.strictObject({}),
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
  personas: z.array(AgentPersonaSummarySchema),
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

export const PublicSessionSnapshotSchema = z
  .strictObject({
    sessionId: SessionIdSchema,
    stateVersion: StateVersionSchema,
    eventSeq: EventSequenceSchema,
    pokerPhase: PokerPhaseSchema,
    lifecycleStatus: SessionLifecycleSchema,
    agentRunState: AgentRunStateSchema,
    activeDecision: AgentDecisionSummarySchema.nullable(),
    seats: z.array(PublicSeatSchema).min(6).max(9),
    hand: PublicHandSnapshotSchema.nullable(),
    lastCompletedHandSummary: PublicCompletedHandSummarySchema.nullable(),
  })
  .superRefine((snapshot, context) => {
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
