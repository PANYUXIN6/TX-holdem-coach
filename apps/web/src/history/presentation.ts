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
export function localDateBoundary(value: string, end: boolean) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('请输入有效日期')
  const [year, month, day] = value.split('-').map(Number) as [
    number,
    number,
    number,
  ]
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  )
    throw new Error('请输入有效日期')
  if (end) date.setDate(date.getDate() + 1)
  return date.toISOString().replace('.000Z', '.000000Z')
}
export function localDateInput(value: string | null, end = false) {
  if (!value) return ''
  const date = new Date(value)
  if (end) date.setDate(date.getDate() - 1)
  return `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1).toString().padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`
}
export function signed(amount: number) {
  return `${amount > 0 ? '+' : ''}${amount}`
}
