import type {
  HandStatisticsQuery,
  SessionStatisticsQuery,
} from '@tx-holdem-coach/contracts'
import type { StatisticsHandFact } from './hand-statistics.js'
import type { StatisticsSessionFact } from './session-statistics.js'

export interface StatisticsFactsReader {
  scanHandFacts(
    query: HandStatisticsQuery,
    consume: (fact: StatisticsHandFact) => void | Promise<void>,
  ): Promise<void>
  scanSessionFacts(
    query: SessionStatisticsQuery,
    consume: (fact: StatisticsSessionFact) => void | Promise<void>,
  ): Promise<void>
}
