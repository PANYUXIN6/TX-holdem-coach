import type { QueryClient } from '@tanstack/react-query'
import {
  PublicSessionSnapshotSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { sessionId } from '../api/client.js'
import { keys } from './keys.js'

export type Baseline = { eventSeq: number; stateVersion: number }
export type ReceiveContext = {
  generation: number
  revision: number
  baseline?: Baseline | undefined
}
export type ReceiveKind =
  'accepted' | 'duplicate' | 'superseded' | 'gap' | 'protocol' | 'invalidated'
export type ReceiveMode = 'incremental' | 'calibration'
export type ReceiveResult = {
  kind: ReceiveKind
  snapshot?: PublicSessionSnapshot | undefined
}
export function decideSnapshot(
  current: Baseline | undefined,
  candidate: Baseline,
  mode: ReceiveMode,
  baseline: Baseline | undefined,
  advanced: boolean,
): ReceiveKind {
  if (!current) return 'accepted'
  const { eventSeq: e, stateVersion: v } = candidate
  const { eventSeq: E, stateVersion: V } = current
  if (mode === 'incremental') {
    if (e <= E) return 'duplicate'
    if (v < V) return 'protocol'
    return e === E + 1 ? 'accepted' : 'gap'
  }
  if ((e > E && v >= V) || (e === E && v === V)) return 'accepted'
  if (
    e < E &&
    v <= V &&
    advanced &&
    (!baseline || (e >= baseline.eventSeq && v >= baseline.stateVersion))
  )
    return 'superseded'
  return 'protocol'
}
/** 仅保护已经接收器裁定的结果到 Query 自动 setData 之间的竞速。 */
export function sessionStructuralSharing(
  old: unknown,
  incoming: unknown,
): unknown {
  const previous = old as PublicSessionSnapshot | undefined
  const next = incoming as PublicSessionSnapshot
  if (
    previous &&
    (next.eventSeq < previous.eventSeq ||
      next.stateVersion < previous.stateVersion)
  )
    return previous
  return incoming
}
export function createReceiver(
  client: QueryClient,
  onAccepted?: (
    previous: PublicSessionSnapshot | undefined,
    next: PublicSessionSnapshot,
    recovery: boolean,
    eventType?: string,
  ) => void,
) {
  const metadata = new Map<string, { generation: number; revision: number }>()
  client.setQueryDefaults(['session'], {
    structuralSharing: sessionStructuralSharing,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  })
  function meta(id: string) {
    const key = sessionId(id)
    let value = metadata.get(key)
    if (!value) {
      value = { generation: 0, revision: 0 }
      metadata.set(key, value)
    }
    return value
  }
  function current(id: string) {
    return client.getQueryData<PublicSessionSnapshot>(keys.session(id))
  }
  function valid(id: string, context: ReceiveContext) {
    return meta(id).generation === context.generation
  }
  return {
    current,
    valid,
    begin(id: string): ReceiveContext {
      const data = current(id)
      return {
        ...meta(id),
        ...(data
          ? {
              baseline: {
                eventSeq: data.eventSeq,
                stateVersion: data.stateVersion,
              },
            }
          : {}),
      }
    },
    invalidate(id: string) {
      meta(id).generation++
    },
    receive(
      id: string,
      input: PublicSessionSnapshot,
      mode: ReceiveMode,
      context: ReceiveContext,
      recovery = false,
      eventType?: string,
    ): ReceiveResult {
      if (!valid(id, context)) return { kind: 'invalidated' }
      const parsed = PublicSessionSnapshotSchema.safeParse(input)
      if (
        !parsed.success ||
        parsed.data.sessionId.toLowerCase() !== sessionId(id)
      )
        return { kind: 'protocol' }
      const next = parsed.data
      const previous = current(id)
      const kind = decideSnapshot(
        previous,
        next,
        mode,
        context.baseline,
        meta(id).revision > context.revision,
      )
      if (kind === 'accepted') {
        client.setQueryData(keys.session(id), next)
        meta(id).revision++
        onAccepted?.(
          previous,
          next,
          recovery ||
            !previous ||
            (mode === 'calibration' && next.eventSeq > previous.eventSeq + 1),
          eventType,
        )
      }
      return { kind, snapshot: current(id) }
    },
  }
}
export type Receiver = ReturnType<typeof createReceiver>
