import { z } from 'zod'
import { AuthoritativeStateValidationError } from './errors.js'
import {
  createPokerPrivateEvent,
  type PokerPrivateEvent,
} from './poker-private-event.js'

const SafeNonnegativeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)
const SeatNumberSchema = z.number().int().min(0).max(8)
const EventSeatSchema = z.strictObject({
  seatNumber: SeatNumberSchema,
  stack: SafeNonnegativeIntegerSchema,
  cumulativeBuyIn: SafeNonnegativeIntegerSchema,
})
const EventTableSchema = z.strictObject({
  buttonSeatNumber: SeatNumberSchema,
  completedHandCount: SafeNonnegativeIntegerSchema,
  seats: z.array(EventSeatSchema).min(6).max(9),
})

const SessionCreatedEventSchema = z
  .strictObject({
    type: z.literal('sessionCreated'),
    initialBuyIns: z
      .array(
        z.strictObject({
          seatNumber: SeatNumberSchema,
          amount: z.literal(2_000),
        }),
      )
      .min(6)
      .max(9),
  })
  .superRefine((event, context) => {
    if (
      event.initialBuyIns[0]?.seatNumber !== 0 ||
      event.initialBuyIns.some(
        (buyIn, index) =>
          index > 0 &&
          buyIn.seatNumber <= event.initialBuyIns[index - 1]!.seatNumber,
      )
    ) {
      context.addIssue({
        code: 'custom',
        message: '创建场次买入必须包含座位 0 并按唯一座位严格升序。',
        path: ['initialBuyIns'],
      })
    }
  })

const UserRebuyEventSchema = z
  .strictObject({
    type: z.literal('userRebuy'),
    seatNumber: z.literal(0),
    amount: SafeNonnegativeIntegerSchema.positive(),
    stackBefore: SafeNonnegativeIntegerSchema,
    stackAfter: SafeNonnegativeIntegerSchema.max(2_000),
    cumulativeBuyInBefore: SafeNonnegativeIntegerSchema,
    cumulativeBuyInAfter: SafeNonnegativeIntegerSchema,
  })
  .superRefine((event, context) => {
    if (
      BigInt(event.stackBefore) + BigInt(event.amount) !==
        BigInt(event.stackAfter) ||
      BigInt(event.cumulativeBuyInBefore) + BigInt(event.amount) !==
        BigInt(event.cumulativeBuyInAfter)
    ) {
      context.addIssue({
        code: 'custom',
        message: '用户补码事件的前后金额必须精确镜像。',
      })
    }
  })

const AiAutoRebuyEventSchema = z
  .strictObject({
    type: z.literal('aiAutoRebuy'),
    seatNumber: z.number().int().min(1).max(8),
    amount: z.literal(2_000),
    stackBefore: z.literal(0),
    stackAfter: z.literal(2_000),
    cumulativeBuyInBefore: SafeNonnegativeIntegerSchema,
    cumulativeBuyInAfter: SafeNonnegativeIntegerSchema,
  })
  .superRefine((event, context) => {
    if (
      BigInt(event.cumulativeBuyInBefore) + 2_000n !==
      BigInt(event.cumulativeBuyInAfter)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'AI 自动买入事件的累计买入必须精确增加 2000。',
      })
    }
  })

