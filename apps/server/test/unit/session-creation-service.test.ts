import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test, vi } from 'vitest'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { createConfigSnapshotKey } from '../../src/personas/config.js'
import { currentPrivateEventProtocol } from '../../src/sessions/authoritative-state/current-private-event-protocol.js'
import {
  createSessionCreationService,
  DeepSeekNotConfiguredError,
  RosterModelInactiveServiceError,
  RosterSourceChangedServiceError,
  RosterSourceNotFoundServiceError,
  type HandAuditCreationWriter,
} from '../../src/sessions/session-creation/session-creation-service.js'
import {
  ActiveModelConfigurationError,
  RosterSourceChangedError,
} from '../../src/persistence/errors.js'
import type { SessionCreationRepository } from '../../src/persistence/session-creation-repository.js'
import type { SessionMutationRepository } from '../../src/persistence/session-mutation-repository.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'
const userParticipantId = '33333333-3333-4333-8333-333333333333'
const handId = '55555555-5555-4555-8555-555555555555'
const eventIds = [
  '66666666-6666-4666-8666-666666666661',
  '66666666-6666-4666-8666-666666666662',
] as const
const createdAt = '2026-08-09T12:00:00.000Z'

function agentParticipantId(index: number): string {
  return `44444444-4444-4444-8444-${index.toString().padStart(12, '0')}`
}

function currentCatalogRequest() {
  return {
    protocolVersion: 1 as const,
    rosterSource: {
      type: 'currentCatalog' as const,
      selections: loadAndValidatePersonaCatalog()
        .list()
        .slice(0, 5)
        .map((entry, index) => ({
          personaId: entry.personaId,
          seatNumber: index + 1,
        })),
    },
  }
}

function createSqlBoundary(additionalResponses: readonly unknown[] = []) {
  let ownerQueryCount = 0
  let beginCount = 0
  const responses = [[{ databaseOwnerId }], ...additionalResponses]
  const transaction = (() => Promise.resolve([])) as unknown as TransactionSql
  const sql = ((template: TemplateStringsArray, ...parameters: unknown[]) => {
    const text = template.join('?')
    if (!text.includes('SELECT') && text.includes('state_version::float8')) {
      return { text, parameters }
    }
    ownerQueryCount += 1
    return Promise.resolve(responses.shift() ?? [])
  }) as unknown as Sql
  Object.assign(sql, {
    begin: async <Result>(
      callback: (transaction: TransactionSql) => Promise<Result>,
    ) => {
      beginCount += 1
      return callback(transaction)
    },
  })
  return {
    sql,
    transaction,
    ownerQueryCount: () => ownerQueryCount,
    beginCount: () => beginCount,
  }
}

