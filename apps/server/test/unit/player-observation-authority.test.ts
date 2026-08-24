import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import type { DatabaseClient } from '../../src/db/client.js'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { createPostgresPlayerObservationPort } from '../../src/persistence/player-observation-authority.js'
import {
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { encodeCurrentPrivateEvent } from '../../src/sessions/authoritative-state/private-event-codec.js'
import { isPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'

interface SqlCall {
  readonly text: string
  readonly parameters: readonly unknown[]
}

function createSqlMock(responses: readonly unknown[]): {
  readonly sql: Sql
  readonly calls: SqlCall[]
  readonly committed: () => boolean
} {
  const pending = [...responses]
  const calls: SqlCall[] = []
  let transactionCommitted = false
  const tag = ((template: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = template.join('?')
    calls.push({ text, parameters })
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response as readonly unknown[])
  }) as unknown as Sql
  Object.assign(tag, {
    begin: async (
      operation: (transaction: TransactionSql) => Promise<unknown>,
    ) => {
      const result = await operation(tag as unknown as TransactionSql)
      transactionCommitted = true
      return result
    },
    json: (value: unknown) => value,
  })
  return { sql: tag, calls, committed: () => transactionCommitted }
}

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const runId = '60000000-0000-4000-8000-000000000001'

async function resolvedOwner() {
  const ownerSql = createSqlMock([[{ databaseOwnerId }]])
  return resolveOwnerScope(ownerSql.sql, { ownerId: 'local-user' })
}

function authority() {
  return issueRuntimeCommitAuthority({
    runtimeType: 'player',
    runId,
    leaseOwner: 'm44-worker:player:0',
    fencingToken: 7,
  })
}

function readyResponses() {
  const fixture = createPlayerObservationFixture({ withPublicAction: true })
  const snapshot = encodeSnapshot(fixture.input.state)
  return {
    fixture,
    responses: [
      [
        {
          lifecycleStatus: 'active',
          stateVersion: fixture.input.identity.stateVersion,
          nextEventSeq: fixture.input.asOfEventSeq + 1,
          currentHandId: fixture.input.identity.handId,
          agentRunState: 'thinking',
          activePlayerRunId: runId,
          activeDecisionRequestId: fixture.input.identity.decisionRequestId,
        },
      ],
      [
        {
          runtime: 'player',
          lifecycle: 'running',
          handId: fixture.input.identity.handId,
          participantId: fixture.input.identity.actorParticipantId,
          sourceStateVersion: fixture.input.identity.stateVersion,
          decisionRequestId: fixture.input.identity.decisionRequestId,
          leaseOwner: 'm44-worker:player:0',
          fencingToken: 7,
          leaseCurrent: true,
          deadlineCurrent: true,
        },
      ],
      [
        {
          payloadVersion: snapshot.payloadVersion,
          payload: snapshot.payload,
        },
      ],
      [
        {
          participantId: fixture.input.identity.actorParticipantId,
          seatNumber: fixture.input.identity.actorSeat,
          participantType: 'agent',
        },
      ],
      fixture.input.events.map((row) => {
        const stored = encodeCurrentPrivateEvent(row.event)
        return {
          handId: row.handId,
          eventSeq: row.eventSeq,
          stateVersionBefore: row.stateVersionBefore,
          stateVersionAfter: row.stateVersionAfter,
          payloadVersion: stored.payloadVersion,
          payload: stored.payload,
        }
      }),
      [{ leaseCurrent: true, deadlineCurrent: true }],
    ],
  }
}

function database(sql: Sql): DatabaseClient {
  return {
    sql,
    db: {} as DatabaseClient['db'],
    close: async () => undefined,
  }
}

describe('PostgreSQL Player observation authority', () => {
  test('locks Session then Run and returns a certified observation only after commit', async () => {
    const prepared = readyResponses()
    const mock = createSqlMock(prepared.responses)
    const port = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(mock.sql),
    })
    const result = await port.load({
      owner: await resolvedOwner(),
      identity: prepared.fixture.input.identity,
    })
    expect(result.kind).toBe('ready')
    expect(mock.committed()).toBe(true)
    if (result.kind !== 'ready') throw new Error('观察未就绪。')
    expect(isPlayerVisibleState(result.observation)).toBe(true)
    expect(Object.isFrozen(port)).toBe(true)

    expect(mock.calls).toHaveLength(6)
    expect(mock.calls[0]?.text).toMatch(
      /FROM app_private\.sessions[\s\S]+FOR SHARE/,
    )
    expect(mock.calls[1]?.text).toMatch(
      /FROM app_private\.agent_runs[\s\S]+FOR SHARE/,
    )
    expect(mock.calls[1]?.text).toContain('clock_timestamp()')
    expect(mock.calls.every((call) => call.text.includes('owner_id ='))).toBe(
      true,
    )
    const queryText = mock.calls.map((call) => call.text).join('\n')
    expect(queryText).not.toMatch(
      /config_payload|memory_payload|completed_result_payload|agent_attempts|agent_capability_invocations/,
    )
  })

  test('classifies stale, authority loss and missing without returning partial data', async () => {
    const prepared = readyResponses()
    const staleResponses = structuredClone(prepared.responses)
    ;(staleResponses[0] as Array<{ stateVersion: number }>)[0]!.stateVersion +=
      1
    const staleMock = createSqlMock(staleResponses)
    const stalePort = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(staleMock.sql),
    })
    await expect(
      stalePort.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).resolves.toEqual({ kind: 'stale' })
    expect(staleMock.calls).toHaveLength(1)

    const lostResponses = structuredClone(prepared.responses)
    ;(lostResponses[1] as Array<{ fencingToken: number }>)[0]!.fencingToken = 8
    const lostPort = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(createSqlMock(lostResponses).sql),
    })
    await expect(
      lostPort.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).resolves.toEqual({ kind: 'authorityLost' })

    const missingPort = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(createSqlMock([[]]).sql),
    })
    await expect(
      missingPort.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).resolves.toEqual({ kind: 'resourceMissing' })
  })

  test('rechecks lease and deadline after projection before returning ready', async () => {
    const prepared = readyResponses()
    const responses = structuredClone(prepared.responses)
    responses[5] = [{ leaseCurrent: false, deadlineCurrent: true }]
    const mock = createSqlMock(responses)
    const port = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(mock.sql),
    })

    await expect(
      port.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).resolves.toEqual({ kind: 'authorityLost' })
    expect(mock.calls).toHaveLength(6)
  })

  test('fails closed on current payload corruption and database errors', async () => {
    const prepared = readyResponses()
    const corruptResponses = structuredClone(prepared.responses)
    ;(
      corruptResponses[2] as Array<{ payloadVersion: number }>
    )[0]!.payloadVersion = 999
    const corruptPort = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(createSqlMock(corruptResponses).sql),
    })
    await expect(
      corruptPort.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).rejects.toMatchObject({ corruption: 'invalidPlayerObservation' })

    const failedPort = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(createSqlMock([new Error('secret SQL detail')]).sql),
    })
    await expect(
      failedPort.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
  })

  test('classifies a same-version snapshot actor contradiction as corruption', async () => {
    const prepared = readyResponses()
    const responses = structuredClone(prepared.responses)
    const currentHand = prepared.fixture.input.state.poker.hand
    if (currentHand === null) throw new Error('测试当前手缺失。')
    const contradictoryState = createPrivateTableState({
      ...prepared.fixture.input.state,
      poker: {
        ...prepared.fixture.input.state.poker,
        hand: {
          ...currentHand,
          currentActorSeatNumber:
            currentHand.currentActorSeatNumber === 4 ? 5 : 4,
        },
      },
    })
    const snapshot = encodeSnapshot(contradictoryState)
    responses[2] = [
      { payloadVersion: snapshot.payloadVersion, payload: snapshot.payload },
    ]
    const port = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(createSqlMock(responses).sql),
    })

    await expect(
      port.load({
        owner: await resolvedOwner(),
        identity: prepared.fixture.input.identity,
      }),
    ).rejects.toMatchObject({ corruption: 'invalidPlayerObservation' })
  })

  test('rejects forged authority, owner and identity inputs', async () => {
    const prepared = readyResponses()
    expect(() =>
      createPostgresPlayerObservationPort({
        authority: {
          ...authority(),
          fencingToken: 9,
        },
        database: database(createSqlMock(prepared.responses).sql),
      }),
    ).toThrow(RepositoryInputValidationError)

    const port = createPostgresPlayerObservationPort({
      authority: authority(),
      database: database(createSqlMock(prepared.responses).sql),
    })
    await expect(
      port.load({
        owner: {
          ...(await resolvedOwner()),
          databaseOwnerId: '99999999-9999-4999-8999-999999999999',
        },
        identity: prepared.fixture.input.identity,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    await expect(
      port.load({
        owner: await resolvedOwner(),
        identity: {
          ...prepared.fixture.input.identity,
          actorSeat: 0,
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })
})