const HandAbortedEventSchema = z
  .strictObject({
    type: z.literal('handAborted'),
    handId: z.uuid(),
    beforeAbort: EventTableSchema.extend({
      pot: SafeNonnegativeIntegerSchema,
    }),
    restored: EventTableSchema,
  })
  .superRefine((event, context) => {
    const beforeSeats = event.beforeAbort.seats
    const restoredSeats = event.restored.seats
    const beforeSeatNumbers = beforeSeats.map((seat) => seat.seatNumber)
    const restoredSeatNumbers = restoredSeats.map((seat) => seat.seatNumber)
    const isStrictlySortedUnique = (seatNumbers: readonly number[]) =>
      seatNumbers.every(
        (seatNumber, index) =>
          index === 0 || seatNumber > (seatNumbers[index - 1] as number),
      )
    const sameSeats =
      beforeSeatNumbers.length === restoredSeatNumbers.length &&
      beforeSeatNumbers.every(
        (seatNumber, index) => seatNumber === restoredSeatNumbers[index],
      )
    if (
      !isStrictlySortedUnique(beforeSeatNumbers) ||
      !isStrictlySortedUnique(restoredSeatNumbers) ||
      !sameSeats ||
      !beforeSeatNumbers.includes(0) ||
      !beforeSeatNumbers.includes(event.beforeAbort.buttonSeatNumber) ||
      !restoredSeatNumbers.includes(event.restored.buttonSeatNumber) ||
      event.beforeAbort.completedHandCount !== event.restored.completedHandCount
    ) {
      context.addIssue({
        code: 'custom',
        message: '中止前后桌面集合、按钮和完成手数必须一致有效。',
      })
      return
    }

    const maximumSafeInteger = BigInt(Number.MAX_SAFE_INTEGER)
    const beforeBuyIns = beforeSeats.reduce(
      (total, seat) => total + BigInt(seat.cumulativeBuyIn),
      0n,
    )
    const beforeFunds = beforeSeats.reduce(
      (total, seat) => total + BigInt(seat.stack),
      BigInt(event.beforeAbort.pot),
    )
    const restoredBuyIns = restoredSeats.reduce(
      (total, seat) => total + BigInt(seat.cumulativeBuyIn),
      0n,
    )
    const restoredFunds = restoredSeats.reduce(
      (total, seat) => total + BigInt(seat.stack),
      0n,
    )
    if (
      beforeBuyIns > maximumSafeInteger ||
      beforeFunds > maximumSafeInteger ||
      restoredBuyIns > maximumSafeInteger ||
      restoredFunds > maximumSafeInteger ||
      beforeBuyIns !== beforeFunds ||
      restoredBuyIns !== restoredFunds
    ) {
      context.addIssue({
        code: 'custom',
        message: '中止事件的资金必须安全且守恒。',
      })
    }

    for (let index = 0; index < beforeSeats.length; index += 1) {
      const before = beforeSeats[index]!
      const restored = restoredSeats[index]!
      const rollback =
        BigInt(before.cumulativeBuyIn) - BigInt(restored.cumulativeBuyIn)
      if (
        (before.seatNumber === 0 && rollback !== 0n) ||
        (before.seatNumber !== 0 &&
          (rollback < 0n ||
            (rollback !== 0n && rollback !== 2_000n) ||
            (rollback === 2_000n) !== (restored.stack === 0)))
      ) {
        context.addIssue({
          code: 'custom',
          message: '中止事件的买入回退不满足固定规则。',
          path: ['restored', 'seats', index],
        })
      }
    }
  })

const SessionEndedEventSchema = z.strictObject({
  type: z.literal('sessionEnded'),
  reason: z.enum(['userRequested', 'handAborted']),
})

export const PlayerPauseReasonSchema = z.enum([
  'provider_billing_unavailable',
  'provider_network_error',
  'provider_timeout',
  'provider_service_unavailable',
  'provider_auth_error',
  'provider_rate_limited',
  'provider_unknown_error',
  'provider_usage_unavailable',
  'content_correction_exhausted',
  'execution_budget_exhausted',
  'execution_deadline_exhausted',
  'sensitive_projection_rejected',
  'player_dependency_unavailable',
  'player_runtime_contract_rejected',
  'player_internal_failure',
])

