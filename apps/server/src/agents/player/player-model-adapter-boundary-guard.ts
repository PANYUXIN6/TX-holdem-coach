import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import {
  isPreparedContextEnvelope,
  type PreparedContextEnvelope,
} from '../foundation/context-envelope.js'
import {
  isPreparedModelRequest,
  READ_ONLY_CONTEXT_MESSAGE_PREFIX,
  type PreparedModelRequest,
} from '../foundation/prompt-module.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import {
  PlayerBoundedChoiceSchema,
  isCertifiedPlayerBoundedChoiceValidatorV1,
  type CertifiedPlayerBoundedChoiceValidatorV1,
} from './player-bounded-choice.js'
import {
  isPlayerDecisionPacketV1,
  type PlayerDecisionPacketV1,
} from './player-decision-packet-leak-guard.js'
import { PlayerDecisionContextSectionV1Schema } from './player-model-projection.js'
import { PLAYER_STATIC_PROMPT_MESSAGES_V1 } from './player-prompt-modules.js'
import {
  decodeFrozenPlayerModelInputV1,
  restoreFrozenPlayerModelRequestV1,
  type FrozenPlayerModelInputV1,
} from './player-frozen-model-input.js'

export const PLAYER_OUTPUT_SCHEMA_REFERENCE = Object.freeze({
  id: 'player.output.decision',
  version: 1,
} as const satisfies RuntimeComponentReference)
export const PLAYER_VALIDATOR_REFERENCE = Object.freeze({
  id: 'player.validator.decision',
  version: 1,
} as const satisfies RuntimeComponentReference)

declare const playerPreparedGenerationBundleBrand: unique symbol
declare const playerFrozenGenerationBundleBrand: unique symbol
interface PlayerGenerationBundleCommonV1 {
  readonly packet: PlayerDecisionPacketV1
  readonly request: PreparedModelRequest<'player'>
  readonly outputSchemaReference: typeof PLAYER_OUTPUT_SCHEMA_REFERENCE
  readonly outputSchema: typeof PlayerBoundedChoiceSchema
  readonly validatorReference: typeof PLAYER_VALIDATOR_REFERENCE
  readonly validate: CertifiedPlayerBoundedChoiceValidatorV1
}

export interface PlayerPreparedGenerationBundleV1 {
  readonly packet: PlayerDecisionPacketV1
  readonly context: PreparedContextEnvelope<'player'>
  readonly request: PreparedModelRequest<'player'>
  readonly outputSchemaReference: typeof PLAYER_OUTPUT_SCHEMA_REFERENCE
  readonly outputSchema: typeof PlayerBoundedChoiceSchema
  readonly validatorReference: typeof PLAYER_VALIDATOR_REFERENCE
  readonly validate: CertifiedPlayerBoundedChoiceValidatorV1
  readonly [playerPreparedGenerationBundleBrand]: never
}

/**
 * modelPrepared 恢复的 bundle 不携带新生成的 Context：Provider request 只能来自
 * 持久化的冻结输入，避免 Prompt 或上下文代码变化重写已承诺的首次调用。
 */
export interface PlayerFrozenGenerationBundleV1 extends PlayerGenerationBundleCommonV1 {
  readonly frozenModelInput: FrozenPlayerModelInputV1
  readonly [playerFrozenGenerationBundleBrand]: never
}

export type PlayerGenerationBundleV1 =
  PlayerPreparedGenerationBundleV1 | PlayerFrozenGenerationBundleV1

