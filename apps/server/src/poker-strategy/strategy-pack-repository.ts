import {
  parseStrategyPack,
  type StrategyPack,
  type StrategyPackReference,
} from './strategy-pack.js'

export class StrategyPackUnavailableError extends Error {
  public constructor(
    public readonly reason: 'missing' | 'revoked' | 'deprecated',
  ) {
    super('固定策略包版本不可用。')
    this.name = 'StrategyPackUnavailableError'
  }
}

export interface StrategyPackRepository {
  read(input: {
    readonly reference: StrategyPackReference
    readonly usage: 'newRun' | 'pinnedRun'
  }): StrategyPack
}

export const EMPTY_AUTHORIZED_STRATEGY_PACK = parseStrategyPack({
  strategyPackSchemaVersion: 1,
  datasetId: 'm45-empty-authorized',
  datasetVersion: 1,
  status: 'active',
  pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
  abstractionProfile: {
    profileId: 'm45-no-production-coverage',
    version: 1,
    descriptionCode: 'authorizedEmptyCoverage',
  },
  records: [],
})

export function createStaticStrategyPackRepository(
  packs: readonly StrategyPack[] = [EMPTY_AUTHORIZED_STRATEGY_PACK],
): StrategyPackRepository {
  const byKey = new Map<string, StrategyPack>()
  for (const rawPack of packs) {
    const pack = parseStrategyPack(rawPack)
    const key = `${pack.datasetId}@${pack.datasetVersion}`
    if (byKey.has(key)) throw new RangeError('静态策略包版本不得重复。')
    byKey.set(key, pack)
  }
  return Object.freeze({
    read(input: {
      readonly reference: StrategyPackReference
      readonly usage: 'newRun' | 'pinnedRun'
    }) {
      const pack = byKey.get(
        `${input.reference.datasetId}@${input.reference.datasetVersion}`,
      )
      if (pack === undefined) throw new StrategyPackUnavailableError('missing')
      if (pack.status === 'revoked') {
        throw new StrategyPackUnavailableError('revoked')
      }
      if (pack.status === 'deprecated' && input.usage === 'newRun') {
        throw new StrategyPackUnavailableError('deprecated')
      }
      return pack
    },
  })
}
