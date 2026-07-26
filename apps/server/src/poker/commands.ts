import { PokerActionSchema } from '@tx-holdem-coach/contracts'
import { z } from 'zod'

export const PokerCommandSchema = z.strictObject({
  actorSeatNumber: z.number().int().min(0).max(8),
  action: PokerActionSchema,
})

export type PokerCommand = z.infer<typeof PokerCommandSchema>
