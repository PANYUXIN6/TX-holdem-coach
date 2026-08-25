import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson, type JsonValue } from '../../persisted-json.js'
import { Sha256DigestSchema } from '../audit/audit-primitives.js'
import {
  DecisionAuditSnapshotV1Schema,
  isDecisionAuditSnapshotV1,
  type DecisionAuditSnapshotV1,
} from './player-decision-audit.js'
import { PlayerDecisionAnalysisBindingSchema } from './player-decision-capabilities.js'
import {
  PlayerModelProjectionV1Schema,
  assertPlayerModelProjectionDescriptorV1,
  buildPlayerModelProjectionV1,
  hashPlayerModelProjectionV1,
  type PlayerModelProjectionV1,
} from './player-model-projection.js'

export const PlayerDecisionPacketV1DataSchema = z.strictObject({
  binding: PlayerDecisionAnalysisBindingSchema,
  decisionRecordId: z.string().uuid(),
  snapshotSha256: Sha256DigestSchema,
  candidateSetSha256: Sha256DigestSchema,
  projection: PlayerModelProjectionV1Schema,
  projectionSha256: Sha256DigestSchema,
})

declare const playerDecisionPacketBrand: unique symbol
export type PlayerDecisionPacketV1 = Readonly<
  z.infer<typeof PlayerDecisionPacketV1DataSchema>
> & {
  readonly [playerDecisionPacketBrand]: never
}

const certifiedPackets = new WeakSet<object>()

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested)
    Object.freeze(value)
  }
  return value
}

function assertNoServerIdentity(value: JsonValue): void {
  const serialized = canonicalJson(value)
  const forbiddenKeys = [
    'decisionRequestId',
    'observationSha256',
    'preprocessingSha256',
    'snapshotSha256',
    'candidateSetSha256',
    'participantId',
    'sessionId',
    'handId',
    'leaseOwner',
    'fencingToken',
    'authority',
  ]
  if (forbiddenKeys.some((key) => serialized.includes(`"${key}"`))) {
    throw new RangeError('Player 模型投影包含服务端身份字段。')
  }
}

export function certifyPlayerDecisionPacketV1(input: {
  readonly snapshot: DecisionAuditSnapshotV1
  readonly decisionRecordId: string
  readonly projection?: PlayerModelProjectionV1
}): PlayerDecisionPacketV1 {
  if (!isDecisionAuditSnapshotV1(input.snapshot)) {
    throw new RangeError('Player Packet 只接受认证审计快照。')
  }
  const snapshot = DecisionAuditSnapshotV1Schema.parse(input.snapshot)
  const rebuilt = buildPlayerModelProjectionV1(input.snapshot)
  const projection = PlayerModelProjectionV1Schema.parse(
    input.projection ?? rebuilt,
  )
  if (
    canonicalJson(projection as unknown as JsonValue) !==
    canonicalJson(rebuilt as unknown as JsonValue)
  ) {
    throw new RangeError('Player 模型投影与审计快照不一致。')
  }
  assertPlayerModelProjectionDescriptorV1(projection)
  assertNoServerIdentity(projection as unknown as JsonValue)
  const decoded = PlayerDecisionPacketV1DataSchema.parse({
    binding: snapshot.binding,
    decisionRecordId: input.decisionRecordId,
    snapshotSha256: snapshot.snapshotSha256,
    candidateSetSha256: snapshot.candidates.candidateSetSha256,
    projection,
    projectionSha256: hashPlayerModelProjectionV1(projection),
  })
  const packet = deepFreeze(decoded as PlayerDecisionPacketV1)
  certifiedPackets.add(packet)
  return packet
}

export function isPlayerDecisionPacketV1(
  value: unknown,
): value is PlayerDecisionPacketV1 {
  return (
    typeof value === 'object' && value !== null && certifiedPackets.has(value)
  )
}

export function hashPlayerDecisionPacketBindingV1(
  packet: PlayerDecisionPacketV1,
): string {
  if (!isPlayerDecisionPacketV1(packet)) {
    throw new RangeError('Player Packet 未认证。')
  }
  return createHash('sha256')
    .update(
      canonicalJson({
        binding: packet.binding,
        decisionRecordId: packet.decisionRecordId,
        candidateSetSha256: packet.candidateSetSha256,
      } as JsonValue),
      'utf8',
    )
    .digest('hex')
}
