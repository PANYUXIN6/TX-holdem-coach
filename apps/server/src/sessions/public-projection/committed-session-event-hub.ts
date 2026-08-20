import { SseEventSchema, type SseEvent } from '@tx-holdem-coach/contracts'
import { PublicProjectionInvariantError } from './errors.js'

export interface CommittedSessionEventPublisher {
  publish(events: readonly [SseEvent, ...SseEvent[]]): void
}

export interface CommittedSessionEventHub extends CommittedSessionEventPublisher {
  subscribe(sessionId: string, listener: (event: SseEvent) => void): () => void
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

export function createCommittedSessionEventHub(input?: {
  readonly onListenerError?: () => void
}): CommittedSessionEventHub {
  const listenersBySession = new Map<string, Set<(event: SseEvent) => void>>()
  const hub: CommittedSessionEventHub = {
    subscribe(sessionId: string, listener: (event: SseEvent) => void) {
      const key = sessionId.toLowerCase()
      const listeners = listenersBySession.get(key) ?? new Set()
      listeners.add(listener)
      listenersBySession.set(key, listeners)
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        listeners.delete(listener)
        if (listeners.size === 0) listenersBySession.delete(key)
      }
    },
    publish(events: readonly [SseEvent, ...SseEvent[]]) {
      try {
        const parsed = events.map((event) =>
          deepFreeze(SseEventSchema.parse(event)),
        )
        const sessionId = parsed[0]?.sessionId
        if (
          sessionId === undefined ||
          parsed.some(
            (event, index) =>
              event.sessionId !== sessionId ||
              (index > 0 &&
                (event.eventSeq !== parsed[index - 1]!.eventSeq + 1 ||
                  event.stateVersion < parsed[index - 1]!.stateVersion)),
          )
        ) {
          throw new PublicProjectionInvariantError()
        }
        const listeners = listenersBySession.get(sessionId.toLowerCase())
        if (listeners === undefined) return
        for (const event of parsed) {
          for (const listener of [...listeners]) {
            try {
              listener(event)
            } catch {
              listeners.delete(listener)
              try {
                input?.onListenerError?.()
              } catch {
                // Listener diagnostics must not interrupt committed delivery.
              }
            }
          }
        }
        if (listeners.size === 0) {
          listenersBySession.delete(sessionId.toLowerCase())
        }
      } catch (error) {
        if (error instanceof PublicProjectionInvariantError) throw error
        throw new PublicProjectionInvariantError()
      }
    },
  }
  return Object.freeze(hub)
}
