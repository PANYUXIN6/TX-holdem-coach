import { createHash } from 'node:crypto'
import { PokerActionSchema, type PokerAction } from '@tx-holdem-coach/contracts'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { isLegalCandidateSemanticallyConsistent } from '../../poker/betting-projection.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../foundation/runtime-ports.js'
import type { PlayerRuntimeDefinition } from './foundation-definition.js'
import {
  CandidateOutcomeDataSchema,
  FinalCandidateDataSchema,
} from './player-decision-preprocessing-schema.js'
import {
  isPlayerRuntimeCandidateResultV1,
  type PlayerRuntimeCandidateResultV1,
} from './player-runtime-result-port.js'
import {
  isDecodedPlayerDecisionRecordV1,
  type DecodedPlayerDecisionRecordV1,
} from '../../persistence/player-decision-repository.js'

export const PLAYER_COMMIT_GATE_REFERENCE = Object.freeze({
  id: 'player.commit-poker-decision',
  version: 1,
} as const)

declare const playerValidatedDecisionBrand: unique symbol

export interface PlayerValidatedDecisionV1 {
  readonly validatedDecisionSchemaVersion: 1
  readonly runtimeType: 'player'
  readonly runtimeDefinitionVersion: 1
  readonly commitGateReference: typeof PLAYER_COMMIT_GATE_REFERENCE
  readonly outputSchemaReference: {
    readonly id: 'player.output.decision'
    readonly version: 1
  }
  readonly validatorReference: {
    readonly id: 'player.validator.decision'
    readonly version: 1
  }
  readonly decisionRecordId: string
  readonly agentRunId: string
  readonly binding: {
    readonly sessionId: string
    readonly handId: string
    readonly stateVersion: number
    readonly decisionRequestId: string
    readonly actorParticipantId: string
    readonly actorSeat: number
    readonly pokerRuleSetVersion: string
  }
  readonly candidateSetSchemaVersion: 1
  readonly candidateSetSha256: string
  readonly selectedCandidateActionId: string
  readonly selectedAction: PokerAction
  readonly choiceSha256: string
  readonly acceptedAttemptId: string
  readonly commandId: string
  readonly [playerValidatedDecisionBrand]: never
}

export interface PlayerDecisionValidationInput {
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly result: PlayerRuntimeCandidateResultV1
  readonly persisted: DecodedPlayerDecisionRecordV1
  readonly runtimeDefinition: PlayerRuntimeDefinition
}

export class PlayerDecisionValidationError extends Error {
  public constructor() {
    super('Player 已选择决策未通过提交校验。')
    this.name = 'PlayerDecisionValidationError'
  }
}

const validatedDecisions = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left as JsonValue) === canonicalJson(right as JsonValue)
}

function sha256(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value as JsonValue), 'utf8')
    .digest('hex')
}

function uuidEquals(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase()
}

function requireValidCandidateSet(
  persisted: DecodedPlayerDecisionRecordV1,
  candidateActionId: string,
) {
  const { candidateSet, auditSnapshot } = persisted
  if (
    candidateSet.candidateSetSchemaVersion !== 1 ||
    !canonicalEqual(candidateSet, auditSnapshot.candidates) ||
    candidateSet.candidateSetSha256 !==
      sha256(
        (({ candidateSetSha256: _hash, ...value }) => value)(candidateSet),
      ) ||
    !canonicalEqual(candidateSet.binding, auditSnapshot.binding)
  ) {
    throw new PlayerDecisionValidationError()
  }

  const matchingCandidates = candidateSet.candidates.filter(
    (candidate) => candidate.candidateId === candidateActionId,
  )
  if (matchingCandidates.length !== 1) {
    throw new PlayerDecisionValidationError()
  }
  const candidate = FinalCandidateDataSchema.safeParse(matchingCandidates[0])
  if (!candidate.success) throw new PlayerDecisionValidationError()

  const candidateIds = candidateSet.candidates.map((item) => item.candidateId)
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new PlayerDecisionValidationError()
  }
  const matchingOutcomes = candidateSet.outcomes.filter(
    (outcome) => outcome.candidate.candidateId === candidateActionId,
  )
  if (matchingOutcomes.length !== 1) {
    throw new PlayerDecisionValidationError()
  }
  const outcome = CandidateOutcomeDataSchema.safeParse(matchingOutcomes[0])
  const targetMatches =
    outcome.success &&
    outcome.data.targetStreetCommitment.status === 'available'
      ? outcome.data.targetStreetCommitment.value ===
        candidate.data.targetStreetCommitment
      : candidate.data.targetStreetCommitment === null
  if (
    !outcome.success ||
    !isLegalCandidateSemanticallyConsistent(outcome.data.candidate) ||
    outcome.data.contributionDelta !== candidate.data.contributionDelta ||
    !targetMatches ||
    !canonicalEqual(outcome.data.candidate.action, candidate.data.action)
  ) {
    throw new PlayerDecisionValidationError()
  }
  return candidate.data
}

