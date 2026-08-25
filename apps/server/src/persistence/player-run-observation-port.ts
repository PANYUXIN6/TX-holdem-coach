import type { TransactionSql } from 'postgres'
import { z } from 'zod'
import type { LeasedAgentRun } from '../agents/foundation/agent-run-types.js'
import {
  isRuntimeCommitAuthority,
  type RuntimeCommitAuthority,
} from '../agents/foundation/runtime-ports.js'
import type { PlayerObservationLoadResult } from '../agents/player/player-observation-port.js'
import type { DatabaseClient } from '../db/client.js'
import { createPlayerDecisionIdentity } from '../sessions/authoritative-state/decision-identity.js'
import { runDatabaseTransaction } from './database-transaction.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from './errors.js'
import { isResolvedOwnerScope, type ResolvedOwnerScope } from './owner-scope.js'
import { loadPlayerObservationInTransaction } from './player-observation-authority.js'

const ParticipantSeatRowSchema = z.strictObject({
  seatNumber: z.number().int().min(1).max(8),
  participantType: z.literal('agent'),
})

export interface PlayerRunObservationPort {
  loadForRun(input: {
    readonly owner: ResolvedOwnerScope
    readonly run: LeasedAgentRun<'player'>
  }): Promise<PlayerObservationLoadResult>
}

export type PlayerRunObservationPortFactory = (input: {
  readonly database: DatabaseClient
  readonly authority: RuntimeCommitAuthority<'player'>
}) => PlayerRunObservationPort

async function loadForRun(
  transaction: TransactionSql,
  authority: RuntimeCommitAuthority<'player'>,
  owner: ResolvedOwnerScope,
  run: LeasedAgentRun<'player'>,
): Promise<PlayerObservationLoadResult> {
  let rows: readonly unknown[]
  try {
    rows = await transaction`
      SELECT
        participant.seat_number AS "seatNumber",
        participant.participant_type AS "participantType"
      FROM app_private.session_participants AS participant
      INNER JOIN app_private.session_agents AS agent
        ON agent.participant_id = participant.id
        AND agent.session_id = participant.session_id
        AND agent.owner_id = participant.owner_id
      WHERE participant.id = ${run.participantId}::uuid
        AND participant.session_id = ${run.sessionId}::uuid
        AND participant.owner_id = ${owner.databaseOwnerId}::uuid
      FOR SHARE OF participant, agent
    `
  } catch {
    throw new DatabaseOperationError()
  }
  const parsed = z.array(ParticipantSeatRowSchema).safeParse(rows)
  if (!parsed.success || parsed.data.length !== 1) {
    throw new PersistenceDataCorruptionError('invalidPlayerObservation')
  }
  const identity = createPlayerDecisionIdentity({
    sessionId: run.sessionId,
    handId: run.handId,
    stateVersion: run.sourceStateVersion,
    actorParticipantId: run.participantId,
    actorSeat: parsed.data[0]!.seatNumber,
    decisionRequestId: run.decisionRequestId,
  })
  return loadPlayerObservationInTransaction(
    transaction,
    authority,
    owner,
    identity,
  )
}

export const createPostgresPlayerRunObservationPort: PlayerRunObservationPortFactory =
  (input) => {
    if (
      !isRuntimeCommitAuthority(input.authority, 'player') ||
      typeof input.database !== 'object' ||
      input.database === null ||
      typeof input.database.sql !== 'function'
    ) {
      throw new RepositoryInputValidationError()
    }
    const port: PlayerRunObservationPort = {
      async loadForRun(loadInput) {
        if (
          !isResolvedOwnerScope(loadInput.owner) ||
          loadInput.run.runtimeType !== 'player' ||
          loadInput.run.runId !== input.authority.runId ||
          loadInput.run.leaseOwner !== input.authority.leaseOwner ||
          loadInput.run.fencingToken !== input.authority.fencingToken
        ) {
          throw new RepositoryInputValidationError()
        }
        return runDatabaseTransaction(input.database.sql, (transaction) =>
          loadForRun(
            transaction,
            input.authority,
            loadInput.owner,
            loadInput.run,
          ),
        )
      },
    }
    return Object.freeze(port)
  }
