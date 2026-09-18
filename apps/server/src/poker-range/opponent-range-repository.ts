import {
  parseOpponentRangePack,
  type OpponentRangePack,
  type OpponentRangePackReference,
} from './opponent-range-pack.js'
import type { PokerRuleSetVersion } from '../poker/poker-rule-set.js'

export class OpponentRangePackUnavailableError extends Error {
  constructor(
    public readonly reason: 'missing' | 'revoked' | 'deprecated' | 'ambiguous',
  ) {
    super(`opponent_range_pack_${reason}`)
    this.name = 'OpponentRangePackUnavailableError'
  }
}
const repositoryPacks = new WeakSet<object>()
export function assertRepositoryOpponentRangePack(
  pack: OpponentRangePack,
): void {
  if (!repositoryPacks.has(pack)) throw new TypeError('range_untrusted_pack')
  if (pack.status === 'revoked')
    throw new OpponentRangePackUnavailableError('revoked')
}
export interface OpponentRangeRepository {
  read(input: {
    readonly reference: OpponentRangePackReference
    readonly usage: 'newRun' | 'pinnedRun'
  }): OpponentRangePack
  resolveActiveForNewRun(input: {
    readonly pokerRuleSetVersion: PokerRuleSetVersion
  }): OpponentRangePack
}
export function createStaticOpponentRangeRepository(
  packs: readonly unknown[] = [],
): OpponentRangeRepository {
  const stored = new Map<string, OpponentRangePack>()
  for (const raw of packs) {
    const pack = parseOpponentRangePack(raw)
    const key = `${pack.datasetId}@${pack.datasetVersion}`
    if (stored.has(key)) throw new TypeError('range_duplicate_pack_version')
    stored.set(key, pack)
    repositoryPacks.add(pack)
  }
  return Object.freeze({
    read({
      reference,
      usage,
    }: {
      readonly reference: OpponentRangePackReference
      readonly usage: 'newRun' | 'pinnedRun'
    }) {
      const pack = stored.get(
        `${reference.datasetId}@${reference.datasetVersion}`,
      )
      if (!pack) throw new OpponentRangePackUnavailableError('missing')
      if (
        pack.status === 'revoked' ||
        (pack.status === 'deprecated' && usage === 'newRun')
      )
        throw new OpponentRangePackUnavailableError(pack.status)
      return pack
    },
    resolveActiveForNewRun({
      pokerRuleSetVersion,
    }: {
      readonly pokerRuleSetVersion: PokerRuleSetVersion
    }) {
      const active = [...stored.values()].filter(
        (pack) =>
          pack.pokerRuleSetVersion === pokerRuleSetVersion &&
          pack.status === 'active',
      )
      if (active.length !== 1)
        throw new OpponentRangePackUnavailableError(
          active.length ? 'ambiguous' : 'missing',
        )
      return active[0]!
    },
  })
}
