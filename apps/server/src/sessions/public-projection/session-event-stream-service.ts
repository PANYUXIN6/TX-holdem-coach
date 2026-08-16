import { randomUUID } from 'node:crypto'
import {
  SseEventSchema,
  type PublicSessionSnapshot,
  type SseEvent,
} from '@tx-holdem-coach/contracts'
import {
  DatabaseOperationError,
  ResourceNotFoundError,
} from '../../persistence/errors.js'
import type { CommittedSessionEventHub } from './committed-session-event-hub.js'
import {
  PublicProjectionInvariantError,
  SessionReadonlyDiagnosticError,
} from './errors.js'
import {
  REPLAY_PAGE_SIZE,
  type PublicEventReplayRepository,
  type ReplayPageProof,
} from './public-event-replay.js'
import {
  decodeStoredPublicEvent,
  hashStoredPublicEventPage,
  type StoredPublicEventDecodeFailureReason,
} from './public-event-protocol.js'
import {
  createPendingSessionEventConnection,
  type OpenSessionEventStream,
  type SessionEventStreamDiagnostic,
} from './session-event-connection.js'
import { projectPublicSessionSnapshot } from './public-session-projector.js'

export type ParsedLastEventId =
  | { readonly kind: 'absent' }
  | { readonly kind: 'candidate'; readonly eventSeq: number }
  | {
      readonly kind: 'invalid'
      readonly reason: 'invalidFormat' | 'negative' | 'unsafeInteger'
    }

export type SessionEventStreamCursorDiagnostic = {
  readonly category: 'sse_cursor_recalibrated'
  readonly reason:
    | 'invalidFormat'
    | 'negative'
    | 'unsafeInteger'
    | 'ahead'
    | 'sequenceGap'
    | StoredPublicEventDecodeFailureReason
}

export type SessionEventStreamServiceDiagnostic =
  SessionEventStreamCursorDiagnostic | SessionEventStreamDiagnostic

export interface SessionEventStreamService {
  open(input: {
    readonly sessionId: string
    readonly lastEventId: ParsedLastEventId
    readonly signal?: AbortSignal
  }): Promise<OpenSessionEventStream>
}

export function parseLastEventId(value: string | undefined): ParsedLastEventId {
  if (value === undefined) return { kind: 'absent' }
  if (/^-[0-9]+$/.test(value)) return { kind: 'invalid', reason: 'negative' }
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    return { kind: 'invalid', reason: 'invalidFormat' }
  }
  const integer = Number(value)
  if (!Number.isSafeInteger(integer)) {
    return { kind: 'invalid', reason: 'unsafeInteger' }
  }
  return { kind: 'candidate', eventSeq: integer }
}

export function createSnapshotCalibrationEvent(input: {
  readonly snapshot: PublicSessionSnapshot
  readonly eventId?: string
}): SseEvent {
  return SseEventSchema.parse({
    eventId: input.eventId ?? randomUUID(),
    sessionId: input.snapshot.sessionId,
    eventSeq: input.snapshot.eventSeq,
    stateVersion: input.snapshot.stateVersion,
    type: 'snapshot',
    payload: { snapshot: input.snapshot },
  })
}

function validateReplayPage(input: {
  readonly rows: Awaited<
    ReturnType<PublicEventReplayRepository['readReplayPage']>
  >
  readonly sessionId: string
  readonly fromEventSeq: number
  readonly throughEventSeq: number
  readonly previousStateVersion: number
}):
  | {
      readonly kind: 'valid'
      readonly proof: ReplayPageProof
      readonly lastStateVersion: number
    }
  | {
      readonly kind: 'invalid'
      readonly reason:
        StoredPublicEventDecodeFailureReason | 'sequenceGap' | 'missing'
    } {
  const expectedCount = input.throughEventSeq - input.fromEventSeq + 1
  if (input.rows === null) return { kind: 'invalid', reason: 'missing' }
  if (input.rows.length !== expectedCount) {
    return { kind: 'invalid', reason: 'sequenceGap' }
  }
  const events: SseEvent[] = []
  let previousStateVersion = input.previousStateVersion
  for (const [index, row] of input.rows.entries()) {
    const decoded = decodeStoredPublicEvent(row)
    if (decoded.kind === 'invalid') return decoded
    if (
      decoded.event.sessionId.toLowerCase() !== input.sessionId.toLowerCase() ||
      decoded.event.eventSeq !== input.fromEventSeq + index ||
      decoded.event.stateVersion < previousStateVersion
    ) {
      return { kind: 'invalid', reason: 'sequenceGap' }
    }
    previousStateVersion = decoded.event.stateVersion
    events.push(decoded.event)
  }
  return {
    kind: 'valid',
    proof: Object.freeze({
      fromEventSeq: input.fromEventSeq,
      throughEventSeq: input.throughEventSeq,
      eventCount: events.length,
      canonicalSha256: hashStoredPublicEventPage(events),
    }),
    lastStateVersion: previousStateVersion,
  }
}

