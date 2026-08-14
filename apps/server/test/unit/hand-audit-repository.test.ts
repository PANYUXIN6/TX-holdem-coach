import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import {
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import { POKER_RULE_SET_VERSION } from '../../src/poker/poker-rule-set.js'
import {
  abortHandAudit,
  completeHandAudit,
  insertInProgressHandAudit,
  readHandAudit,
} from '../../src/persistence/hand-audit-repository.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import {
  HandAuditTransitionError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
} from '../../src/persistence/errors.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import { encodeHandStartCheckpointV1 } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec-v1.js'
import { encodeHandStartCheckpointV2 } from '../../src/sessions/hand-audit/hand-start-checkpoint-codec-v2.js'
import { encodeCompletedHandResultV1 } from '../../src/sessions/hand-audit/completed-hand-result-codec-v1.js'
import { createTestCompletedPokerResult } from '../poker/create-test-completed-poker-result.js'

const sessionId = '22222222-2222-4222-8222-222222222222'
const handId = '10000000-0000-4000-8000-000000000001'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const playerRunId = '77777777-7777-4777-8777-777777777777'
const startedAt = '2026-08-04T12:00:00.000Z'
const randomSource = Object.freeze({ nextInt: () => 0 })

function createCheckpoint() {
  const poker = initializePokerTable(
    Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `00000000-0000-4000-8000-${(seatNumber + 1)
        .toString()
        .padStart(12, '0')}`,
      isUser: seatNumber === 0,
      stack: 1_000,
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    randomSource,
  )
  return {
    stateBeforeStartCommand: createPrivateTableState({
      stateVersion: 7,
      poker,
      completedHandCount: 0,
      seatAccounting: poker.seats.map((seat) => ({
        seatNumber: seat.seatNumber,
        cumulativeBuyIn: 1_000,
      })),
      lastCompletedHandSummary: null,
    }),
    startedHand: startPokerHand(poker, {
      handId,
      completedHandCountBeforeStart: 0,
      randomSource,
    }).startedHand,
  }
}

function createCurrentCheckpoint() {
  return {
    pokerRuleSetVersion: POKER_RULE_SET_VERSION,
    ...createCheckpoint(),
  }
}

function createTransactionMock(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  const transaction = ((template: TemplateStringsArray) => {
    if (!('raw' in template)) throw new Error('Unexpected helper call.')
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
    typed: (value: string) => JSON.parse(value) as unknown,
  })
  return transaction
}