function projectSnapshot(input: {
  readonly state: {
    readonly stateVersion: number
    readonly poker: {
      readonly pokerPhase: 'betweenHands' | 'inHand'
      readonly seats: readonly {
        readonly seatNumber: number
        readonly playerId: string
        readonly isUser: boolean
        readonly stack: number
        readonly status: 'active' | 'folded' | 'allIn' | 'out'
      }[]
      readonly hand: {
        readonly handId: string
        readonly street:
          | 'postingBlinds'
          | 'preflop'
          | 'flop'
          | 'turn'
          | 'river'
          | 'showdown'
          | 'complete'
        readonly board: readonly unknown[]
        readonly pot: number
        readonly currentActorSeatNumber: number | null
      } | null
    }
  }
  readonly session: {
    readonly sessionId: string
    readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
    readonly agentRunState: 'idle' | 'thinking' | 'paused'
  }
  readonly eventSeq: number
}) {
  return {
    protocolVersion: 1 as const,
    sessionId: input.session.sessionId,
    stateVersion: input.state.stateVersion,
    eventSeq: input.eventSeq,
    pokerPhase: input.state.poker.pokerPhase,
    lifecycleStatus: input.session.lifecycleStatus,
    agentRunState: input.session.agentRunState,
    activeDecision: null,
    seats: input.state.poker.seats.map((seat) => ({
      seatNumber: seat.seatNumber,
      playerId: seat.playerId,
      displayName: seat.isUser ? '玩家' : `AI ${seat.seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seat.isUser,
      stack: seat.stack,
      status: seat.status,
    })),
    hand:
      input.state.poker.hand === null
        ? null
        : {
            handId: input.state.poker.hand.handId,
            street: input.state.poker.hand.street,
            board: input.state.poker.hand.board,
            pot: input.state.poker.hand.pot,
            currentActorSeatNumber:
              input.state.poker.hand.currentActorSeatNumber,
            heroHoleCards: null,
            legalActions: [],
            actionTimeline: [],
          },
    lastCompletedHandSummary: null,
  }
}

function createDependencies(
  options: {
    readonly latest?: boolean
    readonly latestError?: Error
    readonly active?: boolean
    readonly sqlResponses?: readonly unknown[]
  } = {},
) {
  const boundary = createSqlBoundary(options.sqlResponses)
  const calls: string[] = []
  const creationRepository = {
    async lockOwnerForSessionCreation(
      _transaction: TransactionSql,
      owner: unknown,
    ) {
      calls.push('lockOwner')
      return { owner }
    },
    async checkActiveSessionForCreation() {
      calls.push('checkActive')
      if (options.active) {
        return {
          kind: 'activeSession' as const,
          reference: {
            session: {
              sessionId,
              lifecycleStatus: 'active' as const,
              endedAt: null,
              stateVersion: 5,
              nextEventSeq: 10,
              currentHandId: null,
              diagnosticCode: null,
              diagnosedAt: null,
              agentRunState: 'idle' as const,
              activePlayerRunId: null,
              activeDecisionRequestId: null,
            },
          },
        }
      }
      return { kind: 'noActiveSession' as const }
    },
    async acceptCurrentCatalogRosterForCreation(
      _transaction: TransactionSql,
      lockedOwner: { owner: unknown },
      prepared: {
        sessionId: string
        userParticipantId: string
        agents: readonly { seatNumber: number; agentParticipantId: string }[]
      },
    ) {
      calls.push('acceptRoster')
      return {
        owner: lockedOwner.owner,
        sessionId: prepared.sessionId,
        userParticipantId: prepared.userParticipantId,
        agentParticipants: prepared.agents.map((agent) => ({
          seatNumber: agent.seatNumber,
          participantId: agent.agentParticipantId,
        })),
      }
    },
    async lockLatestEndedRosterForCreation(
      _transaction: TransactionSql,
      lockedOwner: { owner: unknown },
      _preflight: unknown,
      identity: {
        sessionId: string
        userParticipantId: string
        agentParticipants: readonly {
          seatNumber: number
          agentParticipantId: string
        }[]
      },
    ) {
      if (!options.latest) throw new Error('unexpected latest-ended path')
      calls.push('lockLatestRoster')
      if (options.latestError !== undefined) throw options.latestError
      return {
        owner: lockedOwner.owner,
        sessionId: identity.sessionId,
        userParticipantId: identity.userParticipantId,
        agentParticipants: identity.agentParticipants.map((participant) => ({
          seatNumber: participant.seatNumber,
          participantId: participant.agentParticipantId,
        })),
      }
    },
    async insertLockedSessionRoster(
      _transaction: TransactionSql,
      roster: {
        owner: unknown
        sessionId: string
        userParticipantId: string
        agentParticipants: readonly {
          seatNumber: number
          participantId: string
        }[]
      },
    ) {
      calls.push('insertRoster')
      return roster
    },
  } as unknown as SessionCreationRepository
  const lockedSession = {
    sessionId,
    lifecycleStatus: 'active' as const,
    endedAt: null,
    stateVersion: 0,
    nextEventSeq: 0,
    currentHandId: null,
    diagnosticCode: null,
    diagnosedAt: null,
    agentRunState: 'idle' as const,
    activePlayerRunId: null,
    activeDecisionRequestId: null,
  }
  let mutationBatch: unknown
  const mutationRepository = {
    currentPrivateEventProtocol,
    async lockSessionForMutation() {
      calls.push('lockSession')
      return lockedSession
    },
    validateSessionMutation(
      _transaction: TransactionSql,
      _locked: unknown,
      batch: unknown,
    ) {
      calls.push('validateMutation')
      mutationBatch = batch
    },
    async persistSessionMutation() {
      calls.push('persistMutation')
      const events = (
        mutationBatch as {
          readonly events: readonly { readonly publicEvent: unknown }[]
        }
      ).events.map((event) => event.publicEvent)
      return {
        sessionId,
        finalStateVersion: 1,
        nextEventSeq: 2,
        firstEventSeq: 0,
        lastEventSeq: 1,
        events,
      }
    },
  } as unknown as SessionMutationRepository
  const handAuditWriter = {
    async insertInProgress(_transaction, _owner, input) {
      calls.push('insertHand')
      return {
        handId: input.checkpoint.startedHand.handId,
        handNumber: input.checkpoint.startedHand.handNumber,
      }
    },
  } satisfies HandAuditCreationWriter

  return {
    boundary,
    calls,
    creationRepository,
    mutationRepository,
    handAuditWriter,
    mutationBatch: () => mutationBatch,
  }
}

describe('session creation service', () => {
  test('rejects missing DeepSeek before owner, identity, random, or transaction work', async () => {
    const dependencies = createDependencies()
    let identityCalls = 0
    let randomCalls = 0
    const service = createSessionCreationService({
      sql: dependencies.boundary.sql,
      catalog: loadAndValidatePersonaCatalog(),
      readProviderPolicy: () => ({
        deepSeekConfigured: false,
        kimiConfigured: true,
      }),
      createIdentityGraph: () => {
        identityCalls += 1
        throw new Error('identity must not be generated')
      },
      randomSource: {
        nextInt() {
          randomCalls += 1
          return 0
        },
      },
      now: () => createdAt,
      creationRepository: dependencies.creationRepository,
      mutationRepository: dependencies.mutationRepository,
      handAuditWriter: dependencies.handAuditWriter,
      snapshotProjectorBinding: {
        bindReadPort: () => ({}),
        projector: {
          project: async (input) => projectSnapshot(input) as never,
        },
      },
      activeSessionSnapshotReaderBinding: {
        bindReadPort: () => ({}),
        reader: {
          read: async () => {
            throw new Error('unexpected')
          },
        },
      },
    })

    await expect(
      service.create(currentCatalogRequest()),
    ).rejects.toBeInstanceOf(DeepSeekNotConfiguredError)
    expect(identityCalls).toBe(0)
    expect(randomCalls).toBe(0)
    expect(dependencies.boundary.ownerQueryCount()).toBe(0)
    expect(dependencies.boundary.beginCount()).toBe(0)
  })

  test('atomically creates the first hand and returns the fixed Kimi warning after commit', async () => {
    const dependencies = createDependencies()
    let identityCalls = 0
    const service = createSessionCreationService({
      sql: dependencies.boundary.sql,
      catalog: loadAndValidatePersonaCatalog(),
      readProviderPolicy: () => ({
        deepSeekConfigured: true,
        kimiConfigured: false,
      }),
      createIdentityGraph: (seatNumbers) => {
        identityCalls += 1
        return {
          sessionId,
          userParticipantId,
          handId,
          agentParticipants: seatNumbers.map((seatNumber) => ({
            seatNumber,
            participantId: agentParticipantId(seatNumber),
          })),
          eventIds,
        }
      },
      randomSource: { nextInt: () => 0 },
      now: () => createdAt,
      creationRepository: dependencies.creationRepository,
      mutationRepository: dependencies.mutationRepository,
      handAuditWriter: dependencies.handAuditWriter,
      snapshotProjectorBinding: {
        bindReadPort: () => ({}),
        projector: {
          project: async (input) => projectSnapshot(input) as never,
        },
      },
      activeSessionSnapshotReaderBinding: {
        bindReadPort: () => ({}),
        reader: {
          read: async () => {
            throw new Error('unexpected')
          },
        },
      },
    })

    const result = await service.create(currentCatalogRequest())

    expect(result.kind).toBe('created')
    if (result.kind !== 'created') throw new Error('expected created')
    expect(identityCalls).toBe(1)
    expect(result.response.warnings).toEqual([
      {
        code: 'KIMI_FALLBACK_UNAVAILABLE',
        message: 'Kimi API Key 未配置，自动降级不可用。',
      },
    ])
    expect(result.response.snapshot).toMatchObject({
      sessionId,
      stateVersion: 1,
      eventSeq: 1,
      pokerPhase: 'inHand',
    })
    expect(result.newlyPersistedEvents.map((event) => event.eventSeq)).toEqual([
      0, 1,
    ])
    expect(dependencies.calls).toEqual([
      'lockOwner',
      'checkActive',
      'acceptRoster',
      'insertRoster',
      'lockSession',
      'validateMutation',
      'insertHand',
      'persistMutation',
    ])
    expect(dependencies.mutationBatch()).toMatchObject({
      finalStateVersion: 1,
      currentHandId: handId,
      events: [
        { eventSeq: 0, commandLedgerId: null },
        { eventSeq: 1, commandLedgerId: null, handId },
      ],
    })
  })

  test('uses latest-ended preflight only for seats and acquires config under the owner lock', async () => {
    const catalog = loadAndValidatePersonaCatalog()
    const sourceSessionId = '77777777-7777-4777-8777-777777777777'
    const sourceSession = {
      id: sourceSessionId,
      lifecycleStatus: 'ended' as const,
      stateVersion: 9,
      nextEventSeq: 20,
      currentHandId: null,
      agentRunState: 'idle' as const,
      activePlayerRunId: null,
      activeDecisionRequestId: null,
      createdAt: '2026-08-01T00:00:00.000001Z',
      endedAt: '2026-08-01T01:00:00.000001Z',
      updatedAt: '2026-08-01T01:00:00.000001Z',
    }
    const snapshots = catalog
      .list()
      .slice(0, 5)
      .map((entry, index) => {
        const payload = { ...entry, personaVersion: 7 }
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
    const dependencies = createDependencies({
      latest: true,
      sqlResponses: [[sourceSession], snapshots],
    })
    const service = createSessionCreationService({
      sql: dependencies.boundary.sql,
      catalog,
      readProviderPolicy: () => ({
        deepSeekConfigured: true,
        kimiConfigured: true,
      }),
      createIdentityGraph: (seatNumbers) => ({
        sessionId,
        userParticipantId,
        handId,
        agentParticipants: seatNumbers.map((seatNumber) => ({
          seatNumber,
          participantId: agentParticipantId(seatNumber),
        })),
        eventIds,
      }),
      randomSource: { nextInt: () => 0 },
      now: () => createdAt,
      creationRepository: dependencies.creationRepository,
      mutationRepository: dependencies.mutationRepository,
      handAuditWriter: dependencies.handAuditWriter,
      snapshotProjectorBinding: {
        bindReadPort: () => ({}),
        projector: {
          project: async (input) => projectSnapshot(input) as never,
        },
      },
      activeSessionSnapshotReaderBinding: {
        bindReadPort: () => ({}),
        reader: {
          read: async () => {
            throw new Error('unexpected')
          },
        },
      },
    })

    await expect(
      service.create({
        protocolVersion: 1,
        rosterSource: { type: 'latestEnded' },
      }),
    ).resolves.toMatchObject({ kind: 'created' })
    expect(dependencies.calls).toEqual([
      'lockOwner',
      'checkActive',
      'lockLatestRoster',
      'insertRoster',
      'lockSession',
      'validateMutation',
      'insertHand',
      'persistMutation',
    ])
  })

  test('maps a missing latest-ended preflight to the stable service error', async () => {
    const dependencies = createDependencies({
      latest: true,
      sqlResponses: [[]],
    })
    const service = createSessionCreationService({
      sql: dependencies.boundary.sql,
      catalog: loadAndValidatePersonaCatalog(),
      readProviderPolicy: () => ({
        deepSeekConfigured: true,
        kimiConfigured: true,
      }),
      createIdentityGraph: () => {
        throw new Error('identity must not be generated')
      },
      randomSource: { nextInt: () => 0 },
      now: () => createdAt,
      creationRepository: dependencies.creationRepository,
      mutationRepository: dependencies.mutationRepository,
      handAuditWriter: dependencies.handAuditWriter,
      snapshotProjectorBinding: {
        bindReadPort: () => ({}),
        projector: { project: async () => projectSnapshot as never },
      },
      activeSessionSnapshotReaderBinding: {
        bindReadPort: () => ({}),
        reader: { read: async () => projectSnapshot as never },
      },
    })

    await expect(
      service.create({
        protocolVersion: 1,
        rosterSource: { type: 'latestEnded' },
      }),
    ).rejects.toMatchObject({
      name: 'RosterSourceNotFoundServiceError',
      code: 'ROSTER_SOURCE_NOT_FOUND',
    } satisfies Partial<RosterSourceNotFoundServiceError>)
    expect(dependencies.boundary.beginCount()).toBe(0)
  })

  test.each([
    {
      repositoryError: new RosterSourceChangedError(),
      expected: {
        name: 'RosterSourceChangedServiceError',
        code: 'ROSTER_SOURCE_CHANGED',
      } satisfies Partial<RosterSourceChangedServiceError>,
    },
    {
      repositoryError: new ActiveModelConfigurationError(3, 'tag_pro'),
      expected: {
        name: 'RosterModelInactiveServiceError',
        code: 'ROSTER_MODEL_INACTIVE',
        seatNumber: 3,
        personaId: 'tag_pro',
      } satisfies Partial<RosterModelInactiveServiceError>,
    },
  ])(
    'maps $expected.code from the locked latest-ended repository boundary',
    async ({ repositoryError, expected }) => {
      const catalog = loadAndValidatePersonaCatalog()
      const sourceSession = {
        id: '77777777-7777-4777-8777-777777777777',
        lifecycleStatus: 'ended' as const,
        stateVersion: 9,
        nextEventSeq: 20,
        currentHandId: null,
        agentRunState: 'idle' as const,
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        createdAt: '2026-08-01T00:00:00.000001Z',
        endedAt: '2026-08-01T01:00:00.000001Z',
        updatedAt: '2026-08-01T01:00:00.000001Z',
      }
      const snapshots = catalog
        .list()
        .slice(0, 5)
        .map((entry, index) => ({
          hasAgent: true,
          participantId: `88888888-8888-4888-8888-${(index + 1)
            .toString()
            .padStart(12, '0')}`,
          seatNumber: index + 1,
          displayName: entry.name,
          avatarColor: entry.avatarColor,
          personaId: entry.personaId,
          personaVersion: entry.personaVersion,
          configSnapshotKey: createConfigSnapshotKey(1, entry),
          configPayloadVersion: 1,
          configPayload: entry,
        }))
      const dependencies = createDependencies({
        latest: true,
        latestError: repositoryError,
        sqlResponses: [[sourceSession], snapshots],
      })
      const service = createSessionCreationService({
        sql: dependencies.boundary.sql,
        catalog,
        readProviderPolicy: () => ({
          deepSeekConfigured: true,
          kimiConfigured: true,
        }),
        createIdentityGraph: (seatNumbers) => ({
          sessionId,
          userParticipantId,
          handId,
          agentParticipants: seatNumbers.map((seatNumber) => ({
            seatNumber,
            participantId: agentParticipantId(seatNumber),
          })),
          eventIds,
        }),
        randomSource: { nextInt: () => 0 },
        now: () => createdAt,
        creationRepository: dependencies.creationRepository,
        mutationRepository: dependencies.mutationRepository,
        handAuditWriter: dependencies.handAuditWriter,
        snapshotProjectorBinding: {
          bindReadPort: () => ({}),
          projector: { project: async () => projectSnapshot as never },
        },
        activeSessionSnapshotReaderBinding: {
          bindReadPort: () => ({}),
          reader: { read: async () => projectSnapshot as never },
        },
      })

      await expect(
        service.create({
          protocolVersion: 1,
          rosterSource: { type: 'latestEnded' },
        }),
      ).rejects.toMatchObject(expected)
      expect(dependencies.calls).toEqual([
        'lockOwner',
        'checkActive',
        'lockLatestRoster',
      ])
    },
  )

  test('returns the locked active snapshot without creating another roster or hand', async () => {
    const dependencies = createDependencies({ active: true })
    const latestSnapshot = {
      protocolVersion: 1 as const,
      sessionId,
      stateVersion: 5,
      eventSeq: 9,
      pokerPhase: 'betweenHands' as const,
      lifecycleStatus: 'active' as const,
      agentRunState: 'idle' as const,
      activeDecision: null,
      seats: Array.from({ length: 6 }, (_, seatNumber) => ({
        seatNumber,
        playerId:
          seatNumber === 0 ? userParticipantId : agentParticipantId(seatNumber),
        displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
        avatarColor: '#0f766e',
        isUser: seatNumber === 0,
        stack: 2_000,
        status: 'active' as const,
      })),
      hand: null,
      lastCompletedHandSummary: null,
    }
    const service = createSessionCreationService({
      sql: dependencies.boundary.sql,
      catalog: loadAndValidatePersonaCatalog(),
      readProviderPolicy: () => ({
        deepSeekConfigured: true,
        kimiConfigured: true,
      }),
      createIdentityGraph: (seatNumbers) => ({
        sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        userParticipantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        handId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        agentParticipants: seatNumbers.map((seatNumber) => ({
          seatNumber,
          participantId: `dddddddd-dddd-4ddd-8ddd-${seatNumber
            .toString()
            .padStart(12, '0')}`,
        })),
        eventIds: [
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
          'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee2',
        ],
      }),
      randomSource: { nextInt: () => 0 },
      now: () => createdAt,
      creationRepository: dependencies.creationRepository,
      mutationRepository: dependencies.mutationRepository,
      handAuditWriter: dependencies.handAuditWriter,
      snapshotProjectorBinding: {
        bindReadPort: () => ({}),
        projector: {
          project: async () => {
            throw new Error('unexpected')
          },
        },
      },
      activeSessionSnapshotReaderBinding: {
        bindReadPort: () => ({}),
        reader: { read: async () => latestSnapshot },
      },
    })

    await expect(service.create(currentCatalogRequest())).resolves.toEqual({
      kind: 'activeSessionExists',
      response: {
        protocolVersion: 1,
        code: 'ACTIVE_SESSION_EXISTS',
        message: '当前已有进行中的训练场次，请继续该场次。',
        latestSnapshot,
      },
    })
    expect(dependencies.calls).toEqual(['lockOwner', 'checkActive'])
  })
})
