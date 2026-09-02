import { randomUUID } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { expect } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
  PersonaConfigPayloadSchema,
} from '../../src/personas/config.js'
import {
  EMPTY_AUTHORIZED_STRATEGY_PACK,
  createStaticStrategyPackRepository,
} from '../../src/poker-strategy/strategy-pack-repository.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import { hashPlayerSessionMemoryV1 } from '../../src/agents/player/player-session-memory.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createStartupRecoveryCandidateRepository } from '../../src/persistence/startup-recovery-candidate-repository.js'
import {
  INITIAL_AGENT_MEMORY,
  insertSessionRosterSnapshot,
} from '../helpers/session-roster-fixture.js'
import { runDatabaseTestWithCleanup } from './database-test-runtime.js'

const SECOND_OWNER_ID = '10000000-0000-4000-8000-000000000410'
const SECOND_SESSION_ID = '20000000-0000-4000-8000-000000000410'

async function clearM410Fixtures(sql: Sql): Promise<void> {
  await sql`
    DELETE FROM app_private.sessions
    WHERE id = ${SECOND_SESSION_ID}::uuid
       OR owner_id = (
         SELECT id FROM app_private.owners WHERE identity_key = 'local-user'
       )
  `
  await sql`
    DELETE FROM app_private.owners
    WHERE id = ${SECOND_OWNER_ID}::uuid
  `
}

function createRosterAgents() {
  return loadAndValidatePersonaCatalog()
    .list()
    .slice(0, 5)
    .map((entry, index) => {
      const payload = PersonaConfigPayloadSchema.parse({
        ...entry,
        personaVersion: 1,
      })
      return {
        seatNumber: index + 1,
        agentParticipantId: randomUUID(),
        displayName: payload.name,
        avatarColor: payload.avatarColor,
        personaId: payload.personaId,
        personaVersion: payload.personaVersion,
        configSnapshotKey: createConfigSnapshotKey(
          PERSONA_CONFIG_PAYLOAD_VERSION,
          payload,
        ),
        configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
        configPayload: payload,
        initialMemory: INITIAL_AGENT_MEMORY,
      }
    })
}

async function insertOtherOwnerRoster(
  transaction: TransactionSql,
): Promise<void> {
  await transaction`
    INSERT INTO app_private.owners (id, identity_key)
    VALUES (${SECOND_OWNER_ID}::uuid, 'm410-second-owner')
  `
  await transaction`
    INSERT INTO app_private.sessions (id, owner_id)
    VALUES (${SECOND_SESSION_ID}::uuid, ${SECOND_OWNER_ID}::uuid)
  `
  for (let seatNumber = 0; seatNumber < 6; seatNumber += 1) {
    const participantId = randomUUID()
    await transaction`
      INSERT INTO app_private.session_participants (
        id, session_id, owner_id, participant_type, seat_number
      ) VALUES (
        ${participantId}::uuid, ${SECOND_SESSION_ID}::uuid,
        ${SECOND_OWNER_ID}::uuid,
        ${seatNumber === 0 ? 'user' : 'agent'}, ${seatNumber}
      )
    `
    if (seatNumber === 0) continue
    await transaction`
      INSERT INTO app_private.session_agents (
        participant_id, session_id, owner_id, display_name,
        avatar_color, persona_id, persona_version,
        config_snapshot_key, config_payload_version, config_payload,
        memory_payload_version, memory_payload
      ) VALUES (
        ${participantId}::uuid, ${SECOND_SESSION_ID}::uuid,
        ${SECOND_OWNER_ID}::uuid, ${`M410 Agent ${seatNumber}`}, '#000000',
        ${`m410-persona-${seatNumber}`}, 1, ${'0'.repeat(64)},
        1, ${transaction.json({})}, 1,
        ${transaction.json(INITIAL_AGENT_MEMORY.currentPayload)}
      )
    `
    await transaction`
      INSERT INTO app_private.agent_memory_revisions (
        participant_id, session_id, owner_id, revision,
        memory_payload_version, memory_payload, memory_sha256
      ) VALUES (
        ${participantId}::uuid, ${SECOND_SESSION_ID}::uuid,
        ${SECOND_OWNER_ID}::uuid, 0, 1,
        ${transaction.json(INITIAL_AGENT_MEMORY.revisionPayload)},
        ${hashPlayerSessionMemoryV1(INITIAL_AGENT_MEMORY.revisionPayload)}
      )
    `
  }
}

/**
 * M4.10 database 阶段只验证 Persistence 边界：候选扫描严格 owner-scoped，且
 * initial Run 使用的唯一 active pack 可以在无数据库/网络依赖下精确解析。Session
 * 锁、协调事件和 Worker 闭环属于 PostgreSQL E2E，避免 database suite 反向依赖命令层。
 */
export async function assertM410PlayerSessionIntegrationPersistence(
  sql: Sql,
): Promise<void> {
  await runDatabaseTestWithCleanup(
    async () => {
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const sessionId = randomUUID()
      await sql.begin(async (transaction) => {
        await insertSessionRosterSnapshot(transaction, {
          owner,
          sessionId,
          userParticipantId: randomUUID(),
          agents: createRosterAgents(),
        })
      })
      await sql.begin(async (transaction) => {
        await insertOtherOwnerRoster(transaction)
      })

      const candidateReader = createStartupRecoveryCandidateRepository({
        sql,
        owner,
      })
      await expect(candidateReader.listActiveSessionIds()).resolves.toEqual([
        sessionId,
      ])

      const activePack =
        createStaticStrategyPackRepository().resolveActiveForNewRun({
          pokerRuleSetVersion: POKER_RULE_SET_VERSION,
        })
      expect(activePack).toMatchObject({
        datasetId: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetId,
        datasetVersion: EMPTY_AUTHORIZED_STRATEGY_PACK.datasetVersion,
        status: 'active',
      })
    },
    () => clearM410Fixtures(sql),
  )
}
