import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { createConfigSnapshotKey } from '../../src/personas/config.js'
import {
  RosterSourceChangedError,
  RepositoryInputValidationError,
  SessionCreationTransitionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createSessionCreationRepository } from '../../src/persistence/session-creation-repository.js'
import { prepareCurrentCatalogRoster } from '../../src/sessions/roster-preparation.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const userParticipantId = '33333333-3333-4333-8333-333333333333'
const sourceSessionId = '77777777-7777-4777-8777-777777777777'

function agentParticipantId(index: number): string {
  return `44444444-4444-4444-8444-${index.toString().padStart(12, '0')}`
}

async function resolvedOwner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function preparedRoster() {
  const catalog = loadAndValidatePersonaCatalog()
  return prepareCurrentCatalogRoster(catalog, {
    sessionId,
    userParticipantId,
    agents: catalog
      .list()
      .slice(0, 5)
      .map((entry, index) => ({
        personaId: entry.personaId,
        seatNumber: index + 1,
        agentParticipantId: agentParticipantId(index + 1),
      })),
  })
}

function historicalSnapshotRows(personaVersion = 7) {
  return loadAndValidatePersonaCatalog()
    .list()
    .slice(0, 5)
    .map((entry, index) => {
      const payload = { ...entry, personaVersion }
      return {
        hasAgent: true,
        participantId: `88888888-8888-4888-8888-${(index + 1)
          .toString()
          .padStart(12, '0')}`,
        seatNumber: index + 1,
        displayName: payload.name,
        avatarColor: payload.avatarColor,
        personaId: payload.personaId,
        personaVersion: payload.personaVersion,
        configSnapshotKey: createConfigSnapshotKey(1, payload),
        configPayloadVersion: 1,
        configPayload: payload,
      }
    })
}