export function createSessionEventStreamService(input: {
  readonly repository: PublicEventReplayRepository
  readonly hub: CommittedSessionEventHub
  readonly nextEventId?: () => string
  readonly diagnose?: (diagnostic: SessionEventStreamServiceDiagnostic) => void
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delayMs: number) => unknown
  readonly clearTimer?: (handle: unknown) => void
}): SessionEventStreamService {
  return Object.freeze({
    async open({
      sessionId,
      lastEventId,
      signal,
    }: {
      readonly sessionId: string
      readonly lastEventId: ParsedLastEventId
      readonly signal?: AbortSignal
    }) {
      signal?.throwIfAborted()
      const head = await input.repository.readHead(sessionId)
      signal?.throwIfAborted()
      if (head === null) throw new ResourceNotFoundError()
      if (head.lifecycleStatus === 'readonlyDiagnostic') {
        throw new SessionReadonlyDiagnosticError()
      }

      const pending = createPendingSessionEventConnection({
        sessionId,
        repository: input.repository,
        subscribe: (listener) => input.hub.subscribe(sessionId, listener),
        ...(signal === undefined ? {} : { signal }),
        ...(input.now === undefined ? {} : { now: input.now }),
        ...(input.setTimer === undefined ? {} : { setTimer: input.setTimer }),
        ...(input.clearTimer === undefined
          ? {}
          : { clearTimer: input.clearTimer }),
        ...(input.diagnose === undefined ? {} : { diagnose: input.diagnose }),
      })
      try {
        signal?.throwIfAborted()
        const bootstrap = await input.repository.readBootstrap(sessionId)
        signal?.throwIfAborted()
        if (bootstrap === null) throw new ResourceNotFoundError()
        if (bootstrap.kind === 'readonlyDiagnostic') {
          throw new SessionReadonlyDiagnosticError()
        }
        const hasContinuousHistory =
          bootstrap.highWatermark >= 0 &&
          bootstrap.totalEventCount === bootstrap.highWatermark + 1 &&
          bootstrap.minimumEventSeq === 0 &&
          bootstrap.maximumEventSeq === bootstrap.highWatermark
        const snapshot = projectPublicSessionSnapshot(bootstrap.facts)
        if (snapshot.lifecycleStatus === 'readonlyDiagnostic') {
          throw new SessionReadonlyDiagnosticError()
        }
        let replayFrom: number | null = null
        if (lastEventId.kind === 'invalid') {
          input.diagnose?.({
            category: 'sse_cursor_recalibrated',
            reason: lastEventId.reason,
          })
        } else if (lastEventId.kind === 'candidate') {
          if (lastEventId.eventSeq > bootstrap.highWatermark) {
            input.diagnose?.({
              category: 'sse_cursor_recalibrated',
              reason: 'ahead',
            })
          } else if (!hasContinuousHistory) {
            input.diagnose?.({
              category: 'sse_cursor_recalibrated',
              reason: 'sequenceGap',
            })
          } else if (lastEventId.eventSeq < bootstrap.highWatermark) {
            replayFrom = lastEventId.eventSeq + 1
          }
        } else if (!hasContinuousHistory) {
          input.diagnose?.({
            category: 'sse_cursor_recalibrated',
            reason: 'sequenceGap',
          })
        }

        let replayProofs: readonly ReplayPageProof[] = []
        if (replayFrom !== null) {
          const proofs: ReplayPageProof[] = []
          let previousStateVersion = -1
          for (
            let fromEventSeq = replayFrom;
            fromEventSeq <= bootstrap.highWatermark;
            fromEventSeq += REPLAY_PAGE_SIZE
          ) {
            signal?.throwIfAborted()
            if (pending.overflowed || pending.failed) {
              throw new DatabaseOperationError()
            }
            const throughEventSeq = Math.min(
              bootstrap.highWatermark,
              fromEventSeq + REPLAY_PAGE_SIZE - 1,
            )
            const page = validateReplayPage({
              rows: await input.repository.readReplayPage({
                sessionId,
                fromEventSeq,
                throughEventSeq,
              }),
              sessionId,
              fromEventSeq,
              throughEventSeq,
              previousStateVersion,
            })
            signal?.throwIfAborted()
            if (pending.overflowed || pending.failed) {
              throw new DatabaseOperationError()
            }
            if (page.kind === 'invalid') {
              if (page.reason === 'missing') {
                throw new PublicProjectionInvariantError()
              }
              input.diagnose?.({
                category: 'sse_cursor_recalibrated',
                reason: page.reason,
              })
              proofs.length = 0
              replayFrom = null
              break
            }
            proofs.push(page.proof)
            previousStateVersion = page.lastStateVersion
          }
          replayProofs = Object.freeze(proofs)
        }

        signal?.throwIfAborted()
        if (pending.overflowed || pending.failed)
          throw new DatabaseOperationError()
        return pending.activate({
          lifecycleStatus: snapshot.lifecycleStatus,
          highWatermark: bootstrap.highWatermark,
          replayProofs,
          calibrationEvent: createSnapshotCalibrationEvent({
            snapshot,
            ...(input.nextEventId === undefined
              ? {}
              : { eventId: input.nextEventId() }),
          }),
        })
      } catch (error) {
        pending.close()
        throw error
      }
    },
  })
}
