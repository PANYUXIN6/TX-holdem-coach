import { isDeepStrictEqual } from 'node:util'
import type { CoachReadResource } from '../../persistence/coach-read-resource.js'
import { createCoachRunReadRepository } from '../../persistence/agent-run-lifecycle-repository.js'
import { createCompletedHandReviewSourceRepository } from '../../persistence/completed-hand-review-repository.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import { createRunConfigurationSnapshot } from '../foundation/agent-run-coordinator.js'
import { coachRuntimeDefinition } from './foundation-definition.js'
import {
  readCoachPolicyVersions,
  type CoachPolicyVersions,
} from './policy-versions.js'
import { createCoachReviewSourceAdapter } from './review-source-adapter.js'

/** Production entry: authenticate persisted execution, load once, then release SQL before replay. */
export function createCoachReviewSourceLoader(input: {
  readonly resource: CoachReadResource
  readonly owner: ResolvedOwnerScope
  readonly supported: CoachPolicyVersions
}) {
  const authenticate = createCoachRunReadRepository(input)
  const reader = createCompletedHandReviewSourceRepository(input)
  return async (request: {
    readonly authority: RuntimeCommitAuthority<'coach'>
    readonly sessionId: string
    readonly handId: string
    readonly signal: AbortSignal
    readonly deadlineAt: number
  }) => {
    const signal = AbortSignal.any([request.signal, input.resource.signal])
    const execution = await authenticate(
      request.authority,
      request.sessionId,
      request.handId,
      { signal, deadlineAt: request.deadlineAt },
    )
    readCoachPolicyVersions(
      execution.run.runConfiguration.dataDependencies,
      input.supported,
    )
    if (
      !isDeepStrictEqual(
        execution.run.runConfiguration,
        createRunConfigurationSnapshot(
          coachRuntimeDefinition,
          execution.run.runConfiguration.dataDependencies,
        ),
      )
    )
      throw new TypeError('coach_run_configuration_unsupported')
    const loaded = await reader.readCompletedSource(request.handId, {
      signal,
      deadlineAt: Math.min(
        request.deadlineAt,
        Date.parse(execution.run.deadlineAt),
      ),
    })
    signal.throwIfAborted()
    if (loaded.kind !== 'completed') return loaded
    return {
      kind: 'ready' as const,
      adapter: createCoachReviewSourceAdapter({
        facts: loaded.facts,
        execution,
        supported: input.supported,
        signal,
      }),
    }
  }
}
