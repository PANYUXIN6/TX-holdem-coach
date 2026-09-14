import { pauseIntentMatches } from '../ai-status/adapter.js'
import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { ApiError } from '../api/errors.js'
import { writePolicy } from '../query/client.js'
import { keys } from '../query/keys.js'
import type { SessionRuntime } from '../session-sync/runtime.js'
import type { OverlayDescriptor } from './stores.js'

export function confirmationTargetMatches(
  target: OverlayDescriptor,
  current: PublicSessionSnapshot | undefined,
) {
  if (target.kind === 'clearData') return true
  if (!current) return false
  if (target.kind === 'deleteSession')
    return current.lifecycleStatus === 'ended'
  return (
    current.lifecycleStatus === 'active' &&
    current.pokerPhase === 'inHand' &&
    current.agentRunState === 'paused' &&
    current.hand?.handId === target.handId &&
    current.stateVersion === target.stateVersion &&
    current.eventSeq === target.eventSeq
  )
}

export function confirmationEligible(
  target: OverlayDescriptor,
  client: QueryClient,
  runtime: SessionRuntime,
) {
  if (target.kind === 'clearData') return true
  const query = client.getQueryState<PublicSessionSnapshot>(
    keys.session(target.sessionId),
  )
  const current = query?.data
  if (
    !confirmationTargetMatches(target, current) ||
    query?.status === 'error' ||
    query?.fetchStatus === 'fetching' ||
    runtime.getStatus(target.sessionId) === 'missing'
  )
    return false
  if (target.kind === 'deleteSession') return true
  return (
    pauseIntentMatches(target, client) &&
    runtime.getStatus(target.sessionId) === 'ready' &&
    !runtime.isSubmitting(target.sessionId) &&
    runtime.pendingOperations(target.sessionId).length === 0
  )
}
export function abortConfirmationOptions(
  client: QueryClient,
  runtime: SessionRuntime,
  isCurrent: (target: OverlayDescriptor) => boolean,
) {
  return mutationOptions({
    ...writePolicy,
    mutationFn: (
      target: Extract<OverlayDescriptor, { kind: 'abortHandAndEndSession' }>,
      context,
    ) => {
      if (!isCurrent(target) || !confirmationEligible(target, client, runtime))
        throw new ApiError('input', undefined, 'SESSION_NOT_READY')
      // 与原入口同步衔接，Mutation 调度后仍不可用旧确认授权新版本。
      return runtime.commandOptions(target.sessionId).mutationFn!(
        {
          type: 'endSession',
          payload: { expectedPausedRunId: target.expectedPausedRunId },
        },
        context,
      )
    },
  })
}
