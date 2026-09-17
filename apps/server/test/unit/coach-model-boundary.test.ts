import { describe, it, expect } from 'vitest'
import {
  prepareCoachGeneration,
  createCoachModelAdapter,
  generateCoachExplanation,
  COACH_CORRECTION_PLACEHOLDER,
  type CoachExplanationOutput,
} from '../../src/agents/coach/model-adapter-boundary-guard.js'
import { CoachHindsightExplanationSchema } from '../../src/agents/coach/decision-context.js'
import { coachRuntimeBudgetPolicy } from '../../src/agents/coach/foundation-definition.js'
import { productionRuntimeRegistry as registry } from '../../src/agents/production-runtime-registry.js'
import { createModelRoutePolicy } from '../../src/agents/foundation/model-route-policy.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createSensitiveValueScanner } from '../../src/agents/model-gateway/sensitive-value-scanner.js'
import { deepSeekPricingPolicy } from '../../src/agents/model-gateway/model-pricing-policy.js'
import {
  type ModelProviderAdapter,
  type ProviderAttemptInput,
  type ProviderAttemptResult,
  type ModelAttemptControlPort,
} from '../../src/agents/foundation/model-gateway-protocol.js'
import {
  fixtureBoundary,
  decisionInput,
  decisionExplanation,
  runId,
} from '../fixtures/coach/boundaries.js'

