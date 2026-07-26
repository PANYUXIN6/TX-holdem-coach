import { z } from 'zod'

export const PROTOCOL_VERSION = 1 as const

export const ProtocolVersionSchema = z.literal(PROTOCOL_VERSION)
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
  personaVersion: z.number().int().positive(),
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
export const PersonaSnapshotFilterSchema = z.strictObject({
  personaId: AgentPersonaIdSchema,
  personaVersion: z.number().int().positive().optional(),
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

export const LegalActionSchema = z.discriminatedUnion('type', [
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
    suggestedTargets: z.array(PositiveChipAmountSchema),
  }),
  z.strictObject({
    type: z.literal('raise'),
    minTarget: PositiveChipAmountSchema,
    maxTarget: PositiveChipAmountSchema,
    suggestedTargets: z.array(PositiveChipAmountSchema),
  }),
  z.strictObject({
    type: z.literal('allIn'),
    target: PositiveChipAmountSchema,
  }),
])

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

export const PokerPhaseSchema = z.enum(['setup', 'betweenHands', 'inHand'])
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

export const ProviderIdSchema = z.enum(['deepseek', 'kimi'])
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

const KimiProviderSettingsSchema = z
  .strictObject({
    ...providerHealthSummaryShape,
    canFallback: z.boolean(),
  })
  .superRefine((provider, context) => {
    validateProviderHealthSummary(provider, context)

    if (provider.canFallback !== provider.configured) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: '自动降级能力必须与 Kimi 配置状态一致。',
        path: ['canFallback'],
      })
    }
  })

export const ProviderSettingsResponseSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  deepSeek: DeepSeekProviderSettingsSchema,
  kimi: KimiProviderSettingsSchema,
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

export const PublicHandSnapshotSchema = z.strictObject({
  handId: HandIdSchema,
  street: HandStreetSchema,
  board: z.array(CardSchema).max(5),
  pot: ChipAmountSchema,
  currentActorSeatNumber: SeatNumberSchema.nullable(),
  heroHoleCards: z.array(CardSchema).length(2).nullable(),
  legalActions: z.array(LegalActionSchema),
})

export const PublicSessionSnapshotSchema = z
  .strictObject({
    protocolVersion: ProtocolVersionSchema,
    sessionId: SessionIdSchema,
    stateVersion: StateVersionSchema,
    eventSeq: EventSequenceSchema,
    pokerPhase: PokerPhaseSchema,
    lifecycleStatus: SessionLifecycleSchema,
    agentRunState: AgentRunStateSchema,
    activeDecision: AgentDecisionSummarySchema.nullable(),
    seats: z.array(PublicSeatSchema).min(6).max(9),
    hand: PublicHandSnapshotSchema.nullable(),
  })
  .superRefine((snapshot, context) => {
    const seatNumbers = new Set<number>()
    let userCount = 0

    snapshot.seats.forEach((seat, index) => {
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
  })

export const SseEventTypeSchema = z.enum([
  'snapshot',
  'actionCommitted',
  'agentStarted',
  'agentProviderFallback',
  'agentRepairAttempted',
  'agentPaused',
  'handAborted',
  'handCompleted',
  'sessionEnded',
])

export const SseEventSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  eventSeq: EventSequenceSchema,
  stateVersion: StateVersionSchema,
  type: SseEventTypeSchema,
  payload: z.strictObject({ snapshot: PublicSessionSnapshotSchema }),
})

export const CommandRequestSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  command: SessionCommandSchema,
})

export const CommandResponseSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  snapshot: PublicSessionSnapshotSchema,
})

export const FieldErrorSchema = z.strictObject({
  path: z.array(z.string()),
  message: z.string().min(1),
})

export const ErrorResponseSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
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
export type PersonaSnapshotFilter = z.infer<typeof PersonaSnapshotFilterSchema>
export type PokerAction = z.infer<typeof PokerActionSchema>
export type LegalAction = z.infer<typeof LegalActionSchema>
export type ProviderId = z.infer<typeof ProviderIdSchema>
export type ProviderCheckStatus = z.infer<typeof ProviderCheckStatusSchema>
export type ProviderPublicErrorCode = z.infer<
  typeof ProviderPublicErrorCodeSchema
>
export type ProviderHealthSummary = z.infer<typeof ProviderHealthSummarySchema>
export type ProviderSettingsResponse = z.infer<
  typeof ProviderSettingsResponseSchema
>
export type SessionCommand = z.infer<typeof SessionCommandSchema>
export type PublicSeat = z.infer<typeof PublicSeatSchema>
export type PublicHandSnapshot = z.infer<typeof PublicHandSnapshotSchema>
export type PublicSessionSnapshot = z.infer<typeof PublicSessionSnapshotSchema>
export type SseEvent = z.infer<typeof SseEventSchema>
export type CommandRequest = z.infer<typeof CommandRequestSchema>
export type CommandResponse = z.infer<typeof CommandResponseSchema>
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>
