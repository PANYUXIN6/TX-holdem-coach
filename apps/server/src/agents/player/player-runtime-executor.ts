import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type { DatabaseClient } from '../../db/client.js'
import { PERSONA_MODEL_BUNDLE_DEFAULTS } from '../../personas/config.js'
import type { StrategyPackRepository } from '../../poker-strategy/strategy-pack-repository.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type {
  PlayerDecisionRepository,
  PlayerDecisionResumeState,
} from '../../persistence/player-decision-repository.js'
import type { PlayerModelAttemptControlV1 } from '../../persistence/player-model-attempt-control.js'
import type { PlayerRunObservationPortFactory } from '../../persistence/player-run-observation-port.js'
import type { LeasedAgentRun } from '../foundation/agent-run-types.js'
import type { RuntimeExecutionPort } from '../foundation/agent-worker-ports.js'
import type {
  CapabilityExecutionControlPort,
  CapabilityExecutor,
} from '../foundation/capability-executor.js'
import {
  prepareContextEnvelope,
  type SensitiveValueScanner,
} from '../foundation/context-envelope.js'
import type { ModelGateway } from '../foundation/model-gateway-protocol.js'
import type { ModelGatewayFailure } from '../foundation/errors.js'
import type { ModelRoutePolicy } from '../foundation/model-route-policy.js'
import { prepareModelRequest } from '../foundation/prompt-module.js'
import {
  issueRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../foundation/runtime-ports.js'
import type { RuntimeRegistry } from '../foundation/runtime-registry.js'
import type { ModelPricingPolicy } from '../model-gateway/model-pricing-policy.js'
import { playerRuntimeDefinition } from './foundation-definition.js'
import {
  buildDecisionAuditSnapshotV1,
  certifyPersistedDecisionAuditSnapshotV1,
  type DecisionAuditSnapshotV1,
} from './player-decision-audit.js'
import type { PlayerDecisionPreprocessingPlan } from './player-decision-preprocessing-plan.js'
import type { PlayerDecisionReferencePort } from './player-decision-reference-port.js'
import {
  certifyPlayerDecisionPacketV1,
  type PlayerDecisionPacketV1,
} from './player-decision-packet-leak-guard.js'
import { readPinnedStrategyPackReference } from './player-strategy-pack-audit-reference.js'
import {
  playerContextPolicy,
  PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
} from './player-context-policy.js'
import {
  createPlayerBoundedChoiceValidator,
  PlayerBoundedChoiceSchema,
} from './player-bounded-choice.js'
import {
  PLAYER_OUTPUT_SCHEMA_REFERENCE,
  PLAYER_VALIDATOR_REFERENCE,
  certifyPlayerPreparedGenerationBundleV1,
} from './player-model-adapter-boundary-guard.js'
import { generatePlayerBoundedChoice } from './player-model-generation.js'
import { PLAYER_MODEL_INPUT_LIMITS } from './player-model-input-limits.js'
import { buildPlayerModelProjectionV1 } from './player-model-projection.js'
import {
  createPlayerPromptInvocations,
  playerPromptModules,
} from './player-prompt-modules.js'
import {
  certifyPlayerRuntimeCandidateResultV1,
  type PlayerRuntimeResultPort,
} from './player-runtime-result-port.js'

export type PlayerRuntimeFailureCode =
  | 'player_decision_runtime_mismatch'
  | 'player_decision_dependency_missing'
  | 'player_decision_dependency_mismatch'
  | 'player_decision_snapshot_rejected'
  | 'player_decision_projection_rejected'
  | 'player_decision_packet_leak_rejected'
  | 'player_model_adapter_boundary_rejected'
  | 'player_decision_persistence_rejected'
  | 'player_decision_resume_rejected'
  | 'player_decision_resume_inflight_unknown'
  | 'player_bounded_choice_failed'
  | 'player_decision_authority_lost'
  | ModelGatewayFailure

export class PlayerRuntimeExecutionError extends Error {
  public constructor(public readonly code: PlayerRuntimeFailureCode) {
    super('Player Runtime 决策执行失败。')
    this.name = 'PlayerRuntimeExecutionError'
  }
}

export interface PlayerRuntimeExecutorDependencies {
  readonly database: DatabaseClient
  readonly owner: ResolvedOwnerScope
  readonly registry: RuntimeRegistry
  readonly observationPortFactory: PlayerRunObservationPortFactory
  readonly referencePort: PlayerDecisionReferencePort
  readonly strategyPackRepository: StrategyPackRepository
  readonly capabilityExecutor: CapabilityExecutor<'player'>
  readonly capabilityControlFactory: (input: {
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly run: LeasedAgentRun<'player'>
  }) => CapabilityExecutionControlPort
  readonly preprocessingPlan: PlayerDecisionPreprocessingPlan
  readonly decisionRepository: PlayerDecisionRepository
  readonly scanner: SensitiveValueScanner
  readonly modelGateway: ModelGateway
  readonly routePolicy: ModelRoutePolicy<'player'>
  readonly pricingPolicy: ModelPricingPolicy
  readonly modelControlFactory: (input: {
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly packet: PlayerDecisionPacketV1
  }) => PlayerModelAttemptControlV1
  readonly resultPort: PlayerRuntimeResultPort
}

function expectedRunConfiguration(run: LeasedAgentRun<'player'>): JsonValue {
  const definition = playerRuntimeDefinition
  return {
    runtime: definition.runtimeType,
    runtimeDefinitionVersion: definition.runtimeDefinitionVersion,
    contextSchemaVersion: definition.contextSchemaVersion,
    promptModules: definition.promptModules,
    capabilityManifest: {
      id: 'player.capability-manifest',
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
    dataDependencies: run.runConfiguration.dataDependencies,
  }
}

function verifyRun(
  run: LeasedAgentRun<'player'>,
  registry: RuntimeRegistry,
): void {
  if (run.runtimeType !== 'player' || run.lifecycle !== 'running') {
    throw new PlayerRuntimeExecutionError('player_decision_runtime_mismatch')
  }
  let definition
  try {
    definition = registry.resolveExact('player', run.runtimeDefinitionVersion)
  } catch {
    throw new PlayerRuntimeExecutionError('player_decision_runtime_mismatch')
  }
  if (
    definition.runtimeDefinitionVersion !==
      playerRuntimeDefinition.runtimeDefinitionVersion ||
    canonicalJson(run.runConfiguration as unknown as JsonValue) !==
      canonicalJson(expectedRunConfiguration(run))
  ) {
    throw new PlayerRuntimeExecutionError('player_decision_runtime_mismatch')
  }
}

function certifyResumeSnapshot(
  state: Extract<
    PlayerDecisionResumeState,
    { readonly kind: 'auditPrepared' | 'modelPrepared' }
  >,
  authority: RuntimeCommitAuthority<'player'>,
): DecisionAuditSnapshotV1 {
  try {
    return certifyPersistedDecisionAuditSnapshotV1({
      snapshot: state.record.auditSnapshot,
      authority,
      expected: {
        sessionId: state.record.sessionId,
        handId: state.record.handId,
        participantId: state.record.participantId,
        sourceStateVersion: state.record.sourceStateVersion,
        decisionRequestId: state.record.decisionRequestId,
      },
    })
  } catch {
    throw new PlayerRuntimeExecutionError('player_decision_resume_rejected')
  }
}

export function createPlayerRuntimeExecutor(
  dependencies: PlayerRuntimeExecutorDependencies,
): RuntimeExecutionPort<'player'> {
  const executor: RuntimeExecutionPort<'player'> = {
    runtimeType: 'player',
    async execute(run, signal) {
      verifyRun(run, dependencies.registry)
      const authority = issueRuntimeCommitAuthority({
        runtimeType: 'player',
        runId: run.runId,
        leaseOwner: run.leaseOwner,
        fencingToken: run.fencingToken,
      })
      let resume: PlayerDecisionResumeState
      try {
        resume = await runDatabaseTransaction(
          dependencies.database.sql,
          (transaction) =>
            dependencies.decisionRepository.readForResume(
              transaction,
              dependencies.owner,
              authority,
            ),
        )
      } catch {
        throw new PlayerRuntimeExecutionError(
          'player_decision_persistence_rejected',
        )
      }
      if (resume.kind === 'inflightUnknown') {
        throw new PlayerRuntimeExecutionError(
          'player_decision_resume_inflight_unknown',
        )
      }
      if (resume.kind === 'committed' || resume.kind === 'terminal') {
        throw new PlayerRuntimeExecutionError('player_decision_resume_rejected')
      }
      if (resume.kind === 'selected') {
        if (resume.record.choice === null) {
          throw new PlayerRuntimeExecutionError(
            'player_decision_resume_rejected',
          )
        }
        const receipt = await runDatabaseTransaction(
          dependencies.database.sql,
          (transaction) =>
            dependencies.decisionRepository.readSelectedReceipt(
              transaction,
              dependencies.owner,
              authority,
              {
                decisionRecordId: resume.record.decisionRecordId,
                expectedChoice: resume.record.choice!,
              },
            ),
        )
        await dependencies.resultPort.publish({
          authority,
          result: certifyPlayerRuntimeCandidateResultV1(receipt),
        })
        return
      }

      let snapshot: DecisionAuditSnapshotV1
      let decisionRecordId: string
      let projection
      if (resume.kind === 'none') {
        const observationResult = await dependencies
          .observationPortFactory({
            database: dependencies.database,
            authority,
          })
          .loadForRun({ owner: dependencies.owner, run })
        if (observationResult.kind !== 'ready') {
          throw new PlayerRuntimeExecutionError(
            observationResult.kind === 'authorityLost'
              ? 'player_decision_authority_lost'
              : 'player_decision_snapshot_rejected',
          )
        }
        const referenceResult = await dependencies.referencePort.load({
          owner: dependencies.owner,
          observation: observationResult.observation,
        })
        if (referenceResult.kind !== 'ready') {
          throw new PlayerRuntimeExecutionError(
            'player_decision_dependency_missing',
          )
        }
        let pinnedReference
        let strategyPack
        try {
          pinnedReference = readPinnedStrategyPackReference(
            run.runConfiguration.dataDependencies,
          )
          strategyPack = dependencies.strategyPackRepository.read({
            reference: pinnedReference,
            usage: 'pinnedRun',
          })
        } catch {
          throw new PlayerRuntimeExecutionError(
            'player_decision_dependency_mismatch',
          )
        }
        const preprocessing = await dependencies.preprocessingPlan.execute({
          executor: dependencies.capabilityExecutor,
          authority,
          control: dependencies.capabilityControlFactory({ authority, run }),
          signal,
          observation: observationResult.observation,
          reference: referenceResult.reference,
          strategyPack,
        })
        try {
          snapshot = buildDecisionAuditSnapshotV1({
            observation: observationResult.observation,
            preprocessing,
            strategyPackRef: pinnedReference,
          })
        } catch {
          throw new PlayerRuntimeExecutionError(
            'player_decision_snapshot_rejected',
          )
        }
        const created = await runDatabaseTransaction(
          dependencies.database.sql,
          (transaction) =>
            dependencies.decisionRepository.createAuditPrepared(
              transaction,
              dependencies.owner,
              authority,
              { snapshot },
            ),
        )
        decisionRecordId = created.decisionRecordId
        projection = buildPlayerModelProjectionV1(snapshot)
      } else {
        snapshot = certifyResumeSnapshot(resume, authority)
        decisionRecordId = resume.record.decisionRecordId
        projection = buildPlayerModelProjectionV1(snapshot)
        if (
          resume.kind === 'modelPrepared' &&
          (resume.record.projection === null ||
            canonicalJson(resume.record.projection as unknown as JsonValue) !==
              canonicalJson(projection as unknown as JsonValue))
        ) {
          throw new PlayerRuntimeExecutionError(
            'player_decision_resume_rejected',
          )
        }
      }
      let packet: PlayerDecisionPacketV1
      try {
        packet = certifyPlayerDecisionPacketV1({
          snapshot,
          decisionRecordId,
          projection,
        })
      } catch {
        throw new PlayerRuntimeExecutionError(
          'player_decision_packet_leak_rejected',
        )
      }
      if (resume.kind !== 'modelPrepared') {
        await runDatabaseTransaction(dependencies.database.sql, (transaction) =>
          dependencies.decisionRepository.markModelPrepared(
            transaction,
            dependencies.owner,
            authority,
            {
              decisionRecordId,
              snapshotSha256: snapshot.snapshotSha256,
              candidateSetSha256: snapshot.candidates.candidateSetSha256,
              projection,
            },
          ),
        )
      }
      const context = prepareContextEnvelope({
        envelope: {
          runtimeType: 'player',
          runtimeDefinitionVersion: 1,
          contextSchemaVersion: 1,
          contextKind: 'decision',
          promptModules: playerRuntimeDefinition.promptModules,
          sourceVersions: [
            {
              source: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
              contentVersion: packet.projectionSha256,
            },
          ],
          sections: [
            {
              sectionId: 'playerDecision',
              schema: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
              payload: packet as unknown as JsonValue,
            },
          ],
        },
        policy: playerContextPolicy,
        registry: dependencies.registry,
        budget: run.budget,
        scanner: dependencies.scanner,
      })
      const request = prepareModelRequest({
        runtimeType: 'player',
        runtimeDefinitionVersion: 1,
        context,
        modules: playerPromptModules,
        invocations: createPlayerPromptInvocations(),
        registry: dependencies.registry,
        scanner: dependencies.scanner,
        maximumRequestBytes: PLAYER_MODEL_INPUT_LIMITS.maximumRequestBytes,
        maximumInputTokens: run.budget.maxInputTokens,
      })
      const validate = createPlayerBoundedChoiceValidator({
        packet,
        scanner: dependencies.scanner,
      })
      let bundle
      try {
        bundle = certifyPlayerPreparedGenerationBundleV1({
          packet,
          context,
          request,
          outputSchemaReference: PLAYER_OUTPUT_SCHEMA_REFERENCE,
          outputSchema: PlayerBoundedChoiceSchema,
          validatorReference: PLAYER_VALIDATOR_REFERENCE,
          validate,
        })
      } catch {
        throw new PlayerRuntimeExecutionError(
          'player_model_adapter_boundary_rejected',
        )
      }
      const control = dependencies.modelControlFactory({ authority, packet })
      const generated = await generatePlayerBoundedChoice({
        gateway: dependencies.modelGateway,
        bundle,
        authority,
        budget: run.budget,
        routePolicy: dependencies.routePolicy,
        pricingPolicy: dependencies.pricingPolicy,
        modelSelection: PERSONA_MODEL_BUNDLE_DEFAULTS,
        signal,
        scanner: dependencies.scanner,
        control,
      })
      if (generated.kind !== 'accepted') {
        throw new PlayerRuntimeExecutionError(generated.failure)
      }
      const receipt = await runDatabaseTransaction(
        dependencies.database.sql,
        (transaction) =>
          dependencies.decisionRepository.readSelectedReceipt(
            transaction,
            dependencies.owner,
            authority,
            {
              decisionRecordId,
              expectedChoice: generated.value,
            },
          ),
      )
      await dependencies.resultPort.publish({
        authority,
        result: certifyPlayerRuntimeCandidateResultV1(receipt),
      })
    },
  }
  return Object.freeze(executor)
}
