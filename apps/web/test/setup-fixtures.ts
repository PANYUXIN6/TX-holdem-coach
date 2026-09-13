import {
  AGENT_PERSONA_IDS,
  type AgentPersonaSummary,
  type LatestEndedRosterPreviewResponse,
} from '@tx-holdem-coach/contracts'
import { agentPersonaSummary, ids } from './fixtures.js'
export const setupPersonas: AgentPersonaSummary[] = AGENT_PERSONA_IDS.map(
  (personaId, i) => ({
    ...agentPersonaSummary,
    personaVersion: 1,
    personaId,
    name: [
      '谨慎的观察者',
      '善于捕捉机会的长名字对手',
      '稳健的职业玩家',
      '短筹码猎手',
      '坚持跟注的常客',
      '深筹码冒险家',
      '小底池专家',
      '耐心的设局者',
    ][i]!,
    style: {
      tightness: 20 + i * 10,
      aggression: 70 - i * 5,
      bluffTendency: 30 + i * 6,
      pressureCallTendency: 45,
      riskPreference: 55,
    },
  }),
)
export const rosterPreview: LatestEndedRosterPreviewResponse = {
  sourceSessionId: ids.session,
  endedAt: '2026-09-13T01:00:00.000000Z',
  agents: setupPersonas.slice(0, 5).map((p, i) => ({
    ...p,
    name: `历史 · ${p.name}`,
    personaVersion: 1,
    sourceSeatNumber: i + 1,
    configSnapshotKey: String(i + 1).repeat(64),
  })),
}
