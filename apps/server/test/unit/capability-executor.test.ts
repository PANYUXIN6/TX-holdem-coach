import { describe, expect, test, vi } from 'vitest'
import { z } from 'zod'
import { createCapabilityExecutor } from '../../src/agents/foundation/capability-executor.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import {
  playerRuntimeDefinition,
  playerRuntimeBudgetPolicy,
} from '../../src/agents/player/foundation-definition.js'

const authority = issueRuntimeCommitAuthority({
  runtimeType: 'player',
  runId: '11111111-1111-4111-8111-111111111111',
  leaseOwner: 'test:player:0',
  fencingToken: 1,
})
const budget = playerRuntimeBudgetPolicy.createSnapshot({
  runtimeType: 'player',
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45,
})

describe('capability executor', () => {
  test('executes only a declared static capability and hashes its projection', async () => {
    const execute = vi.fn(async (input: unknown) => {
      const parsed = z.strictObject({ value: z.number() }).parse(input)
      return { result: parsed.value * 2 }
    })
    const audits: unknown[] = []
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [
        {
          runtimeType: 'player',
          capability: { id: 'player.compute-decision-metrics', version: 1 },
          mode: 'deterministicCompute',
          inputSchema: { id: 'player.input.metrics', version: 1 },
          outputSchema: { id: 'player.output.metrics', version: 1 },
          timeoutMs: 1_000,
          parseInput: (value) =>
            z.strictObject({ value: z.number() }).parse(value),
          parseOutput: (value) =>
            z.strictObject({ result: z.number() }).parse(value),
          execute,
        },
      ],
    })
    const result = await executor.invoke<{ readonly result: number }>({
      runtimeType: 'player',
      authority,
      capability: { id: 'player.compute-decision-metrics', version: 1 },
      payload: { value: 3 },
      signal: new AbortController().signal,
      control: {
        reserveInvocation: async () => ({
          kind: 'reserved',
          reservationId: 'reservation-1',
        }),
        finishInvocation: async ({ audit }) => {
          audits.push(audit)
          return 'recorded'
        },
      },
    })
    expect(result).toEqual({ result: 6 })
    expect(execute).toHaveBeenCalledOnce()
    expect(audits).toMatchObject([
      { authorized: true, budgetCost: 1, errorCode: null },
    ])
  })

  test('rejects an undeclared or commit-gate capability before execution', async () => {
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [],
    })
    await expect(
      executor.invoke({
        runtimeType: 'player',
        authority,
        capability: { id: 'player.commit-poker-decision', version: 1 },
        payload: {},
        signal: new AbortController().signal,
        control: {
          reserveInvocation: async () => ({
            kind: 'reserved',
            reservationId: 'reservation-1',
          }),
          finishInvocation: async () => 'recorded',
        },
      }),
    ).rejects.toMatchObject({ failure: 'capabilityNotDeclared' })
  })

  test('does not reserve or execute when the parent signal is already cancelled', async () => {
    const execute = vi.fn(async () => ({ result: 1 }))
    const reserveInvocation = vi.fn(async () => ({
      kind: 'reserved' as const,
      reservationId: 'reservation-1',
    }))
    const controller = new AbortController()
    controller.abort()
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [
        {
          runtimeType: 'player',
          capability: { id: 'player.compute-decision-metrics', version: 1 },
          mode: 'deterministicCompute',
          inputSchema: { id: 'player.input.metrics', version: 1 },
          outputSchema: { id: 'player.output.metrics', version: 1 },
          timeoutMs: 1_000,
          parseInput: (value) =>
            z.strictObject({ value: z.number() }).parse(value),
          parseOutput: (value) =>
            z.strictObject({ result: z.number() }).parse(value),
          execute,
        },
      ],
    })

    await expect(
      executor.invoke({
        runtimeType: 'player',
        authority,
        capability: { id: 'player.compute-decision-metrics', version: 1 },
        payload: { value: 1 },
        signal: controller.signal,
        control: {
          reserveInvocation,
          finishInvocation: async () => 'recorded',
        },
      }),
    ).rejects.toMatchObject({ failure: 'capabilityCancelled' })
    expect(reserveInvocation).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  test('returns the same deeply frozen projection that was hashed', async () => {
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [
        {
          runtimeType: 'player',
          capability: { id: 'player.compute-decision-metrics', version: 1 },
          mode: 'deterministicCompute',
          inputSchema: { id: 'player.input.metrics', version: 1 },
          outputSchema: { id: 'player.output.metrics', version: 1 },
          timeoutMs: 1_000,
          parseInput: (value) =>
            z.strictObject({ value: z.number() }).parse(value),
          parseOutput: (value) =>
            z
              .strictObject({
                nested: z.strictObject({ values: z.array(z.number()) }),
              })
              .parse(value),
          execute: async () => ({ nested: { values: [1, 2] } }),
        },
      ],
    })
    const result = await executor.invoke<{
      readonly nested: { readonly values: number[] }
    }>({
      runtimeType: 'player',
      authority,
      capability: { id: 'player.compute-decision-metrics', version: 1 },
      payload: { value: 1 },
      signal: new AbortController().signal,
      control: {
        reserveInvocation: async () => ({
          kind: 'reserved',
          reservationId: 'reservation-1',
        }),
        finishInvocation: async () => 'recorded',
      },
    })

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.nested)).toBe(true)
    expect(Object.isFrozen(result.nested.values)).toBe(true)
    expect(() => result.nested.values.push(3)).toThrow()
  })

  test('uses an immutable Definition snapshot for reservation and audit facts', async () => {
    const inputSchema = { id: 'player.input.metrics', version: 1 }
    const outputSchema = { id: 'player.output.metrics', version: 1 }
    const reserveInvocation = vi.fn(async () => ({
      kind: 'reserved' as const,
      reservationId: 'reservation-1',
    }))
    const finishInvocation = vi.fn(async () => 'recorded' as const)
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [
        {
          runtimeType: 'player',
          capability: {
            id: 'player.compute-decision-metrics',
            version: 1,
          },
          mode: 'deterministicCompute',
          inputSchema,
          outputSchema,
          timeoutMs: 1_000,
          parseInput: (value) =>
            z.strictObject({ value: z.number() }).parse(value),
          parseOutput: (value) =>
            z.strictObject({ result: z.number() }).parse(value),
          execute: async () => ({ result: 2 }),
        },
      ],
    })
    inputSchema.version = 99
    outputSchema.version = 99

    await executor.invoke({
      runtimeType: 'player',
      authority,
      capability: { id: 'player.compute-decision-metrics', version: 1 },
      payload: { value: 1 },
      signal: new AbortController().signal,
      control: { reserveInvocation, finishInvocation },
    })

    expect(reserveInvocation).toHaveBeenCalledWith(
      expect.objectContaining({ inputSchemaVersion: 1 }),
    )
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        audit: expect.objectContaining({
          inputSchemaVersion: 1,
          outputSchemaVersion: 1,
        }),
      }),
    )
  })

  test('finalizes but does not execute when cancellation arrives during reservation', async () => {
    const controller = new AbortController()
    const execute = vi.fn(async () => ({ result: 1 }))
    const finishInvocation = vi.fn(async () => 'recorded' as const)
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [
        {
          runtimeType: 'player',
          capability: { id: 'player.compute-decision-metrics', version: 1 },
          mode: 'deterministicCompute',
          inputSchema: { id: 'player.input.metrics', version: 1 },
          outputSchema: { id: 'player.output.metrics', version: 1 },
          timeoutMs: 1_000,
          parseInput: (value) =>
            z.strictObject({ value: z.number() }).parse(value),
          parseOutput: (value) =>
            z.strictObject({ result: z.number() }).parse(value),
          execute,
        },
      ],
    })

    await expect(
      executor.invoke({
        runtimeType: 'player',
        authority,
        capability: { id: 'player.compute-decision-metrics', version: 1 },
        payload: { value: 1 },
        signal: controller.signal,
        control: {
          reserveInvocation: async () => {
            controller.abort()
            return {
              kind: 'reserved',
              reservationId: 'reservation-1',
            }
          },
          finishInvocation,
        },
      }),
    ).rejects.toMatchObject({ failure: 'capabilityCancelled' })
    expect(execute).not.toHaveBeenCalled()
    expect(finishInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'reservation-1',
        audit: expect.objectContaining({ errorCode: 'capabilityCancelled' }),
      }),
    )
  })

  test('does not deliver output when the database reports a stale finish', async () => {
    const executor = createCapabilityExecutor({
      runtimeType: 'player',
      manifest: playerRuntimeDefinition.capabilityManifest,
      budget,
      definitions: [
        {
          runtimeType: 'player',
          capability: { id: 'player.compute-decision-metrics', version: 1 },
          mode: 'deterministicCompute',
          inputSchema: { id: 'player.input.metrics', version: 1 },
          outputSchema: { id: 'player.output.metrics', version: 1 },
          timeoutMs: 1_000,
          parseInput: (value) =>
            z.strictObject({ value: z.number() }).parse(value),
          parseOutput: (value) =>
            z.strictObject({ result: z.number() }).parse(value),
          execute: async () => ({ result: 2 }),
        },
      ],
    })

    await expect(
      executor.invoke({
        runtimeType: 'player',
        authority,
        capability: { id: 'player.compute-decision-metrics', version: 1 },
        payload: { value: 1 },
        signal: new AbortController().signal,
        control: {
          reserveInvocation: async () => ({
            kind: 'reserved',
            reservationId: 'reservation-1',
          }),
          finishInvocation: async () => 'stale',
        },
      }),
    ).rejects.toMatchObject({ failure: 'capabilityDeadlineExhausted' })
  })
})
