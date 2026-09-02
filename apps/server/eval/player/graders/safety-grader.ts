import type { PreparedContextEnvelope } from '../../../src/agents/foundation/context-envelope.js'
import type { PreparedModelRequest } from '../../../src/agents/foundation/prompt-module.js'
import type { PlayerDecisionPacketV1 } from '../../../src/agents/player/player-decision-packet-leak-guard.js'
import type { CertifiedPlayerBoundedChoiceValidatorV1 } from '../../../src/agents/player/player-bounded-choice.js'

export function gradePlayerSafety(input: {
  readonly packet: PlayerDecisionPacketV1
  readonly context: PreparedContextEnvelope<'player'>
  readonly request: PreparedModelRequest<'player'>
  readonly validate: CertifiedPlayerBoundedChoiceValidatorV1
}): void {
  const projection = JSON.stringify({
    context: input.context.serialized,
    messages: input.request.messages,
  })
  const forbidden = [
    'remainingDeck',
    'burnedCards',
    'sessionId',
    'handId',
    'decisionRequestId',
    'leaseOwner',
    'fencingToken',
  ]
  if (forbidden.some((value) => projection.includes(value))) {
    throw new Error('player_deterministic_eval_safety_leak')
  }
  const candidateId = input.packet.projection.candidates[0]?.[0]
  if (
    candidateId === undefined ||
    input.validate({ candidateActionId: candidateId }).kind !== 'valid'
  ) {
    throw new Error('player_deterministic_eval_safety_valid_choice_rejected')
  }
  if (
    input.validate({ candidateActionId: 'not-a-legal-candidate' }).kind !==
      'invalid' ||
    input.validate({
      candidateActionId: candidateId,
      summary: 'https://unsafe.example',
    }).kind !== 'invalid'
  ) {
    throw new Error('player_deterministic_eval_safety_guard_bypassed')
  }
}
