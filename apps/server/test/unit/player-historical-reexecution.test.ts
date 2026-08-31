import { describe, expect, test } from 'vitest'
import {
  certifyHistoricalReexecutionSourceV1,
  type HistoricalReexecutionSourceV1,
} from '../../src/agents/player/player-historical-reexecution.js'
import {
  createFrozenPlayerModelInputV1,
  hashFrozenPlayerModelInputV1,
} from '../../src/agents/player/player-frozen-model-input.js'

function source(): HistoricalReexecutionSourceV1 {
  const frozenModelInput = createFrozenPlayerModelInputV1({
    contextSha256: 'a'.repeat(64),
    messages: [
      { role: 'system', content: '固定系统消息。' },
      { role: 'user', content: '固定用户消息。' },
    ],
    maximumRequestBytes: 33_000,
    estimatedInputTokens: 128,
    routePolicy: {
      policy: { id: 'player.route-policy', version: 1 },
      pricingPolicy: { id: 'foundation.deepseek-pricing-cny', version: 1 },
      provider: 'deepseek',
      maximumContentCorrections: 2,
    },
    modelSelection: {
      modelId: 'deepseek-v4-flash',
      temperature: 0.2,
      maxOutputTokens: 256,
      thinkingMode: 'disabled',
    },
    outputSchema: { id: 'player.output.decision', version: 1 },
    validator: { id: 'player.validator.decision', version: 1 },
  })
  return {
    sourceRunId: '60000000-0000-4000-8000-000000000049',
    sourceDecisionId: '70000000-0000-4000-8000-000000000049',
    executionMode: 'live',
    status: 'modelPrepared',
    snapshotSha256: 'b'.repeat(64),
    candidateSetSha256: 'c'.repeat(64),
    projectionSha256: 'd'.repeat(64),
    frozenModelInput,
    frozenModelInputSha256: hashFrozenPlayerModelInputV1(frozenModelInput),
  }
}

describe('M4.9 Historical Re-execution source', () => {
  test('只接受已固化 model input 的 live 来源，并保持 Provider 初始消息逐字节不变', () => {
    const certified = certifyHistoricalReexecutionSourceV1(source())

    expect(certified.frozenModelInput.messages).toEqual([
      { role: 'system', content: '固定系统消息。' },
      { role: 'user', content: '固定用户消息。' },
    ])
    expect(certified).toEqual(
      expect.objectContaining({
        sourceRunId: '60000000-0000-4000-8000-000000000049',
        sourceDecisionId: '70000000-0000-4000-8000-000000000049',
      }),
    )
    expect(() =>
      certifyHistoricalReexecutionSourceV1({
        ...source(),
        executionMode: 'historicalReexecution',
      }),
    ).toThrow(/来源/)
    expect(() =>
      certifyHistoricalReexecutionSourceV1({
        ...source(),
        frozenModelInputSha256: 'f'.repeat(64),
      }),
    ).toThrow(/摘要/)
  })
})