const AgentStartedEventSchema = z
  .strictObject({
    type: z.literal('agentStarted'),
    handId: z.uuid(),
    agentRunId: z.uuid(),
    decisionRequestId: z.uuid(),
    actorSeatNumber: z.number().int().min(1).max(8),
    trigger: z.enum([
      'initial',
      'manualRetry',
      'staleReplacement',
      'processRestartReplacement',
    ]),
    supersedesRunId: z.uuid().nullable(),
  })
  .superRefine((event, context) => {
    const mustHaveNoPredecessor = event.trigger === 'initial'
    if (mustHaveNoPredecessor !== (event.supersedesRunId === null)) {
      context.addIssue({
        code: 'custom',
        message: 'Player Run 启动事件的触发来源必须与前任 Run 成对。',
        path: ['supersedesRunId'],
      })
    }
  })

const AgentRepairAttemptedEventSchema = z.strictObject({
  type: z.literal('agentRepairAttempted'),
  handId: z.uuid(),
  agentRunId: z.uuid(),
  decisionRequestId: z.uuid(),
  actorSeatNumber: z.number().int().min(1).max(8),
  attemptId: z.uuid(),
  repairOrdinal: z.union([z.literal(1), z.literal(2)]),
})

const AgentPausedEventSchema = z.strictObject({
  type: z.literal('agentPaused'),
  handId: z.uuid(),
  failedAgentRunId: z.uuid(),
  decisionRequestId: z.uuid(),
  actorSeatNumber: z.number().int().min(1).max(8),
  failureCode: PlayerPauseReasonSchema,
})

const SessionPrivateEventSchema = z.discriminatedUnion('type', [
  SessionCreatedEventSchema,
  UserRebuyEventSchema,
  AiAutoRebuyEventSchema,
  HandAbortedEventSchema,
  SessionEndedEventSchema,
  AgentStartedEventSchema,
  AgentRepairAttemptedEventSchema,
  AgentPausedEventSchema,
])

export type SessionCreatedEvent = z.infer<typeof SessionCreatedEventSchema>
export type UserRebuyEvent = z.infer<typeof UserRebuyEventSchema>
export type AiAutoRebuyEvent = z.infer<typeof AiAutoRebuyEventSchema>
export type HandAbortedEvent = z.infer<typeof HandAbortedEventSchema>
export type SessionEndedEvent = z.infer<typeof SessionEndedEventSchema>
export type PlayerPauseReason = z.infer<typeof PlayerPauseReasonSchema>
export type AgentStartedEvent = z.infer<typeof AgentStartedEventSchema>
export type AgentRepairAttemptedEvent = z.infer<
  typeof AgentRepairAttemptedEventSchema
>
export type AgentPausedEvent = z.infer<typeof AgentPausedEventSchema>
export type PrivateEvent =
  PokerPrivateEvent | z.infer<typeof SessionPrivateEventSchema>

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) {
      deepFreeze(nestedValue)
    }
    Object.freeze(value)
  }
  return value
}

function isPokerPrivateEventInput(input: unknown): boolean {
  return (
    typeof input === 'object' &&
    input !== null &&
    'type' in input &&
    typeof input.type === 'string' &&
    [
      'handStarted',
      'actionCommitted',
      'uncalledBetReturned',
      'handCompleted',
    ].includes(input.type)
  )
}

function parseNonPokerPrivateEvent(input: unknown): PrivateEvent {
  return deepFreeze(
    structuredClone(SessionPrivateEventSchema.parse(input)),
  ) as PrivateEvent
}

export function createPrivateEvent(input: unknown): PrivateEvent {
  try {
    if (isPokerPrivateEventInput(input)) {
      return createPokerPrivateEvent(input)
    }
    return parseNonPokerPrivateEvent(input)
  } catch {
    throw new AuthoritativeStateValidationError()
  }
}

export function getPrivateEventHandId(event: PrivateEvent): string | null {
  switch (event.type) {
    case 'handStarted':
      return event.startedHand.handId
    case 'actionCommitted':
    case 'uncalledBetReturned':
    case 'handCompleted':
    case 'handAborted':
    case 'agentStarted':
    case 'agentRepairAttempted':
    case 'agentPaused':
      return event.handId
    case 'sessionCreated':
    case 'userRebuy':
    case 'aiAutoRebuy':
    case 'sessionEnded':
      return null
  }
}
