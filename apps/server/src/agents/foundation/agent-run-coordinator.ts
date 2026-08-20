import { isDeepStrictEqual } from 'node:util'
import type { Sql, TransactionSql } from 'postgres'
import { z } from 'zod'
import {
  AuditVersionReferenceSchema,
  StableAuditCodeSchema,
  type AuditVersionReference,
} from '../audit/audit-primitives.js'
import { encodeRunConfigurationAudit } from '../audit/run-configuration-audit-codec.js'
import { productionRuntimeRegistry } from '../production-runtime-registry.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import {
  createAgentRunLifecycleRepository,
  type AgentRunLifecycleRepository,
  type ClaimCandidateDecision,
} from '../../persistence/agent-run-lifecycle-repository.js'
import {
  isResolvedOwnerScope,
  type ResolvedOwnerScope,
} from '../../persistence/owner-scope.js'
import {
  lockPlayerTimeoutSettings,
  readResolvedPlayerTimeoutSettings,
} from '../../persistence/player-settings-repository.js'
import { createExecutionBudget } from './execution-budget.js'
import { RuntimeResolutionError } from './errors.js'
import {
  AgentRunCreationError,
  AgentRunTransitionError,
} from './agent-run-lifecycle.js'
import type {
  AgentRunCancellationInput,
  AgentRunClaimResult,
  AgentRunCreationInput,
  AgentRunCreationResult,
  AgentRunExecutionDisposition,
  AgentRunFinalizationInput,
  AgentRunTerminalResult,
  PersistedAgentRun,
  PersistedAgentRunEffect,
} from './agent-run-types.js'
import type { AgentRunWorkerControl } from './agent-worker-ports.js'
import {
  issueRuntimeCommitAuthority,
  type AgentRunEventPort,
  type PersistedAgentRunEvent,
} from './runtime-ports.js'
import type { RuntimeRegistry } from './runtime-registry.js'
import type { AnyRuntimeDefinition } from './runtime-definition.js'

const CanonicalTimestampSchema = z
  .string()
  .datetime({ offset: false, precision: 3 })
const SafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const IdempotencyKeySchema = z.string().min(1).max(256)

const CreationBaseSchema = z.strictObject({
  agentRunId: z.uuid(),
  sessionId: z.uuid(),
  handId: z.uuid(),
  triggerType: StableAuditCodeSchema,
  idempotencyKey: IdempotencyKeySchema,
  supersedesRunId: z.uuid().nullable(),
  dataDependencies: z
    .array(AuditVersionReferenceSchema)
    .superRefine((references, context) => {
      if (new Set(references.map(({ id }) => id)).size !== references.length) {
        context.addIssue({ code: 'custom' })
      }
    }),
  createdAt: CanonicalTimestampSchema,
})

const CreationInputSchema = z.discriminatedUnion('runtimeType', [
  CreationBaseSchema.extend({
    runtimeType: z.literal('player'),
    actorParticipantId: z.uuid(),
    sourceStateVersion: SafeIntegerSchema,
    decisionRequestId: z.uuid(),
  }),
  CreationBaseSchema.extend({ runtimeType: z.literal('coach') }),
])

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object') {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function createEffect(
  run: PersistedAgentRun,
  kind: PersistedAgentRunEvent['kind'],
): PersistedAgentRunEffect {
  const event = Object.freeze({
    runtimeType: run.runtimeType,
    kind,
    runId: run.runId,
  }) as PersistedAgentRunEvent
  return Object.freeze({
    runtimeType: run.runtimeType,
    runId: run.runId,
    event,
  })
}

function snapshotRunConfiguration(
  definition: AnyRuntimeDefinition,
  dataDependencies: readonly AuditVersionReference[],
) {
  return {
    runtime: definition.runtimeType,
    runtimeDefinitionVersion: definition.runtimeDefinitionVersion,
    contextSchemaVersion: definition.contextSchemaVersion,
    promptModules: definition.promptModules,
    capabilityManifest: {
      id: `${definition.runtimeType}.capability-manifest`,
      version: definition.capabilityManifest.manifestVersion,
    },
    capabilities: definition.capabilityManifest.grants.map(
      ({ capability }) => capability,
    ),
    routePolicy: definition.routePolicy,
    outputSchema: definition.outputSchema,
    validator: definition.validator,
    commitGate: {
      id: definition.commitGate.id,
      version: definition.commitGate.version,
    },
    recoveryPolicy: definition.recoveryPolicy,
    dataDependencies,
  }
}

async function publishBestEffort(
  eventPort: AgentRunEventPort,
  events: readonly PersistedAgentRunEvent[],
  onDeliveryError: ((error: unknown) => void | Promise<void>) | undefined,
): Promise<void> {
  if (events.length === 0) return
  try {
    await eventPort.publish(events)
  } catch (error) {
    try {
      await Promise.resolve(onDeliveryError?.(error))
    } catch {
      // Event delivery and its diagnostic callback are both best-effort.
    }
  }
}

