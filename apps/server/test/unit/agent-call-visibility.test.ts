import { describe, expect, it } from 'vitest'
import { projectNormalizedActionVisibility } from '../../src/agents/audit/agent-call-visibility.js'

describe('M5.5 Agent 决策可见性', () => {
  it('进行中只公开已提交且账本认证的 live 行动', () => {
    expect(
      projectNormalizedActionVisibility({
        handStatus: 'inProgress',
        executionMode: 'live',
        decisionStatus: 'selected',
        action: { type: 'check' },
        commandRange: null,
      }),
    ).toEqual({ status: 'withheld' })
    expect(
      projectNormalizedActionVisibility({
        handStatus: 'inProgress',
        executionMode: 'live',
        decisionStatus: 'committed',
        action: { type: 'check' },
        commandRange: { firstEventSeq: 1, lastEventSeq: 1 },
      }),
    ).toEqual({ status: 'visible', action: { type: 'check' } })
  })

  it('中止手一律隐藏，完成手区分未选择与已选择', () => {
    expect(
      projectNormalizedActionVisibility({
        handStatus: 'aborted',
        executionMode: 'live',
        decisionStatus: 'committed',
        action: { type: 'fold' },
        commandRange: { firstEventSeq: 1, lastEventSeq: 2 },
      }),
    ).toEqual({ status: 'withheld' })
    expect(
      projectNormalizedActionVisibility({
        handStatus: 'completed',
        executionMode: 'historicalReexecution',
        decisionStatus: 'modelPrepared',
        action: null,
        commandRange: null,
      }),
    ).toEqual({ status: 'notSelected' })
  })
})
