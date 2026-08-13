import type {
  CreateSessionResponse,
  ErrorResponse,
  SseEvent,
} from '@tx-holdem-coach/contracts'
import {
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  ErrorResponseSchema,
  PublicSessionSnapshotSchema,
  SseEventSchema,
} from '@tx-holdem-coach/contracts'
import type { Sql, TransactionSql } from 'postgres'
import type { PersonaCatalog } from '../../personas/catalog.js'
import type { RandomSource } from '../../poker/random-source.js'
import type { InsertInProgressHandAuditInput } from '../../persistence/hand-audit-repository.js'
import {
  ActiveModelConfigurationError,
  ResourceNotFoundError,
  RosterSourceChangedError,
} from '../../persistence/errors.js'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import {
  resolveOwnerScope,
  type ResolvedOwnerScope,
} from '../../persistence/owner-scope.js'
import type { SessionCreationRepository } from '../../persistence/session-creation-repository.js'
import type { SessionMutationRepository } from '../../persistence/session-mutation-repository.js'
import { getPrivateEventHandId } from '../authoritative-state/private-event-v2.js'
import { encodeSnapshotV1 } from '../authoritative-state/snapshot-codec-v1.js'
import {
  prepareCurrentCatalogRoster,
  prepareLatestEndedRosterPreflight,
} from '../roster-preparation.js'
import {
  createSessionCreationPlan,
  SessionCreationInvariantError,
  type SessionCreationIdentityGraph,
} from './session-creation-consistency.js'
import type {
  ActiveSessionSnapshotReaderBinding,
  SessionCreationSnapshotProjectorBinding,
} from './session-creation-projector.js'
import type { CommittedSessionEventPublisher } from '../public-projection/committed-session-event-hub.js'

export interface ProviderCreationPolicy {
  readonly deepSeekConfigured: boolean
  readonly kimiConfigured: boolean
}

export class DeepSeekNotConfiguredError extends Error {
  public readonly code = 'DEEPSEEK_NOT_CONFIGURED'

  public constructor() {
    super('DeepSeek API Key 未配置，无法创建场次。')
    this.name = 'DeepSeekNotConfiguredError'
  }
}

export class InvalidSessionCreationRequestError extends Error {
  public readonly code = 'INVALID_REQUEST'

  public constructor() {
    super('场次创建请求无效。')
    this.name = 'InvalidSessionCreationRequestError'
  }
}

export class RosterSourceNotFoundServiceError extends Error {
  public readonly code = 'ROSTER_SOURCE_NOT_FOUND'

  public constructor() {
    super('没有可复用的历史阵容。')
    this.name = 'RosterSourceNotFoundServiceError'
  }
}

export class RosterSourceChangedServiceError extends Error {
  public readonly code = 'ROSTER_SOURCE_CHANGED'

  public constructor() {
    super('历史阵容来源已变化，请重新提交。')
    this.name = 'RosterSourceChangedServiceError'
  }
}

export class RosterModelInactiveServiceError extends Error {
  public readonly code = 'ROSTER_MODEL_INACTIVE'

  public constructor(
    public readonly seatNumber: number,
    public readonly personaId: string,
  ) {
    super('历史阵容包含当前不可用的人物模型配置。')
    this.name = 'RosterModelInactiveServiceError'
  }
}

export type SessionCreationResult =
  | {
      readonly kind: 'created'
      readonly response: CreateSessionResponse
      readonly newlyPersistedEvents: readonly [SseEvent, SseEvent]
    }
  | {
      readonly kind: 'activeSessionExists'
      readonly response: ErrorResponse
    }

export interface SessionCreationService {
  create(request: unknown): Promise<SessionCreationResult>
}

export interface HandAuditCreationWriter {
  insertInProgress(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: InsertInProgressHandAuditInput,
  ): Promise<{ readonly handId: string; readonly handNumber: number }>
}

