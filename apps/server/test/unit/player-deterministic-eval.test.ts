import { describe, expect, test } from 'vitest'
import { runPlayerDeterministicEval } from '../../eval/player/player-deterministic-eval-runner.js'
import {
  buildPlayerEvalSessionMemory,
  buildPlayerEvalObservation,
  readPlayerEvalScenarios,
} from '../../eval/player/player-eval-scenarios.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'

describe('Player deterministic eval', () => {
  test('回放固定场景声明的真实加注、短码与边池行动，而非用被动行动凑到目标座位', () => {
    const expectedScripts = {
      'eight-handed-squeeze': [
        { actorSeat: 3, action: { type: 'raise', targetStreetCommitment: 60 } },
        { actorSeat: 4, action: { type: 'call' } },
      ],
      'nine-handed-four-bet': [
        { actorSeat: 3, action: { type: 'raise', targetStreetCommitment: 60 } },
        {
          actorSeat: 4,
          action: { type: 'raise', targetStreetCommitment: 140 },
        },
        {
          actorSeat: 5,
          action: { type: 'raise', targetStreetCommitment: 300 },
        },
      ],
      'short-all-in-no-reopen': [
        { actorSeat: 3, action: { type: 'raise', targetStreetCommitment: 60 } },
        { actorSeat: 4, action: { type: 'call' } },
        { actorSeat: 5, action: { type: 'allIn' } },
        { actorSeat: 0, action: { type: 'call' } },
        { actorSeat: 1, action: { type: 'call' } },
        { actorSeat: 2, action: { type: 'call' } },
      ],
      'full-raise-reopen': [
        { actorSeat: 3, action: { type: 'raise', targetStreetCommitment: 60 } },
        {
          actorSeat: 4,
          action: { type: 'raise', targetStreetCommitment: 140 },
        },
        { actorSeat: 5, action: { type: 'call' } },
        { actorSeat: 6, action: { type: 'call' } },
        { actorSeat: 0, action: { type: 'call' } },
        { actorSeat: 1, action: { type: 'call' } },
        { actorSeat: 2, action: { type: 'call' } },
      ],
      'side-pot-eligibility': [
        { actorSeat: 3, action: { type: 'allIn' } },
        {
          actorSeat: 4,
          action: { type: 'raise', targetStreetCommitment: 200 },
        },
        { actorSeat: 5, action: { type: 'allIn' } },
        { actorSeat: 6, action: { type: 'call' } },
        { actorSeat: 7, action: { type: 'call' } },
        { actorSeat: 8, action: { type: 'call' } },
        { actorSeat: 0, action: { type: 'call' } },
      ],
    } as const
    const scenarios = new Map(
      readPlayerEvalScenarios().map((scenario) => [
        scenario.scenarioId,
        scenario,
      ]),
    )

    for (const [scenarioId, expectedScript] of Object.entries(
      expectedScripts,
    )) {
      const scenario = scenarios.get(scenarioId)
      expect(scenario, scenarioId).toBeDefined()
      const declaredScript = (
        scenario!.input as unknown as {
          readonly actionScript?: readonly unknown[]
        }
      ).actionScript
      expect(declaredScript, scenarioId).toEqual(expectedScript)
      const observation = buildPlayerObservationDraft(
        buildPlayerEvalObservation(scenario!),
      )
      expect(
        observation.hand.publicActions.map((entry) => ({
          actorSeat: entry.actorSeatNumber,
          action: entry.action.action,
        })),
        scenarioId,
      ).toEqual(expectedScript)
    }
  })

  test('固定场景独立声明候选金额、可争夺底池、pot odds、牌力和跨手 Memory 断言', () => {
    const scenarios = new Map(
      readPlayerEvalScenarios().map((scenario) => [
        scenario.scenarioId,
        scenario,
      ]),
    )

    for (const scenario of scenarios.values()) {
      const assertions = scenario.assertions as unknown as Record<
        string,
        unknown
      >
      expect(assertions, scenario.scenarioId).toHaveProperty('candidateSizing')
      expect(assertions, scenario.scenarioId).toHaveProperty('contestablePot')
      expect(assertions, scenario.scenarioId).toHaveProperty('potOdds')
      expect(assertions, scenario.scenarioId).toHaveProperty('handFeatures')
    }

    const sidePot = scenarios.get('side-pot-eligibility')
    expect(sidePot).toBeDefined()
    expect(sidePot!.input.targetStreet).toBe('preflop')
    expect(sidePot!.input.targetActorSeat).toBe(1)
    expect(
      (
        sidePot!.assertions as unknown as {
          readonly contestablePot?: {
            readonly potBreakdown?: readonly {
              readonly eligibleSeatNumbers: readonly number[]
            }[]
          }
        }
      ).contestablePot?.potBreakdown?.some(
        ({ eligibleSeatNumbers }) => !eligibleSeatNumbers.includes(1),
      ),
    ).toBe(true)

    const memory = scenarios.get('memory-cutoff-zero-exploit')
    expect(memory).toBeDefined()
    expect(memory!.input as unknown as Record<string, unknown>).toHaveProperty(
      'memoryHistory',
    )
    expect(
      memory!.assertions as unknown as Record<string, unknown>,
    ).toHaveProperty('memory')
  })

  test('turn 牌力场景逐项声明未来牌、redraw 与 counterfeit 原子事实', () => {
    const turnScenarios = readPlayerEvalScenarios().filter(
      (scenario) =>
        (scenario.assertions.handFeatures as { readonly kind: string }).kind ===
        'postflop',
    )

    expect(turnScenarios.length).toBeGreaterThan(0)
    for (const scenario of turnScenarios) {
      const handFeatures = scenario.assertions.handFeatures as unknown as {
        readonly structuralOutCards: Record<string, unknown>
        readonly redrawFacts: Record<string, unknown>
        readonly counterfeitRiskFacts: Record<string, unknown>
      }
      for (const fact of [
        handFeatures.structuralOutCards,
        handFeatures.redrawFacts,
        handFeatures.counterfeitRiskFacts,
      ]) {
        if (fact.status === 'available') {
          expect(fact, scenario.scenarioId).toHaveProperty('valueSha256')
          expect(fact, scenario.scenarioId).not.toHaveProperty('count')
        }
      }
    }
  })

  test('Memory revision 使用当前观察版本，历史截止点仅存在于 payload', () => {
    const scenario = readPlayerEvalScenarios().find(
      ({ scenarioId }) => scenarioId === 'memory-cutoff-zero-exploit',
    )
    expect(scenario).toBeDefined()
    const observation = buildPlayerEvalObservation(scenario!)
    const memory = buildPlayerEvalSessionMemory(
      scenario!,
      observation.asOfEventSeq,
    )

    expect(memory.asOfEventSeq).toBe(observation.asOfEventSeq)
    expect(memory.payload.scannedThrough).toEqual({
      handNumber: 3,
      eventSeq: 30,
    })
  })

  test('runs every fixed scenario through the Player pure chain and safety grader', () => {
    const result = runPlayerDeterministicEval()

    expect(result.scenarioCount).toBe(12)
    expect(result.scenarios.every((scenario) => scenario.passed)).toBe(true)
  })
})
