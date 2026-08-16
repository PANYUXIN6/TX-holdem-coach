import { describe, expect, test } from 'vitest'
import { coachRuntimeDefinition } from '../../src/agents/coach/foundation-definition.js'
import { createRuntimeRegistry } from '../../src/agents/foundation/runtime-registry.js'
import { createRuntimeBudgetPolicy } from '../../src/agents/foundation/execution-budget.js'
import type { RuntimeDefinitionMap } from '../../src/agents/foundation/runtime-definition.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import { productionRuntimeRegistry } from '../../src/agents/production-runtime-registry.js'

describe('M4.1 static runtime registry', () => {
  test('resolves only the static current and exact Player/Coach definitions', () => {
    expect(productionRuntimeRegistry.resolveCurrent('player')).toMatchObject({
      runtimeType: 'player',
      runtimeDefinitionVersion: 1,
      modelToolPolicy: 'none',
    })
    expect(productionRuntimeRegistry.resolveExact('coach', 1)).toMatchObject({
      runtimeType: 'coach',
      contextKinds: ['decisionAnalysis', 'hindsight'],
    })
    expect(
      productionRuntimeRegistry
        .listCurrent()
        .map(({ runtimeType }) => runtimeType),
    ).toEqual(['player', 'coach'])
    expect(() => productionRuntimeRegistry.resolveExact('player', 2)).toThrow()
    expect(() =>
      productionRuntimeRegistry.resolveCurrent('plugin' as never),
    ).toThrow()
    expect('register' in productionRuntimeRegistry).toBe(false)
    expect('replace' in productionRuntimeRegistry).toBe(false)
    expect(Object.isFrozen(productionRuntimeRegistry)).toBe(true)
  })

  test('copies and freezes definitions instead of exposing mutable inputs', () => {
    const promptModules = [{ id: 'player.prompt.system', version: 1 }]
    const player = {
      ...playerRuntimeDefinition,
      promptModules,
    }
    const definitions = { player, coach: coachRuntimeDefinition }
    const registry = createRuntimeRegistry<RuntimeDefinitionMap>({
      definitions,
    })

    promptModules[0] = { id: 'player.prompt.changed', version: 1 }
    definitions.player = {
      ...player,
      promptModules: [{ id: 'player.prompt.replaced', version: 1 }],
    }
    expect(registry.resolveCurrent('player').promptModules).toEqual([
      { id: 'player.prompt.system', version: 1 },
    ])
    expect(Object.isFrozen(registry.resolveCurrent('player'))).toBe(true)
    expect(
      Object.isFrozen(registry.resolveCurrent('player').promptModules),
    ).toBe(true)
  })

  test('rejects invalid ownership and cross-runtime grants', () => {
    expect(() =>
      createRuntimeRegistry<RuntimeDefinitionMap>({
        definitions: {
          player: coachRuntimeDefinition,
          coach: playerRuntimeDefinition,
        } as never,
      }),
    ).toThrow()
    expect(() =>
      createRuntimeRegistry<RuntimeDefinitionMap>({
        definitions: {
          player: {
            ...playerRuntimeDefinition,
            capabilityManifest: {
              ...playerRuntimeDefinition.capabilityManifest,
              grants: [
                {
                  runtimeType: 'player',
                  capability: {
                    id: 'coach.compute-decision-metrics',
                    version: 1,
                  },
                  maxInvocations: 1,
                },
              ],
            },
          },
          coach: coachRuntimeDefinition,
        },
      }),
    ).toThrow()
  })

  test('rejects unauthenticated policies and invalid policy snapshots during configuration', () => {
    expect(() =>
      createRuntimeRegistry<RuntimeDefinitionMap>({
        definitions: {
          player: {
            ...playerRuntimeDefinition,
            budgetPolicy: {
              runtimeType: 'player',
              policyVersion: 1,
              createSnapshot: () => ({}),
            } as never,
          },
          coach: coachRuntimeDefinition,
        },
      }),
    ).toThrow()

    expect(() =>
      createRuntimeBudgetPolicy({
        runtimeType: 'player',
        policyVersion: 1,
        validationInput: {
          runtimeType: 'player',
          attemptTimeoutSeconds: 15,
          decisionDeadlineSeconds: 45,
        },
        createSnapshot: () => ({}),
      }),
    ).toThrow()
  })
})
