import { createHash } from 'node:crypto'
import { z } from 'zod'
import { NonnegativeSafeIntegerSchema } from '../../agents/audit/audit-primitives.js'

const CanonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase())

const PlayerDecisionIdentitySchema = z.strictObject({
  sessionId: CanonicalUuidSchema,
  handId: CanonicalUuidSchema,
  stateVersion: NonnegativeSafeIntegerSchema,
  actorParticipantId: CanonicalUuidSchema,
  actorSeat: z.number().int().min(1).max(8),
  decisionRequestId: CanonicalUuidSchema,
})

export type PlayerDecisionIdentity = Readonly<
  z.infer<typeof PlayerDecisionIdentitySchema>
>

export const CoachDecisionStreetSchema = z.enum([
  'preflop',
  'flop',
  'turn',
  'river',
])
export type CoachDecisionStreet = z.infer<typeof CoachDecisionStreetSchema>

const URL_NAMESPACE_UUID = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const COACH_DECISION_NAMESPACE_NAME = 'urn:tx-holdem-coach:coach-decision:v1'

function uuidToBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replaceAll('-', ''), 'hex')
}

function bytesToUuid(bytes: Uint8Array): string {
  const hex = Buffer.from(bytes).toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join('-')
}

function uuidV5(namespace: string, name: string): string {
  const digest = createHash('sha1')
    .update(uuidToBytes(namespace))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  digest[6] = ((digest[6] ?? 0) & 0x0f) | 0x50
  digest[8] = ((digest[8] ?? 0) & 0x3f) | 0x80
  return bytesToUuid(digest)
}

export const COACH_DECISION_UUID_NAMESPACE = uuidV5(
  URL_NAMESPACE_UUID,
  COACH_DECISION_NAMESPACE_NAME,
)

export function createPlayerDecisionIdentity(
  input: unknown,
): PlayerDecisionIdentity {
  return Object.freeze(PlayerDecisionIdentitySchema.parse(input))
}

export function createCoachDecisionId(input: {
  readonly handId: string
  readonly street: CoachDecisionStreet
  readonly authoritativeSequence: number
}): string {
  const parsed = z
    .strictObject({
      handId: CanonicalUuidSchema,
      street: CoachDecisionStreetSchema,
      authoritativeSequence: NonnegativeSafeIntegerSchema,
    })
    .parse(input)
  return uuidV5(
    COACH_DECISION_UUID_NAMESPACE,
    `${parsed.handId}:${parsed.street}:${String(parsed.authoritativeSequence)}`,
  )
}
