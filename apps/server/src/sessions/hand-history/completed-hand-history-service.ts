import { z } from 'zod'
import type {
  AuthoritativeCompletedHandHistoryReader,
  CompletedHandHistoryFactsReader,
} from './completed-hand-history.js'
import { projectAuthoritativeCompletedHandHistory } from './completed-hand-history-projector.js'
import { CompletedHandHistoryInvariantError } from './errors.js'

const ReadInputSchema = z.strictObject({ handId: z.uuid() })

export function createAuthoritativeCompletedHandHistoryReader(input: {
  readonly factsReader: CompletedHandHistoryFactsReader
}): AuthoritativeCompletedHandHistoryReader {
  if (typeof input.factsReader?.readCompletedHandHistoryFacts !== 'function') {
    throw new CompletedHandHistoryInvariantError()
  }
  return Object.freeze({
    async read(rawInput: { readonly handId: string }) {
      const parsed = ReadInputSchema.safeParse(rawInput)
      if (!parsed.success) throw new CompletedHandHistoryInvariantError()
      const facts = await input.factsReader.readCompletedHandHistoryFacts(
        parsed.data.handId,
      )
      return facts === null
        ? null
        : projectAuthoritativeCompletedHandHistory(facts)
    },
  })
}
