import type { AuditVersionReference } from '../audit/audit-primitives.js'
import { AuditVersionReferenceSchema } from '../audit/audit-primitives.js'
import {
  StrategyPackReferenceSchema,
  type StrategyPackReference,
} from '../../poker-strategy/strategy-pack.js'

const STRATEGY_PACK_AUDIT_REFERENCE_PREFIX = 'strategy-pack/'

export function encodeStrategyPackAuditReference(
  reference: StrategyPackReference,
): AuditVersionReference {
  const parsed = StrategyPackReferenceSchema.parse(reference)
  return Object.freeze(
    AuditVersionReferenceSchema.parse({
      id: `${STRATEGY_PACK_AUDIT_REFERENCE_PREFIX}${parsed.datasetId}`,
      version: parsed.datasetVersion,
    }),
  )
}

export function decodeStrategyPackAuditReference(
  reference: AuditVersionReference,
): StrategyPackReference {
  const parsed = AuditVersionReferenceSchema.parse(reference)
  if (!parsed.id.startsWith(STRATEGY_PACK_AUDIT_REFERENCE_PREFIX)) {
    throw new RangeError('审计依赖不是 StrategyPack 引用。')
  }
  return Object.freeze(
    StrategyPackReferenceSchema.parse({
      datasetId: parsed.id.slice(STRATEGY_PACK_AUDIT_REFERENCE_PREFIX.length),
      datasetVersion: parsed.version,
    }),
  )
}

export function readPinnedStrategyPackReference(
  dependencies: readonly AuditVersionReference[],
): StrategyPackReference {
  const matches = dependencies.filter(({ id }) =>
    id.startsWith(STRATEGY_PACK_AUDIT_REFERENCE_PREFIX),
  )
  if (matches.length !== 1) {
    throw new RangeError('Player Run 必须固化且仅固化一个 StrategyPack 引用。')
  }
  return decodeStrategyPackAuditReference(matches[0]!)
}
