import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import type { DatabaseClient } from '../../src/db/client.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  createConfigSnapshotKey,
  PERSONA_CONFIG_PAYLOAD_VERSION,
} from '../../src/personas/config.js'
import { createPostgresPlayerDecisionReferencePort } from '../../src/persistence/player-decision-reference-authority.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { createHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint.js'
import { encodeCurrentHandStartCheckpoint } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'

function createSqlMock(responses: readonly unknown[]): Sql {
  const pending = [...responses]
  const tag = ((template: TemplateStringsArray, ..._parameters: unknown[]) => {
    const response = pending.shift()
    if (response === undefined) {
      throw new Error(`未登记 SQL 响应：${template.join('?')}`)
    }
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response as readonly unknown[])
  }) as unknown as Sql
  Object.assign(tag, {
    begin: async (
      operation: (transaction: TransactionSql) => Promise<unknown>,
    ) => operation(tag as unknown as TransactionSql),
    json: (value: unknown) => value,
  })
  return tag
}

function database(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'

async function owner() {
  return resolveOwnerScope(createSqlMock([[{ databaseOwnerId }]]), {
    ownerId: 'local-user',
  })
}

function preparedReference() {
  const fixture = createPlayerObservationFixture({ withPublicAction: true })
  const observation = certifyPlayerVisibleState(
    buildPlayerObservationDraft(fixture.input),
  )
  const startedEvent = fixture.input.events[0]?.event
  if (startedEvent?.type !== 'handStarted') {
    throw new Error('测试缺少 handStarted。')
  }
  const startingStackBySeat = new Map(
    startedEvent.startedHand.startingStacks.map((entry) => [
      entry.seatNumber,
      entry.stack,
    ]),
  )
  const checkpoint = createHandStartCheckpoint({
    pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
    stateBeforeStartCommand: createPrivateTableState({
      stateVersion: 0,
      completedHandCount: 0,
      seatAccounting: fixture.input.state.seatAccounting,
      lastCompletedHandSummary: null,
      poker: {
        pokerPhase: 'betweenHands',
        buttonSeatNumber: fixture.input.state.poker.buttonSeatNumber,
        blinds: fixture.input.state.poker.blinds,
        hand: null,
        seats: fixture.input.state.poker.seats.map((seat) => ({
          seatNumber: seat.seatNumber,
          playerId: seat.playerId,
          isUser: seat.isUser,
          stack: startingStackBySeat.get(seat.seatNumber)!,
          status: 'active' as const,
          streetContribution: 0,
          totalContribution: 0,
        })),
      },
    }),
    startedHand: startedEvent.startedHand,
  })
  const storedCheckpoint = encodeCurrentHandStartCheckpoint(checkpoint)
  const persona = loadAndValidatePersonaCatalog().list()[0]!
  return {
    observation,
    persona,
    responses: [
      [
        {
          lifecycleStatus: 'active',
          currentHandId: observation.identity.handId,
          stateVersion: observation.identity.stateVersion,
        },
      ],
      [
        {
          handId: observation.identity.handId,
          handNumber: observation.hand.handNumber,
          handStatus: 'inProgress',
          checkpointPayloadVersion: storedCheckpoint.payloadVersion,
          checkpointPayload: storedCheckpoint.payload,
          participantId: observation.identity.actorParticipantId,
          participantSeatNumber: observation.identity.actorSeat,
          participantType: 'agent',
          personaId: persona.personaId,
          personaVersion: persona.personaVersion,
          configSnapshotKey: createConfigSnapshotKey(
            PERSONA_CONFIG_PAYLOAD_VERSION,
            persona,
          ),
          configPayloadVersion: PERSONA_CONFIG_PAYLOAD_VERSION,
          configPayload: persona,
        },
      ],
    ],
  }
}

describe('PostgreSQL Player decision reference authority', () => {
  test('returns only rule and persona policy facts bound to a certified observation', async () => {
    const prepared = preparedReference()
    const port = createPostgresPlayerDecisionReferencePort({
      database: database(createSqlMock(prepared.responses)),
    })

    const result = await port.load({
      owner: await owner(),
      observation: prepared.observation,
    })

    expect(result).toEqual({
      kind: 'ready',
      reference: {
        sessionId: prepared.observation.identity.sessionId,
        handId: prepared.observation.identity.handId,
        actorParticipantId: prepared.observation.identity.actorParticipantId,
        actorSeat: prepared.observation.identity.actorSeat,
        pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1',
        handNumber: prepared.observation.hand.handNumber,
        configSnapshotKey: createConfigSnapshotKey(
          PERSONA_CONFIG_PAYLOAD_VERSION,
          prepared.persona,
        ),
        personaId: prepared.persona.personaId,
        personaVersion: 1,
        personaPolicy: prepared.persona.style,
      },
    })
    expect(JSON.stringify(result)).not.toMatch(
      /strategyDescription|models|stateBeforeStartCommand/,
    )
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('returns stale for a changed session mirror and missing for another owner scope', async () => {
    const prepared = preparedReference()
    const stale = structuredClone(prepared.responses)
    ;(stale[0] as Array<{ stateVersion: number }>)[0]!.stateVersion += 1
    const stalePort = createPostgresPlayerDecisionReferencePort({
      database: database(createSqlMock(stale)),
    })
    await expect(
      stalePort.load({
        owner: await owner(),
        observation: prepared.observation,
      }),
    ).resolves.toEqual({ kind: 'stale' })

    const missingPort = createPostgresPlayerDecisionReferencePort({
      database: database(createSqlMock([[]])),
    })
    await expect(
      missingPort.load({
        owner: await owner(),
        observation: prepared.observation,
      }),
    ).resolves.toEqual({ kind: 'resourceMissing' })
  })

  test('fails closed when the stored persona snapshot key is corrupted', async () => {
    const prepared = preparedReference()
    const corrupt = structuredClone(prepared.responses)
    ;(
      corrupt[1] as Array<{ configSnapshotKey: string }>
    )[0]!.configSnapshotKey = '0'.repeat(64)
    const port = createPostgresPlayerDecisionReferencePort({
      database: database(createSqlMock(corrupt)),
    })
    await expect(
      port.load({ owner: await owner(), observation: prepared.observation }),
    ).rejects.toMatchObject({ corruption: 'invalidPlayerDecisionReference' })
  })

  test('separates positive unknown persona versions from malformed versions', async () => {
    const unknown = preparedReference()
    ;(
      unknown.responses[1] as Array<{ configPayloadVersion: number }>
    )[0]!.configPayloadVersion = 999
    const unknownPort = createPostgresPlayerDecisionReferencePort({
      database: database(createSqlMock(unknown.responses)),
    })
    await expect(
      unknownPort.load({
        owner: await owner(),
        observation: unknown.observation,
      }),
    ).rejects.toMatchObject({ payloadKind: 'personaConfig' })

    for (const configPayloadVersion of [
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      const malformed = preparedReference()
      ;(
        malformed.responses[1] as Array<{ configPayloadVersion: number }>
      )[0]!.configPayloadVersion = configPayloadVersion
      const malformedPort = createPostgresPlayerDecisionReferencePort({
        database: database(createSqlMock(malformed.responses)),
      })
      await expect(
        malformedPort.load({
          owner: await owner(),
          observation: malformed.observation,
        }),
      ).rejects.toMatchObject({
        corruption: 'invalidPlayerDecisionReference',
      })
    }
  })
})
