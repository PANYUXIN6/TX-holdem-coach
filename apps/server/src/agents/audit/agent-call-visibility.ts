import {
  PublicNormalizedActionSchema,
  type AgentCallHandSummary,
} from '@tx-holdem-coach/contracts'
import type { z } from 'zod'
import { PokerCommandSchema } from '../../poker/commands.js'

type PublicNormalizedAction = z.infer<typeof PublicNormalizedActionSchema>

export function projectNormalizedActionVisibility(input: {
  readonly handStatus: AgentCallHandSummary['status']
  readonly executionMode: 'live' | 'historicalReexecution'
  readonly decisionStatus:
    'auditPrepared' | 'modelPrepared' | 'selected' | 'committed'
  readonly action: z.infer<typeof PokerCommandSchema>['action'] | null
  readonly commandRange: {
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  } | null
}): PublicNormalizedAction {
  if (input.handStatus === 'aborted')
    return Object.freeze({ status: 'withheld' })
  if (input.action === null) return Object.freeze({ status: 'notSelected' })
  if (
    input.handStatus === 'inProgress' &&
    (input.executionMode !== 'live' ||
      input.decisionStatus !== 'committed' ||
      input.commandRange === null)
  ) {
    return Object.freeze({ status: 'withheld' })
  }
  return Object.freeze({ status: 'visible', action: input.action })
}
