import type { PrivateEventV1 } from './private-event.js'
import type { PrivateEventVersionRegistry } from './private-event-version-registry.js'
import type { PrivateTableState } from './private-table-state.js'
import type { SnapshotVersionRegistry } from './snapshot-version-registry.js'

export const SESSION_DIAGNOSTIC_CODES = [
  'legacyDiagnosticState',
  'eventSequenceInvalid',
  'eventVersionUnknown',
  'eventPayloadInvalid',
  'eventRowMismatch',
  'snapshotMissing',
  'snapshotVersionUnknown',
  'snapshotPayloadInvalid',
  'stateVersionMismatch',
  'handRelationshipInvalid',
] as const

export type SessionDiagnosticCode = (typeof SESSION_DIAGNOSTIC_CODES)[number]

export interface StoredSnapshotRow {
  readonly rowPayloadVersion: number
  readonly payload: unknown
}

export interface StoredPrivateEventRow {
  readonly eventSeq: number
  readonly handId: string | null
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly rowPayloadVersion: number
  readonly payload: unknown
}

export interface SessionRecoveryFacts {
  readonly session: {
    readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
    readonly endedAt: string | null
    readonly stateVersion: number
    readonly nextEventSeq: number
    readonly currentHandId: string | null
    readonly diagnosticCode: SessionDiagnosticCode | null
    readonly diagnosedAt: string | null
  }
  readonly snapshotRow: StoredSnapshotRow | null
  readonly inProgressHandIds: readonly string[]
  readonly eventRows: readonly StoredPrivateEventRow[]
}

export interface RecoveryRegistries {
  readonly snapshot: SnapshotVersionRegistry
  readonly privateEvent: PrivateEventVersionRegistry
}

export type RecoveryDecision =
  | { readonly kind: 'ready'; readonly state: PrivateTableState }
  | {
      readonly kind: 'repairCurrentHandPointer'
      readonly state: PrivateTableState
      readonly currentHandId: string | null
    }
  | {
      readonly kind: 'readonlyDiagnostic'
      readonly code: SessionDiagnosticCode
    }

const DIAGNOSTIC_SUMMARIES: Readonly<Record<SessionDiagnosticCode, string>> =
  Object.freeze({
    legacyDiagnosticState: '场次需要重新执行诊断恢复。',
    eventSequenceInvalid: '场次事件序列不完整。',
    eventVersionUnknown: '场次事件版本暂不受支持。',
    eventPayloadInvalid: '场次事件数据无法读取。',
    eventRowMismatch: '场次事件结构化事实不一致。',
    snapshotMissing: '场次权威快照缺失。',
    snapshotVersionUnknown: '场次快照版本暂不受支持。',
    snapshotPayloadInvalid: '场次快照数据无法读取。',
    stateVersionMismatch: '场次状态版本事实不一致。',
    handRelationshipInvalid: '场次当前手牌关系无法解释。',
  })

function diagnostic(code: SessionDiagnosticCode): RecoveryDecision {
  return Object.freeze({ kind: 'readonlyDiagnostic', code })
}

function isSafeNonnegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function normalizeUuid(value: string): string {
  return value.toLowerCase()
}

function privateEventHandId(event: PrivateEventV1): string {
  return event.type === 'handStarted' ? event.startedHand.handId : event.handId
}

function hasExactEventSequence(
  eventRows: readonly StoredPrivateEventRow[],
  nextEventSeq: number,
): boolean {
  if (
    !isSafeNonnegativeInteger(nextEventSeq) ||
    nextEventSeq === 0 ||
    eventRows.length !== nextEventSeq
  ) {
    return false
  }
  return eventRows.every(
    (row, index) =>
      isSafeNonnegativeInteger(row.eventSeq) && row.eventSeq === index,
  )
}

function hasValidEventVersionChain(
  eventRows: readonly StoredPrivateEventRow[],
): boolean {
  let previousBefore: number | null = null
  let previousAfter: number | null = null
  for (const [index, row] of eventRows.entries()) {
    if (
      !isSafeNonnegativeInteger(row.stateVersionBefore) ||
      !isSafeNonnegativeInteger(row.stateVersionAfter)
    ) {
      return false
    }
    const before = BigInt(row.stateVersionBefore)
    const after = BigInt(row.stateVersionAfter)
    if (after !== before && after !== before + 1n) {
      return false
    }
    if (index === 0 && row.stateVersionBefore !== 0) {
      return false
    }
    if (previousBefore !== null && previousAfter !== null) {
      const isSameSegment =
        row.stateVersionBefore === previousBefore &&
        row.stateVersionAfter === previousAfter
      if (!isSameSegment && row.stateVersionBefore !== previousAfter) {
        return false
      }
    }
    previousBefore = row.stateVersionBefore
    previousAfter = row.stateVersionAfter
  }
  return true
}