const certifiedBundles = new WeakSet<object>()
const ContextEnvelopeProjectionSchema = z.strictObject({
  runtimeType: z.literal('player'),
  runtimeDefinitionVersion: z.literal(1),
  contextSchemaVersion: z.literal(1),
  contextKind: z.literal('decision'),
  promptModules: z.tuple([
    z.strictObject({
      id: z.literal('player.prompt.system'),
      version: z.literal(1),
    }),
    z.strictObject({
      id: z.literal('player.prompt.decision'),
      version: z.literal(1),
    }),
  ]),
  sourceVersions: z.tuple([
    z.strictObject({
      source: z.strictObject({
        id: z.literal('player.context.decision'),
        version: z.literal(1),
      }),
      contentVersion: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ]),
  sections: z.tuple([
    z.strictObject({
      sectionId: z.literal('playerDecision'),
      schema: z.strictObject({
        id: z.literal('player.context.decision'),
        version: z.literal(1),
      }),
      payload: PlayerDecisionContextSectionV1Schema,
    }),
  ]),
})

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function sameReference(
  left: RuntimeComponentReference,
  right: RuntimeComponentReference,
): boolean {
  return left.id === right.id && left.version === right.version
}

function assertRequestBoundary(input: {
  readonly packet: PlayerDecisionPacketV1
  readonly context: PreparedContextEnvelope<'player'>
  readonly request: PreparedModelRequest<'player'>
}): void {
  let parsedContext: z.infer<typeof ContextEnvelopeProjectionSchema>
  try {
    parsedContext = ContextEnvelopeProjectionSchema.parse(
      JSON.parse(input.context.serialized),
    )
  } catch {
    throw new RangeError('Player Prepared Context 无效。')
  }
  const section = parsedContext.sections[0].payload
  if (
    parsedContext.sourceVersions[0].contentVersion !==
      input.packet.projectionSha256 ||
    section.projectionSha256 !== input.packet.projectionSha256 ||
    canonicalJson(section.projection as unknown as JsonValue) !==
      canonicalJson(input.packet.projection as unknown as JsonValue) ||
    createHash('sha256')
      .update(input.context.serialized, 'utf8')
      .digest('hex') !== input.context.sha256 ||
    input.request.messages.length !== 3 ||
    input.request.messages[0]?.role !==
      PLAYER_STATIC_PROMPT_MESSAGES_V1[0].role ||
    input.request.messages[0]?.content !==
      PLAYER_STATIC_PROMPT_MESSAGES_V1[0].content ||
    input.request.messages[1]?.role !==
      PLAYER_STATIC_PROMPT_MESSAGES_V1[1].role ||
    input.request.messages[1]?.content !==
      PLAYER_STATIC_PROMPT_MESSAGES_V1[1].content ||
    input.request.messages[2]?.role !== 'user' ||
    input.request.messages[2]?.content !==
      `${READ_ONLY_CONTEXT_MESSAGE_PREFIX}${input.context.serialized}`
  ) {
    throw new RangeError('Player Prepared request 未精确绑定 Packet。')
  }
  const requestProjection = canonicalJson({
    messages: input.request.messages.map((message) => ({ ...message })),
  })
  if (
    Buffer.byteLength(requestProjection, 'utf8') !== input.request.byteLength ||
    createHash('sha256').update(requestProjection, 'utf8').digest('hex') !==
      input.request.sha256 ||
    requestProjection.includes(input.packet.snapshotSha256) ||
    requestProjection.includes(input.packet.binding.observationSha256) ||
    requestProjection.includes(input.packet.binding.decisionRequestId) ||
    requestProjection.includes(input.packet.binding.actorParticipantId) ||
    requestProjection.includes(input.packet.binding.sessionId) ||
    requestProjection.includes(input.packet.binding.handId)
  ) {
    throw new RangeError('Player Adapter request 泄漏服务端事实。')
  }
}

export function certifyPlayerPreparedGenerationBundleV1(input: {
  readonly packet: PlayerDecisionPacketV1
  readonly context: PreparedContextEnvelope<'player'>
  readonly request: PreparedModelRequest<'player'>
  readonly outputSchemaReference: RuntimeComponentReference
  readonly outputSchema: typeof PlayerBoundedChoiceSchema
  readonly validatorReference: RuntimeComponentReference
  readonly validate: CertifiedPlayerBoundedChoiceValidatorV1
}): PlayerPreparedGenerationBundleV1 {
  if (
    !isPlayerDecisionPacketV1(input.packet) ||
    !isPreparedContextEnvelope(input.context, 'player') ||
    !isPreparedModelRequest(input.request, 'player') ||
    input.outputSchema !== PlayerBoundedChoiceSchema ||
    !sameReference(
      input.outputSchemaReference,
      PLAYER_OUTPUT_SCHEMA_REFERENCE,
    ) ||
    !sameReference(input.validatorReference, PLAYER_VALIDATOR_REFERENCE) ||
    !isCertifiedPlayerBoundedChoiceValidatorV1({
      value: input.validate,
      packet: input.packet,
    })
  ) {
    throw new RangeError('Player Adapter 第三道边界认证失败。')
  }
  assertRequestBoundary(input)
  const bundle = deepFreeze({
    packet: input.packet,
    context: input.context,
    request: input.request,
    outputSchemaReference: PLAYER_OUTPUT_SCHEMA_REFERENCE,
    outputSchema: PlayerBoundedChoiceSchema,
    validatorReference: PLAYER_VALIDATOR_REFERENCE,
    validate: input.validate,
  }) as PlayerPreparedGenerationBundleV1
  certifiedBundles.add(bundle)
  return bundle
}

export function certifyPlayerFrozenGenerationBundleV1(input: {
  readonly packet: PlayerDecisionPacketV1
  readonly frozenModelInput: unknown
  readonly outputSchemaReference: RuntimeComponentReference
  readonly outputSchema: typeof PlayerBoundedChoiceSchema
  readonly validatorReference: RuntimeComponentReference
  readonly validate: CertifiedPlayerBoundedChoiceValidatorV1
}): PlayerFrozenGenerationBundleV1 {
  let frozen: FrozenPlayerModelInputV1
  let request: PreparedModelRequest<'player'>
  try {
    frozen = decodeFrozenPlayerModelInputV1(input.frozenModelInput)
    request = restoreFrozenPlayerModelRequestV1(frozen)
  } catch {
    throw new RangeError('Player 冻结 request 无效。')
  }
  if (
    !isPlayerDecisionPacketV1(input.packet) ||
    input.outputSchema !== PlayerBoundedChoiceSchema ||
    !sameReference(
      input.outputSchemaReference,
      PLAYER_OUTPUT_SCHEMA_REFERENCE,
    ) ||
    !sameReference(input.validatorReference, PLAYER_VALIDATOR_REFERENCE) ||
    !sameReference(frozen.outputSchema, PLAYER_OUTPUT_SCHEMA_REFERENCE) ||
    !sameReference(frozen.validator, PLAYER_VALIDATOR_REFERENCE) ||
    !isCertifiedPlayerBoundedChoiceValidatorV1({
      value: input.validate,
      packet: input.packet,
    })
  ) {
    throw new RangeError('Player 冻结 Adapter 边界认证失败。')
  }
  const bundle = deepFreeze({
    packet: input.packet,
    request,
    frozenModelInput: frozen,
    outputSchemaReference: PLAYER_OUTPUT_SCHEMA_REFERENCE,
    outputSchema: PlayerBoundedChoiceSchema,
    validatorReference: PLAYER_VALIDATOR_REFERENCE,
    validate: input.validate,
  }) as PlayerFrozenGenerationBundleV1
  certifiedBundles.add(bundle)
  return bundle
}

export function isPlayerPreparedGenerationBundleV1(
  value: unknown,
): value is PlayerPreparedGenerationBundleV1 {
  return (
    typeof value === 'object' && value !== null && certifiedBundles.has(value)
  )
}

export function isPlayerGenerationBundleV1(
  value: unknown,
): value is PlayerGenerationBundleV1 {
  return (
    typeof value === 'object' && value !== null && certifiedBundles.has(value)
  )
}
