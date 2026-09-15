import { describe, expect, it } from 'vitest'
import {
  budgetCandidate,
  budgetPatch,
  providerSummary,
  chips,
} from '../src/settings/adapter.js'

describe('设置页公开投影与预算', () => {
  it('检测不可用不改变配置和开场能力', () => {
    expect(
      providerSummary({
        configured: true,
        canCreateSession: true,
        checkStatus: 'unavailable',
        lastCheckedAt: null,
        errorCode: 'provider_timeout',
      }),
    ).toMatchObject({
      key: '已配置',
      capacity: '可创建场次',
      status: '检测不可用',
    })
  })
  it('完整候选拒绝空值、小数、越界和交叉冲突', () => {
    for (const draft of [
      { attemptTimeoutSeconds: '', decisionDeadlineSeconds: '45' },
      { attemptTimeoutSeconds: '5.5', decisionDeadlineSeconds: '45' },
      { attemptTimeoutSeconds: '31', decisionDeadlineSeconds: '45' },
      { attemptTimeoutSeconds: '30', decisionDeadlineSeconds: '15' },
    ])
      expect(budgetCandidate(draft).success).toBe(false)
    expect(
      budgetCandidate({
        attemptTimeoutSeconds: '5',
        decisionDeadlineSeconds: '120',
      }).success,
    ).toBe(true)
  })
  it('只提交实际变化字段，完整显示安全整数和零', () => {
    expect(
      budgetPatch(
        { attemptTimeoutSeconds: 15, decisionDeadlineSeconds: 45 },
        { attemptTimeoutSeconds: 20, decisionDeadlineSeconds: 45 },
      ),
    ).toEqual({ settings: { attemptTimeoutSeconds: 20 } })
    expect(chips(Number.MAX_SAFE_INTEGER)).toBe('9,007,199,254,740,991 筹码')
    expect(chips(0)).toBe('0 筹码')
  })
})
