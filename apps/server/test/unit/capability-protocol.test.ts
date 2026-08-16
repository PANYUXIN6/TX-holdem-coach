import { describe, expect, test } from 'vitest'
import {
  authorizeCapabilityInvocation,
  createCapabilityManifest,
} from '../../src/agents/foundation/capability-protocol.js'
import { coachCapabilityDefinitionsV1 } from '../../src/agents/coach/foundation-definition.js'
import {
  playerCapabilityDefinitionsV1,
  playerRuntimeDefinitionV1,
} from '../../src/agents/player/foundation-definition.js'
import { isRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'

describe('M4.1 capability protocol', () => {
  test('authorizes only the exact state-declared, manifested definition', () => {
    const capability = playerCapabilityDefinitionsV1[0]
    expect(capability).toBeDefined()
    if (capability === undefined) return

    expect(
      authorizeCapabilityInvocation({
        intent: {
          runtimeType: 'player',
          capability: capability.capability,
        },
        manifest: playerRuntimeDefinitionV1.capabilityManifest,
        definitions: playerCapabilityDefinitionsV1,
        commitGate: playerRuntimeDefinitionV1.commitGate,
        stateDeclaredCapabilities: [capability.capability],
        invocationCount: 0,
      }),
    ).toBe(capability)

    expect(() =>
      authorizeCapabilityInvocation({
        intent: {
          runtimeType: 'player',
          capability: capability.capability,
        },
        manifest: playerRuntimeDefinitionV1.capabilityManifest,
        definitions: playerCapabilityDefinitionsV1,
        commitGate: playerRuntimeDefinitionV1.commitGate,
        stateDeclaredCapabilities: [],
        invocationCount: 0,
      }),
    ).toThrow()
  })

  test('default-denies version mismatches, cross-runtime calls and exhausted grants', () => {
    const capability = playerCapabilityDefinitionsV1[0]
    expect(capability).toBeDefined()
    if (capability === undefined) return

    const common = {
      manifest: playerRuntimeDefinitionV1.capabilityManifest,
      definitions: playerCapabilityDefinitionsV1,
      commitGate: playerRuntimeDefinitionV1.commitGate,
      stateDeclaredCapabilities: [capability.capability],
    }
    expect(() =>
      authorizeCapabilityInvocation({
        ...common,
        intent: {
          runtimeType: 'player',
          capability: { ...capability.capability, version: 2 },
        },
        invocationCount: 0,
      }),
    ).toThrow()
    expect(() =>
      authorizeCapabilityInvocation({
        ...common,
        intent: {
          runtimeType: 'player',
          capability: capability.capability,
        },
        invocationCount: 1,
      }),
    ).toThrow()
    expect(coachCapabilityDefinitionsV1[0]?.runtimeType).toBe('coach')
  })

  test('never admits a Commit Gate into the ordinary capability manifest', () => {
    expect(() =>
      createCapabilityManifest({
        manifest: {
          runtimeType: 'player',
          manifestVersion: 1,
          grants: [
            {
              runtimeType: 'player',
              capability: playerRuntimeDefinitionV1.commitGate,
              maxInvocations: 1,
            },
          ],
        },
        commitGate: playerRuntimeDefinitionV1.commitGate,
        maxCapabilityInvocations: 1,
      }),
    ).toThrow()
  })

  test('rejects a hand-built Runtime Commit Authority', () => {
    expect(
      isRuntimeCommitAuthority(
        {
          runtimeType: 'player',
          runId: '00000000-0000-4000-8000-000000000001',
          leaseOwner: 'worker-1',
          fencingToken: 1,
        },
        'player',
      ),
    ).toBe(false)
  })
})
