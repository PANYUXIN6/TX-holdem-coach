import { z } from 'zod'
import type { AuditVersionReference } from '../audit/audit-primitives.js'
import type { ExecutionBudgetAudit } from '../audit/execution-budget-audit-codec.js'
import type { RunConfigurationAudit } from '../audit/run-configuration-audit-codec.js'
import type { PersistedAgentRunEvent } from './runtime-ports.js'
import type { RuntimeType } from './runtime-definition.js'

export const AgentRunLifecycleSchema = z.enum([
  'queued',
  'leased',
  'running',
  'completed',
  'failed',
  'cancelled',
  'stale',
])
export type AgentRunLifecycle = z.infer<typeof AgentRunLifecycleSchema>

export type ActiveAgentRunLifecycle = Extract<
  AgentRunLifecycle,
  'queued' | 'leased' | 'running'
>
export type TerminalAgentRunLifecycle = Exclude<
  AgentRunLifecycle,
  ActiveAgentRunLifecycle
>

interface PersistedAgentRunBase<TRuntime extends RuntimeType> {
  readonly ownerId: 'local-user'
  readonly runId: string
  readonly runtimeType: TRuntime
  readonly sessionId: string
  readonly handId: string
  readonly triggerType: string
  readonly lifecycle: AgentRunLifecycle
  readonly idempotencyKey: string
  readonly parentRunId: string | null
  readonly replacementRunId: string | null
  readonly leaseOwner: string | null
  readonly leaseExpiresAt: string | null
  readonly fencingToken: number
  readonly deadlineAt: string
  readonly runtimeDefinitionVersion: number
  readonly terminationReason: string | null
  readonly runConfiguration: RunConfigurationAudit
  readonly budget: ExecutionBudgetAudit
  readonly checkpointPayloadVersion: number | null
  readonly checkpointPayload: Readonly<Record<string, unknown>> | null
  readonly resultPayloadVersion: number | null
  readonly resultPayload: Readonly<Record<string, unknown>> | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly completedAt: string | null
  readonly updatedAt: string
}

export type PersistedAgentRun<TRuntime extends RuntimeType = RuntimeType> =
  TRuntime extends 'player'
    ? PersistedAgentRunBase<'player'> & {
        readonly participantId: string
        readonly sourceStateVersion: number
        readonly decisionRequestId: string
      }
    : PersistedAgentRunBase<'coach'> & {
        readonly participantId: null
        readonly sourceStateVersion: null
        readonly decisionRequestId: null
      }

export type LeasedAgentRun<TRuntime extends RuntimeType = RuntimeType> =
  PersistedAgentRun<TRuntime> & {
    readonly lifecycle: 'leased' | 'running'
    readonly leaseOwner: string
    readonly leaseExpiresAt: string
    readonly fencingToken: number
  }

interface AgentRunCreationBase {
  readonly agentRunId: string
  readonly sessionId: string
  readonly handId: string
  readonly triggerType: string
  readonly idempotencyKey: string
  readonly supersedesRunId: string | null
  readonly dataDependencies: readonly AuditVersionReference[]
  readonly createdAt: string
}

export type AgentRunCreationInput =
  | (AgentRunCreationBase & {
      readonly runtimeType: 'player'
      readonly actorParticipantId: string
      readonly sourceStateVersion: number
      readonly decisionRequestId: string
    })
  | (AgentRunCreationBase & {
      readonly runtimeType: 'coach'
    })

export interface PersistedAgentRunEffect {
  readonly runtimeType: RuntimeType
  readonly runId: string
  readonly event: PersistedAgentRunEvent
}

export type AgentRunCreationResult =
  | {
      readonly kind: 'created'
      readonly run: PersistedAgentRun
      readonly committedEffects: readonly [PersistedAgentRunEffect]
    }
  | {
      readonly kind: 'existing'
      readonly run: PersistedAgentRun
      readonly committedEffects: readonly []
    }

export interface AgentRunCancellationInput {
  readonly runId: string
  readonly reason: 'user_cancelled' | 'process_restart'
  readonly completedAt: string
}

export interface AgentRunFinalizationInput {
  readonly runId: string
  readonly authority: import('./runtime-ports.js').RuntimeCommitAuthority
  readonly lifecycle: TerminalAgentRunLifecycle
  readonly terminationReason: string | null
  readonly resultPayloadVersion: number | null
  readonly resultPayload: Readonly<Record<string, unknown>> | null
  readonly completedAt: string
}

export interface AgentRunTerminalResult {
  readonly run: PersistedAgentRun
  readonly changed: boolean
  readonly committedEffects: readonly PersistedAgentRunEffect[]
}

export interface AgentRunClaimInput {
  readonly runtimeType: RuntimeType
  readonly leaseOwner: string
}

export type AgentRunClaimDiagnostic =
  | 'agent_run_payload_unknown'
  | 'agent_run_payload_invalid'
  | 'agent_run_runtime_unavailable'
  | 'agent_run_recovery_rejected'
  | 'agent_run_deadline_expired'
  | 'agent_run_capacity_unavailable'
  | 'agent_run_fencing_rejected'

export type AgentRunClaimResult =
  | {
      readonly kind: 'claimed'
      readonly run: LeasedAgentRun
      readonly authority: import('./runtime-ports.js').RuntimeCommitAuthority
    }
  | {
      readonly kind: 'none'
      readonly diagnostics: readonly AgentRunClaimDiagnostic[]
    }

export type AgentRunExecutionDisposition =
  'terminal' | 'authorityLost' | 'runtimeSettlementRequired'