export interface AgentRunCoordinator {
  createOrReuse(
    transaction: TransactionSql,
    input: AgentRunCreationInput,
  ): Promise<AgentRunCreationResult>
  cancel(
    transaction: TransactionSql,
    input: AgentRunCancellationInput,
  ): Promise<AgentRunTerminalResult>
  finalize(
    transaction: TransactionSql,
    input: AgentRunFinalizationInput,
  ): Promise<AgentRunTerminalResult>
  readonly workerControl: AgentRunWorkerControl
}

export function createAgentRunCoordinator(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly registry?: RuntimeRegistry
  readonly repository?: AgentRunLifecycleRepository
  readonly eventPort: AgentRunEventPort
  readonly onEventDeliveryError?: (error: unknown) => void | Promise<void>
}): AgentRunCoordinator {
  const { sql, owner } = input
  if (typeof sql !== 'function' || !isResolvedOwnerScope(owner)) {
    throw new AgentRunCreationError('invalid_agent_run_input')
  }
  const registry = input.registry ?? productionRuntimeRegistry
  const repository = input.repository ?? createAgentRunLifecycleRepository()

  async function createOrReuse(
    transaction: TransactionSql,
    creationInput: AgentRunCreationInput,
  ): Promise<AgentRunCreationResult> {
    const parsed = CreationInputSchema.safeParse(creationInput)
    if (typeof transaction !== 'function' || !parsed.success) {
      throw new AgentRunCreationError('invalid_agent_run_input')
    }
    let definition
    try {
      definition = registry.resolveCurrent(parsed.data.runtimeType)
    } catch {
      throw new AgentRunCreationError('runtime_snapshot_unavailable')
    }
    let budget
    try {
      if (parsed.data.runtimeType === 'player') {
        await lockPlayerTimeoutSettings(transaction, owner)
        const settings = await readResolvedPlayerTimeoutSettings(
          transaction,
          owner,
        )
        const playerDefinition = registry.resolveCurrent('player')
        budget = playerDefinition.budgetPolicy.createSnapshot({
          runtimeType: 'player',
          ...settings,
        })
      } else {
        const coachDefinition = registry.resolveCurrent('coach')
        budget = coachDefinition.budgetPolicy.createSnapshot({
          runtimeType: 'coach',
        })
      }
      budget = createExecutionBudget(budget)
    } catch (error) {
      if (error instanceof AgentRunCreationError) throw error
      throw new AgentRunCreationError('runtime_snapshot_unavailable')
    }
    const runConfiguration = snapshotRunConfiguration(
      definition,
      parsed.data.dataDependencies,
    )
    try {
      encodeRunConfigurationAudit(runConfiguration)
    } catch {
      throw new AgentRunCreationError('runtime_snapshot_unavailable')
    }
    const createdMilliseconds = Date.parse(parsed.data.createdAt)
    if (
      !Number.isSafeInteger(createdMilliseconds) ||
      budget.maxWallClockMs > Number.MAX_SAFE_INTEGER - createdMilliseconds
    ) {
      throw new AgentRunCreationError('invalid_agent_run_input')
    }
    const deadlineAt = new Date(
      createdMilliseconds + budget.maxWallClockMs,
    ).toISOString()
    const result = await repository.createOrReuse(transaction, owner, {
      agentRunId: parsed.data.agentRunId,
      runtimeType: parsed.data.runtimeType,
      sessionId: parsed.data.sessionId,
      handId: parsed.data.handId,
      participantId:
        parsed.data.runtimeType === 'player'
          ? parsed.data.actorParticipantId
          : null,
      sourceStateVersion:
        parsed.data.runtimeType === 'player'
          ? parsed.data.sourceStateVersion
          : null,
      decisionRequestId:
        parsed.data.runtimeType === 'player'
          ? parsed.data.decisionRequestId
          : null,
      triggerType: parsed.data.triggerType,
      idempotencyKey: parsed.data.idempotencyKey,
      parentRunId: parsed.data.supersedesRunId,
      deadlineAt,
      runtimeDefinitionVersion: definition.runtimeDefinitionVersion,
      runConfiguration,
      budget,
      createdAt: parsed.data.createdAt,
    })
    if (result.kind === 'existing') {
      return deepFreeze({
        kind: 'existing' as const,
        run: result.run,
        committedEffects: [] as const,
      })
    }
    const effect = createEffect(result.run, 'queued')
    return deepFreeze({
      kind: 'created' as const,
      run: result.run,
      committedEffects: [effect] as const,
    })
  }

  function validateClaimCandidate(
    candidate: PersistedAgentRun,
    requestedLeaseOwner: string,
  ): ClaimCandidateDecision {
    let definition
    try {
      definition = registry.resolveExact(
        candidate.runtimeType,
        candidate.runtimeDefinitionVersion,
      )
    } catch (error) {
      return {
        kind: 'rejected',
        diagnostic:
          error instanceof RuntimeResolutionError
            ? 'agent_run_runtime_unavailable'
            : 'agent_run_payload_invalid',
      }
    }
    const expectedConfiguration = snapshotRunConfiguration(
      definition,
      candidate.runConfiguration.dataDependencies,
    )
    if (!isDeepStrictEqual(candidate.runConfiguration, expectedConfiguration)) {
      return { kind: 'rejected', diagnostic: 'agent_run_payload_invalid' }
    }
    if (
      candidate.lifecycle !== 'queued' &&
      candidate.leaseOwner !== requestedLeaseOwner
    ) {
      return { kind: 'rejected', diagnostic: 'agent_run_recovery_rejected' }
    }
    return { kind: 'eligible' }
  }

  const workerControl: AgentRunWorkerControl = {
    async claimNext(claimInput): Promise<AgentRunClaimResult> {
      const committedEffects: PersistedAgentRunEffect[] = []
      const transactionResult = await runDatabaseTransaction(
        sql,
        async (transaction) => {
          const recoverableRunIds = new Set<string>()
          const claimed = await repository.claimNext(
            transaction,
            owner,
            claimInput,
            (candidate) => {
              const decision = validateClaimCandidate(
                candidate,
                claimInput.leaseOwner,
              )
              if (
                decision.kind === 'rejected' &&
                decision.diagnostic === 'agent_run_recovery_rejected' &&
                candidate.runtimeType === 'coach'
              ) {
                recoverableRunIds.add(candidate.runId)
              }
              return decision
            },
          )
          for (const runId of recoverableRunIds) {
            let cancelResult
            try {
              cancelResult = await repository.cancel(transaction, owner, {
                runId,
                reason: 'process_restart',
                completedAt: new Date().toISOString(),
              })
            } catch (error) {
              if (
                !(error instanceof AgentRunTransitionError) ||
                error.failure !== 'agent_run_already_terminal'
              ) {
                throw error
              }
              continue
            }
            if (cancelResult.changed) {
              committedEffects.push(createEffect(cancelResult.run, 'cancelled'))
            }
          }
          if (claimed.kind === 'none') return claimed
          const run = claimed.value.run
          let authority
          try {
            authority = issueRuntimeCommitAuthority({
              runtimeType: run.runtimeType,
              runId: run.runId,
              leaseOwner: run.leaseOwner,
              fencingToken: run.fencingToken,
            })
          } catch {
            throw new AgentRunTransitionError('agent_run_fencing_rejected')
          }
          return deepFreeze({ kind: 'claimed' as const, run, authority })
        },
      )
      const publishedEffects = [
        ...committedEffects.map((effect) => effect.event),
        ...(transactionResult.kind === 'claimed'
          ? [createEffect(transactionResult.run, 'leased').event]
          : []),
      ]
      await publishBestEffort(
        input.eventPort,
        publishedEffects,
        input.onEventDeliveryError,
      )
      return transactionResult
    },

    async markRunning(authority) {
      const run = await runDatabaseTransaction(sql, (transaction) =>
        repository.markRunning(transaction, owner, authority),
      )
      await publishBestEffort(
        input.eventPort,
        [createEffect(run, 'running').event],
        input.onEventDeliveryError,
      )
      return run
    },

    renewLease: (authority) =>
      runDatabaseTransaction(sql, (transaction) =>
        repository.renewLease(transaction, owner, authority),
      ),

    inspectSettlement: (authority) =>
      runDatabaseTransaction(sql, (transaction) =>
        repository.inspectSettlement(transaction, owner, authority),
      ),

    classifyExecutionSettlement(settlement): AgentRunExecutionDisposition {
      if (settlement.persisted === 'terminal') return 'terminal'
      if (settlement.persisted === 'authorityLost') return 'authorityLost'
      return 'runtimeSettlementRequired'
    },
  }

  const coordinator: AgentRunCoordinator = {
    createOrReuse,
    async cancel(transaction, cancellationInput) {
      const result = await repository.cancel(
        transaction,
        owner,
        cancellationInput,
      )
      return deepFreeze({
        ...result,
        committedEffects: result.changed
          ? [createEffect(result.run, 'cancelled')]
          : [],
      })
    },
    async finalize(transaction, finalizationInput) {
      const result = await repository.finalize(
        transaction,
        owner,
        finalizationInput,
      )
      return deepFreeze({
        ...result,
        committedEffects: result.changed
          ? [createEffect(result.run, result.run.lifecycle)]
          : [],
      })
    },
    workerControl,
  }
  return Object.freeze({
    ...coordinator,
    workerControl: Object.freeze(workerControl),
  })
}
