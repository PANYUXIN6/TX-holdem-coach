import type { Query, QueryClient } from '@tanstack/react-query'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {}
}
export function maintainSessionResources(
  client: QueryClient,
  previous: PublicSessionSnapshot | undefined,
  next: PublicSessionSnapshot,
  recovery: boolean,
  valid: () => boolean,
  eventType?: string,
) {
  const completed = next.lastCompletedHandSummary?.handId
  const handChanged =
    previous?.hand?.handId !== next.hand?.handId ||
    previous?.lastCompletedHandSummary?.handId !== completed
  const ended =
    next.lifecycleStatus === 'ended' && previous?.lifecycleStatus !== 'ended'
  const stacksChanged =
    !previous ||
    previous.seats.some(
      (seat, index) => seat.stack !== next.seats[index]?.stack,
    )
  const history =
    recovery ||
    (completed !== undefined &&
      previous?.lastCompletedHandSummary?.handId !== completed) ||
    eventType === 'handCompleted'
  const calls =
    recovery ||
    handChanged ||
    previous?.agentRunState !== next.agentRunState ||
    previous?.activeDecision?.decisionRequestId !==
      next.activeDecision?.decisionRequestId ||
    [
      'agentStarted',
      'agentRepairAttempted',
      'agentPaused',
      'actionCommitted',
      'retryAgent',
    ].includes(eventType ?? '') ||
    previous?.stateVersion !== next.stateVersion
  const sessions =
    recovery ||
    handChanged ||
    stacksChanged ||
    previous?.lifecycleStatus !== next.lifecycleStatus ||
    ['rebuy', 'userRebuy', 'aiAutoRebuy', 'sessionCreated'].includes(
      eventType ?? '',
    )
  const matches = (query: Query) => {
    const key = query.queryKey
    if (key[0] === 'sessions') return key[1] === 'list' && sessions
    const filter = object(key[key[0] === 'statistics' ? 1 : 2]).sessionId
    const inScope =
      filter == null ||
      (typeof filter === 'string' &&
        filter.toLowerCase() === next.sessionId.toLowerCase())
    if (key[0] === 'statistics')
      return (
        inScope &&
        (recovery || (object(key[1]).scope === 'hands' ? history : ended))
      )
    if (key[0] === 'hands' && key[1] === 'list') return history && inScope
    if (key[0] === 'hands' && key[1] === 'detail') {
      const owner = object(object(query.state.data).history).sessionId
      return (
        history &&
        (key[2] === completed ||
          (recovery &&
            typeof owner === 'string' &&
            owner.toLowerCase() === next.sessionId.toLowerCase()))
      )
    }
    if (key[0] === 'hands' && key[1] === 'calls')
      return (
        calls &&
        (recovery ||
          key[2] === next.hand?.handId ||
          key[2] === previous?.hand?.handId ||
          key[2] === completed)
      )
    if (key[0] === 'agent-runs') {
      const data = object(query.state.data)
      const owner = query.meta?.sessionId ?? data.sessionId
      const hand = query.meta?.handId ?? data.handId
      return (
        calls &&
        (recovery
          ? owner == null || owner === next.sessionId
          : owner === next.sessionId ||
            (typeof hand === 'string' &&
              (hand === next.hand?.handId || hand === previous?.hand?.handId)))
      )
    }
    return false
  }
  // 取消同步生效；异步失效前再次检查生命周期，删除后的尾部不复活列表。
  void client
    .cancelQueries({ predicate: matches }, { revert: false })
    .then(() => {
      if (valid())
        return client.invalidateQueries(
          { predicate: matches },
          { throwOnError: false },
        )
    })
    .catch(() => {})
}
