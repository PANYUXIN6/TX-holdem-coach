import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { POKER_RULE_SET_VERSION } from '../../poker/poker-rule-set.js'

export const PLAYER_SESSION_MEMORY_PAYLOAD_VERSION = 1 as const
export const PLAYER_SESSION_MEMORY_MAX_BYTES = 16_384 as const
export const PLAYER_SESSION_MEMORY_MAX_OPPONENTS = 8 as const
export const PLAYER_SESSION_MEMORY_MAX_RECENT_HANDS = 5 as const

const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const SeatNumberSchema = z.number().int().min(0).max(8)
const CardSchema = z.strictObject({
  rank: z.enum([
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
  ]),
  suit: z.enum(['clubs', 'diamonds', 'hearts', 'spades']),
})

export const PlayerMemoryMetricSchema = z.enum([
  'preflopVoluntaryParticipation',
  'preflopFullRaise',
  'facingAggressionFold',
  'facingAggressionCall',
  'facingAggressionRaise',
  'currentStreetAggression',
])
export type PlayerMemoryMetric = z.infer<typeof PlayerMemoryMetricSchema>

const PlayerMemoryRateSchema = z
  .strictObject({
    metric: PlayerMemoryMetricSchema,
    numerator: SafeIntegerSchema,
    denominator: SafeIntegerSchema,
    distinctHandCount: SafeIntegerSchema,
  })
  .superRefine((value, context) => {
    if (
      value.numerator > value.denominator ||
      value.distinctHandCount > value.denominator
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Memory 统计分子、不同 Hand 数不得超过分母。',
      })
    }
  })

const OpponentMemoryV1Schema = z
  .strictObject({
    participantId: z.string().uuid(),
    seatNumber: SeatNumberSchema,
    completedHandsObserved: SafeIntegerSchema,
    showdownHandsObserved: SafeIntegerSchema,
    metrics: z.array(PlayerMemoryRateSchema).length(6),
  })
  .superRefine((opponent, context) => {
    const metricNames = opponent.metrics.map(({ metric }) => metric)
    if (
      new Set(metricNames).size !== metricNames.length ||
      opponent.showdownHandsObserved > opponent.completedHandsObserved
    ) {
      context.addIssue({
        code: 'custom',
        message: '对手 Memory 统计不一致。',
      })
    }
  })

const PublicMemoryActionFullSchema = z.strictObject({
  actorSeatNumber: SeatNumberSchema,
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  contributionDelta: SafeIntegerSchema,
})
const PublicMemoryActionCompactSchema = z.strictObject({
  actorSeatNumber: SeatNumberSchema,
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
})

const PublicCompletedHandMemoryV1Schema = z.strictObject({
  handNumber: SafeIntegerSchema.positive(),
  buttonSeatNumber: SeatNumberSchema,
  participantSeatNumbers: z.array(SeatNumberSchema).min(6).max(9),
  actions: z.array(
    z.union([PublicMemoryActionFullSchema, PublicMemoryActionCompactSchema]),
  ),
  showdown: z
    .strictObject({
      board: z.tuple([
        CardSchema,
        CardSchema,
        CardSchema,
        CardSchema,
        CardSchema,
      ]),
      revealedHands: z.array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          holeCards: z.tuple([CardSchema, CardSchema]),
        }),
      ),
    })
    .nullable(),
})

export const AgentMemoryPayloadV1Schema = z
  .strictObject({
    memorySchemaVersion: z.literal(1),
    pokerRuleSetVersion: z.literal(POKER_RULE_SET_VERSION),
    scannedThrough: z
      .strictObject({
        handNumber: SafeIntegerSchema,
        eventSeq: SafeIntegerSchema,
      })
      .nullable(),
    lastCompletedHandNumber: SafeIntegerSchema.positive().nullable(),
    sessionSummary: z.strictObject({
      completedHandsObserved: SafeIntegerSchema,
      showdownHandsObserved: SafeIntegerSchema,
    }),
    opponents: z
      .array(OpponentMemoryV1Schema)
      .max(PLAYER_SESSION_MEMORY_MAX_OPPONENTS),
    recentHands: z
      .array(PublicCompletedHandMemoryV1Schema)
      .max(PLAYER_SESSION_MEMORY_MAX_RECENT_HANDS),
    detailLevel: z.enum(['full', 'compact']),
  })
  .superRefine((memory, context) => {
    const opponentSeats = memory.opponents.map(({ seatNumber }) => seatNumber)
    const opponentIds = memory.opponents.map(
      ({ participantId }) => participantId,
    )
    const recentHandNumbers = memory.recentHands.map(
      ({ handNumber }) => handNumber,
    )
    const sorted = (values: readonly number[]) =>
      values.every(
        (value, index) => index === 0 || value > (values[index - 1] ?? -1),
      )
    if (
      !sorted(opponentSeats) ||
      new Set(opponentIds).size !== opponentIds.length ||
      !sorted(recentHandNumbers) ||
      memory.sessionSummary.showdownHandsObserved >
        memory.sessionSummary.completedHandsObserved ||
      (memory.lastCompletedHandNumber !== null &&
        memory.lastCompletedHandNumber >
          (memory.scannedThrough?.handNumber ?? 0)) ||
      (memory.scannedThrough === null &&
        (memory.lastCompletedHandNumber !== null ||
          memory.sessionSummary.completedHandsObserved !== 0 ||
          memory.sessionSummary.showdownHandsObserved !== 0 ||
          memory.opponents.length !== 0 ||
          memory.recentHands.length !== 0))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Memory 游标、排序或汇总统计不一致。',
      })
    }
    if (
      memory.detailLevel === 'full' &&
      memory.recentHands.some((hand) =>
        hand.actions.some((action) => !('contributionDelta' in action)),
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: 'full Memory 的公开行动必须保留投入金额。',
      })
    }
  })

