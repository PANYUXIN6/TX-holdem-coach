import type { RuntimeCommitAuthority } from '../foundation/runtime-ports.js'
import type {
  PlayerRuntimeCandidateResultV1,
  PlayerRuntimeResultPort,
} from './player-runtime-result-port.js'

/** M4.7 固定组合向 Player Runtime 暴露的唯一提交协议。 */
export interface PlayerCommitReceiptV1 {
  readonly decisionRecordId: string
  readonly commandLedgerId: string
  readonly agentRunId: string
  readonly finalStateVersion: number
  readonly firstEventSeq: number
  readonly lastEventSeq: number
  readonly origin: 'newCommit' | 'replay'
}

export interface PlayerCommitGate {
  commit(input: {
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly result: PlayerRuntimeCandidateResultV1
  }): Promise<PlayerCommitReceiptV1>
}

export function createPlayerCommitResultPort(input: {
  readonly gate: PlayerCommitGate
}): PlayerRuntimeResultPort {
  return Object.freeze({
    async publish({
      authority,
      result,
    }: Parameters<PlayerRuntimeResultPort['publish']>[0]) {
      await input.gate.commit({ authority, result })
    },
  })
}
