import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../query/options.js'
import { useSession } from '../session-sync/react.js'
import { aiStatusMatches } from './adapter.js'

export function useReadForeground() {
  const [active, setActive] = useState(
    () => !document.hidden && navigator.onLine,
  )
  useEffect(() => {
    const update = () => setActive(!document.hidden && navigator.onLine)
    document.addEventListener('visibilitychange', update)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return active
}
export function useAiStatus(id: string) {
  const session = useSession(id)
  const foreground = useReadForeground()
  const client = useQueryClient()
  const options = queries.sessionAiStatus(id)
  const ai = useQuery({
    ...options,
    enabled: foreground && session.status !== 'missing',
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  const [calibrated, setCalibrated] = useState('')
  const source = ai.data
    ? `${ai.data.stateVersion}:${ai.data.eventSeq}:${session.data?.stateVersion}:${session.data?.eventSeq}`
    : ''
  useEffect(() => {
    if (
      !foreground ||
      !ai.data ||
      !session.data ||
      ai.isError ||
      ai.isFetching ||
      calibrated === source ||
      aiStatusMatches(session.data, ai.data)
    )
      return
    setCalibrated(source)
    if (
      ai.data.stateVersion > session.data.stateVersion ||
      ai.data.eventSeq > session.data.eventSeq
    )
      void session.runtime.refresh(id).catch(() => {})
    else void ai.refetch()
  }, [
    foreground,
    ai.data,
    ai.isError,
    ai.isFetching,
    session.data,
    session.runtime,
    source,
    calibrated,
    id,
    ai.refetch,
  ])
  useEffect(() => {
    if (!foreground)
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    return () => {
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    }
  }, [foreground, client, id])
  return {
    ai,
    session,
    foreground,
    matches: !ai.isError && aiStatusMatches(session.data, ai.data),
  }
}
