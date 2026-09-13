import type {
  SessionManagementItem,
  SessionManagementPageRequest,
} from '@tx-holdem-coach/contracts'

export function preparationAllowed(query: {
  data: unknown
  status: string
  fetchStatus: string
}) {
  return (
    query.data === null &&
    query.status === 'success' &&
    query.fetchStatus === 'idle'
  )
}
export function homeSessions(
  lifecycle: 'all' | 'active' | 'ended',
): SessionManagementPageRequest {
  return {
    query: {
      lifecycle,
      from: null,
      to: null,
      sort: 'newest',
      limit: lifecycle === 'all' ? 5 : 1,
    },
    cursor: null,
  }
}
export function userAccounting(item: SessionManagementItem) {
  const user = item.roster.find((seat) => seat.kind === 'user')
  return item.accounting.status === 'available'
    ? item.accounting.seats.find((seat) => seat.seatNumber === user?.seatNumber)
    : undefined
}
export function settlementText(item: SessionManagementItem) {
  if (item.accounting.status === 'unavailable') return '—'
  if (item.lifecycle === 'active') return '本场未结算'
  const net = userAccounting(item)?.sessionNetChange
  if (net === null || net === undefined) return '—'
  return net === 0
    ? '持平 0'
    : `${net > 0 ? '+' : ''}${net.toLocaleString('zh-CN')}`
}
export function localTime(value: string, now = new Date()) {
  const date = new Date(value)
  return date.toLocaleString('zh-CN', {
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}