export function createSessionCreationService(input: {
  readonly sql: Sql
  readonly catalog: PersonaCatalog
  readonly readProviderPolicy: () => ProviderCreationPolicy
  readonly createIdentityGraph: (
    aiSeatNumbers: readonly number[],
  ) => SessionCreationIdentityGraph
  readonly randomSource: RandomSource
  readonly now: () => string
  readonly creationRepository: SessionCreationRepository
  readonly mutationRepository: SessionMutationRepository
  readonly handAuditWriter: HandAuditCreationWriter
  readonly snapshotProjectorBinding: SessionCreationSnapshotProjectorBinding
  readonly activeSessionSnapshotReaderBinding: ActiveSessionSnapshotReaderBinding
  readonly committedEventPublisher?: CommittedSessionEventPublisher
  readonly logPublishFailure?: (input: {
    readonly eventCount: number
    readonly firstEventSeq: number
    readonly lastEventSeq: number
  }) => void
}): SessionCreationService {
  const {
    sql,
    catalog,
    readProviderPolicy,
    createIdentityGraph,
    randomSource,
    now,
    creationRepository,
    mutationRepository,
    handAuditWriter,
    snapshotProjectorBinding,
    activeSessionSnapshotReaderBinding,
    committedEventPublisher,
    logPublishFailure,
  } = input

  const assertRosterMirrorsPlan = (
    roster: {
      readonly sessionId: string
      readonly userParticipantId: string
      readonly agentParticipants: readonly {
        readonly seatNumber: number
        readonly participantId: string
      }[]
    },
    identity: SessionCreationIdentityGraph,
  ) => {
    if (
      roster.sessionId !== identity.sessionId ||
      roster.userParticipantId !== identity.userParticipantId ||
      roster.agentParticipants.length !== identity.agentParticipants.length ||
      roster.agentParticipants.some((participant, index) => {
        const expected = identity.agentParticipants[index]
        return (
          expected === undefined ||
          participant.seatNumber !== expected.seatNumber ||
          participant.participantId !== expected.participantId
        )
      })
    ) {
      throw new SessionCreationInvariantError()
    }
  }

  const mapLatestEndedError = (error: unknown): never => {
    if (error instanceof ResourceNotFoundError) {
      throw new RosterSourceNotFoundServiceError()
    }
    if (error instanceof RosterSourceChangedError) {
      throw new RosterSourceChangedServiceError()
    }
    if (error instanceof ActiveModelConfigurationError) {
      throw new RosterModelInactiveServiceError(
        error.seatNumber,
        error.personaId,
      )
    }
    throw error
  }

  return Object.freeze({
    async create(request: unknown) {
      const parsedRequest = CreateSessionRequestSchema.safeParse(request)
      if (!parsedRequest.success) {
        throw new InvalidSessionCreationRequestError()
      }
      const providerPolicy = readProviderPolicy()
      if (!providerPolicy.deepSeekConfigured) {
        throw new DeepSeekNotConfiguredError()
      }
      const warnings = providerPolicy.kimiConfigured
        ? []
        : [
            {
              code: 'KIMI_FALLBACK_UNAVAILABLE' as const,
              message: 'Kimi API Key 未配置，自动降级不可用。' as const,
            },
          ]
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const rosterSource = parsedRequest.data.rosterSource
      const selections =
        rosterSource.type === 'currentCatalog'
          ? [...rosterSource.selections].sort(
              (left, right) => left.seatNumber - right.seatNumber,
            )
          : null
      const latestEndedPreflight =
        rosterSource.type === 'latestEnded'
          ? await prepareLatestEndedRosterPreflight(sql, owner).catch(
              mapLatestEndedError,
            )
          : null
      const aiSeatNumbers =
        selections?.map((selection) => selection.seatNumber) ??
        latestEndedPreflight?.aiSeatNumbers ??
        []
      const identityGraph = createIdentityGraph(aiSeatNumbers)
      const participantsBySeat = new Map(
        identityGraph.agentParticipants.map((participant) => [
          participant.seatNumber,
          participant.participantId,
        ]),
      )
      if (
        participantsBySeat.size !== aiSeatNumbers.length ||
        aiSeatNumbers.some((seatNumber) => !participantsBySeat.has(seatNumber))
      ) {
        throw new SessionCreationInvariantError()
      }
      const preparedRoster =
        selections === null
          ? null
          : prepareCurrentCatalogRoster(catalog, {
              sessionId: identityGraph.sessionId,
              userParticipantId: identityGraph.userParticipantId,
              agents: selections.map((selection) => ({
                ...selection,
                agentParticipantId:
                  participantsBySeat.get(selection.seatNumber) ?? '',
              })),
            })
      const plan = createSessionCreationPlan({ identityGraph, randomSource })
      const mutationAt = now()

      const result = await runDatabaseTransaction(sql, async (transaction) => {
        const lockedOwner =
          await creationRepository.lockOwnerForSessionCreation(
            transaction,
            owner,
          )
        const active = await creationRepository.checkActiveSessionForCreation(
          transaction,
          lockedOwner,
        )
        if (active.kind === 'activeSession') {
          const latestSnapshot = PublicSessionSnapshotSchema.parse(
            await activeSessionSnapshotReaderBinding.reader.read({
              reference: active.reference,
              reads:
                activeSessionSnapshotReaderBinding.bindReadPort(transaction),
            }),
          )
          if (
            latestSnapshot.sessionId !== active.reference.session.sessionId ||
            latestSnapshot.lifecycleStatus !== 'active' ||
            latestSnapshot.stateVersion !==
              active.reference.session.stateVersion ||
            latestSnapshot.eventSeq !==
              active.reference.session.nextEventSeq - 1 ||
            latestSnapshot.agentRunState !==
              active.reference.session.agentRunState
          ) {
            throw new SessionCreationInvariantError()
          }
          return Object.freeze({
            kind: 'activeSessionExists' as const,
            response: ErrorResponseSchema.parse({
              protocolVersion: 1,
              code: 'ACTIVE_SESSION_EXISTS',
              message: '当前已有进行中的训练场次，请继续该场次。',
              latestSnapshot,
            }),
          })
        }

        const lockedRoster =
          preparedRoster === null && latestEndedPreflight !== null
            ? await creationRepository
                .lockLatestEndedRosterForCreation(
                  transaction,
                  lockedOwner,
                  latestEndedPreflight,
                  {
                    sessionId: plan.identityGraph.sessionId,
                    userParticipantId: plan.identityGraph.userParticipantId,
                    agentParticipants: plan.identityGraph.agentParticipants.map(
                      (participant) => ({
                        seatNumber: participant.seatNumber,
                        agentParticipantId: participant.participantId,
                      }),
                    ),
                  },
                )
                .catch(mapLatestEndedError)
            : preparedRoster !== null
              ? await creationRepository.acceptCurrentCatalogRosterForCreation(
                  transaction,
                  lockedOwner,
                  preparedRoster,
                )
              : (() => {
                  throw new SessionCreationInvariantError()
                })()
        assertRosterMirrorsPlan(lockedRoster, plan.identityGraph)
        const inserted = await creationRepository.insertLockedSessionRoster(
          transaction,
          lockedRoster,
        )
        assertRosterMirrorsPlan(inserted, plan.identityGraph)
        const lockedSession = await mutationRepository.lockSessionForMutation(
          transaction,
          owner,
          plan.identityGraph.sessionId,
        )
        if (
          lockedSession.lifecycleStatus !== 'active' ||
          lockedSession.stateVersion !== 0 ||
          lockedSession.nextEventSeq !== 0 ||
          lockedSession.currentHandId !== null ||
          lockedSession.agentRunState !== 'idle' ||
          lockedSession.activePlayerRunId !== null ||
          lockedSession.activeDecisionRequestId !== null
        ) {
          throw new SessionCreationInvariantError()
        }
        const projectedSession = Object.freeze({
          ...lockedSession,
          stateVersion: 1,
          nextEventSeq: 2,
          currentHandId: plan.identityGraph.handId,
        })
        const finalSnapshot = PublicSessionSnapshotSchema.parse(
          await snapshotProjectorBinding.projector.project({
            state: plan.finalState,
            session: projectedSession,
            eventSeq: 1,
            newPrivateEvents: plan.privateEventDrafts,
            reads: snapshotProjectorBinding.bindReadPort(transaction),
          }),
        )
        const expectedPlayers = new Map([
          [0, plan.identityGraph.userParticipantId],
          ...plan.identityGraph.agentParticipants.map(
            (participant) =>
              [participant.seatNumber, participant.participantId] as const,
          ),
        ])
        if (
          finalSnapshot.sessionId !== plan.identityGraph.sessionId ||
          finalSnapshot.stateVersion !== 1 ||
          finalSnapshot.eventSeq !== 1 ||
          finalSnapshot.lifecycleStatus !== 'active' ||
          finalSnapshot.agentRunState !== 'idle' ||
          finalSnapshot.activeDecision !== null ||
          finalSnapshot.pokerPhase !== 'inHand' ||
          finalSnapshot.hand?.handId !== plan.identityGraph.handId ||
          finalSnapshot.seats.length !== expectedPlayers.size ||
          finalSnapshot.seats.some(
            (seat, index) =>
              seat.seatNumber !==
                plan.finalState.poker.seats[index]?.seatNumber ||
              expectedPlayers.get(seat.seatNumber) !== seat.playerId ||
              seat.isUser !== (seat.seatNumber === 0),
          )
        ) {
          throw new SessionCreationInvariantError()
        }

        const publicEvents = plan.privateEventDrafts.map((draft, index) => {
          const eventSeq = index
          return SseEventSchema.parse({
            protocolVersion: 1,
            eventId: plan.identityGraph.eventIds[index],
            sessionId: plan.identityGraph.sessionId,
            eventSeq,
            stateVersion: 1,
            type: draft.type,
            payload: {
              snapshot: { ...finalSnapshot, eventSeq },
            },
          })
        }) as [SseEvent, SseEvent]
        const mutationBatch = Object.freeze({
          finalStateVersion: 1,
          lifecycleStatus: 'active' as const,
          currentHandId: plan.identityGraph.handId,
          agentRunState: 'idle' as const,
          activePlayerRunId: null,
          activeDecisionRequestId: null,
          snapshot: encodeSnapshotV1(plan.finalState),
          events: Object.freeze(
            plan.privateEventDrafts.map((draft, index) => ({
              eventId: plan.identityGraph.eventIds[index] as string,
              eventSeq: index,
              handId: getPrivateEventHandId(draft),
              commandLedgerId: null,
              stateVersionBefore: 0,
              stateVersionAfter: 1,
              privateEvent:
                mutationRepository.currentPrivateEventProtocol.encodeCurrent(
                  draft,
                ),
              publicEvent: publicEvents[index] as SseEvent,
              createdAt: mutationAt,
            })),
          ),
          mutationAt,
        })
        mutationRepository.validateSessionMutation(
          transaction,
          lockedSession,
          mutationBatch,
        )
        const insertedHand = await handAuditWriter.insertInProgress(
          transaction,
          owner,
          {
            sessionId: plan.identityGraph.sessionId,
            checkpoint: plan.checkpoint,
            startedAt: mutationAt,
          },
        )
        if (
          insertedHand.handId !== plan.identityGraph.handId ||
          insertedHand.handNumber !== 1
        ) {
          throw new SessionCreationInvariantError()
        }
        const persisted = await mutationRepository.persistSessionMutation(
          transaction,
          lockedSession,
          mutationBatch,
        )
        if (
          persisted.sessionId !== plan.identityGraph.sessionId ||
          persisted.finalStateVersion !== 1 ||
          persisted.nextEventSeq !== 2 ||
          persisted.firstEventSeq !== 0 ||
          persisted.lastEventSeq !== 1 ||
          persisted.events.length !== publicEvents.length ||
          persisted.events.some(
            (event, index) =>
              JSON.stringify(event) !== JSON.stringify(publicEvents[index]),
          )
        ) {
          throw new SessionCreationInvariantError()
        }
        return Object.freeze({
          kind: 'created' as const,
          response: CreateSessionResponseSchema.parse({
            protocolVersion: 1,
            snapshot: finalSnapshot,
            warnings,
          }),
          newlyPersistedEvents: Object.freeze(publicEvents) as readonly [
            SseEvent,
            SseEvent,
          ],
        })
      })
      if (result.kind === 'created' && committedEventPublisher !== undefined) {
        try {
          committedEventPublisher.publish(result.newlyPersistedEvents)
        } catch {
          try {
            logPublishFailure?.({
              eventCount: result.newlyPersistedEvents.length,
              firstEventSeq: result.newlyPersistedEvents[0].eventSeq,
              lastEventSeq: result.newlyPersistedEvents.at(-1)!.eventSeq,
            })
          } catch {
            // 提交后诊断日志不改变创建结果。
          }
        }
      }
      return result
    },
  })
}
