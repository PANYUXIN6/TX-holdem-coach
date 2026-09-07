import {
  StatisticsQuerySchema,
  StatisticsResponseSchema,
  type HandStatisticsQuery,
  type StatisticsResponse,
  type StatisticsQuery,
} from '@tx-holdem-coach/contracts'
import type { LogicalPosition } from '../../poker/positioning.js'
import {
  buildHandStatisticsContributions,
  createHandStatisticsAccumulator,
  type HandStatisticsAccumulator,
} from './hand-statistics.js'
import {
  buildSessionStatisticsContributions,
  createSessionStatisticsAccumulator,
} from './session-statistics.js'
import type { StatisticsFactsReader } from './statistics.js'
import { StatisticsInvariantError } from './errors.js'

const POSITION_ORDER = [
  'UTG',
  'UTG+1',
  'MP',
  'LJ',
  'HJ',
  'CO',
  'BTN',
  'SB',
  'BB',
] as const satisfies readonly LogicalPosition[]

function invalid(): never {
  throw new StatisticsInvariantError()
}

function parseQuery(query: unknown): StatisticsQuery {
  const parsed = StatisticsQuerySchema.safeParse(query)
  if (!parsed.success) return invalid()
  return parsed.data
}

export interface StatisticsQueryService {
  read(query: StatisticsQuery): Promise<StatisticsResponse>
}

export function createStatisticsQueryService(input: {
  readonly reader: StatisticsFactsReader
}): StatisticsQueryService {
  if (
    typeof input.reader?.scanHandFacts !== 'function' ||
    typeof input.reader?.scanSessionFacts !== 'function'
  ) {
    return invalid()
  }
  return Object.freeze({
    async read(query: StatisticsQuery) {
      const parsed = parseQuery(query)
      if (parsed.scope === 'sessions') {
        const accumulator = createSessionStatisticsAccumulator()
        await input.reader.scanSessionFacts(parsed, async (fact) => {
          accumulator.addSession(
            buildSessionStatisticsContributions({ ...parsed, fact }),
          )
        })
        const response = {
          scope: 'sessions' as const,
          query: parsed,
          timeBasis: 'sessionEndedAt' as const,
          totals: accumulator.totals(),
        }
        const output = StatisticsResponseSchema.safeParse(response)
        if (!output.success) return invalid()
        return output.data
      }

      const totals = createHandStatisticsAccumulator()
      const positionAccumulators = new Map<
        LogicalPosition,
        HandStatisticsAccumulator
      >(
        POSITION_ORDER.map((position) => [
          position,
          createHandStatisticsAccumulator(),
        ]),
      )
      await input.reader.scanHandFacts(parsed, async (fact) => {
        const contributions = buildHandStatisticsContributions({
          ...parsed,
          fact,
        })
        totals.addHand(contributions)
        for (const contribution of contributions) {
          const accumulator = positionAccumulators.get(contribution.position)
          if (accumulator === undefined) return invalid()
          accumulator.addHand([contribution])
        }
      })
      const response = {
        scope: 'hands' as const,
        query: parsed as HandStatisticsQuery,
        timeBasis: 'handStartedAt' as const,
        totals: totals.metrics(),
        byPosition:
          parsed.groupBy === 'position'
            ? POSITION_ORDER.map((position) => {
                const accumulator = positionAccumulators.get(position)
                if (accumulator === undefined) return invalid()
                return { position, metrics: accumulator.metrics() }
              })
            : [],
      }
      const output = StatisticsResponseSchema.safeParse(response)
      if (!output.success) return invalid()
      return output.data
    },
  })
}
