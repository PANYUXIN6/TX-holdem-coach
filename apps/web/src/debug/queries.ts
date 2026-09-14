import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../query/options.js'
import { keys } from '../query/keys.js'
import { useReadForeground } from '../ai-status/queries.js'
import type { AgentCallPageRequest } from '@tx-holdem-coach/contracts'

export const terminalRun = (lifecycle: string | undefined) =>
  lifecycle !== undefined &&
  ['completed', 'failed', 'cancelled', 'stale'].includes(lifecycle)
export const summaryPage: AgentCallPageRequest = {
  query: { limit: 1 },
  cursor: null,
}
export function useRunAudit(
  id: string,
  mode: 'debug' | 'thinking' | 'paused' = 'debug',
) {
  const foreground = useReadForeground()
  const client = useQueryClient()
  const parent = useQuery({
    ...queries.run(id),
    enabled: foreground,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      foreground &&
      mode !== 'paused' &&
      !query.state.error &&
      (!terminalRun(query.state.data?.lifecycle) ||
        (mode === 'debug' &&
          client.getQueryData(
            queries.handCalls(query.state.data?.handId ?? id, summaryPage)
              .queryKey,
          )?.hand.status === 'inProgress'))
        ? 3000
        : false,
    refetchIntervalInBackground: false,
  })
  const hand = useQuery({
    ...queries.handCalls(parent.data?.handId ?? id, summaryPage),
    enabled: foreground && !!parent.data && !parent.isError,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (query) =>
      foreground &&
      !!parent.data &&
      (mode === 'debug' ||
        (mode === 'thinking' && !terminalRun(parent.data.lifecycle))) &&
      !parent.isError &&
      !query.state.error &&
      query.state.data?.hand.status === 'inProgress'
        ? 3000
        : false,
    refetchIntervalInBackground: false,
  })
  const terminal = terminalRun(parent.data?.lifecycle)
  useEffect(() => {
    if (mode === 'thinking' && foreground && terminal && !parent.isError)
      void hand.refetch()
  }, [mode, foreground, terminal, parent.isError, hand.refetch])
  const aborted = hand.data?.hand.status === 'aborted'
  useEffect(() => {
    if (!foreground || parent.isError || aborted) {
      void client.cancelQueries({
        predicate: (query) =>
          query.queryKey[0] === 'agent-runs' &&
          query.queryKey[1] === id &&
          query.queryKey[2] !== 'detail',
      })
    }
    if (!foreground) {
      void client.cancelQueries({ queryKey: keys.run(id), exact: true })
      if (parent.data)
        void client.cancelQueries({
          queryKey: queries.handCalls(parent.data.handId, summaryPage).queryKey,
          exact: true,
        })
    }
  }, [foreground, parent.isError, aborted, client, id, parent.data?.handId])
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: ['agent-runs', id] })
    },
    [client, id],
  )
  return {
    parent,
    hand,
    foreground,
    allowChildren:
      !parent.isError &&
      !hand.isError &&
      !!hand.data &&
      (!aborted ||
        (hand.data.hand.status === 'aborted' &&
          hand.data.hand.abortedByAgentRunId === id)),
    polling:
      foreground &&
      !parent.isError &&
      !hand.isError &&
      mode !== 'paused' &&
      ((mode === 'debug' && hand.data?.hand.status === 'inProgress') ||
        !terminalRun(parent.data?.lifecycle)),
    allowAction: !parent.isError && !hand.isError && !!hand.data && !aborted,
  }
}
