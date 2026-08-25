import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import type {
  ModelVisibleValidationIssue,
  RuntimeOutputValidation,
} from '../foundation/model-gateway-protocol.js'
import type { SensitiveValueScanner } from '../foundation/context-envelope.js'
import {
  isPlayerDecisionPacketV1,
  type PlayerDecisionPacketV1,
} from './player-decision-packet-leak-guard.js'

const RawPlayerBoundedChoiceSchema = z.strictObject({
  candidateActionId: z.string().trim().min(1).max(128),
  summary: z.string().trim().min(1).max(160).optional(),
})

export type PlayerBoundedChoiceV1 =
  | Readonly<{ candidateActionId: string }>
  | Readonly<{ candidateActionId: string; summary: string }>

export const PlayerBoundedChoiceSchema =
  RawPlayerBoundedChoiceSchema as unknown as z.ZodType<PlayerBoundedChoiceV1>

declare const certifiedPlayerBoundedChoiceValidatorBrand: unique symbol
export type CertifiedPlayerBoundedChoiceValidatorV1 = ((
  value: PlayerBoundedChoiceV1,
) => RuntimeOutputValidation<PlayerBoundedChoiceV1>) & {
  readonly [certifiedPlayerBoundedChoiceValidatorBrand]: never
}

interface ValidatorBinding {
  readonly packet: PlayerDecisionPacketV1
  readonly candidateSetSha256: string
}

const validatorBindings = new WeakMap<Function, ValidatorBinding>()
const UNKNOWN_CANDIDATE_ISSUE = Object.freeze({
  code: 'candidate_action_unknown',
  path: Object.freeze(['candidateActionId']),
}) satisfies ModelVisibleValidationIssue
const SUMMARY_NOT_ALLOWED_ISSUE = Object.freeze({
  code: 'summary_not_allowed',
  path: Object.freeze(['summary']),
}) satisfies ModelVisibleValidationIssue

function unsafeSummary(
  summary: string,
  scanner: SensitiveValueScanner,
): boolean {
  if (
    /[\u0000-\u001f\u007f]/.test(summary) ||
    /(?:https?:\/\/|www\.)/i.test(summary) ||
    /(?:<\/?think>|chain[- ]of[- ]thought|hidden reasoning|system prompt)/i.test(
      summary,
    )
  ) {
    return true
  }
  try {
    scanner.assertSafe({ summary })
    return false
  } catch {
    return true
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

export function createPlayerBoundedChoiceValidator(input: {
  readonly packet: PlayerDecisionPacketV1
  readonly scanner: SensitiveValueScanner
}): CertifiedPlayerBoundedChoiceValidatorV1 {
  if (!isPlayerDecisionPacketV1(input.packet)) {
    throw new RangeError('Player 选择 Validator 只接受认证 Packet。')
  }
  const candidateIds = new Set(
    input.packet.projection.candidates.map((candidate) => candidate[0]),
  )
  const validate = ((value: PlayerBoundedChoiceV1) => {
    const parsed = PlayerBoundedChoiceSchema.safeParse(value)
    if (!parsed.success) {
      return Object.freeze({
        kind: 'invalid' as const,
        issues: Object.freeze([UNKNOWN_CANDIDATE_ISSUE]),
      })
    }
    const issues: ModelVisibleValidationIssue[] = []
    if (!candidateIds.has(parsed.data.candidateActionId)) {
      issues.push(UNKNOWN_CANDIDATE_ISSUE)
    }
    if (
      'summary' in parsed.data &&
      unsafeSummary(parsed.data.summary, input.scanner)
    ) {
      issues.push(SUMMARY_NOT_ALLOWED_ISSUE)
    }
    if (issues.length > 0) {
      return Object.freeze({
        kind: 'invalid' as const,
        issues: Object.freeze(issues),
      })
    }
    return Object.freeze({
      kind: 'valid' as const,
      value: deepFreeze(PlayerBoundedChoiceSchema.parse(parsed.data)),
    })
  }) as CertifiedPlayerBoundedChoiceValidatorV1
  validatorBindings.set(validate, {
    packet: input.packet,
    candidateSetSha256: input.packet.candidateSetSha256,
  })
  return Object.freeze(validate)
}

export function isCertifiedPlayerBoundedChoiceValidatorV1(input: {
  readonly value: unknown
  readonly packet: PlayerDecisionPacketV1
}): boolean {
  if (
    typeof input.value !== 'function' ||
    !isPlayerDecisionPacketV1(input.packet)
  ) {
    return false
  }
  const binding = validatorBindings.get(input.value)
  return (
    binding?.packet === input.packet &&
    binding.candidateSetSha256 === input.packet.candidateSetSha256
  )
}

export const PlayerValidatorResultV1Schema = z.strictObject({
  validatorResultSchemaVersion: z.literal(1),
  validatorReference: z.strictObject({
    id: z.literal('player.validator.decision'),
    version: z.literal(1),
  }),
  candidateSetSha256: z.string().regex(/^[0-9a-f]{64}$/),
  choiceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  validationStatus: z.literal('valid'),
})

export type PlayerValidatorResultV1 = Readonly<
  z.infer<typeof PlayerValidatorResultV1Schema>
>

export function createPlayerValidatorResultV1(input: {
  readonly packet: PlayerDecisionPacketV1
  readonly choice: PlayerBoundedChoiceV1
}): PlayerValidatorResultV1 {
  if (
    !isPlayerDecisionPacketV1(input.packet) ||
    !input.packet.projection.candidates.some(
      (candidate) => candidate[0] === input.choice.candidateActionId,
    )
  ) {
    throw new RangeError('Player 选择结果未绑定候选集合。')
  }
  const choice = PlayerBoundedChoiceSchema.parse(input.choice)
  return deepFreeze(
    PlayerValidatorResultV1Schema.parse({
      validatorResultSchemaVersion: 1,
      validatorReference: { id: 'player.validator.decision', version: 1 },
      candidateSetSha256: input.packet.candidateSetSha256,
      choiceSha256: createHash('sha256')
        .update(canonicalJson(choice as unknown as JsonValue), 'utf8')
        .digest('hex'),
      validationStatus: 'valid',
    }),
  )
}
