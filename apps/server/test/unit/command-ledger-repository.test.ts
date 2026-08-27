import type { TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import {
  completeCommand,
  failCommand,
  prepareCommandRegistration,
  readExistingCommandResult,
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
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const uppercaseIds = {
  sessionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  commandId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
} as const

function command(
  type: 'playerAction' | 'startNextHand' | 'rebuy' | 'endSession',
) {
  const payload =
    type === 'playerAction'
      ? { action: { type: 'check' as const } }
      : type === 'rebuy'
        ? { amount: 2_000 }
        : {}
  return { sessionId, commandId, expectedStateVersion: 12, type, payload }
}

function createTransactionMock(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  const transaction = ((
    template: TemplateStringsArray,
    ..._parameters: unknown[]
  ) => {
    if (!('raw' in template)) {
      throw new Error('Unexpected helper call.')
    }
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
  })
  return transaction
}

function createTrackedTransaction(responses: readonly unknown[]) {
  const pending = [...responses]
  let callCount = 0
  const parameterLists: unknown[][] = []
  const transaction = ((
    template: TemplateStringsArray,
    ...parameters: unknown[]
  ) => {
    if (!('raw' in template)) {
      throw new Error('Unexpected helper call.')
    }
    callCount += 1
    parameterLists.push(parameters)
    const response = pending.shift()
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, {
    json: (value: unknown) => value,
  })
  return {
    transaction,
    getCallCount: () => callCount,
    getParameterLists: () => parameterLists,
  }
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
    snapshot: snapshot(stateVersion, eventSeq),
  }
}

function eventRange() {
  return { firstEventSeq: 19, lastEventSeq: 20 }
}

function errorResponse() {
  return {
    code: 'state_conflict',
    message: '场次状态已变化。',
    latestSnapshot: snapshot(),
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
  test('reads ended-session ledger outcomes without inserting or granting capability', async () => {
    const owner = await resolvedOwner()
    const cases = [
      { rows: [], expected: { status: 'notFound' } },
      {
        rows: (prepared: ReturnType<typeof prepareCommandRegistration>) => [
          ledgerRow(prepared, {
            processingStatus: 'completed',
            finalStateVersion: 13,
            firstEventSeq: 19,
            lastEventSeq: 20,
            responsePayloadVersion: 1,
            responsePayload: commandResponse(),
            hasCompletedAt: true,
          }),
        ],
        expected: { status: 'completed', response: commandResponse() },
      },
      {
        rows: (prepared: ReturnType<typeof prepareCommandRegistration>) => [
          ledgerRow(prepared, {
            processingStatus: 'failed',
            finalStateVersion: 13,
            responsePayloadVersion: 1,
            responsePayload: errorResponse(),
            hasCompletedAt: true,
          }),
        ],
        expected: { status: 'failed', response: errorResponse() },
      },
    ] as const

    for (const entry of cases) {
      const prepared = prepareCommandRegistration(command('endSession'))
      const rows =
        typeof entry.rows === 'function' ? entry.rows(prepared) : entry.rows
      const tracked = createTrackedTransaction([rows])
      await expect(
        readExistingCommandResult(tracked.transaction, owner, prepared),
      ).resolves.toEqual(entry.expected)
      expect(tracked.getCallCount()).toBe(1)
    }
  })

  test('rejects a visible processing row as persistence corruption', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    await expect(
      readExistingCommandResult(
        createTransactionMock([[ledgerRow(prepared)]]),
        await resolvedOwner(),
        prepared,
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })

  test('prepares all commands as frozen commands', () => {
    for (const type of [
      'playerAction',
      'startNextHand',
      'rebuy',
      'endSession',
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
  })

  test('uses the fixed canonical SHA-256 golden vector', () => {
    const prepared = prepareCommandRegistration(command('rebuy'))

    expect(prepared.canonicalPayloadDigest).toBe(
      '7dd8ea4d4c87848ae817ca1c88d3563d6a16adbc6e2adad7f60ec012c232ddba',
    )
  })

  test('keeps the digest stable when input object keys use a different order', () => {
    const original = command('rebuy')
    const reordered = {
      type: original.type,
      payload: original.payload,
      expectedStateVersion: original.expectedStateVersion,
      commandId: original.commandId,
      sessionId: original.sessionId,
    }

    expect(prepareCommandRegistration(reordered).canonicalPayloadDigest).toBe(
      prepareCommandRegistration(original).canonicalPayloadDigest,
    )
  })

  test('hashes every semantic field but excludes ledger location keys', () => {
    const digest = (input: unknown) =>
      prepareCommandRegistration(input).canonicalPayloadDigest
    const pairs: readonly (readonly [unknown, unknown])[] = [
      [command('endSession'), command('startNextHand')],
      [
        command('endSession'),
        { ...command('endSession'), expectedStateVersion: 13 },
      ],
      [command('rebuy'), { ...command('rebuy'), payload: { amount: 2_001 } }],
      [
        command('playerAction'),
        {
          ...command('playerAction'),
          payload: { action: { type: 'fold' as const } },
        },
      ],
    ]

    for (const [left, right] of pairs) {
      expect(digest(left)).not.toBe(digest(right))
    }
    expect(digest(command('endSession'))).toBe(
      digest({
        ...command('endSession'),
        sessionId: '77777777-7777-4777-8777-777777777777',
        commandId: '88888888-8888-4888-8888-888888888888',
      }),
    )
  })

  test('validates then normalizes command UUID fields before hashing', () => {
    const uppercase = {
      ...command('endSession'),
      sessionId: uppercaseIds.sessionId,
      commandId: uppercaseIds.commandId,
    }
    const lowercase = {
      ...uppercase,
      sessionId: uppercase.sessionId.toLowerCase(),
      commandId: uppercase.commandId.toLowerCase(),
    }

    const preparedUppercase = prepareCommandRegistration(uppercase)
    const preparedLowercase = prepareCommandRegistration(lowercase)
    expect(preparedUppercase.command).toEqual(lowercase)
    expect(preparedUppercase.canonicalPayloadDigest).toBe(
      preparedLowercase.canonicalPayloadDigest,
    )
  })

  test('rejects invalid UUID fields and unsafe versions', () => {
    for (const invalid of [
      { ...command('endSession'), sessionId: 'not-a-uuid' },
      { ...command('endSession'), commandId: 'not-a-uuid' },
      {
        ...command('endSession'),
        expectedStateVersion: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(() => prepareCommandRegistration(invalid)).toThrow(
        RepositoryInputValidationError,
      )
    }
  })

  test('keeps aiAction outside the public command registration boundary', () => {
    expect(() =>
      prepareCommandRegistration({
        sessionId,
        commandId,
        expectedStateVersion: 12,
        type: 'aiAction',
        payload: {
          decisionRequestId: '50000000-0000-4000-8000-000000000001',
          handId: '10000000-0000-4000-8000-000000000001',
          actorSeatNumber: 1,
          candidateActionId: 'candidate-fold',
          action: { type: 'fold' },
        },
      }),
    ).toThrow(RepositoryInputValidationError)
  })

  test('replays the original uppercase response using normalized UUID equality', async () => {
    const input = {
      ...command('endSession'),
      sessionId: uppercaseIds.sessionId,
      commandId: uppercaseIds.commandId,
    }
    const prepared = prepareCommandRegistration(input)
    const response = {
      ...commandResponse(),
      snapshot: {
        ...commandResponse().snapshot,
        sessionId: uppercaseIds.sessionId,
      },
    }
    const result = await registerCommand(
      createTransactionMock([
        [],
        [
          ledgerRow(prepared, {
            sessionId: uppercaseIds.sessionId.toLowerCase(),
            commandId: uppercaseIds.commandId.toLowerCase(),
            processingStatus: 'completed',
            finalStateVersion: response.snapshot.stateVersion,
            ...eventRange(),
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
  })

  test('rejects unknown fields and unsafe versions', () => {
    for (const invalid of [
      { ...command('endSession'), unexpected: true },
      {
        ...command('endSession'),
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

  test('consumes prepared after not-found, conflict, corruption, or SQL failure', async () => {
    const owner = await resolvedOwner()
    for (const createResponses of [
      (_prepared: ReturnType<typeof prepareCommandRegistration>) => [[], []],
      (prepared: ReturnType<typeof prepareCommandRegistration>) => [
        [],
        [ledgerRow(prepared, { canonicalPayloadDigest: 'a'.repeat(64) })],
      ],
      (prepared: ReturnType<typeof prepareCommandRegistration>) => [
        [],
        [ledgerRow(prepared, { hasCompletedAt: true })],
      ],
      (_prepared: ReturnType<typeof prepareCommandRegistration>) => [
        new Error('database failed'),
      ],
    ]) {
      const prepared = prepareCommandRegistration(command('endSession'))
      await expect(
        registerCommand(
          createTransactionMock(createResponses(prepared)),
          owner,
          prepared,
        ),
      ).rejects.toBeDefined()
      await expect(
        registerCommand(
          createTransactionMock([[{ ledgerId: prepared.ledgerId }]]),
          owner,
          prepared,
        ),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    }
  })

  test('rejects a forged prepared capability before SQL', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const forged = { ...prepared } as typeof prepared
    const tracked = createTrackedTransaction([])

    await expect(
      registerCommand(tracked.transaction, await resolvedOwner(), forged),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(0)
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

  test('rejects a same-transaction repeat that exposes processing', async () => {
    const first = prepareCommandRegistration(command('endSession'))
    const firstResult = await registerCommand(
      createTransactionMock([[{ ledgerId: first.ledgerId }]]),
      await resolvedOwner(),
      first,
    )
    const second = prepareCommandRegistration(command('endSession'))
    expect(firstResult.status).toBe('acquired')
    await expect(
      registerCommand(
        createTransactionMock([[], [ledgerRow(second)]]),
        await resolvedOwner(),
        second,
      ),
    ).rejects.toBeInstanceOf(PersistenceDataCorruptionError)
  })

  test('replays failed responses with their latest snapshot', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const response = errorResponse()
    const result = await registerCommand(
      createTransactionMock([
        [],
        [
          ledgerRow(prepared, {
            processingStatus: 'failed',
            finalStateVersion: 13,
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
  })

  test('accepts the reachable completed and failed field matrix', async () => {
    const owner = await resolvedOwner()
    const completedResponse = commandResponse()
    const failedResponse = errorResponse()
    const cases = [
      {
        overrides: {
          processingStatus: 'completed',
          finalStateVersion: 13,
          firstEventSeq: 19,
          lastEventSeq: 20,
          responsePayloadVersion: 1,
          responsePayload: completedResponse,
          hasCompletedAt: true,
        },
        expected: { status: 'completed', response: completedResponse },
      },
      {
        overrides: {
          processingStatus: 'failed',
          finalStateVersion: 13,
          responsePayloadVersion: 1,
          responsePayload: failedResponse,
          hasCompletedAt: true,
        },
        expected: { status: 'failed', response: failedResponse },
      },
    ]

    for (const entry of cases) {
      const prepared = prepareCommandRegistration(command('endSession'))
      await expect(
        registerCommand(
          createTransactionMock([[], [ledgerRow(prepared, entry.overrides)]]),
          owner,
          prepared,
        ),
      ).resolves.toEqual(entry.expected)
    }
  })

  test('rejects every invalid terminal field matrix as persistence corruption', async () => {
    const owner = await resolvedOwner()
    const completed = commandResponse()
    const failedWithoutSnapshot = {
      code: 'state_conflict',
      message: '场次状态已变化。',
    }
    const invalidOverrides: readonly Readonly<Record<string, unknown>>[] = [
      { finalStateVersion: 1 },
      { firstEventSeq: 1 },
      { lastEventSeq: 1 },
      { responsePayloadVersion: 1, responsePayload: completed },
      { hasCompletedAt: true },
      {
        processingStatus: 'completed',
        finalStateVersion: null,
        responsePayloadVersion: 1,
        responsePayload: completed,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: 13,
        firstEventSeq: 19,
        lastEventSeq: 20,
        responsePayloadVersion: null,
        responsePayload: null,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: 13,
        firstEventSeq: 20,
        lastEventSeq: 19,
        responsePayloadVersion: 1,
        responsePayload: completed,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: 13,
        firstEventSeq: 19,
        lastEventSeq: 19,
        responsePayloadVersion: 1,
        responsePayload: completed,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: 13,
        firstEventSeq: 19,
        lastEventSeq: 20,
        responsePayloadVersion: 1,
        responsePayload: failedWithoutSnapshot,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: 13,
        firstEventSeq: 19,
        lastEventSeq: 20,
        responsePayloadVersion: 1,
        responsePayload: completed,
        hasCompletedAt: false,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: 13,
        firstEventSeq: 1,
        lastEventSeq: 1,
        responsePayloadVersion: 1,
        responsePayload: errorResponse(),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: 13,
        responsePayloadVersion: 1,
        responsePayload: failedWithoutSnapshot,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: null,
        responsePayloadVersion: 1,
        responsePayload: errorResponse(),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: null,
        responsePayloadVersion: 1,
        responsePayload: completed,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: null,
        responsePayloadVersion: 1,
        responsePayload: failedWithoutSnapshot,
        hasCompletedAt: false,
      },
    ]

    for (const overrides of invalidOverrides) {
      const prepared = prepareCommandRegistration(command('endSession'))
      await expect(
        registerCommand(
          createTransactionMock([[], [ledgerRow(prepared, overrides)]]),
          owner,
          prepared,
        ),
      ).rejects.toMatchObject({ corruption: 'invalidCommandLedger' })
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

  test('does not expose SQL details in database errors', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const databaseUrl = 'postgres://secret-user:secret-password@example.test/db'
    const rawMessage = `duplicate ${prepared.command.commandId} ${prepared.canonicalPayloadDigest} at ${databaseUrl}`
    let caught: unknown
    try {
      await registerCommand(
        createTransactionMock([new Error(rawMessage)]),
        await resolvedOwner(),
        prepared,
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(DatabaseOperationError)
    expect((caught as Error).message).toBe('数据库操作失败。')
    for (const secret of [
      databaseUrl,
      prepared.command.commandId,
      prepared.canonicalPayloadDigest,
      rawMessage,
    ]) {
      expect((caught as Error).message).not.toContain(secret)
    }
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
              ...eventRange(),
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
        ...eventRange(),
        responsePayloadVersion: 1,
        responsePayload: commandResponse(),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: null,
        responsePayloadVersion: 1,
        responsePayload: errorResponse(),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: Number.MAX_SAFE_INTEGER + 1,
        ...eventRange(),
        responsePayloadVersion: 1,
        responsePayload: commandResponse(Number.MAX_SAFE_INTEGER + 1),
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: 13,
        responsePayloadVersion: 1,
        responsePayload: {
          ...errorResponse(),
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
    const tracked = createTrackedTransaction([
      [{ ledgerId: prepared.ledgerId }],
      [{ ledgerId: prepared.ledgerId }],
    ])
    const acquired = await registerCommand(
      tracked.transaction,
      await resolvedOwner(),
      prepared,
    )
    if (acquired.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    await expect(
      completeCommand(
        tracked.transaction,
        acquired,
        commandResponse(Number.MAX_SAFE_INTEGER + 1),
        eventRange(),
      ),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(1)

    await expect(
      completeCommand(tracked.transaction, acquired, commandResponse(), {
        firstEventSeq: 19,
        lastEventSeq: 20,
      }),
    ).resolves.toBeUndefined()
    expect(tracked.getCallCount()).toBe(2)
    expect(tracked.getParameterLists().flat()).toContainEqual(commandResponse())
  })

  test('validates failed snapshot input before consuming acquired capability', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const tracked = createTrackedTransaction([
      [{ ledgerId: prepared.ledgerId }],
      [{ ledgerId: prepared.ledgerId }],
    ])
    const acquired = await registerCommand(
      tracked.transaction,
      await resolvedOwner(),
      prepared,
    )
    if (acquired.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    const invalid = {
      ...errorResponse(),
      latestSnapshot: snapshot(Number.MAX_SAFE_INTEGER + 1),
    }

    await expect(
      failCommand(tracked.transaction, acquired, invalid),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(1)
    await expect(
      failCommand(tracked.transaction, acquired, {
        ...errorResponse(),
        latestSnapshot: {
          ...snapshot(),
          sessionId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(1)
    await expect(
      failCommand(tracked.transaction, acquired, errorResponse()),
    ).resolves.toBeUndefined()
    expect(tracked.getCallCount()).toBe(2)
    expect(tracked.getParameterLists().flat()).toContainEqual(errorResponse())
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
        eventRange(),
      ],
      [commandResponse(), { firstEventSeq: 21, lastEventSeq: 20 }],
      [commandResponse(), { firstEventSeq: 19, lastEventSeq: 21 }],
    ] as const) {
      const prepared = prepareCommandRegistration(command('endSession'))
      const tracked = createTrackedTransaction([
        [{ ledgerId: prepared.ledgerId }],
      ])
      const acquired = await registerCommand(
        tracked.transaction,
        await resolvedOwner(),
        prepared,
      )
      if (acquired.status !== 'acquired') {
        throw new Error('Expected an acquired registration.')
      }
      await expect(
        completeCommand(
          tracked.transaction,
          acquired,
          responseAndRange[0],
          responseAndRange[1],
        ),
      ).rejects.toBeInstanceOf(RepositoryInputValidationError)
      expect(tracked.getCallCount()).toBe(1)
    }
  })

  test('consumes acquired after terminal SQL is attempted', async () => {
    for (const terminalRows of [[], new Error('database failed')]) {
      const prepared = prepareCommandRegistration(command('endSession'))
      const transaction = createTransactionMock([
        [{ ledgerId: prepared.ledgerId }],
        terminalRows,
      ])
      const acquired = await registerCommand(
        transaction,
        await resolvedOwner(),
        prepared,
      )
      if (acquired.status !== 'acquired') {
        throw new Error('Expected an acquired registration.')
      }

      const firstAttempt = completeCommand(
        transaction,
        acquired,
        commandResponse(),
        eventRange(),
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
          errorResponse(),
        ),
      ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    }
  })

  test('rejects every second or cross-terminal transition', async () => {
    const owner = await resolvedOwner()

    const completedPrepared = prepareCommandRegistration(command('endSession'))
    const completedTransaction = createTransactionMock([
      [{ ledgerId: completedPrepared.ledgerId }],
      [{ ledgerId: completedPrepared.ledgerId }],
    ])
    const completed = await registerCommand(
      completedTransaction,
      owner,
      completedPrepared,
    )
    if (completed.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    await completeCommand(
      completedTransaction,
      completed,
      commandResponse(),
      eventRange(),
    )
    await expect(
      completeCommand(
        createTransactionMock([]),
        completed,
        commandResponse(),
        eventRange(),
      ),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    await expect(
      failCommand(createTransactionMock([]), completed, errorResponse()),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)

    const failedPrepared = prepareCommandRegistration(command('endSession'))
    const failedTransaction = createTransactionMock([
      [{ ledgerId: failedPrepared.ledgerId }],
      [{ ledgerId: failedPrepared.ledgerId }],
    ])
    const failed = await registerCommand(
      failedTransaction,
      owner,
      failedPrepared,
    )
    if (failed.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    await failCommand(failedTransaction, failed, errorResponse())
    await expect(
      failCommand(createTransactionMock([]), failed, errorResponse()),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    await expect(
      completeCommand(
        createTransactionMock([]),
        failed,
        commandResponse(),
        eventRange(),
      ),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
  })

  test('binds acquired to its registration transaction without consuming on mismatch', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const original = createTrackedTransaction([
      [{ ledgerId: prepared.ledgerId }],
      [{ ledgerId: prepared.ledgerId }],
    ])
    const other = createTrackedTransaction([[{ ledgerId: prepared.ledgerId }]])
    const acquired = await registerCommand(
      original.transaction,
      await resolvedOwner(),
      prepared,
    )
    if (acquired.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }

    await expect(
      completeCommand(
        other.transaction,
        acquired,
        commandResponse(),
        eventRange(),
      ),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    expect(other.getCallCount()).toBe(0)
    await expect(
      completeCommand(
        original.transaction,
        acquired,
        commandResponse(),
        eventRange(),
      ),
    ).resolves.toBeUndefined()
    expect(original.getCallCount()).toBe(2)
  })

  test('rejects forged acquired capabilities before response validation or SQL', async () => {
    const prepared = prepareCommandRegistration(command('endSession'))
    const transaction = createTrackedTransaction([
      [{ ledgerId: prepared.ledgerId }],
      [{ ledgerId: prepared.ledgerId }],
    ])
    const acquired = await registerCommand(
      transaction.transaction,
      await resolvedOwner(),
      prepared,
    )
    if (acquired.status !== 'acquired') {
      throw new Error('Expected an acquired registration.')
    }
    const forged = { ...acquired } as typeof acquired

    await expect(
      completeCommand(transaction.transaction, forged, {}, eventRange()),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(transaction.getCallCount()).toBe(1)
    await expect(
      failCommand(transaction.transaction, forged, errorResponse()),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(transaction.getCallCount()).toBe(1)
    await expect(
      failCommand(transaction.transaction, acquired, errorResponse()),
    ).resolves.toBeUndefined()
  })
})
