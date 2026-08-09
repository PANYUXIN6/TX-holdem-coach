import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { LockedSessionView } from '../../persistence/session-mutation-repository.js'
import type { PrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'

export interface SnapshotProjectionInput<ReadPort = unknown> {
  readonly command: LedgerCommand
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly eventSeq: number
  readonly newPrivateEvents: readonly PrivateEventV2[]
  readonly reads: ReadPort
}

export interface SnapshotProjector<ReadPort = unknown> {
  project(
    input: SnapshotProjectionInput<ReadPort>,
  ): Promise<PublicSessionSnapshot>
}

export interface SnapshotProjectorBinding<ReadPort = unknown> {
  readonly projector: SnapshotProjector<ReadPort>
  bindReadPort(transaction: TransactionSql): ReadPort
}
import type { TransactionSql } from 'postgres'
