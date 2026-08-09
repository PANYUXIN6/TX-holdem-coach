import { z } from 'zod'

export interface CommandNotAllowedInPhaseRejection {
  readonly kind: 'commandNotAllowedInPhase'
  readonly phase: 'betweenHands' | 'inHand'
}

export type StableCommandRejection = CommandNotAllowedInPhaseRejection

const StableCommandRejectionSchema = z.strictObject({
  kind: z.literal('commandNotAllowedInPhase'),
  phase: z.enum(['betweenHands', 'inHand']),
})

export function parseStableCommandRejection(
  input: unknown,
  expectedPhase: CommandNotAllowedInPhaseRejection['phase'],
): StableCommandRejection | null {
  const parsed = StableCommandRejectionSchema.safeParse(input)
  return parsed.success && parsed.data.phase === expectedPhase
    ? Object.freeze(parsed.data)
    : null
}
