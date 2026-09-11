import type * as C from '@tx-holdem-coach/contracts'
import { handId, personaId, runId, sessionId } from '../api/client.js'

/** 参数为 search codec 的同一个认证结果；options 同时用于 key 与 HTTP。 */
export const keys = {
  health: () => ['health'] as const,
  providers: () => ['settings', 'providers'] as const,
  agent: () => ['settings', 'agent'] as const,
  personas: () => ['personas', 'list'] as const,
  persona: (id: string) => ['personas', 'detail', personaId(id)] as const,
  sessions: (page: C.SessionManagementPageRequest) =>
    ['sessions', 'list', page.query, page.cursor] as const,
  active: () => ['sessions', 'active'] as const,
  session: (id: string) => ['session', sessionId(id)] as const,
  hands: (page: C.HandHistoryPageRequest) =>
    ['hands', 'list', page.query, page.cursor] as const,
  hand: (id: string, view: C.HandHistoryQuery['view']) =>
    ['hands', 'detail', handId(id), view] as const,
  statistics: (query: C.StatisticsQuery) => ['statistics', query] as const,
  handCalls: (id: string, page: C.AgentCallPageRequest) =>
    ['hands', 'calls', handId(id), page.query, page.cursor] as const,
  run: (id: string) => ['agent-runs', runId(id), 'detail'] as const,
  attempts: (id: string, page: C.AgentCallPageRequest) =>
    ['agent-runs', runId(id), 'attempts', page.query, page.cursor] as const,
  capabilities: (id: string, page: C.AgentCallPageRequest) =>
    ['agent-runs', runId(id), 'capabilities', page.query, page.cursor] as const,
}
