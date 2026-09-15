import {
  PlayerAgentSettingsSchema,
  type PlayerAgentSettings,
  type ProviderSettingsResponse,
} from '@tx-holdem-coach/contracts'
import { providerStatusMessages } from '../api/errors.js'
export type BudgetDraft = Record<keyof PlayerAgentSettings, string>
export const budgetFields = [
  'attemptTimeoutSeconds',
  'decisionDeadlineSeconds',
] as const
export function budgetDraft(value: PlayerAgentSettings): BudgetDraft {
  return {
    attemptTimeoutSeconds: String(value.attemptTimeoutSeconds),
    decisionDeadlineSeconds: String(value.decisionDeadlineSeconds),
  }
}
export function budgetCandidate(draft: BudgetDraft) {
  return PlayerAgentSettingsSchema.safeParse(
    Object.fromEntries(
      budgetFields.map((key) => [
        key,
        /^\d+$/.test(draft[key]) ? Number(draft[key]) : NaN,
      ]),
    ),
  )
}
export function budgetPatch(
  baseline: PlayerAgentSettings,
  candidate: PlayerAgentSettings,
) {
  return {
    settings: Object.fromEntries(
      budgetFields
        .filter((key) => baseline[key] !== candidate[key])
        .map((key) => [key, candidate[key]]),
    ) as Partial<PlayerAgentSettings>,
  }
}
export function providerSummary(value: ProviderSettingsResponse['deepSeek']) {
  return {
    key: value.configured ? '已配置' : '未配置',
    capacity: value.canCreateSession ? '可创建场次' : '不可创建场次',
    status: providerStatusMessages[value.checkStatus],
  }
}
export const chips = (value: number) => `${value.toLocaleString('zh-CN')} 筹码`
export const lifecycleLabels = {
  active: '活动场次',
  ended: '已结束场次',
  readonlyDiagnostic: '只读诊断场次',
} as const
