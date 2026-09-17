import { describe, expect, test } from 'vitest'
import {
  COACH_POLICY_DEPENDENCY_IDS,
  readCoachPolicyVersions,
  writeCoachPolicyDependencies,
} from '../../src/agents/coach/policy-versions.js'

describe('Coach persisted policy references', () => {
  const supported = Object.fromEntries(
    Object.entries(COACH_POLICY_DEPENDENCY_IDS).map(([role, id]) => [
      role,
      { id, version: 1 },
    ]),
  ) as Parameters<typeof writeCoachPolicyDependencies>[0]

  test('uses exact IDs independent of persisted order', () => {
    const dependencies = writeCoachPolicyDependencies(supported)
    expect(
      readCoachPolicyVersions([...dependencies].reverse(), supported),
    ).toEqual(supported)
    expect(
      Object.isFrozen(readCoachPolicyVersions(dependencies, supported)),
    ).toBe(true)
  })

  test('rejects missing, duplicated and unsupported producer versions', () => {
    const dependencies = writeCoachPolicyDependencies(supported)
    for (const invalid of [
      dependencies.slice(1),
      [...dependencies, dependencies[0]!],
      dependencies.map((ref, index) =>
        index === 0 ? { ...ref, version: 2 } : ref,
      ),
    ])
      expect(() => readCoachPolicyVersions(invalid, supported)).toThrow()
  })
})
