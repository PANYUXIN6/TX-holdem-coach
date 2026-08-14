import { describe, expect, test } from 'vitest'
import {
  isPreparedContextEnvelope,
  prepareContextEnvelope,
  type ContextEnvelope,
} from '../../src/agents/foundation/context-envelope.js'
import { playerRuntimeDefinitionV1 } from '../../src/agents/player/foundation-definition.js'

const playerBudget = playerRuntimeDefinitionV1.budgetPolicy.createSnapshot({
  runtimeType: 'player',
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45,
})

function playerEnvelope(): ContextEnvelope<'player', 'decision'> {
  const sectionIds = [
    'protocol',
    'persona',
    'observation',
    'memory',
    'metrics',
    'strategy',
    'candidates',
    'constraints',
  ] as const
  return {
    runtimeType: 'player',
    runtimeDefinitionVersion: 1,
    contextSchemaVersion: 1,
    contextKind: 'decision',
    promptModules: playerRuntimeDefinitionV1.promptModules,
    sourceVersions: [
      {
        source: { id: 'foundation.token-estimator', version: 1 },
        contentVersion: 'v1',
      },
    ],
    sections: sectionIds.map((sectionId) => ({
      sectionId,
      schema: {
        id: `player.context.decision.${sectionId}`,
        version: 1,
      },
      payload: { b: 2, a: 1 },
    })),
  }
}

function withFirstPayload(
  envelope: ContextEnvelope<'player', 'decision'>,
  payload: unknown,
): ContextEnvelope<'player', 'decision'> {
  return {
    ...envelope,
    sections: envelope.sections.map((section, index) =>
      index === 0 ? { ...section, payload } : section,
    ),
  }
}

describe('M4.1 context envelope', () => {
  test('canonicalizes, hashes, authenticates and recursively freezes exact sections', () => {
    const first = prepareContextEnvelope({
      definition: playerRuntimeDefinitionV1,
      envelope: playerEnvelope(),
      budget: playerBudget,
    })
    const reorderedPayload = withFirstPayload(playerEnvelope(), {
      a: 1,
      b: 2,
    })
    const second = prepareContextEnvelope({
      definition: playerRuntimeDefinitionV1,
      envelope: reorderedPayload,
      budget: playerBudget,
    })

    expect(first.sha256).toBe(second.sha256)
    expect(first.serialized).toBe(second.serialized)
    expect(first.estimatedInputTokens).toBeGreaterThan(0)
    expect(isPreparedContextEnvelope(first)).toBe(true)
    expect(isPreparedContextEnvelope({ ...first })).toBe(false)
    expect(Object.isFrozen(first)).toBe(true)
  })

  test('rejects missing, extra, duplicate or reordered partitions and mismatched versions', () => {
    const base = playerEnvelope()
    for (const envelope of [
      { ...base, sections: base.sections.slice(1) },
      { ...base, sections: [...base.sections, base.sections[0]] },
      {
        ...base,
        sections: [
          base.sections[1],
          base.sections[0],
          ...base.sections.slice(2),
        ],
      },
      { ...base, runtimeDefinitionVersion: 2 },
      { ...base, contextKind: 'hindsight' },
    ]) {
      expect(() =>
        prepareContextEnvelope({
          definition: playerRuntimeDefinitionV1,
          envelope: envelope as ContextEnvelope<'player', 'decision'>,
          budget: playerBudget,
        }),
      ).toThrow()
    }
  })

  test('rejects non-JSON, sensitive and over-budget payloads without truncation', () => {
    const invalidValues = [
      undefined,
      Number.NaN,
      () => undefined,
      new Date(),
      'postgresql://user:password@localhost/db',
      { reasoning_content: 'hidden' },
      { holeCards: ['As', 'Ah'] },
    ]
    for (const payload of invalidValues) {
      const envelope = withFirstPayload(playerEnvelope(), payload)
      expect(() =>
        prepareContextEnvelope({
          definition: playerRuntimeDefinitionV1,
          envelope,
          budget: playerBudget,
          forbiddenFieldNames: ['holeCards'],
        }),
      ).toThrow()
    }

    const envelope = withFirstPayload(playerEnvelope(), 'x'.repeat(1_000))
    expect(() =>
      prepareContextEnvelope({
        definition: playerRuntimeDefinitionV1,
        envelope,
        budget: { ...playerBudget, maxInputTokens: 10 },
      }),
    ).toThrow()
  })
})