async function resolvedOwner() {
  const sql = (() => Promise.resolve([{ databaseOwnerId }])) as unknown as Sql
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function inProgressRow(options: { readonly current?: boolean } = {}) {
  const checkpoint = options.current
    ? encodeHandStartCheckpointV2(createCurrentCheckpoint())
    : encodeHandStartCheckpointV1(createCheckpoint())
  return {
    handId,
    sessionId,
    handNumber: 1,
    status: 'inProgress' as const,
    checkpointPayloadVersion: checkpoint.payloadVersion,
    checkpointPayload: checkpoint.payload,
    completedResultPayloadVersion: null,
    completedResultPayload: null,
    abortReasonCode: null,
    failedAgentRunId: null,
    buttonSeatNumber:
      checkpoint.payload.checkpoint.startedHand.buttonSeatNumber,
    participantSeatNumbers:
      checkpoint.payload.checkpoint.startedHand.participantSeatNumbers,
    startedAt: '2026-08-04T12:00:00.000000Z',
    completedAt: null,
    abortedAt: null,
    updatedAt: '2026-08-04T12:00:00.000000Z',
    abortedRunRuntime: null,
    abortedRunOwnerId: null,
    abortedRunSessionId: null,
    abortedRunHandId: null,
  }
}

function createShowdownResultWithDisplayName(displayName: string) {
  const result = createTestCompletedPokerResult().completedHand
  const evaluatedSeatNumber = result.pots[0]!.eligibleSeatNumbers[0]!
  const board = result.remainingDeck.slice(0, 5)
  const evaluation = {
    category: 'highCard' as const,
    comparisonGrade: [0, 14, 13, 12, 11, 9] as const,
    bestFive: [board[0]!, board[1]!, board[2]!, board[3]!, board[4]!] as const,
    displayName,
  }
  const participantHands = result.participantHands.map((hand) =>
    hand.seatNumber === evaluatedSeatNumber
      ? { ...hand, handEvaluation: evaluation }
      : hand,
  )

  return {
    ...result,
    terminationReason: 'showdown' as const,
    remainingDeck: result.remainingDeck.slice(5),
    board,
    handEvaluations: [{ seatNumber: evaluatedSeatNumber, evaluation }],
    participantHands,
    summary: {
      ...result.summary,
      terminationReason: 'showdown' as const,
      board,
      participantHands,
    },
  }
}

describe('hand audit repository', () => {
  test('inserts one current in-progress checkpoint and returns its derived identity', async () => {
    const transaction = createTransactionMock([[{ handId, handNumber: 1 }]])

    await expect(
      insertInProgressHandAudit(transaction, await resolvedOwner(), {
        sessionId,
        checkpoint: createCurrentCheckpoint(),
        startedAt,
      }),
    ).resolves.toEqual({ handId, handNumber: 1 })
  })

  test('reports an owner-scoped missing parent Session without relying on a foreign-key failure', async () => {
    const transaction = createTransactionMock([[]])

    await expect(
      insertInProgressHandAudit(transaction, await resolvedOwner(), {
        sessionId,
        checkpoint: createCurrentCheckpoint(),
        startedAt,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)
  })

  test('reads one owner-scoped in-progress hand through the current V2 checkpoint registry', async () => {
    const checkpoint = encodeHandStartCheckpointV2(createCurrentCheckpoint())
    const transaction = createTransactionMock([
      [inProgressRow({ current: true })],
    ])

    const audit = await readHandAudit(
      transaction,
      await resolvedOwner(),
      sessionId,
      handId,
    )

    expect(audit).toEqual({
      ownerId: 'local-user',
      sessionId,
      handId,
      handNumber: 1,
      status: 'inProgress',
      buttonSeatNumber:
        checkpoint.payload.checkpoint.startedHand.buttonSeatNumber,
      participantSeatNumbers:
        checkpoint.payload.checkpoint.startedHand.participantSeatNumbers,
      startedAt: '2026-08-04T12:00:00.000000Z',
      completedAt: null,
      abortedAt: null,
      updatedAt: '2026-08-04T12:00:00.000000Z',
      checkpoint: checkpoint.payload.checkpoint,
      result: null,
      abortReasonCode: null,
      failedAgentRunId: null,
    })
    expect(Object.isFrozen(audit)).toBe(true)
    expect(Object.isFrozen(audit.checkpoint.startedHand)).toBe(true)
  })

  test('completes one locked in-progress hand after checkpoint-result mirror validation', async () => {
    const result = createTestCompletedPokerResult().completedHand
    const transaction = createTransactionMock([[inProgressRow()], [{ handId }]])

    const audit = await completeHandAudit(transaction, await resolvedOwner(), {
      sessionId,
      handId,
      result,
      completedAt: '2026-08-04T12:05:00.000Z',
    })

    expect(audit).toMatchObject({
      ownerId: 'local-user',
      sessionId,
      handId,
      status: 'completed',
      result,
      completedAt: '2026-08-04T12:05:00.000000Z',
      updatedAt: '2026-08-04T12:05:00.000000Z',
      abortReasonCode: null,
      failedAgentRunId: null,
      abortedAt: null,
    })
    expect(Object.isFrozen(audit.result)).toBe(true)
  })

  test('aborts one locked hand only for a structurally matching Player Run', async () => {
    const transaction = createTransactionMock([
      [inProgressRow()],
      [
        {
          agentRunId: playerRunId,
          sessionId,
          handId,
          runtime: 'player',
        },
      ],
      [{ handId }],
    ])

    const audit = await abortHandAudit(transaction, await resolvedOwner(), {
      sessionId,
      handId,
      failedAgentRunId: playerRunId,
      reasonCode: 'provider_timeout',
      abortedAt: '2026-08-04T12:03:00.000Z',
    })

    expect(audit).toMatchObject({
      status: 'aborted',
      result: null,
      completedAt: null,
      abortReasonCode: 'provider_timeout',
      failedAgentRunId: playerRunId,
      abortedAt: '2026-08-04T12:03:00.000000Z',
      updatedAt: '2026-08-04T12:03:00.000000Z',
    })
    expect(audit.checkpoint.stateBeforeStartCommand.stateVersion).toBe(7)
    expect(audit.checkpoint.pokerRuleSetVersion).toBe(POKER_RULE_SET_VERSION)
  })

  test('reads an aborted hand only when the referenced Run mirrors Player ownership and identity', async () => {
    const transaction = createTransactionMock([
      [
        {
          ...inProgressRow(),
          status: 'aborted',
          abortReasonCode: 'provider_timeout',
          failedAgentRunId: playerRunId,
          abortedAt: '2026-08-04T12:03:00.000000Z',
          updatedAt: '2026-08-04T12:03:00.000000Z',
          abortedRunRuntime: 'player',
          abortedRunOwnerId: databaseOwnerId,
          abortedRunSessionId: sessionId,
          abortedRunHandId: handId,
        },
      ],
    ])

    await expect(
      readHandAudit(transaction, await resolvedOwner(), sessionId, handId),
    ).resolves.toMatchObject({
      status: 'aborted',
      failedAgentRunId: playerRunId,
      abortReasonCode: 'provider_timeout',
    })
  })

  test('rejects a Coach Run as an abort cause', async () => {
    const transaction = createTransactionMock([
      [inProgressRow()],
      [
        {
          agentRunId: playerRunId,
          sessionId,
          handId,
          runtime: 'coach',
        },
      ],
    ])

    await expect(
      abortHandAudit(transaction, await resolvedOwner(), {
        sessionId,
        handId,
        failedAgentRunId: playerRunId,
        reasonCode: 'provider_timeout',
        abortedAt: '2026-08-04T12:03:00.000Z',
      }),
    ).rejects.toBeInstanceOf(HandAuditTransitionError)
  })

  test('rejects forbidden checkpoint fields before issuing modifying SQL', async () => {
    const checkpoint = createCheckpoint()
    const transaction = createTransactionMock([
      new Error('modifying SQL must not run'),
    ])

    await expect(
      insertInProgressHandAudit(transaction, await resolvedOwner(), {
        sessionId,
        checkpoint: {
          ...checkpoint,
          reasoning_content: 'SECRET_SENTINEL_M27',
        } as never,
        startedAt,
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })

  test('rejects an unapproved evaluation display string before issuing completion SQL', async () => {
    const transaction = createTransactionMock([
      new Error('modifying SQL must not run'),
    ])

    await expect(
      completeHandAudit(transaction, await resolvedOwner(), {
        sessionId,
        handId,
        result: createShowdownResultWithDisplayName('SECRET_SENTINEL_M27'),
        completedAt: '2026-08-04T12:05:00.000Z',
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })

  test('rejects a stored completed result whose starting stacks do not mirror its checkpoint', async () => {
    const checkpointInput = createCheckpoint()
    const checkpoint = encodeHandStartCheckpointV1({
      ...checkpointInput,
      startedHand: {
        ...checkpointInput.startedHand,
        startingStacks: checkpointInput.startedHand.startingStacks.map(
          (stack) =>
            stack.seatNumber === 0 ? { ...stack, stack: 1_200 } : stack,
        ),
      },
    })
    const completed = encodeCompletedHandResultV1(
      createTestCompletedPokerResult().completedHand,
    )
    const transaction = createTransactionMock([
      [
        {
          ...inProgressRow(),
          status: 'completed',
          checkpointPayloadVersion: checkpoint.payloadVersion,
          checkpointPayload: checkpoint.payload,
          completedResultPayloadVersion: completed.payloadVersion,
          completedResultPayload: completed.payload,
          completedAt: '2026-08-04T12:05:00.000000Z',
          updatedAt: '2026-08-04T12:05:00.000000Z',
        },
      ],
    ])

    await expect(
      readHandAudit(transaction, await resolvedOwner(), sessionId, handId),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })
})
