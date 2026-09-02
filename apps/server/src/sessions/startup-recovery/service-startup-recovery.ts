import { SseEventSchema, type SseEvent } from '@tx-holdem-coach/contracts'
import { z } from 'zod'
import { runDatabaseTransaction } from '../../persistence/database-transaction.js'
import { ResourceNotFoundError } from '../../persistence/errors.js'
import type { ResolvedOwnerScope } from '../../persistence/owner-scope.js'
import type { SessionRecoveryRepository } from '../../persistence/session-recovery-repository.js'
import type { CommittedSessionEventPublisher } from '../public-projection/committed-session-event-hub.js'
import type {
  PlayerProcessRestartRecoveryCompositionPort,
  PlayerProcessRestartRecoveryResult,
} from '../../agents/player/session-agent-coordinator.js'
import type { StartupRecoveryCandidateReader } from '../../agents/player/player-turn-dispatcher.js'
import { PlayerRestartRecoveryContractError } from './errors.js'

const CanonicalTimestampSchema = z.iso.datetime({ precision: 3 })
const RestartResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('unchanged') }),
  z.strictObject({ kind: z.literal('paused') }),
  z.strictObject({
    kind: z.literal('reconciledWithoutReplacement'),
    newlyPersistedEvents: z.array(SseEventSchema),
  }),
  z.strictObject({
    kind: z.literal('replacementQueued'),
    replacementRunId: z.uuid(),
    newlyPersistedEvents: z.tuple([SseEventSchema]).rest(SseEventSchema),
  }),
])

export interface StartupCommittedEffects {
  readonly replacementRunIds: readonly string[]
}

export interface ServiceStartupRecovery {
  recoverAtStartup(): Promise<StartupCommittedEffects>
}

function validateRestartResult(input: {
  readonly value: PlayerProcessRestartRecoveryResult
  readonly sessionId: string
  readonly nextEventSeq: number
}): PlayerProcessRestartRecoveryResult {
  const parsed = RestartResultSchema.safeParse(input.value)
  if (!parsed.success) throw new PlayerRestartRecoveryContractError()
  const result = parsed.data
  if (
    result.kind === 'unchanged' ||
    result.kind === 'paused' ||
    result.kind === 'reconciledWithoutReplacement'
  ) {
    if (
      result.kind !== 'reconciledWithoutReplacement' &&
      'newlyPersistedEvents' in result
    ) {
      throw new PlayerRestartRecoveryContractError()
    }
  }
  const events =
    result.kind === 'reconciledWithoutReplacement' ||
    result.kind === 'replacementQueued'
      ? result.newlyPersistedEvents
      : []
  const eventIds = new Set<string>()
  for (const [index, event] of events.entries()) {
    if (
      event.sessionId !== input.sessionId ||
      event.eventSeq !== input.nextEventSeq + index ||
      eventIds.has(event.eventId)
    ) {
      throw new PlayerRestartRecoveryContractError()
    }
    eventIds.add(event.eventId)
  }
  return result as PlayerProcessRestartRecoveryResult
}

/**
 * 将 M2.6 的权威恢复与 M4.8 的 Player 重启策略按单场短事务组合。
 * 所有发布与唤醒仍只发生在事务提交后。
 */
