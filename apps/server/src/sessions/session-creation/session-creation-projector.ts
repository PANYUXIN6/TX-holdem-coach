import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import type { TransactionSql } from 'postgres'
import type { LockedActiveSessionForCreation } from '../../persistence/session-creation-repository.js'
import type { LockedSessionView } from '../../persistence/session-mutation-repository.js'
import type { PrivateEvent } from '../authoritative-state/private-event.js'
import type { PrivateTableState } from '../authoritative-state/private-table-state.js'

export interface SessionCreationSnapshotProjectionInput<ReadPort = unknown> {
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly eventSeq: number
  readonly newPrivateEvents: readonly [PrivateEvent, PrivateEvent]
  readonly reads: ReadPort
}

export interface SessionCreationSnapshotProjectorBinding<ReadPort = unknown> {
  readonly projector: {
    project(
      input: SessionCreationSnapshotProjectionInput<ReadPort>,
    ): Promise<PublicSessionSnapshot>
  }
  bindReadPort(transaction: TransactionSql): ReadPort
}

export interface ActiveSessionSnapshotReaderBinding<ReadPort = unknown> {
  readonly reader: {
    read(input: {
      readonly reference: LockedActiveSessionForCreation
      readonly reads: ReadPort
    }): Promise<PublicSessionSnapshot>
  }
  bindReadPort(transaction: TransactionSql): ReadPort
}
