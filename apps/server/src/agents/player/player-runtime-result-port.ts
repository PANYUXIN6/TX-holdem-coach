import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import {
  isPlayerSelectedDecisionReceiptV1,
  type PlayerSelectedDecisionReceiptV1,
} from '../../persistence/player-decision-repository.js'

declare const playerRuntimeCandidateResultBrand: unique symbol
export interface PlayerRuntimeCandidateResultV1 {
  readonly decisionRecordId: string
  readonly binding: PlayerSelectedDecisionReceiptV1['binding']
  readonly candidateSetSha256: string
  readonly selectedCandidateActionId: string
  readonly choiceSha256: string
  readonly acceptedAttemptId: string
  readonly [playerRuntimeCandidateResultBrand]: never
}

const certifiedResults = new WeakSet<object>()

export interface PlayerRuntimeResultPort {
  publish(input: {
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly result: PlayerRuntimeCandidateResultV1
  }): Promise<void>
}

export function certifyPlayerRuntimeCandidateResultV1(
  receipt: PlayerSelectedDecisionReceiptV1,
): PlayerRuntimeCandidateResultV1 {
  if (!isPlayerSelectedDecisionReceiptV1(receipt)) {
    throw new RangeError('Player Runtime 结果只接受认证 selected receipt。')
  }
  const result = Object.freeze({
    decisionRecordId: receipt.decisionRecordId,
    binding: receipt.binding,
    candidateSetSha256: receipt.candidateSetSha256,
    selectedCandidateActionId: receipt.choice.candidateActionId,
    choiceSha256: receipt.choiceSha256,
    acceptedAttemptId: receipt.acceptedAttemptId,
  }) as PlayerRuntimeCandidateResultV1
  certifiedResults.add(result)
  return result
}

export function isPlayerRuntimeCandidateResultV1(
  value: unknown,
): value is PlayerRuntimeCandidateResultV1 {
  return (
    typeof value === 'object' && value !== null && certifiedResults.has(value)
  )
}