export function createServiceStartupRecovery(input: {
  readonly candidateReader: StartupRecoveryCandidateReader
  readonly sql: Parameters<typeof runDatabaseTransaction>[0]
  readonly owner: ResolvedOwnerScope
  readonly recoveryRepository: SessionRecoveryRepository
  readonly playerRestartRecovery: PlayerProcessRestartRecoveryCompositionPort
  readonly committedEventPublisher: CommittedSessionEventPublisher
  readonly now?: () => string
  readonly onDiagnostic?: (input: {
    readonly category:
      | 'startup_committed_event_publish_failed'
      | 'startup_restart_run_event_publish_failed'
  }) => void
}): ServiceStartupRecovery {
  const now = input.now ?? (() => new Date().toISOString())
  if (
    typeof input.candidateReader.listActiveSessionIds !== 'function' ||
    typeof input.recoveryRepository.recoverSessionForMutation !== 'function' ||
    typeof input.playerRestartRecovery.recoverAfterProcessRestartWithEffects !==
      'function' ||
    typeof input.playerRestartRecovery.publishCommittedRestartRunEffects !==
      'function'
  ) {
    throw new TypeError('服务启动恢复依赖无效。')
  }

  function diagnose(
    category:
      | 'startup_committed_event_publish_failed'
      | 'startup_restart_run_event_publish_failed',
  ): void {
    try {
      input.onDiagnostic?.({ category })
    } catch {
      // Diagnostics never turn a committed recovery transaction into a failure.
    }
  }

  return Object.freeze({
    async recoverAtStartup() {
      const recoveryAt = now()
      if (!CanonicalTimestampSchema.safeParse(recoveryAt).success) {
        throw new TypeError('启动恢复时间戳无效。')
      }
      const sessionIds = await input.candidateReader.listActiveSessionIds()
      const parsedSessionIds = z.array(z.uuid()).safeParse(sessionIds)
      if (
        !parsedSessionIds.success ||
        new Set(parsedSessionIds.data).size !== parsedSessionIds.data.length ||
        parsedSessionIds.data.some(
          (sessionId, index) =>
            index > 0 &&
            parsedSessionIds.data[index - 1]!.localeCompare(sessionId) >= 0,
        )
      ) {
        throw new PlayerRestartRecoveryContractError()
      }
      const replacementRunIds: string[] = []
      for (const sessionId of parsedSessionIds.data) {
        let committed:
          | {
              readonly events: readonly SseEvent[]
              readonly replacementRunId: string | null
              readonly runEffects: Parameters<
                PlayerProcessRestartRecoveryCompositionPort['publishCommittedRestartRunEffects']
              >[0]
            }
          | undefined
        try {
          committed = await runDatabaseTransaction(
            input.sql,
            async (transaction) => {
              const recovered =
                await input.recoveryRepository.recoverSessionForMutation(
                  transaction,
                  input.owner,
                  sessionId,
                  recoveryAt,
                )
              if (recovered.kind !== 'ready') {
                return Object.freeze({
                  events: Object.freeze([]) as readonly SseEvent[],
                  replacementRunId: null,
                  runEffects: Object.freeze([]),
                })
              }
              const transactionResult =
                await input.playerRestartRecovery.recoverAfterProcessRestartWithEffects(
                  transaction,
                  {
                    owner: input.owner,
                    recovery: recovered,
                    recoveryAt,
                  },
                )
              const result = validateRestartResult({
                value: transactionResult.recovery,
                sessionId: recovered.locked.sessionId,
                nextEventSeq: recovered.locked.nextEventSeq,
              })
              const events =
                result.kind === 'reconciledWithoutReplacement' ||
                result.kind === 'replacementQueued'
                  ? result.newlyPersistedEvents
                  : []
              return Object.freeze({
                events: Object.freeze([...events]),
                replacementRunId:
                  result.kind === 'replacementQueued'
                    ? result.replacementRunId
                    : null,
                runEffects: transactionResult.runEffects,
              })
            },
          )
        } catch (error) {
          if (error instanceof ResourceNotFoundError) continue
          throw error
        }
        if (committed.events.length !== 0) {
          try {
            input.committedEventPublisher.publish(
              committed.events as [SseEvent, ...SseEvent[]],
            )
          } catch {
            diagnose('startup_committed_event_publish_failed')
          }
        }
        if (committed.runEffects.length !== 0) {
          try {
            await input.playerRestartRecovery.publishCommittedRestartRunEffects(
              committed.runEffects,
            )
          } catch {
            diagnose('startup_restart_run_event_publish_failed')
          }
        }
        if (committed.replacementRunId !== null) {
          replacementRunIds.push(committed.replacementRunId)
        }
      }
      return Object.freeze({
        replacementRunIds: Object.freeze(replacementRunIds),
      })
    },
  })
}