function createTransaction(responses: readonly unknown[]) {
  const pending = [...responses]
  const calls: string[] = []
  const transaction = ((
    first: TemplateStringsArray | readonly unknown[],
    ...parameters: unknown[]
  ) => {
    if (!('raw' in first)) {
      return { rows: first, columns: parameters }
    }
    calls.push(first.join('?'))
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response ?? [])
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return { transaction, calls, remaining: () => pending.length }
}

describe('session creation repository', () => {
  test('supports the legal ownerLocked -> activeCheckedNoConflict -> rosterIssued chain once', async () => {
    const boundary = createTransaction([
      [{ databaseOwnerId }],
      [],
      [{ databaseOwnerId }],
      [],
      [],
      [],
      [],
    ])
    const repository = createSessionCreationRepository()
    const owner = await repository.lockOwnerForSessionCreation(
      boundary.transaction,
      await resolvedOwner(),
    )

    await expect(
      repository.checkActiveSessionForCreation(boundary.transaction, owner),
    ).resolves.toEqual({ kind: 'noActiveSession' })
    const roster = await repository.acceptCurrentCatalogRosterForCreation(
      boundary.transaction,
      owner,
      preparedRoster(),
    )
    await expect(
      repository.insertLockedSessionRoster(boundary.transaction, roster),
    ).resolves.toMatchObject({ sessionId, userParticipantId })

    expect(boundary.calls).toHaveLength(7)
    await expect(
      repository.acceptCurrentCatalogRosterForCreation(
        boundary.transaction,
        owner,
        preparedRoster(),
      ),
    ).rejects.toBeInstanceOf(SessionCreationTransitionError)
    await expect(
      repository.insertLockedSessionRoster(boundary.transaction, roster),
    ).rejects.toBeInstanceOf(SessionCreationTransitionError)
  })

  test('rejects a forged prepared roster before any roster write', async () => {
    const boundary = createTransaction([[{ databaseOwnerId }], []])
    const repository = createSessionCreationRepository()
    const owner = await repository.lockOwnerForSessionCreation(
      boundary.transaction,
      await resolvedOwner(),
    )
    await repository.checkActiveSessionForCreation(boundary.transaction, owner)

    await expect(
      repository.acceptCurrentCatalogRosterForCreation(
        boundary.transaction,
        owner,
        { ...preparedRoster() },
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(boundary.calls).toHaveLength(2)
  })

  test('moves an owner with an active session to a conflict terminal state', async () => {
    const active = {
      sessionId,
      lifecycleStatus: 'active' as const,
      endedAt: null,
      stateVersion: 4,
      nextEventSeq: 8,
      currentHandId: null,
      diagnosticCode: null,
      diagnosedAt: null,
      agentRunState: 'idle' as const,
      activePlayerRunId: null,
      activeDecisionRequestId: null,
    }
    const boundary = createTransaction([
      [{ databaseOwnerId }],
      [{ sessionId }],
      [active],
    ])
    const repository = createSessionCreationRepository()
    const owner = await repository.lockOwnerForSessionCreation(
      boundary.transaction,
      await resolvedOwner(),
    )

    await expect(
      repository.checkActiveSessionForCreation(boundary.transaction, owner),
    ).resolves.toMatchObject({
      kind: 'activeSession',
      reference: { session: active },
    })
    await expect(
      repository.acceptCurrentCatalogRosterForCreation(
        boundary.transaction,
        owner,
        preparedRoster(),
      ),
    ).rejects.toBeInstanceOf(SessionCreationTransitionError)
    await expect(
      repository.checkActiveSessionForCreation(boundary.transaction, owner),
    ).rejects.toBeInstanceOf(SessionCreationTransitionError)
  })

  test('rejects capabilities across repository instances and transactions', async () => {
    const firstBoundary = createTransaction([
      [{ databaseOwnerId }],
      [],
      [{ databaseOwnerId }],
    ])
    const secondBoundary = createTransaction([])
    const first = createSessionCreationRepository()
    const second = createSessionCreationRepository()
    const owner = await first.lockOwnerForSessionCreation(
      firstBoundary.transaction,
      await resolvedOwner(),
    )
    await first.checkActiveSessionForCreation(firstBoundary.transaction, owner)
    const roster = await first.acceptCurrentCatalogRosterForCreation(
      firstBoundary.transaction,
      owner,
      preparedRoster(),
    )

    await expect(
      second.insertLockedSessionRoster(firstBoundary.transaction, roster),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    await expect(
      first.insertLockedSessionRoster(secondBoundary.transaction, roster),
    ).rejects.toBeInstanceOf(SessionCreationTransitionError)
  })

  test('rejects an owner capability after its transaction has ended', async () => {
    const boundary = createTransaction([[{ databaseOwnerId }], []])
    const repository = createSessionCreationRepository()
    const owner = await repository.lockOwnerForSessionCreation(
      boundary.transaction,
      await resolvedOwner(),
    )
    await repository.checkActiveSessionForCreation(boundary.transaction, owner)

    await expect(
      repository.acceptCurrentCatalogRosterForCreation(
        boundary.transaction,
        owner,
        preparedRoster(),
      ),
    ).rejects.toBeInstanceOf(Error)
    expect(boundary.calls).toHaveLength(3)
  })

  test('locks and rereads the exact latest ended roster while preserving old config', async () => {
    const snapshots = historicalSnapshotRows()
    const boundary = createTransaction([
      [{ databaseOwnerId }],
      [],
      [{ sessionId: sourceSessionId }],
      [{ sessionId: sourceSessionId, lifecycleStatus: 'ended' }],
      [{ sessionId: sourceSessionId }],
      snapshots,
      [],
      [],
      [],
      [],
    ])
    const repository = createSessionCreationRepository()
    const owner = await repository.lockOwnerForSessionCreation(
      boundary.transaction,
      await resolvedOwner(),
    )
    await repository.checkActiveSessionForCreation(boundary.transaction, owner)
    const roster = await repository.lockLatestEndedRosterForCreation(
      boundary.transaction,
      owner,
      {
        sourceSessionId,
        aiSeatNumbers: [1, 2, 3, 4, 5],
      },
      {
        sessionId,
        userParticipantId,
        agentParticipants: [1, 2, 3, 4, 5].map((seatNumber) => ({
          seatNumber,
          agentParticipantId: agentParticipantId(seatNumber),
        })),
      },
    )
    const inserted = await repository.insertLockedSessionRoster(
      boundary.transaction,
      roster,
    )

    expect(inserted.agentParticipants).toEqual(
      [1, 2, 3, 4, 5].map((seatNumber) => ({
        seatNumber,
        participantId: agentParticipantId(seatNumber),
      })),
    )
    expect(boundary.calls[2]).toContain('ORDER BY ended_at DESC, id DESC')
    expect(boundary.calls[3]).toContain('FOR UPDATE')
    expect(boundary.calls[5]).toContain('session_agents')
    const agentRows = boundary.calls[8]
    expect(agentRows).toContain('app_private.session_agents')
  })

  test('rejects a changed latest-ended source without falling back', async () => {
    const changedSourceId = '99999999-9999-4999-8999-999999999999'
    const boundary = createTransaction([
      [{ databaseOwnerId }],
      [],
      [{ sessionId: changedSourceId }],
    ])
    const repository = createSessionCreationRepository()
    const owner = await repository.lockOwnerForSessionCreation(
      boundary.transaction,
      await resolvedOwner(),
    )
    await repository.checkActiveSessionForCreation(boundary.transaction, owner)

    await expect(
      repository.lockLatestEndedRosterForCreation(
        boundary.transaction,
        owner,
        { sourceSessionId, aiSeatNumbers: [1, 2, 3, 4, 5] },
        {
          sessionId,
          userParticipantId,
          agentParticipants: [1, 2, 3, 4, 5].map((seatNumber) => ({
            seatNumber,
            agentParticipantId: agentParticipantId(seatNumber),
          })),
        },
      ),
    ).rejects.toBeInstanceOf(RosterSourceChangedError)
    expect(boundary.calls).toHaveLength(3)
  })
})
