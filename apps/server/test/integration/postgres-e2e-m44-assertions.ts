import { randomUUID } from 'node:crypto'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import type { DatabaseClient } from '../../src/db/client.js'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import { isRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createPostgresPlayerObservationPort } from '../../src/persistence/player-observation-authority.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { isPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { clearLocalOwnerSessions } from './database-m32-assertions.js'
import {
  createSessionFixture,
  readPrivateState,
} from './database-m33-assertions.js'

const eventPort = { publish: async () => undefined }

function asDatabaseClient(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

export async function assertM44PlayerObservationApplicationFlow(
  sql: Sql,
): Promise<void> {
  const identityGraph = await createSessionFixture(sql, 0)
  try {
    const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
    const state = await readPrivateState(sql, identityGraph.sessionId)
    const actorSeat = state.poker.hand?.currentActorSeatNumber
    if (actorSeat === null || actorSeat === undefined || actorSeat === 0) {
      throw new Error('M4.4 E2E 未生成 AI 当前行动者。')
    }
    const actor = identityGraph.agentParticipants.find(
      (participant) => participant.seatNumber === actorSeat,
    )
    if (actor === undefined) throw new Error('M4.4 E2E 缺少行动者镜像。')
    const runId = randomUUID()
    const decisionRequestId = randomUUID()
    const coordinator = createAgentRunCoordinator({ sql, owner, eventPort })
    await sql.begin(async (transaction) => {
      await coordinator.createOrReuse(transaction, {
        runtimeType: 'player',
        agentRunId: runId,
        sessionId: identityGraph.sessionId,
        handId: identityGraph.handId,
        actorParticipantId: actor.participantId,
        sourceStateVersion: state.stateVersion,
        decisionRequestId,
        triggerType: 'action_required',
        idempotencyKey: `m44/player/${runId}`,
        supersedesRunId: null,
        dataDependencies: [],
        createdAt: new Date().toISOString(),
      })
      await transaction`
        UPDATE app_private.sessions
        SET agent_run_state = 'thinking',
            active_player_run_id = ${runId}::uuid,
            active_decision_request_id = ${decisionRequestId}::uuid,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${identityGraph.sessionId}::uuid
          AND owner_id = ${owner.databaseOwnerId}::uuid
      `
    })
    const claim = await coordinator.workerControl.claimNext({
      runtimeType: 'player',
      leaseOwner: 'm44-e2e:player:0',
    })
    if (
      claim.kind !== 'claimed' ||
      claim.run.runId !== runId ||
      claim.run.runtimeType !== 'player' ||
      !isRuntimeCommitAuthority(claim.authority, 'player')
    ) {
      throw new Error('M4.4 E2E 未领取目标 Player Run。')
    }
    await coordinator.workerControl.markRunning(claim.authority)

    const port = createPostgresPlayerObservationPort({
      authority: claim.authority,
      database: asDatabaseClient(sql),
    })
    const result = await port.load({
      owner,
      identity: createPlayerDecisionIdentity({
        sessionId: identityGraph.sessionId,
        handId: identityGraph.handId,
        stateVersion: state.stateVersion,
        actorParticipantId: actor.participantId,
        actorSeat,
        decisionRequestId,
      }),
    })
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('M4.4 E2E 观察未就绪。')
    expect(isPlayerVisibleState(result.observation)).toBe(true)
    const expectedCards = state.poker.hand?.holeCards.find(
      (entry) => entry.seatNumber === actorSeat,
    )?.cards
    expect(result.observation.hand.heroHoleCards).toEqual(expectedCards)
    expect(JSON.stringify(result.observation)).not.toMatch(
      /remainingDeck|burnedCards|configPayload|memoryPayload|fencingToken/,
    )
  } finally {
    await clearLocalOwnerSessions(sql)
  }
}
