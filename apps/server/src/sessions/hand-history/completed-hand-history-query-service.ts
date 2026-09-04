import {
  HandHistoryViewSchema,
  HandIdSchema,
  type HandHistoryResponse,
  type HandHistoryView,
} from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import type { AuthoritativeCompletedHandHistoryReader } from './completed-hand-history.js'
import { CompletedHandHistoryInvariantError } from './errors.js'
import { projectCompletedHandHistoryView } from './completed-hand-history-view-projector.js'

const CompletedHandHistoryQueryInputSchema = z.strictObject({
  handId: HandIdSchema,
  view: HandHistoryViewSchema,
})

export interface CompletedHandHistoryQueryService {
  read(input: {
    readonly handId: string
    readonly view: HandHistoryView
  }): Promise<HandHistoryResponse | null>
}

export function createCompletedHandHistoryQueryService(input: {
  readonly reader: AuthoritativeCompletedHandHistoryReader
}): CompletedHandHistoryQueryService {
  if (typeof input.reader?.read !== 'function') {
    throw new CompletedHandHistoryInvariantError()
  }
  return Object.freeze({
    async read(query: {
      readonly handId: string
      readonly view: HandHistoryView
    }) {
      const parsed = CompletedHandHistoryQueryInputSchema.safeParse(query)
      if (!parsed.success) throw new CompletedHandHistoryInvariantError()
      const history = await input.reader.read({ handId: parsed.data.handId })
      return history === null
        ? null
        : projectCompletedHandHistoryView(history, parsed.data.view)
    },
  })
}
