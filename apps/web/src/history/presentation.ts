import type {
  HandHistoryListItem,
  PokerAction,
} from '@tx-holdem-coach/contracts'

export function adjacentSessions(items: HandHistoryListItem[]) {
  const groups: { sessionId: string; items: HandHistoryListItem[] }[] = []
  for (const item of items) {
    const last = groups.at(-1)
    if (last?.sessionId === item.sessionId) last.items.push(item)
    else groups.push({ sessionId: item.sessionId, items: [item] })
  }
  return groups
}
export function actionLabel(
  action: PokerAction,
  display?: {
    committedAmount: number
    streetContributionAfterAction: number
  },
) {
  const names = {
    fold: '弃牌',
    check: '过牌',
    call: '跟注',
    bet: '下注到',
    raise: '加到',
    allIn: '全下',
  }
  if (action.type === 'fold' || action.type === 'check')
    return names[action.type]
  if (!display) return `${names[action.type]} · 投入详情待校准`
  if (action.type === 'allIn')
    return `全下 ${display.committedAmount} · 本街累计 ${display.streetContributionAfterAction}`
  return `${names[action.type]} ${action.type === 'call' ? display.committedAmount : display.streetContributionAfterAction}`
}
export { localDateBoundary, localDateInput } from '../filters/dates.js'
export function signed(amount: number) {
  return `${amount > 0 ? '+' : ''}${amount}`
}