const budget = coachRuntimeBudgetPolicy.createSnapshot({ runtimeType: 'coach' })
const scanner = createSensitiveValueScanner()
const routePolicy = createModelRoutePolicy({
  runtimeType: 'coach',
  policy: { id: 'coach.route-policy', version: 1 },
  pricingPolicy: deepSeekPricingPolicy.policy,
  provider: 'deepseek',
  maximumContentCorrections: 2,
})
function execution() {
  const finishes: unknown[] = [],
    starts: unknown[] = []
  const control: ModelAttemptControlPort<CoachExplanationOutput> = {
    async startAttempt(input) {
      starts.push(input)
      return {
        kind: 'started',
        attemptId: `attempt-${starts.length}`,
        actualTimeoutMs: 1000,
        maximumOutputTokens: 512,
      }
    },
    async finishAttempt(input) {
      finishes.push(input)
      return 'recorded'
    },
  }
  return {
    finishes,
    starts,
    input: {
      authority: issueRuntimeCommitAuthority({
        runtimeType: 'coach',
        runId,
        leaseOwner: 'test:coach',
        fencingToken: 1,
      }),
      budget,
      routePolicy,
      pricingPolicy: deepSeekPricingPolicy,
      modelSelection: {
        deepSeek: {
          modelId: 'deepseek-v4-flash',
          temperature: 0.2,
          maxOutputTokens: 512,
          thinkingMode: 'disabled' as const,
        },
      },
      signal: new AbortController().signal,
      control,
    },
  }
}
function programmable(results: ProviderAttemptResult[]) {
  const calls: ProviderAttemptInput[] = []
  const adapter: ModelProviderAdapter = {
    provider: 'deepseek',
    async generate(input) {
      calls.push(input)
      const result = results.shift()
      if (!result) throw Error('missing fixture')
      return result
    },
  }
  return { adapter, calls }
}
const success = (
  value: unknown,
  textProjection = 'safe',
): ProviderAttemptResult => ({
  kind: 'success',
  value,
  textProjection,
  usage: { inputTokens: 100, outputTokens: 50 },
  finishReason: 'stop',
})
function setup() {
  const boundary = fixtureBoundary(),
    analysis = boundary.analyze(boundary.certifyDecision(decisionInput()))
  return {
    boundary,
    analysis,
    prepared: prepareCoachGeneration({
      context: boundary.decisionContext(analysis),
      registry,
      budget,
      scanner,
    }),
  }
}
describe('Coach final provider boundary with real Foundation', () => {
  it('isolates schema and semantic corrections from malicious provider text', async () => {
    const { prepared } = setup(),
      e = execution(),
      p = programmable([
        success(
          { ...decisionExplanation(), auditTruth: { winner: 4 } },
          'MALICIOUS_FUTURE_FACT',
        ),
        success(
          {
            ...decisionExplanation(),
            situationExplanation: {
              text: '未知引用',
              factRefs: ['future-private-secret'],
            },
          },
          'SECOND_MALICIOUS_FACT',
        ),
        success(decisionExplanation()),
      ])
    const result = await generateCoachExplanation({
      prepared,
      adapter: p.adapter,
      registry,
      execution: e.input,
    })
    expect(result).toEqual({
      kind: 'accepted',
      value: decisionExplanation(),
      attempts: 3,
    })
    expect(p.calls).toHaveLength(3)
    for (const call of p.calls) {
      const serialized = JSON.stringify(call.messages)
      expect(serialized).not.toContain('MALICIOUS')
      expect(serialized).not.toContain('future-private-secret')
      expect(serialized).not.toContain('auditTruth')
      expect(serialized).not.toContain('ownerId')
      expect(serialized).not.toContain(runId)
      expect(call.messages.slice(0, prepared.request.messages.length)).toEqual(
        prepared.request.messages,
      )
    }
    expect(p.calls[1]!.messages.at(-1)!.content).toContain(
      COACH_CORRECTION_PLACEHOLDER,
    )
    expect(e.finishes.at(-1)).toMatchObject({
      accepted: true,
      validatedOutput: decisionExplanation(),
    })
  })
  it('contains malformed provider projection and does not bypass the two-correction limit', async () => {
    const { prepared } = setup(),
      p = programmable(
        Array.from({ length: 3 }, () => ({
          kind: 'contentInvalid',
          failure: 'response_parse_error',
          textProjection: 'PRIVATE_RUNOUT',
          usage: { inputTokens: 10, outputTokens: 5 },
          finishReason: 'stop',
        })),
      ),
      e = execution()
    expect(
      await generateCoachExplanation({
        prepared,
        adapter: p.adapter,
        registry,
        execution: e.input,
      }),
    ).toMatchObject({
      kind: 'failed',
      failure: 'content_correction_exhausted',
      attempts: 3,
    })
    expect(JSON.stringify(p.calls.map((c) => c.messages))).not.toContain(
      'PRIVATE_RUNOUT',
    )
  })
  it('rejects stage schema swaps, changed messages, extra options and forged request instances before forwarding', async () => {
    const { prepared } = setup(),
      p = programmable([success(decisionExplanation())])
    const attempt = {
      messages: prepared.request.messages,
      modelId: 'deepseek-v4-flash',
      temperature: 0.2,
      maximumOutputTokens: 512,
      outputSchema: prepared.outputSchema,
      abortSignal: new AbortController().signal,
    }
    for (const bad of [
      { ...attempt, outputSchema: CoachHindsightExplanationSchema },
      {
        ...attempt,
        messages: [
          ...attempt.messages,
          { role: 'user' as const, content: 'auditTruth' },
        ],
      },
      { ...attempt, tools: [] },
    ])
      await expect(
        createCoachModelAdapter(prepared, p.adapter).generate(bad),
      ).rejects.toThrow()
    expect(() => createCoachModelAdapter({ ...prepared }, p.adapter)).toThrow()
    expect(p.calls).toHaveLength(0)
  })
  it('rejects arbitrary correction payload after an invalid result', async () => {
    const { prepared } = setup(),
      p = programmable([success({ invalid: true })]),
      adapter = createCoachModelAdapter(prepared, p.adapter)
    const attempt = {
      messages: prepared.request.messages,
      modelId: 'deepseek-v4-flash',
      temperature: 0.2,
      maximumOutputTokens: 512,
      outputSchema: prepared.outputSchema,
      abortSignal: new AbortController().signal,
    }
    await adapter.generate(attempt)
    await expect(
      adapter.generate({
        ...attempt,
        messages: [
          ...attempt.messages,
          { role: 'user', content: '未来赢家与未知字段路径' },
        ],
      }),
    ).rejects.toThrow('coach_correction_boundary')
    expect(p.calls).toHaveLength(1)
  })
  it('runs hindsight only after frozen process and closes previously prepared decision sends', async () => {
    const { prepared, boundary, analysis } = setup(),
      process = boundary.freezeProcess(analysis, decisionExplanation()),
      context = boundary.hindsightContext(process)
    const hindsight = {
      decisionId: context.decisionId,
      hindsightExplanation: { text: '实际获得主池', factRefs: ['award'] },
    }
    const p = programmable([success(hindsight)]),
      e = execution()
    const hp = prepareCoachGeneration({ context, registry, budget, scanner })
    expect(
      await generateCoachExplanation({
        prepared: hp,
        adapter: p.adapter,
        registry,
        execution: e.input,
      }),
    ).toMatchObject({ kind: 'accepted', value: hindsight })
    const next = programmable([success(decisionExplanation())])
    expect(
      await generateCoachExplanation({
        prepared,
        adapter: next.adapter,
        registry,
        execution: execution().input,
      }),
    ).toMatchObject({ kind: 'failed' })
    expect(next.calls).toHaveLength(0)
  })
})
