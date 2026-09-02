import {
  parseStrategyPack,
  type StrategyPack,
  type StrategyPackReference,
} from './strategy-pack.js'
import { POKER_RULE_SET_VERSION } from '../poker/poker-rule-set.js'

export class StrategyPackUnavailableError extends Error {
  public constructor(
    public readonly reason: 'missing' | 'revoked' | 'deprecated',
  ) {
    super('固定策略包版本不可用。')
    this.name = 'StrategyPackUnavailableError'
  }
}

export class ActiveStrategyPackResolutionError extends Error {
  public constructor(public readonly reason: 'missing' | 'ambiguous') {
    super(
      reason === 'missing'
        ? '当前规则集没有可用于新运行的激活策略包。'
        : '当前规则集存在多个可用于新运行的激活策略包。',
    )
    this.name = 'ActiveStrategyPackResolutionError'
  }
}

export interface StrategyPackRepository {
  resolveActiveForNewRun(input: {
    readonly pokerRuleSetVersion: typeof POKER_RULE_SET_VERSION
  }): StrategyPack
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
  const activeByRuleSet = new Map<string, StrategyPack>()
  for (const rawPack of packs) {
    const pack = parseStrategyPack(rawPack)
    const key = `${pack.datasetId}@${pack.datasetVersion}`
    if (byKey.has(key)) throw new RangeError('静态策略包版本不得重复。')
    byKey.set(key, pack)
    if (pack.status === 'active') {
      if (activeByRuleSet.has(pack.pokerRuleSetVersion)) {
        throw new ActiveStrategyPackResolutionError('ambiguous')
      }
      activeByRuleSet.set(pack.pokerRuleSetVersion, pack)
    }
  }
  return Object.freeze({
    resolveActiveForNewRun(input: {
      readonly pokerRuleSetVersion: typeof POKER_RULE_SET_VERSION
    }) {
      const pack = activeByRuleSet.get(input.pokerRuleSetVersion)
      if (pack === undefined)
        throw new ActiveStrategyPackResolutionError('missing')
      return pack
    },
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
