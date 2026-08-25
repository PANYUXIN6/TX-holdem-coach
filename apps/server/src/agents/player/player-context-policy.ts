import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import {
  TOKEN_ESTIMATOR_REFERENCE,
  createContextPolicyDefinition,
} from '../foundation/context-envelope.js'
import type { RuntimeComponentReference } from '../foundation/runtime-definition.js'
import {
  isPlayerDecisionPacketV1,
  type PlayerDecisionPacketV1,
} from './player-decision-packet-leak-guard.js'
import {
  PlayerDecisionContextSectionV1Schema,
  hashPlayerModelProjectionV1,
} from './player-model-projection.js'
import { PLAYER_MODEL_INPUT_LIMITS } from './player-model-input-limits.js'

export const PLAYER_DECISION_CONTEXT_SECTION_REFERENCE = Object.freeze({
  id: 'player.context.decision',
  version: 1,
} as const satisfies RuntimeComponentReference)

export const PLAYER_CONTEXT_POLICY_REFERENCE = Object.freeze({
  id: 'player.context-policy',
  version: 1,
} as const satisfies RuntimeComponentReference)

export function createPlayerDecisionContextSectionV1(
  packet: PlayerDecisionPacketV1,
): JsonValue {
  if (!isPlayerDecisionPacketV1(packet)) {
    throw new RangeError('Player Context 只接受第二道 Guard Packet。')
  }
  const projectionSha256 = hashPlayerModelProjectionV1(packet.projection)
  if (projectionSha256 !== packet.projectionSha256) {
    throw new RangeError('Player Context 投影哈希不一致。')
  }
  const section = PlayerDecisionContextSectionV1Schema.parse({
    sectionSchemaVersion: 1,
    projection: packet.projection,
    projectionSha256,
  })
  canonicalJson(section as unknown as JsonValue)
  return section as unknown as JsonValue
}

export const playerContextPolicy = createContextPolicyDefinition({
  runtimeType: 'player',
  policy: PLAYER_CONTEXT_POLICY_REFERENCE,
  tokenEstimator: TOKEN_ESTIMATOR_REFERENCE,
  maximumSerializedBytes: PLAYER_MODEL_INPUT_LIMITS.maximumContextBytes,
  kinds: [
    {
      contextKind: 'decision',
      sections: [
        {
          sectionId: 'playerDecision',
          schema: PLAYER_DECISION_CONTEXT_SECTION_REFERENCE,
          parse: (input: unknown) =>
            createPlayerDecisionContextSectionV1(
              input as PlayerDecisionPacketV1,
            ),
        },
      ],
    },
  ],
})
