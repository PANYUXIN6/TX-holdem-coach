import { createHash } from 'node:crypto'
import { SseEventSchema, type SseEvent } from '@tx-holdem-coach/contracts'
import { z } from 'zod'

const SafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER)

const StoredPublicEventRowSchema = z.strictObject({
  eventId: z.uuid(),
  sessionId: z.uuid(),
  eventSeq: SafeIntegerSchema,
  stateVersionAfter: SafeIntegerSchema,
  publicEventPayload: z.unknown(),
})

export interface StoredPublicEventRow {
  readonly eventId: unknown
  readonly sessionId: unknown
  readonly eventSeq: unknown
  readonly stateVersionAfter: unknown
  readonly publicEventPayload: unknown
}

export type StoredPublicEventDecodeFailureReason = 'storedPayloadInvalid'

export type DecodedStoredPublicEvent =
  | { readonly kind: 'decoded'; readonly event: SseEvent }
  | {
      readonly kind: 'invalid'
      readonly reason: StoredPublicEventDecodeFailureReason
    }

export function decodeStoredPublicEvent(
  value: StoredPublicEventRow,
): DecodedStoredPublicEvent {
  const row = StoredPublicEventRowSchema.safeParse(value)
  if (!row.success) {
    return { kind: 'invalid', reason: 'storedPayloadInvalid' }
  }
  const event = SseEventSchema.safeParse(row.data.publicEventPayload)
  if (
    !event.success ||
    event.data.type === 'snapshot' ||
    event.data.eventId.toLowerCase() !== row.data.eventId.toLowerCase() ||
    event.data.sessionId.toLowerCase() !== row.data.sessionId.toLowerCase() ||
    event.data.eventSeq !== row.data.eventSeq ||
    event.data.stateVersion !== row.data.stateVersionAfter
  ) {
    return { kind: 'invalid', reason: 'storedPayloadInvalid' }
  }
  return { kind: 'decoded', event: event.data }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
    .join(',')}}`
}

export function hashStoredPublicEventPage(events: readonly SseEvent[]): string {
  return createHash('sha256')
    .update('public-event-page-v1\n')
    .update(canonicalJson(events))
    .digest('hex')
}