function requireMatchingIdentity(input: PlayerDecisionValidationInput): void {
  const { authority, result, persisted } = input
  const binding = persisted.auditSnapshot.binding
  if (
    authority.runtimeType !== 'player' ||
    !uuidEquals(authority.runId, persisted.agentRunId) ||
    !uuidEquals(result.decisionRecordId, persisted.decisionRecordId) ||
    !uuidEquals(result.binding.sessionId, persisted.sessionId) ||
    !uuidEquals(result.binding.handId, persisted.handId) ||
    !uuidEquals(
      result.binding.decisionRequestId,
      persisted.decisionRequestId,
    ) ||
    result.binding.stateVersion !== persisted.sourceStateVersion ||
    !uuidEquals(result.binding.actorParticipantId, persisted.participantId) ||
    !canonicalEqual(result.binding, binding) ||
    !canonicalEqual(binding, persisted.candidateSet.binding) ||
    persisted.auditSnapshot.pokerRuleSetVersion !==
      binding.pokerRuleSetVersion ||
    result.candidateSetSha256 !== persisted.candidateSet.candidateSetSha256 ||
    result.selectedCandidateActionId !== persisted.choice?.candidateActionId ||
    result.choiceSha256 !== persisted.validatorResult?.choiceSha256 ||
    !uuidEquals(result.acceptedAttemptId, persisted.acceptedAttemptId ?? '')
  ) {
    throw new PlayerDecisionValidationError()
  }
}

function requireCurrentReferences(input: PlayerDecisionValidationInput): void {
  const { persisted, runtimeDefinition } = input
  const validator = persisted.validatorResult
  if (
    runtimeDefinition.runtimeType !== 'player' ||
    runtimeDefinition.runtimeDefinitionVersion !== 1 ||
    runtimeDefinition.outputSchema.id !== 'player.output.decision' ||
    runtimeDefinition.outputSchema.version !== 1 ||
    runtimeDefinition.validator.id !== 'player.validator.decision' ||
    runtimeDefinition.validator.version !== 1 ||
    runtimeDefinition.commitGate.id !== PLAYER_COMMIT_GATE_REFERENCE.id ||
    runtimeDefinition.commitGate.version !==
      PLAYER_COMMIT_GATE_REFERENCE.version ||
    persisted.choice === null ||
    validator === null ||
    validator.validatorResultSchemaVersion !== 1 ||
    validator.validatorReference.id !== 'player.validator.decision' ||
    validator.validatorReference.version !== 1 ||
    validator.validationStatus !== 'valid' ||
    validator.candidateSetSha256 !==
      persisted.candidateSet.candidateSetSha256 ||
    validator.choiceSha256 !== sha256(persisted.choice)
  ) {
    throw new PlayerDecisionValidationError()
  }
}

export function validatePlayerDecisionV1(
  input: PlayerDecisionValidationInput,
): PlayerValidatedDecisionV1 {
  if (
    !isPlayerRuntimeCandidateResultV1(input.result) ||
    !isRuntimeCommitAuthority(input.authority, 'player') ||
    !isDecodedPlayerDecisionRecordV1(input.persisted) ||
    (input.persisted.status !== 'selected' &&
      input.persisted.status !== 'committed')
  ) {
    throw new PlayerDecisionValidationError()
  }

  requireMatchingIdentity(input)
  requireCurrentReferences(input)
  const candidate = requireValidCandidateSet(
    input.persisted,
    input.result.selectedCandidateActionId,
  )
  const action = PokerActionSchema.safeParse(candidate.action)
  if (!action.success) throw new PlayerDecisionValidationError()

  const validated = deepFreeze({
    validatedDecisionSchemaVersion: 1 as const,
    runtimeType: 'player' as const,
    runtimeDefinitionVersion: 1 as const,
    commitGateReference: PLAYER_COMMIT_GATE_REFERENCE,
    outputSchemaReference: {
      id: 'player.output.decision' as const,
      version: 1 as const,
    },
    validatorReference: {
      id: 'player.validator.decision' as const,
      version: 1 as const,
    },
    decisionRecordId: input.persisted.decisionRecordId,
    agentRunId: input.persisted.agentRunId,
    binding: {
      sessionId: input.persisted.sessionId,
      handId: input.persisted.handId,
      stateVersion: input.persisted.sourceStateVersion,
      decisionRequestId: input.persisted.decisionRequestId,
      actorParticipantId: input.persisted.participantId,
      actorSeat: input.persisted.auditSnapshot.binding.actorSeat,
      pokerRuleSetVersion:
        input.persisted.auditSnapshot.binding.pokerRuleSetVersion,
    },
    candidateSetSchemaVersion: 1 as const,
    candidateSetSha256: input.persisted.candidateSet.candidateSetSha256,
    selectedCandidateActionId: input.result.selectedCandidateActionId,
    selectedAction: action.data,
    choiceSha256: input.result.choiceSha256,
    acceptedAttemptId: input.result.acceptedAttemptId,
    commandId: input.persisted.decisionRecordId.toLowerCase(),
  }) as PlayerValidatedDecisionV1
  validatedDecisions.add(validated)
  return validated
}

export function isPlayerValidatedDecisionV1(
  value: unknown,
): value is PlayerValidatedDecisionV1 {
  return (
    typeof value === 'object' && value !== null && validatedDecisions.has(value)
  )
}