function hasValidHandRelationship(
  state: PrivateTableState,
  facts: SessionRecoveryFacts,
): boolean {
  if (facts.inProgressHandIds.length > 1) {
    return false
  }
  const originalLifecycle =
    facts.session.lifecycleStatus === 'readonlyDiagnostic'
      ? facts.session.endedAt === null
        ? 'active'
        : 'ended'
      : facts.session.lifecycleStatus
  if (
    originalLifecycle === 'ended' &&
    state.poker.pokerPhase !== 'betweenHands'
  ) {
    return false
  }
  if (state.poker.pokerPhase === 'betweenHands') {
    return facts.inProgressHandIds.length === 0
  }
  const snapshotHandId = state.poker.hand?.handId
  return (
    snapshotHandId !== undefined &&
    facts.inProgressHandIds.length === 1 &&
    normalizeUuid(facts.inProgressHandIds[0]!) === normalizeUuid(snapshotHandId)
  )
}

export function isSessionDiagnosticCode(
  value: unknown,
): value is SessionDiagnosticCode {
  return (
    typeof value === 'string' &&
    (SESSION_DIAGNOSTIC_CODES as readonly string[]).includes(value)
  )
}

export function getSessionDiagnosticSummary(
  code: SessionDiagnosticCode,
): string {
  return DIAGNOSTIC_SUMMARIES[code]
}

export function decideSessionRecovery(
  facts: SessionRecoveryFacts,
  registries: RecoveryRegistries,
): RecoveryDecision {
  const eventRows = [...facts.eventRows].sort(
    (left, right) => left.eventSeq - right.eventSeq,
  )
  if (!hasExactEventSequence(eventRows, facts.session.nextEventSeq)) {
    return diagnostic('eventSequenceInvalid')
  }

  for (const row of eventRows) {
    const result = registries.privateEvent.read(
      row.rowPayloadVersion,
      row.payload,
    )
    if (result.kind === 'unknownVersion') {
      return diagnostic('eventVersionUnknown')
    }
    if (result.kind === 'invalidPayload') {
      return diagnostic('eventPayloadInvalid')
    }
    if (
      row.handId === null ||
      normalizeUuid(row.handId) !==
        normalizeUuid(privateEventHandId(result.value))
    ) {
      return diagnostic('eventRowMismatch')
    }
  }

  if (!hasValidEventVersionChain(eventRows)) {
    return diagnostic('eventRowMismatch')
  }
  if (
    !isSafeNonnegativeInteger(facts.session.stateVersion) ||
    eventRows.at(-1)!.stateVersionAfter !== facts.session.stateVersion
  ) {
    return diagnostic('stateVersionMismatch')
  }

  if (facts.snapshotRow === null) {
    return diagnostic('snapshotMissing')
  }
  const snapshotResult = registries.snapshot.read(
    facts.snapshotRow.rowPayloadVersion,
    facts.snapshotRow.payload,
  )
  if (snapshotResult.kind === 'unknownVersion') {
    return diagnostic('snapshotVersionUnknown')
  }
  if (snapshotResult.kind === 'invalidPayload') {
    return diagnostic('snapshotPayloadInvalid')
  }
  if (snapshotResult.value.stateVersion !== facts.session.stateVersion) {
    return diagnostic('stateVersionMismatch')
  }
  if (!hasValidHandRelationship(snapshotResult.value, facts)) {
    return diagnostic('handRelationshipInvalid')
  }

  const expectedCurrentHandId =
    snapshotResult.value.poker.pokerPhase === 'inHand'
      ? snapshotResult.value.poker.hand!.handId
      : null
  const currentPointerMatches =
    expectedCurrentHandId === null
      ? facts.session.currentHandId === null
      : facts.session.currentHandId !== null &&
        normalizeUuid(facts.session.currentHandId) ===
          normalizeUuid(expectedCurrentHandId)
  if (!currentPointerMatches) {
    return Object.freeze({
      kind: 'repairCurrentHandPointer',
      state: snapshotResult.value,
      currentHandId: expectedCurrentHandId,
    })
  }
  return Object.freeze({ kind: 'ready', state: snapshotResult.value })
}
