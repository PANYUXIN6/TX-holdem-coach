import { randomUUID } from 'node:crypto'
import type postgres from 'postgres'
import type { Sql } from 'postgres'
import { expect } from 'vitest'
import { applyPokerAction } from '../../src/poker/poker-engine.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeSnapshot } from '../../src/sessions/authoritative-state/snapshot-codec.js'
import { productionSessionMutationRepository as mutation } from '../../src/persistence/session-mutation-repository.js'
import {
  prepareCommandRegistration,
  registerCommand,
  completeCommand,
} from '../../src/persistence/command-ledger-repository.js'
import { completeHandAudit } from '../../src/persistence/hand-audit-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createCoachReadResource } from '../../src/persistence/coach-read-resource.js'
import { createCompletedHandReviewSourceRepository } from '../../src/persistence/completed-hand-review-repository.js'
import { createCoachRunReadRepository } from '../../src/persistence/agent-run-lifecycle-repository.js'
import { createAgentRunCoordinator } from '../../src/agents/foundation/agent-run-coordinator.js'
import {
  issueRuntimeCommitAuthority,
  isRuntimeCommitAuthority,
} from '../../src/agents/foundation/runtime-ports.js'
import { createCoachReviewSourceLoader } from '../../src/agents/coach/review-source-loader.js'
import { writeCoachPolicyDependencies } from '../../src/agents/coach/policy-versions.js'
import { fixtureCoachVersions } from '../fixtures/coach/completed-source.js'
import {
  createSessionFixture,
  readPrivateState,
  clearLocalOwnerSessions,
} from '../helpers/coach-session-fixture.js'
import { projectPublicSnapshot } from '../helpers/public-snapshot-fixture.js'
import {
  createDatabaseTestSqlForRole,
  runDatabaseTestWithCleanup,
} from './database-test-runtime.js'

