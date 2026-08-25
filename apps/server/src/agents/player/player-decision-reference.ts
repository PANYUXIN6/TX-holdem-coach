import type { AgentPersonaId } from '@tx-holdem-coach/contracts'
import type { PokerRuleSetVersion } from '../../poker/poker-rule-set.js'

export interface PlayerPersonaPolicy {
  readonly tightness: number
  readonly aggression: number
  readonly bluffTendency: number
  readonly pressureCallTendency: number
  readonly riskPreference: number
}

export interface PlayerDecisionReference {
  readonly sessionId: string
  readonly handId: string
  readonly actorParticipantId: string
  readonly actorSeat: number
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly handNumber: number
  readonly configSnapshotKey: string
  readonly personaId: AgentPersonaId
  readonly personaVersion: 1
  readonly personaPolicy: PlayerPersonaPolicy
}