export type AgentMemoryPayloadV1 = Readonly<
  z.infer<typeof AgentMemoryPayloadV1Schema>
>

export class PlayerSessionMemoryError extends Error {
  public constructor(
    public readonly code:
      | 'invalidPayload'
      | 'unsupportedPayloadVersion'
      | 'invalidLifecycle'
      | 'sizeExceeded',
  ) {
    super(`Player Session Memory 无效：${code}`)
    this.name = 'PlayerSessionMemoryError'
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

const MEMORY_METRICS = Object.freeze([
  'preflopVoluntaryParticipation',
  'preflopFullRaise',
  'facingAggressionFold',
  'facingAggressionCall',
  'facingAggressionRaise',
  'currentStreetAggression',
] as const satisfies readonly PlayerMemoryMetric[])

function emptyRates(): z.infer<typeof PlayerMemoryRateSchema>[] {
  return MEMORY_METRICS.map((metric) => ({
    metric,
    numerator: 0,
    denominator: 0,
    distinctHandCount: 0,
  }))
}

export const PLAYER_EMPTY_SESSION_MEMORY_V1: AgentMemoryPayloadV1 = deepFreeze(
  AgentMemoryPayloadV1Schema.parse({
    memorySchemaVersion: PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    scannedThrough: null,
    lastCompletedHandNumber: null,
    sessionSummary: {
      completedHandsObserved: 0,
      showdownHandsObserved: 0,
    },
    opponents: [],
    recentHands: [],
    detailLevel: 'full',
  }),
)

export function decodePlayerSessionMemoryV1(
  value: unknown,
): AgentMemoryPayloadV1 {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'memorySchemaVersion' in value &&
    (value as { readonly memorySchemaVersion?: unknown })
      .memorySchemaVersion !== 1
  ) {
    throw new PlayerSessionMemoryError('unsupportedPayloadVersion')
  }
  const parsed = AgentMemoryPayloadV1Schema.safeParse(value)
  if (!parsed.success) throw new PlayerSessionMemoryError('invalidPayload')
  return deepFreeze(parsed.data)
}

export function hashPlayerSessionMemoryV1(memory: unknown): string {
  return createHash('sha256')
    .update(
      canonicalJson(decodePlayerSessionMemoryV1(memory) as JsonValue),
      'utf8',
    )
    .digest('hex')
}

export const PlayerMemoryLifecycleFactSchema = z.discriminatedUnion('status', [
  z.strictObject({
    handNumber: SafeIntegerSchema.positive(),
    terminalEventSeq: SafeIntegerSchema,
    status: z.literal('aborted'),
  }),
  z.strictObject({
    handNumber: SafeIntegerSchema.positive(),
    terminalEventSeq: SafeIntegerSchema,
    status: z.literal('completed'),
    buttonSeatNumber: SeatNumberSchema,
    participants: z
      .array(
        z.strictObject({
          participantId: z.string().uuid(),
          seatNumber: SeatNumberSchema,
        }),
      )
      .min(6)
      .max(9),
    actions: z.array(
      z.strictObject({
        eventSeq: SafeIntegerSchema,
        actorSeatNumber: SeatNumberSchema,
        actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
        contributionDelta: SafeIntegerSchema,
        isVoluntaryPreflopContribution: z.boolean(),
        isFullRaise: z.boolean(),
        facedAggression: z.boolean().default(false),
      }),
    ),
    showdown: z
      .strictObject({
        board: z.tuple([
          CardSchema,
          CardSchema,
          CardSchema,
          CardSchema,
          CardSchema,
        ]),
        revealedHands: z.array(
          z.strictObject({
            seatNumber: SeatNumberSchema,
            holeCards: z.tuple([CardSchema, CardSchema]),
          }),
        ),
      })
      .nullable(),
  }),
])
export type PlayerMemoryLifecycleFact = z.infer<
  typeof PlayerMemoryLifecycleFactSchema
>

const FoldInputSchema = z.strictObject({
  memory: AgentMemoryPayloadV1Schema,
  actorParticipantId: z.string().uuid(),
  cutoff: z.strictObject({
    handNumber: SafeIntegerSchema.positive(),
    eventSeq: SafeIntegerSchema,
  }),
  hands: z.array(PlayerMemoryLifecycleFactSchema),
})

function assertContiguousLifecycle(
  input: z.infer<typeof FoldInputSchema>,
): void {
  const start = (input.memory.scannedThrough?.handNumber ?? 0) + 1
  const end = input.cutoff.handNumber - 1
  const expectedCount = Math.max(0, end - start + 1)
  if (
    input.hands.length !== expectedCount ||
    input.hands.some(
      (hand, index) =>
        hand.handNumber !== start + index ||
        hand.terminalEventSeq > input.cutoff.eventSeq ||
        (index > 0 &&
          hand.terminalEventSeq <=
            (input.hands[index - 1]?.terminalEventSeq ?? -1)),
    )
  ) {
    throw new PlayerSessionMemoryError('invalidLifecycle')
  }
}

function addOpportunity(
  rates: z.infer<typeof PlayerMemoryRateSchema>[],
  metric: PlayerMemoryMetric,
  observed: boolean,
  positive: boolean,
): void {
  const target = rates.find((rate) => rate.metric === metric)
  if (target === undefined || !observed) return
  target.denominator += 1
  target.distinctHandCount += 1
  if (positive) target.numerator += 1
}

function updateOpponent(
  opponents: z.infer<typeof OpponentMemoryV1Schema>[],
  participant: { readonly participantId: string; readonly seatNumber: number },
  hand: Extract<PlayerMemoryLifecycleFact, { readonly status: 'completed' }>,
): void {
  let target = opponents.find(
    (opponent) => opponent.participantId === participant.participantId,
  )
  if (target === undefined) {
    target = {
      participantId: participant.participantId,
      seatNumber: participant.seatNumber,
      completedHandsObserved: 0,
      showdownHandsObserved: 0,
      metrics: emptyRates(),
    }
    opponents.push(target)
  }
  if (target.seatNumber !== participant.seatNumber) {
    throw new PlayerSessionMemoryError('invalidLifecycle')
  }
  target.completedHandsObserved += 1
  if (hand.showdown !== null) target.showdownHandsObserved += 1
  const actions = hand.actions.filter(
    (action) => action.actorSeatNumber === participant.seatNumber,
  )
  addOpportunity(
    target.metrics,
    'preflopVoluntaryParticipation',
    true,
    actions.some(
      ({ isVoluntaryPreflopContribution }) => isVoluntaryPreflopContribution,
    ),
  )
  addOpportunity(
    target.metrics,
    'preflopFullRaise',
    true,
    actions.some(({ isFullRaise }) => isFullRaise),
  )
  const facing = actions.find(({ facedAggression }) => facedAggression)
  addOpportunity(
    target.metrics,
    'facingAggressionFold',
    facing !== undefined,
    facing?.actionType === 'fold',
  )
  addOpportunity(
    target.metrics,
    'facingAggressionCall',
    facing !== undefined,
    facing?.actionType === 'call',
  )
  addOpportunity(
    target.metrics,
    'facingAggressionRaise',
    facing !== undefined,
    facing?.actionType === 'raise' || facing?.actionType === 'allIn',
  )
  addOpportunity(
    target.metrics,
    'currentStreetAggression',
    actions.length > 0,
    actions.some(
      ({ actionType }) =>
        actionType === 'bet' ||
        actionType === 'raise' ||
        actionType === 'allIn',
    ),
  )
}

function fullHandSummary(
  hand: Extract<PlayerMemoryLifecycleFact, { readonly status: 'completed' }>,
): z.infer<typeof PublicCompletedHandMemoryV1Schema> {
  return {
    handNumber: hand.handNumber,
    buttonSeatNumber: hand.buttonSeatNumber,
    participantSeatNumbers: hand.participants
      .map(({ seatNumber }) => seatNumber)
      .sort((left, right) => left - right),
    actions: hand.actions.map(
      ({ actorSeatNumber, actionType, contributionDelta }) => ({
        actorSeatNumber,
        actionType,
        contributionDelta,
      }),
    ),
    showdown: hand.showdown,
  }
}

function compactMemory(memory: AgentMemoryPayloadV1): AgentMemoryPayloadV1 {
  return decodePlayerSessionMemoryV1({
    ...memory,
    detailLevel: 'compact',
    recentHands: memory.recentHands.map((hand) => ({
      ...hand,
      actions: hand.actions.map(({ actorSeatNumber, actionType }) => ({
        actorSeatNumber,
        actionType,
      })),
    })),
  })
}

function enforceSize(memory: AgentMemoryPayloadV1): AgentMemoryPayloadV1 {
  if (
    Buffer.byteLength(canonicalJson(memory as JsonValue), 'utf8') <=
    PLAYER_SESSION_MEMORY_MAX_BYTES
  ) {
    return memory
  }
  const compact = compactMemory(memory)
  if (
    Buffer.byteLength(canonicalJson(compact as JsonValue), 'utf8') <=
    PLAYER_SESSION_MEMORY_MAX_BYTES
  ) {
    return compact
  }
  throw new PlayerSessionMemoryError('sizeExceeded')
}

export function foldPlayerSessionMemoryV1(input: {
  readonly memory: AgentMemoryPayloadV1
  readonly actorParticipantId: string
  readonly cutoff: { readonly handNumber: number; readonly eventSeq: number }
  readonly hands: readonly PlayerMemoryLifecycleFact[]
}): AgentMemoryPayloadV1 {
  const parsed = FoldInputSchema.safeParse(input)
  if (!parsed.success) throw new PlayerSessionMemoryError('invalidPayload')
  assertContiguousLifecycle(parsed.data)
  if (parsed.data.hands.length === 0)
    return decodePlayerSessionMemoryV1(parsed.data.memory)

  const opponents = parsed.data.memory.opponents.map((opponent) => ({
    ...opponent,
    metrics: opponent.metrics.map((metric) => ({ ...metric })),
  }))
  const recentHands = [...parsed.data.memory.recentHands]
  let lastCompletedHandNumber = parsed.data.memory.lastCompletedHandNumber
  let completedHandsObserved =
    parsed.data.memory.sessionSummary.completedHandsObserved
  let showdownHandsObserved =
    parsed.data.memory.sessionSummary.showdownHandsObserved

  for (const hand of parsed.data.hands) {
    if (hand.status === 'aborted') continue
    const participants = [...hand.participants].sort(
      (left, right) => left.seatNumber - right.seatNumber,
    )
    if (
      new Set(participants.map(({ participantId }) => participantId)).size !==
        participants.length ||
      new Set(participants.map(({ seatNumber }) => seatNumber)).size !==
        participants.length ||
      !participants.some(
        ({ participantId }) => participantId === parsed.data.actorParticipantId,
      ) ||
      hand.actions.some(
        (action, index) =>
          !participants.some(
            ({ seatNumber }) => seatNumber === action.actorSeatNumber,
          ) ||
          action.eventSeq > hand.terminalEventSeq ||
          (index > 0 &&
            action.eventSeq <= (hand.actions[index - 1]?.eventSeq ?? -1)),
      )
    ) {
      throw new PlayerSessionMemoryError('invalidLifecycle')
    }
    completedHandsObserved += 1
    if (hand.showdown !== null) showdownHandsObserved += 1
    lastCompletedHandNumber = hand.handNumber
    for (const participant of participants) {
      if (participant.participantId !== parsed.data.actorParticipantId) {
        updateOpponent(opponents, participant, hand)
      }
    }
    recentHands.push(fullHandSummary(hand))
  }
  opponents.sort((left, right) => left.seatNumber - right.seatNumber)
  if (opponents.length > PLAYER_SESSION_MEMORY_MAX_OPPONENTS) {
    throw new PlayerSessionMemoryError('invalidLifecycle')
  }
  const memory = decodePlayerSessionMemoryV1({
    memorySchemaVersion: PLAYER_SESSION_MEMORY_PAYLOAD_VERSION,
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    scannedThrough: {
      handNumber: parsed.data.cutoff.handNumber - 1,
      eventSeq: parsed.data.cutoff.eventSeq,
    },
    lastCompletedHandNumber,
    sessionSummary: { completedHandsObserved, showdownHandsObserved },
    opponents,
    recentHands: recentHands.slice(-PLAYER_SESSION_MEMORY_MAX_RECENT_HANDS),
    // 已压缩 revision 的旧摘要不能凭空补回投入额；后续增量只追加新 Hand
    // 的完整事实，并维持 compact 表示，保证下一次 deterministic fold 可解码。
    detailLevel: parsed.data.memory.detailLevel,
  })
  return enforceSize(memory)
}