/** One completed baseline, using production mutation, ledger and Hand writers, without a Coach Worker. */
export async function assertM82CoachReviewSource(
  sql: Sql,
  runtimeUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const dedicated = createDatabaseTestSqlForRole(runtimeUrl, 'm82-coach-read')
  let forced = false
  const resource = createCoachReadResource({
    databaseUrl: runtimeUrl,
    admissionTimeoutMs: 30_000,
    shutdownTimeoutMs: 5_000,
    onForcedClose: () => {
      forced = true
    },
    sqlFactory: ((_url, options) => {
      expect(options?.max).toBe(1)
      return dedicated
    }) as typeof postgres,
  })
  await runDatabaseTestWithCleanup(
    async () => {
      const owner = await resolveOwnerScope(sql, { ownerId: 'local-user' })
      const identity = await createSessionFixture(sql, 3)
      const reader = createCompletedHandReviewSourceRepository({
        owner,
        resource,
      })
      const budget = () => ({ signal, deadlineAt: Date.now() + 30_000 })
      expect(
        await reader.readCompletedSource(identity.handId, budget()),
      ).toEqual({ kind: 'notCompleted' })
      expect(await reader.readCompletedSource(randomUUID(), budget())).toEqual({
        kind: 'notFound',
      })
      await sql.begin(async (transaction) => {
        let state = await readPrivateState(transaction, identity.sessionId)
        while (state.poker.hand !== null) {
          const locked = await mutation.lockSessionForMutation(
            transaction,
            owner,
            identity.sessionId,
          )
          const command = prepareCommandRegistration({
            sessionId: identity.sessionId,
            commandId: randomUUID(),
            expectedStateVersion: state.stateVersion,
            type: 'playerAction',
            payload: { action: { type: 'fold' } },
          })
          const registration = await registerCommand(
            transaction,
            owner,
            command,
          )
          if (registration.status !== 'acquired')
            throw new Error('m82_command_not_acquired')
          const result = applyPokerAction(state.poker, {
            actorSeatNumber: state.poker.hand.currentActorSeatNumber!,
            action: { type: 'fold' },
          })
          const version = locked.stateVersion + 1
          const at = new Date().toISOString()
          state = createPrivateTableState({
            ...state,
            stateVersion: version,
            poker: result.state,
            completedHandCount:
              state.completedHandCount + (result.completedHand ? 1 : 0),
            lastCompletedHandSummary:
              result.completedHand?.summary ?? state.lastCompletedHandSummary,
          })
          const last = locked.nextEventSeq + result.eventDrafts.length - 1
          const projected = {
            ...locked,
            stateVersion: version,
            nextEventSeq: last + 1,
            currentHandId: result.completedHand ? null : identity.handId,
          }
          const snapshot = projectPublicSnapshot(state, projected, last)
          if (result.completedHand)
            await completeHandAudit(transaction, owner, {
              sessionId: identity.sessionId,
              handId: identity.handId,
              result: result.completedHand,
              completedAt: at,
            })
          await mutation.persistSessionMutation(transaction, locked, {
            finalStateVersion: version,
            lifecycleStatus: 'active',
            currentHandId: projected.currentHandId,
            agentRunState: 'idle',
            activePlayerRunId: null,
            activeDecisionRequestId: null,
            snapshot: encodeSnapshot(state),
            mutationAt: at,
            events: result.eventDrafts.map((event, index) => {
              const eventId = randomUUID(),
                eventSeq = locked.nextEventSeq + index
              return {
                eventId,
                eventSeq,
                handId: identity.handId,
                commandLedgerId: registration.ledgerId,
                stateVersionBefore: locked.stateVersion,
                stateVersionAfter: version,
                privateEvent:
                  mutation.currentPrivateEventProtocol.encodeCurrent(event),
                publicEvent: {
                  eventId,
                  sessionId: identity.sessionId,
                  eventSeq,
                  stateVersion: version,
                  type: event.type,
                  payload: { snapshot: { ...snapshot, eventSeq } },
                },
                createdAt: at,
              }
            }),
          })
          await completeCommand(
            transaction,
            registration,
            { snapshot },
            { firstEventSeq: locked.nextEventSeq, lastEventSeq: last },
          )
        }
      })
      const loaded = await reader.readCompletedSource(identity.handId, budget())
      expect(loaded.kind).toBe('completed')
      if (loaded.kind !== 'completed')
        throw new Error('m82_missing_completed_source')
      expect(
        loaded.facts.events.filter((event) => event.type === 'actionCommitted'),
      ).toHaveLength(5)
      const coordinator = createAgentRunCoordinator({
        sql,
        owner,
        eventPort: { publish: async () => undefined },
      })
      const runId = randomUUID()
      const now = await sql<
        { now: string }[]
      >`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`
      await sql.begin((tx) =>
        coordinator.createOrReuse(tx, {
          runtimeType: 'coach',
          agentRunId: runId,
          sessionId: identity.sessionId,
          handId: identity.handId,
          triggerType: 'hand_completed',
          idempotencyKey: `m82:${runId}`,
          supersedesRunId: null,
          dataDependencies: writeCoachPolicyDependencies(fixtureCoachVersions),
          createdAt: now[0]!.now,
        }),
      )
      const authenticate = createCoachRunReadRepository({ resource, owner })
      const queuedAuthority = issueRuntimeCommitAuthority({
        runtimeType: 'coach',
        runId,
        leaseOwner: 'm82',
        fencingToken: 1,
      })
      await expect(
        authenticate(
          queuedAuthority,
          identity.sessionId,
          identity.handId,
          budget(),
        ),
      ).rejects.toThrow()
      const claim = await coordinator.workerControl.claimNext({
        runtimeType: 'coach',
        leaseOwner: 'm82',
      })
      if (
        claim.kind !== 'claimed' ||
        !isRuntimeCommitAuthority(claim.authority, 'coach')
      )
        throw new Error('m82_run_not_claimed')
      const execution = await authenticate(
        claim.authority,
        identity.sessionId,
        identity.handId,
        budget(),
      )
      expect(execution.run.runId).toBe(runId)
      await expect(
        authenticate(
          claim.authority,
          identity.sessionId,
          randomUUID(),
          budget(),
        ),
      ).rejects.toThrow()
      for (const invalid of [
        issueRuntimeCommitAuthority({
          ...claim.authority,
          runId: randomUUID(),
        }),
        issueRuntimeCommitAuthority({
          ...claim.authority,
          leaseOwner: 'wrong-worker',
        }),
        issueRuntimeCommitAuthority({
          ...claim.authority,
          fencingToken: claim.authority.fencingToken + 1,
        }),
      ])
        await expect(
          authenticate(invalid, identity.sessionId, identity.handId, budget()),
        ).rejects.toThrow()
      const loader = createCoachReviewSourceLoader({
        owner,
        resource,
        supported: fixtureCoachVersions,
      })
      const ready = await loader({
        authority: claim.authority,
        sessionId: identity.sessionId,
        handId: identity.handId,
        ...budget(),
      })
      expect(ready.kind).toBe('ready')
      if (ready.kind !== 'ready') throw new Error('m82_source_not_ready')
      expect(ready.adapter.source.heroDecisions).toHaveLength(1)
      // Completed load has released its only connection; memory admission makes no source read.
      expect(
        await resource.read((tx) => tx`SELECT 1 AS ready`, budget()),
      ).toEqual([{ ready: 1 }])
      await sql`UPDATE app_private.hands SET completed_result_payload_version=999 WHERE id=${identity.handId}::uuid`
      try {
        await expect(
          reader.readCompletedSource(identity.handId, budget()),
        ).rejects.toThrow()
      } finally {
        await sql`UPDATE app_private.hands SET completed_result_payload_version=1 WHERE id=${identity.handId}::uuid`
      }
      const cancel = new AbortController()
      let queryEntered!: () => void
      const entered = new Promise<void>((resolve) => {
        queryEntered = resolve
      })
      const pending = resource.read(
        (tx) => {
          queryEntered()
          return tx`SELECT pg_sleep(5)`
        },
        { signal: cancel.signal, deadlineAt: Date.now() + 10_000 },
      )
      const cancelled = expect(pending).rejects.toThrow()
      await entered
      // The gameplay fixture connection remains usable while Coach owns its separate connection.
      expect(await sql`SELECT 1 AS ready`).toEqual([{ ready: 1 }])
      cancel.abort()
      await cancelled
      expect(
        await resource.read((tx) => tx`SELECT 1 AS ready`, budget()),
      ).toEqual([{ ready: 1 }])
      // A delete in flight cannot splice roster/events out of the single-statement old view.
      await sql.begin(async (tx) => {
        await tx`DELETE FROM app_private.sessions WHERE id=${identity.sessionId}::uuid`
        const oldView = await reader.readCompletedSource(
          identity.handId,
          budget(),
        )
        expect(oldView).toEqual(loaded)
      })
      expect(
        await reader.readCompletedSource(identity.handId, budget()),
      ).toEqual({ kind: 'notFound' })
      // The completed snapshot remains usable without another DB read after deletion.
      expect(ready.adapter.readHindsightSource().heroDecisions).toEqual(
        ready.adapter.source.heroDecisions,
      )
      ready.adapter.release()
      expect(ready.adapter.readHindsightSource).toThrow()
      expect(forced).toBe(false)
    },
    async () => {
      await resource.close()
      await clearLocalOwnerSessions(sql)
    },
  )
}
