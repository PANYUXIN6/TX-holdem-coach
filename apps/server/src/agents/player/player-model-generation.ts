import { createHash } from 'node:crypto'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type {
  ModelGateway,
  ModelSelectionSnapshot,
  StructuredGenerationResult,
} from '../foundation/model-gateway-protocol.js'
import type { ExecutionBudget } from '../foundation/execution-budget.js'
import type { ModelRoutePolicy } from '../foundation/model-route-policy.js'
import type { ModelPricingPolicy } from '../model-gateway/model-pricing-policy.js'
import type { SensitiveValueScanner } from '../foundation/context-envelope.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../foundation/runtime-ports.js'
import {
  isPlayerModelAttemptControlV1,
  type PlayerModelAttemptControlV1,
} from '../../persistence/player-model-attempt-control.js'
import type { PlayerBoundedChoiceV1 } from './player-bounded-choice.js'
import {
  isPlayerGenerationBundleV1,
  type PlayerGenerationBundleV1,
} from './player-model-adapter-boundary-guard.js'

function controlAuthorityHash(input: {
  readonly bundle: PlayerGenerationBundleV1
  readonly authority: RuntimeCommitAuthority<'player'>
}): string {
  return createHash('sha256')
    .update(
      canonicalJson({
        packetBindingSha256: createHash('sha256')
          .update(
            canonicalJson({
              binding: input.bundle.packet.binding,
              decisionRecordId: input.bundle.packet.decisionRecordId,
              candidateSetSha256: input.bundle.packet.candidateSetSha256,
            } as JsonValue),
            'utf8',
          )
          .digest('hex'),
        runtimeType: input.authority.runtimeType,
        runId: input.authority.runId,
        leaseOwner: input.authority.leaseOwner,
        fencingToken: input.authority.fencingToken,
      } as JsonValue),
      'utf8',
    )
    .digest('hex')
}

export async function generatePlayerBoundedChoice(input: {
  readonly gateway: ModelGateway
  readonly bundle: PlayerGenerationBundleV1
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly budget: ExecutionBudget
  readonly routePolicy: ModelRoutePolicy<'player'>
  readonly pricingPolicy: ModelPricingPolicy
  readonly modelSelection: ModelSelectionSnapshot
  readonly signal: AbortSignal
  readonly scanner: SensitiveValueScanner
  readonly control: PlayerModelAttemptControlV1
}): Promise<StructuredGenerationResult<PlayerBoundedChoiceV1>> {
  if (
    !isPlayerGenerationBundleV1(input.bundle) ||
    !isRuntimeCommitAuthority(input.authority, 'player') ||
    !isPlayerModelAttemptControlV1(input.control) ||
    input.control.decisionRecordId !== input.bundle.packet.decisionRecordId ||
    input.control.candidateSetSha256 !==
      input.bundle.packet.candidateSetSha256 ||
    input.control.authorityBindingSha256 !==
      controlAuthorityHash({ bundle: input.bundle, authority: input.authority })
  ) {
    return Object.freeze({
      kind: 'failed',
      failure: 'runtime_authority_lost',
      attempts: 0,
    })
  }
  return input.gateway.generateStructured({
    runtimeType: 'player',
    runtimeDefinitionVersion: 1,
    authority: input.authority,
    budget: input.budget,
    routePolicy: input.routePolicy,
    pricingPolicy: input.pricingPolicy,
    request: input.bundle.request,
    outputSchemaReference: input.bundle.outputSchemaReference,
    outputSchema: input.bundle.outputSchema,
    validate: input.bundle.validate,
    modelSelection: input.modelSelection,
    signal: input.signal,
    stage: 'player.bounded-choice',
    scanner: input.scanner,
    control: input.control,
  })
}
