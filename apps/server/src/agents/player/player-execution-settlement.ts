import {
  FoundationProtocolError,
  ModelGatewayProtocolError,
  type ModelGatewayFailure,
} from '../foundation/errors.js'
import { PlayerCommitGateError } from '../../persistence/player-commit-gate-repository.js'
import { DatabaseOperationError } from '../../persistence/errors.js'
import {
  PlayerRuntimeExecutionError,
  type PlayerRuntimeFailureCode,
} from './player-runtime-executor.js'

export type PlayerPauseReason =
  | 'provider_billing_unavailable'
  | 'provider_network_error'
  | 'provider_timeout'
  | 'provider_service_unavailable'
  | 'provider_auth_error'
  | 'provider_rate_limited'
  | 'provider_unknown_error'
  | 'provider_usage_unavailable'
  | 'content_correction_exhausted'
  | 'execution_budget_exhausted'
  | 'execution_deadline_exhausted'
  | 'sensitive_projection_rejected'
  | 'player_dependency_unavailable'
  | 'player_runtime_contract_rejected'
  | 'player_internal_failure'

export type PlayerStaleReason =
  | 'player_decision_authority_lost'
  | 'runtime_authority_lost'
  | 'player_commit_authority_lost'
  | 'player_commit_decision_stale'
  | 'player_commit_resource_missing'

export type PlayerDeferredReason =
  'runtime_cancelled' | 'local_persistence_error'

export type PlayerSettlementKind =
  | { readonly kind: 'finalFailure'; readonly reason: PlayerPauseReason }
  | { readonly kind: 'stale'; readonly reason: PlayerStaleReason }
  | { readonly kind: 'deferred'; readonly reason: PlayerDeferredReason }

const modelGatewayPauseReasons = new Set<PlayerPauseReason>([
  'provider_billing_unavailable',
  'provider_network_error',
  'provider_timeout',
  'provider_service_unavailable',
  'provider_auth_error',
  'provider_rate_limited',
  'provider_unknown_error',
  'provider_usage_unavailable',
  'content_correction_exhausted',
  'execution_budget_exhausted',
  'execution_deadline_exhausted',
  'sensitive_projection_rejected',
])

function finalFailure(reason: PlayerPauseReason): PlayerSettlementKind {
  return Object.freeze({ kind: 'finalFailure' as const, reason })
}

function stale(reason: PlayerStaleReason): PlayerSettlementKind {
  return Object.freeze({ kind: 'stale' as const, reason })
}

function deferred(reason: PlayerDeferredReason): PlayerSettlementKind {
  return Object.freeze({ kind: 'deferred' as const, reason })
}

function classifyModelGatewayFailure(
  failure: ModelGatewayFailure,
): PlayerSettlementKind {
  if (failure === 'runtime_cancelled') return deferred('runtime_cancelled')
  if (failure === 'local_persistence_error') {
    return deferred('local_persistence_error')
  }
  if (failure === 'runtime_authority_lost') {
    return stale('runtime_authority_lost')
  }
  if (
    failure === 'response_parse_error' ||
    failure === 'response_schema_error' ||
    failure === 'response_semantic_invalid'
  ) {
    return finalFailure('content_correction_exhausted')
  }
  if (modelGatewayPauseReasons.has(failure)) return finalFailure(failure)
  return finalFailure('player_internal_failure')
}

function classifyPlayerRuntimeFailure(
  failure: PlayerRuntimeFailureCode,
): PlayerSettlementKind {
  switch (failure) {
    case 'player_decision_authority_lost':
      return stale('player_decision_authority_lost')
    case 'player_decision_persistence_rejected':
      return deferred('local_persistence_error')
    case 'player_decision_dependency_missing':
    case 'player_decision_dependency_mismatch':
      return finalFailure('player_dependency_unavailable')
    case 'player_decision_runtime_mismatch':
    case 'player_decision_snapshot_rejected':
    case 'player_decision_projection_rejected':
    case 'player_decision_packet_leak_rejected':
    case 'player_model_adapter_boundary_rejected':
    case 'player_decision_resume_rejected':
    case 'player_decision_resume_inflight_unknown':
      return finalFailure('player_runtime_contract_rejected')
    case 'player_bounded_choice_failed':
      return finalFailure('content_correction_exhausted')
    default:
      return classifyModelGatewayFailure(failure)
  }
}

function classifyFoundationFailure(
  failure: FoundationProtocolError['failure'],
): PlayerSettlementKind {
  switch (failure) {
    case 'capabilityCancelled':
      return deferred('runtime_cancelled')
    case 'capabilityAuthorityLost':
      return stale('runtime_authority_lost')
    case 'executionBudgetExhausted':
    case 'capabilityBudgetExhausted':
    case 'contextSizeExhausted':
    case 'contextTokenExhausted':
      return finalFailure('execution_budget_exhausted')
    case 'capabilityTimeout':
    case 'capabilityDeadlineExhausted':
      return finalFailure('execution_deadline_exhausted')
    case 'sensitiveContextRejected':
      return finalFailure('sensitive_projection_rejected')
    default:
      return finalFailure('player_runtime_contract_rejected')
  }
}

export function classifyPlayerExecutionFailure(
  error: unknown,
  signal: AbortSignal,
): PlayerSettlementKind {
  if (signal.aborted) return deferred('runtime_cancelled')
  if (error instanceof PlayerRuntimeExecutionError) {
    return classifyPlayerRuntimeFailure(error.code)
  }
  if (error instanceof ModelGatewayProtocolError) {
    return classifyModelGatewayFailure(error.failure)
  }
  if (error instanceof FoundationProtocolError) {
    return classifyFoundationFailure(error.failure)
  }
  if (error instanceof PlayerCommitGateError) {
    switch (error.code) {
      case 'player_commit_authority_lost':
      case 'player_commit_decision_stale':
      case 'player_commit_resource_missing':
        return stale(error.code)
      case 'player_commit_persistence_rejected':
        return deferred('local_persistence_error')
      default:
        return finalFailure('player_runtime_contract_rejected')
    }
  }
  if (error instanceof DatabaseOperationError) {
    return deferred('local_persistence_error')
  }
  return finalFailure('player_internal_failure')
}
