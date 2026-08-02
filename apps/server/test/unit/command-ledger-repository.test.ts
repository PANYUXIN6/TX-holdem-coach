import type { TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import {
  completeCommand,
  failCommand,
  prepareCommandRegistration,
  registerCommand,
} from '../../src/persistence/command-ledger-repository.js'
import {
  CommandLedgerTransitionError,
  CommandPayloadConflictError,
  DatabaseOperationError,
  PersistenceDataCorruptionError,
  RepositoryInputValidationError,
  ResourceNotFoundError,
  UnknownPayloadVersionError,
} from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'

const sessionId = '22222222-2222-4222-8222-222222222222'
const commandId = '33333333-3333-4333-8333-333333333333'
const handId = '44444444-4444-4444-8444-444444444444'
const decisionRequestId = '55555555-5555-4555-8555-555555555555'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'

function command(
  type:
    'playerAction' | 'startNextHand' | 'rebuy' | 'endSession' | 'retryAgent',
) {
  const payload =
    type === 'playerAction'
      ? { action: { type: 'check' as const } }
      : type === 'rebuy'
        ? { amount: 2_000 }
        : {}
  return { sessionId, commandId, expectedStateVersion: 12, type, payload }
}

function aiActionCommand() {
  return {
    sessionId,
    commandId,
    expectedStateVersion: 12,
    type: 'aiAction' as const,
    payload: {
      decisionRequestId,
      handId,
      actorSeatNumber: 2,
      candidateActionId: 'candidate_2',
      action: { type: 'raise' as const, targetStreetCommitment: 120 },
    },
  }
}

function createTransactionMock(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  return ((template: TemplateStringsArray, ..._parameters: unknown[]) => {
    if (!('raw' in template)) {
      throw new Error('Unexpected helper call.')
    }
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
}

function createTrackedTransaction(responses: readonly unknown[]) {
  const pending = [...responses]
  let callCount = 0
  const transaction = ((
    template: TemplateStringsArray,
    ..._parameters: unknown[]
  ) => {
    if (!('raw' in template)) {
      throw new Error('Unexpected helper call.')
    }
    callCount += 1
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  return { transaction, getCallCount: () => callCount }
}

async function resolvedOwner() {
  const sql = (() =>
    Promise.resolve([{ databaseOwnerId }])) as unknown as Parameters<
    typeof resolveOwnerScope
  >[0]
  return resolveOwnerScope(sql, { ownerId: 'local-user' })
}

function snapshot(stateVersion = 13, eventSeq = 20) {
  return {
    protocolVersion: 1 as const,
    sessionId,
    stateVersion,
    eventSeq,
    pokerPhase: 'betweenHands' as const,
    lifecycleStatus: 'active' as const,
    agentRunState: 'idle' as const,
    activeDecision: null,
    seats: Array.from({ length: 6 }, (_, seatNumber) => ({
      seatNumber,
      playerId: `66666666-6666-4666-8666-${seatNumber.toString().padStart(12, '0')}`,
      displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
      avatarColor: '#0f766e',
      isUser: seatNumber === 0,
      stack: 2_000,
      status: 'active' as const,
    })),
    hand: null,
    lastCompletedHandSummary: null,
  }
}

function commandResponse(stateVersion = 13, eventSeq = 20) {
  return {
    protocolVersion: 1 as const,
    snapshot: snapshot(stateVersion, eventSeq),
  }
}

function errorResponse(withSnapshot = true) {
  return {
    protocolVersion: 1 as const,
    code: 'state_conflict',
    message: '场次状态已变化。',
    ...(withSnapshot ? { latestSnapshot: snapshot() } : {}),
  }
}

function ledgerRow(
  prepared: ReturnType<typeof prepareCommandRegistration>,
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    ledgerId: prepared.ledgerId,
    sessionId,
    commandId,
    canonicalPayloadDigest: prepared.canonicalPayloadDigest,
    processingStatus: 'processing',
    finalStateVersion: null,
    firstEventSeq: null,
    lastEventSeq: null,
    responsePayloadVersion: null,
    responsePayload: null,
    hasCompletedAt: false,
    ...overrides,
  }
}

describe('command ledger repository', () => {
  test('prepares all public commands and the private aiAction as frozen commands', () => {
    for (const type of [
      'playerAction',
      'startNextHand',
      'rebuy',
      'endSession',
      'retryAgent',
    ] as const) {
      const prepared = prepareCommandRegistration(command(type))
      expect(prepared.command.type).toBe(type)
      expect(Object.isFrozen(prepared)).toBe(true)
      expect(Object.isFrozen(prepared.command)).toBe(true)
      expect(Object.isFrozen(prepared.command.payload)).toBe(true)
      expect(prepared.ledgerId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      )
    }

    const preparedAiAction = prepareCommandRegistration(aiActionCommand())
    expect(preparedAiAction.command).toEqual(aiActionCommand())
    if (preparedAiAction.command.type !== 'aiAction') {
      throw new Error('Expected an aiAction command.')
    }
    expect(Object.isFrozen(preparedAiAction.command.payload.action)).toBe(true)
  })

  test('uses the fixed canonical SHA-256 golden vector', () => {
    const prepared = prepareCommandRegistration(command('rebuy'))

    expect(prepared.canonicalPayloadDigest).toBe(
      '7dd8ea4d4c87848ae817ca1c88d3563d6a16adbc6e2adad7f60ec012c232ddba',
    )
  })

  test('keeps the digest stable when input object keys use a different order', () => {
    const original = aiActionCommand()
    const reordered = {
      type: original.type,
      payload: {
        action: original.payload.action,
        candidateActionId: original.payload.candidateActionId,
        actorSeatNumber: original.payload.actorSeatNumber,
        handId: original.payload.handId,
        decisionRequestId: original.payload.decisionRequestId,
      },
      expectedStateVersion: original.expectedStateVersion,
      commandId: original.commandId,
      sessionId: original.sessionId,
    }

    expect(prepareCommandRegistration(reordered).canonicalPayloadDigest).toBe(
      prepareCommandRegistration(original).canonicalPayloadDigest,
    )
  })

  test('rejects unknown fields, invalid aiAction facts, and unsafe versions', () => {
    for (const invalid of [
      { ...command('endSession'), unexpected: true },
      {
        ...aiActionCommand(),
        payload: { ...aiActionCommand().payload, candidateActionId: '   ' },
      },
      {
        ...aiActionCommand(),
        payload: { ...aiActionCommand().payload, actorSeatNumber: 0 },
      },
      {
        ...command('retryAgent'),
        expectedStateVersion: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(() => prepareCommandRegistration(invalid)).toThrow(
        RepositoryInputValidationError,
      )
    }
  })

  test('consumes a prepared registration before the first database operation', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const owner = await resolvedOwner()
    const transaction = createTransactionMock([new Error('database failed')])

    await expect(
      registerCommand(transaction, owner, prepared),
    ).rejects.toBeDefined()
    await expect(
      registerCommand(transaction, owner, prepared),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
  })

  test('grants acquired only when the insert returns one row', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const result = await registerCommand(
      createTransactionMock([[{ ledgerId: prepared.ledgerId }]]),
      await resolvedOwner(),
      prepared,
    )

    expect(result).toMatchObject({
      status: 'acquired',
      ledgerId: prepared.ledgerId,
      sessionId,
      commandId,
      canonicalPayloadDigest: prepared.canonicalPayloadDigest,
    })
  })

  test('does not grant acquired when the candidate id equals the existing row id', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const response = commandResponse()
    const result = await registerCommand(
      createTransactionMock([
        [],
        [
          ledgerRow(prepared, {
            processingStatus: 'completed',
            finalStateVersion: response.snapshot.stateVersion,
            firstEventSeq: 19,
            lastEventSeq: response.snapshot.eventSeq,
            responsePayloadVersion: 1,
            responsePayload: response,
            hasCompletedAt: true,
          }),
        ],
      ]),
      await resolvedOwner(),
      prepared,
    )

    expect(result).toEqual({ status: 'completed', response })
    if (result.status !== 'completed') {
      throw new Error('Expected a completed replay.')
    }
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.response.snapshot)).toBe(true)
  })

  test('returns processing without a second capability for a same-transaction repeat', async () => {
    const first = prepareCommandRegistration(command('endSession'))
    const firstResult = await registerCommand(
      createTransactionMock([[{ ledgerId: first.ledgerId }]]),
      await resolvedOwner(),
      first,
    )
    const second = prepareCommandRegistration(command('endSession'))
    const secondResult = await registerCommand(
      createTransactionMock([[], [ledgerRow(second)]]),
      await resolvedOwner(),
      second,
    )

    expect(firstResult.status).toBe('acquired')
    expect(secondResult).toEqual({ status: 'processing' })
  })

  test('replays failed responses with and without a latest snapshot', async () => {
    for (const withSnapshot of [true, false]) {
      const prepared = prepareCommandRegistration(command('endSession'))
      const response = errorResponse(withSnapshot)
      const result = await registerCommand(
        createTransactionMock([
          [],
          [
            ledgerRow(prepared, {
              processingStatus: 'failed',
              finalStateVersion: withSnapshot ? 13 : null,
              responsePayloadVersion: 1,
              responsePayload: response,
              hasCompletedAt: true,
            }),
          ],
        ]),
        await resolvedOwner(),
        prepared,
      )

      expect(result).toEqual({ status: 'failed', response })
      expect(Object.isFrozen(result)).toBe(true)
    }
  })

  test('distinguishes payload conflicts, missing sessions, and database failures', async () => {
    const owner = await resolvedOwner()
    const conflict = prepareCommandRegistration(command('endSession'))
    await expect(
      registerCommand(
        createTransactionMock([
          [],
          [ledgerRow(conflict, { canonicalPayloadDigest: 'a'.repeat(64) })],
        ]),
        owner,
        conflict,
      ),
    ).rejects.toBeInstanceOf(CommandPayloadConflictError)

    const missing = prepareCommandRegistration(command('endSession'))
    await expect(
      registerCommand(createTransactionMock([[], []]), owner, missing),
    ).rejects.toBeInstanceOf(ResourceNotFoundError)

    const primaryKeyCollision = prepareCommandRegistration(
      command('endSession'),
    )
    await expect(
      registerCommand(
        createTransactionMock([new Error('duplicate primary key')]),
        owner,
        primaryKeyCollision,
      ),
    ).rejects.toBeInstanceOf(DatabaseOperationError)
  })

  test('distinguishes unknown response versions from corrupt terminal rows', async () => {
    const owner = await resolvedOwner()
    const unknownVersion = prepareCommandRegistration(command('endSession'))
    await expect(
      registerCommand(
        createTransactionMock([
          [],
          [
            ledgerRow(unknownVersion, {
              processingStatus: 'completed',
              finalStateVersion: 13,
              responsePayloadVersion: 2,
              responsePayload: commandResponse(),
              hasCompletedAt: true,
            }),
          ],
        ]),
        owner,
        unknownVersion,
      ),
    ).rejects.toMatchObject({
      payloadKind: 'commandResponse',
    } satisfies Partial<UnknownPayloadVersionError>)

    for (const overrides of [
      { processingStatus: 'processing', hasCompletedAt: true },
      {
        processingStatus: 'completed',
        finalStateVersion: 12,
        responsePayloadVersion: 1,
        responsePayload: commandResponse(),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: null,
        responsePayloadVersion: 1,
        responsePayload: errorResponse(true),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: Number.MAX_SAFE_INTEGER + 1,
        responsePayloadVersion: 1,
        responsePayload: commandResponse(Number.MAX_SAFE_INTEGER + 1),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: 13,
        responsePayloadVersion: 1,
        responsePayload: {
          ...errorResponse(false),
          latestSnapshot: snapshot(Number.MAX_SAFE_INTEGER + 1),
        },
        hasCompletedAt: true,
      },
    ]) {
      const prepared = prepareCommandRegistration(command('endSession'))
      await expect(
        registerCommand(
          createTransactionMock([[], [ledgerRow(prepared, overrides)]]),
          owner,
          prepared,
        ),
      ).rejects.toMatchObject({
        corruption: 'invalidCommandLedger',
      } satisfies Partial<PersistenceDataCorruptionError>)
    }
  })

  test('validates complete input before consuming acquired capability', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const acquired = await registerCommand(
      createTransactionMock([[{ ledgerId: prepared.ledgerId }]]),
      await resolvedOwner(),
      prepared,
    )
    if (acquired.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    const tracked = createTrackedTransaction([
      [{ ledgerId: acquired.ledgerId }],
    ])

    await expect(
      completeCommand(
        tracked.transaction,
        acquired,
        commandResponse(Number.MAX_SAFE_INTEGER + 1),
        null,
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(0)

    await expect(
      completeCommand(tracked.transaction, acquired, commandResponse(), {
        firstEventSeq: 19,
        lastEventSeq: 20,
      }),
    ).resolves.toBeUndefined()
    expect(tracked.getCallCount()).toBe(1)
  })

  test('validates failed snapshot input before consuming acquired capability', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const acquired = await registerCommand(
      createTransactionMock([[{ ledgerId: prepared.ledgerId }]]),
      await resolvedOwner(),
      prepared,
    )
    if (acquired.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    const tracked = createTrackedTransaction([
      [{ ledgerId: acquired.ledgerId }],
    ])
    const invalid = {
      ...errorResponse(false),
      latestSnapshot: snapshot(Number.MAX_SAFE_INTEGER + 1),
    }

    await expect(
      failCommand(tracked.transaction, acquired, invalid),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(0)
    await expect(
      failCommand(tracked.transaction, acquired, {
        ...errorResponse(false),
        latestSnapshot: {
          ...snapshot(),
          sessionId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(0)
    await expect(
      failCommand(tracked.transaction, acquired, errorResponse(false)),
    ).resolves.toBeUndefined()
    expect(tracked.getCallCount()).toBe(1)
  })

  test('rejects cross-session responses and invalid event ranges before SQL', async () => {
    for (const responseAndRange of [
      [
        {
          ...commandResponse(),
          snapshot: {
            ...commandResponse().snapshot,
            sessionId: '77777777-7777-4777-8777-777777777777',
          },
        },
        null,
      ],
      [commandResponse(), { firstEventSeq: 21, lastEventSeq: 20 }],
      [commandResponse(), { firstEventSeq: 19, lastEventSeq: 21 }],
    ] as const) {
      const prepared = prepareCommandRegistration(command('endSession'))
      const acquired = await registerCommand(
        createTransactionMock([[{ ledgerId: prepared.ledgerId }]]),
        await resolvedOwner(),
        prepared,
      )
      if (acquired.status !== 'acquired') {
        throw new Error('Expected an acquired registration.')
      }
      const tracked = createTrackedTransaction([])

      await expect(
        completeCommand(
          tracked.transaction,
          acquired,
          responseAndRange[0],
          responseAndRange[1],
        ),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      expect(tracked.getCallCount()).toBe(0)
    }
  })

  test('consumes acquired after terminal SQL is attempted', async () => {
    for (const terminalRows of [[], new Error('database failed')]) {
      const prepared = prepareCommandRegistration(command('endSession'))
      const acquired = await registerCommand(
        createTransactionMock([[{ ledgerId: prepared.ledgerId }]]),
        await resolvedOwner(),
        prepared,
      )
      if (acquired.status !== 'acquired') {
        throw new Error('Expected an acquired registration.')
      }

      const firstAttempt = completeCommand(
        createTransactionMock([terminalRows]),
        acquired,
        commandResponse(),
        null,
      )
      if (terminalRows instanceof Error) {
        await expect(firstAttempt).rejects.toBeInstanceOf(
          DatabaseOperationError,
        )
      } else {
        await expect(firstAttempt).rejects.toBeInstanceOf(
          CommandLedgerTransitionError,
        )
      }
      await expect(
        failCommand(
          createTransactionMock([[{ ledgerId: acquired.ledgerId }]]),
          acquired,
          errorResponse(false),
        ),
      ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    }
  })

  test('rejects every second or cross-terminal transition', async () => {
    const owner = await resolvedOwner()

    const completedPrepared = prepareCommandRegistration(command('endSession'))
    const completed = await registerCommand(
      createTransactionMock([[{ ledgerId: completedPrepared.ledgerId }]]),
      owner,
      completedPrepared,
    )
    if (completed.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    await completeCommand(
      createTransactionMock([[{ ledgerId: completed.ledgerId }]]),
      completed,
      commandResponse(),
      null,
    )
    await expect(
      completeCommand(
        createTransactionMock([]),
        completed,
        commandResponse(),
        null,
      ),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    await expect(
      failCommand(createTransactionMock([]), completed, errorResponse(false)),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)

    const failedPrepared = prepareCommandRegistration(command('endSession'))
    const failed = await registerCommand(
      createTransactionMock([[{ ledgerId: failedPrepared.ledgerId }]]),
      owner,
      failedPrepared,
    )
    if (failed.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    await failCommand(
      createTransactionMock([[{ ledgerId: failed.ledgerId }]]),
      failed,
      errorResponse(false),
    )
    await expect(
      failCommand(createTransactionMock([]), failed, errorResponse(false)),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    await expect(
      completeCommand(
        createTransactionMock([]),
        failed,
        commandResponse(),
        null,
      ),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
  })
})
