import {
  ClearDataRequestSchema,
  ClearDataResponseSchema,
  DeleteSessionRequestSchema,
  DeleteSessionResponseSchema,
  SessionIdSchema,
  type ClearDataResponse,
  type DeleteSessionResponse,
} from '@tx-holdem-coach/contracts'
import type { Sql } from 'postgres'
import {
  clearOwnerSessionData,
  deleteEndedSessionData,
  type InvalidatedAgentRunReference,
} from '../persistence/session-deletion-repository.js'
import type { ResolvedOwnerScope } from '../persistence/owner-scope.js'
import {
  DatabaseOperationError,
  isRepositoryDomainError,
} from '../persistence/errors.js'

export interface AgentRunInterruptPort {
  interrupt(run: InvalidatedAgentRunReference): Promise<void>
}

export interface SessionDataDeletionService {
  deleteEndedSession(
    sessionId: string,
    request: unknown,
  ): Promise<DeleteSessionResponse>
  clearAll(request: unknown): Promise<ClearDataResponse>
}

export function createSessionDataDeletionService(input: {
  readonly sql: Sql
  readonly owner: ResolvedOwnerScope
  readonly interrupt?: AgentRunInterruptPort
  readonly now?: () => string
  readonly logInterruptFailure?: (count: number) => void
}): SessionDataDeletionService {
  const { sql, owner } = input
  const now = input.now ?? (() => new Date().toISOString())
  const interrupt = input.interrupt ?? { interrupt: async () => undefined }

  const interruptCommittedRuns = async (
    runs: readonly InvalidatedAgentRunReference[],
  ): Promise<void> => {
    const results = await Promise.allSettled(
      runs.map((run) => Promise.resolve().then(() => interrupt.interrupt(run))),
    )
    const failureCount = results.filter(
      (result) => result.status === 'rejected',
    ).length
    if (failureCount > 0) {
      try {
        input.logInterruptFailure?.(failureCount)
      } catch {
        // A diagnostic sink cannot change an already committed deletion.
      }
    }
  }

  return Object.freeze({
    async deleteEndedSession(
      sessionId: string,
      request: unknown,
    ): Promise<DeleteSessionResponse> {
      const parsedSessionId = SessionIdSchema.parse(sessionId)
      DeleteSessionRequestSchema.parse(request)
      let result
      try {
        result = await sql.begin((transaction) =>
          deleteEndedSessionData(transaction, owner, {
            sessionId: parsedSessionId,
            deletedAt: now(),
          }),
        )
      } catch (error) {
        if (isRepositoryDomainError(error)) throw error
        throw new DatabaseOperationError()
      }
      await interruptCommittedRuns(result.invalidatedRuns)
      return DeleteSessionResponseSchema.parse({
        deletedSessionId: result.sessionId,
        invalidatedRunCount: result.invalidatedRuns.length,
      })
    },
    async clearAll(request: unknown): Promise<ClearDataResponse> {
      ClearDataRequestSchema.parse(request)
      let result
      try {
        result = await sql.begin((transaction) =>
          clearOwnerSessionData(transaction, owner, { deletedAt: now() }),
        )
      } catch (error) {
        if (isRepositoryDomainError(error)) throw error
        throw new DatabaseOperationError()
      }
      await interruptCommittedRuns(result.invalidatedRuns)
      return ClearDataResponseSchema.parse({
        deletedSessionCount: result.deletedSessionCount,
        invalidatedRunCount: result.invalidatedRuns.length,
      })
    },
  })
}
