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
const handId = '44444444-4444-4444-8444-444444444444'
const decisionRequestId = '55555555-5555-4555-8555-555555555555'
const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const uppercaseIds = {
  sessionId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
  commandId: 'BBBBBBBB-BBBB-4BBB-8BBB-BBBBBBBBBBBB',
  decisionRequestId: 'CCCCCCCC-CCCC-4CCC-8CCC-CCCCCCCCCCCC',
  handId: 'DDDDDDDD-DDDD-4DDD-8DDD-DDDDDDDDDDDD',
} as const

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
    typed: (value: string) => JSON.parse(value) as unknown,
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
    typed: (value: string) => JSON.parse(value) as unknown,
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
  test('reads ended-session ledger outcomes without inserting or granting capability', async () => {
    const owner = await resolvedOwner()
    const cases = [
      { rows: [], expected: { status: 'notFound' } },
      {
        rows: (prepared: ReturnType<typeof prepareCommandRegistration>) => [
          ledgerRow(prepared),
        ],
        expected: { status: 'processing' },
      },
      {
        rows: (prepared: ReturnType<typeof prepareCommandRegistration>) => [
          ledgerRow(prepared, {
            processingStatus: 'completed',
            finalStateVersion: 13,
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
            finalStateVersion: null,
            responsePayloadVersion: 1,
            responsePayload: errorResponse(false),
            hasCompletedAt: true,
          }),
        ],
        expected: { status: 'failed', response: errorResponse(false) },
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

  test('hashes every semantic field but excludes ledger location keys', () => {
    const baseAiAction = aiActionCommand()
    const differentDecisionRequestId = '77777777-7777-4777-8777-777777777777'
    const differentHandId = '88888888-8888-4888-8888-888888888888'
    const digest = (input: unknown) =>
      prepareCommandRegistration(input).canonicalPayloadDigest
    const pairs: readonly (readonly [unknown, unknown])[] = [
      [command('endSession'), command('retryAgent')],
      [
        command('endSession'),
        { ...command('endSession'), expectedStateVersion: 13 },
      ],
      [command('rebuy'), { ...command('rebuy'), payload: { amount: 2_001 } }],
      [
        baseAiAction,
        {
          ...baseAiAction,
          payload: {
            ...baseAiAction.payload,
            decisionRequestId: differentDecisionRequestId,
          },
        },
      ],
      [
        baseAiAction,
        {
          ...baseAiAction,
          payload: { ...baseAiAction.payload, handId: differentHandId },
        },
      ],
      [
        baseAiAction,
        {
          ...baseAiAction,
          payload: { ...baseAiAction.payload, actorSeatNumber: 3 },
        },
      ],
      [
        baseAiAction,
        {
          ...baseAiAction,
          payload: {
            ...baseAiAction.payload,
            candidateActionId: 'candidate_3',
          },
        },
      ],
      [
        baseAiAction,
        {
          ...baseAiAction,
          payload: {
            ...baseAiAction.payload,
            action: { type: 'call' as const },
          },
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

  test('validates then normalizes all four command UUID fields before hashing', () => {
    const uppercase = {
      ...aiActionCommand(),
      sessionId: uppercaseIds.sessionId,
      commandId: uppercaseIds.commandId,
      payload: {
        ...aiActionCommand().payload,
        decisionRequestId: uppercaseIds.decisionRequestId,
        handId: uppercaseIds.handId,
      },
    }
    const lowercase = {
      ...uppercase,
      sessionId: uppercase.sessionId.toLowerCase(),
      commandId: uppercase.commandId.toLowerCase(),
      payload: {
        ...uppercase.payload,
        decisionRequestId: uppercase.payload.decisionRequestId.toLowerCase(),
        handId: uppercase.payload.handId.toLowerCase(),
      },
    }

    const preparedUppercase = prepareCommandRegistration(uppercase)
    const preparedLowercase = prepareCommandRegistration(lowercase)
    expect(preparedUppercase.command).toEqual(lowercase)
    expect(preparedUppercase.canonicalPayloadDigest).toBe(
      preparedLowercase.canonicalPayloadDigest,
    )
  })

  test('rejects each invalid UUID field and enforces candidate id length after trim', () => {
    const validAiAction = aiActionCommand()
    for (const invalid of [
      { ...command('endSession'), sessionId: 'not-a-uuid' },
      { ...command('endSession'), commandId: 'not-a-uuid' },
      {
        ...validAiAction,
        payload: { ...validAiAction.payload, decisionRequestId: 'not-a-uuid' },
      },
      {
        ...validAiAction,
        payload: { ...validAiAction.payload, handId: 'not-a-uuid' },
      },
      {
        ...validAiAction,
        payload: {
          ...validAiAction.payload,
          candidateActionId: 'x'.repeat(129),
        },
      },
    ]) {
      expect(() => prepareCommandRegistration(invalid)).toThrow(
        RepositoryInputValidationError,
      )
    }

    const boundary = prepareCommandRegistration({
      ...validAiAction,
      payload: {
        ...validAiAction.payload,
        candidateActionId: `  ${'x'.repeat(128)}  `,
      },
    })
    if (boundary.command.type !== 'aiAction') {
      throw new Error('Expected an aiAction command.')
    }
    expect(boundary.command.payload.candidateActionId).toHaveLength(128)
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

  test('consumes prepared after not-found, conflict, corruption, or SQL failure', async () => {
    const owner = await resolvedOwner()
    for (const createResponses of [
      (prepared: ReturnType<typeof prepareCommandRegistration>) => [[], []],
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

  test('accepts every valid processing, completed, and failed field matrix', async () => {
    const owner = await resolvedOwner()
    const completedResponse = commandResponse()
    const failedWithSnapshot = errorResponse(true)
    const failedWithoutSnapshot = errorResponse(false)
    const cases = [
      {
        overrides: {},
        expected: { status: 'processing' },
      },
      {
        overrides: {
          processingStatus: 'completed',
          finalStateVersion: 13,
          responsePayloadVersion: 1,
          responsePayload: completedResponse,
          hasCompletedAt: true,
        },
        expected: { status: 'completed', response: completedResponse },
      },
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
          finalStateVersion: null,
          responsePayloadVersion: 1,
          responsePayload: failedWithoutSnapshot,
          hasCompletedAt: true,
        },
        expected: { status: 'failed', response: failedWithoutSnapshot },
      },
      {
        overrides: {
          processingStatus: 'failed',
          finalStateVersion: 13,
          responsePayloadVersion: 1,
          responsePayload: failedWithSnapshot,
          hasCompletedAt: true,
        },
        expected: { status: 'failed', response: failedWithSnapshot },
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
    const failed = errorResponse(false)
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
        responsePayloadVersion: 1,
        responsePayload: failed,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'completed',
        finalStateVersion: 13,
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
        responsePayload: failed,
        hasCompletedAt: true,
      },
      {
        processingStatus: 'failed',
        finalStateVersion: 13,
        responsePayloadVersion: 1,
        responsePayload: failed,
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
        responsePayload: failed,
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
        null,
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
      ...errorResponse(false),
      latestSnapshot: snapshot(Number.MAX_SAFE_INTEGER + 1),
    }

    await expect(
      failCommand(tracked.transaction, acquired, invalid),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(1)
    await expect(
      failCommand(tracked.transaction, acquired, {
        ...errorResponse(false),
        latestSnapshot: {
          ...snapshot(),
          sessionId: '77777777-7777-4777-8777-777777777777',
        },
      }),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(tracked.getCallCount()).toBe(1)
    await expect(
      failCommand(tracked.transaction, acquired, errorResponse(false)),
    ).resolves.toBeUndefined()
    expect(tracked.getCallCount()).toBe(2)
    expect(tracked.getParameterLists().flat()).toContainEqual(
      errorResponse(false),
    )
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
    await failCommand(failedTransaction, failed, errorResponse(false))
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
      completeCommand(other.transaction, acquired, commandResponse(), null),
    ).rejects.toBeInstanceOf(CommandLedgerTransitionError)
    expect(other.getCallCount()).toBe(0)
    await expect(
      completeCommand(original.transaction, acquired, commandResponse(), null),
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
      completeCommand(transaction.transaction, forged, {}, null),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(transaction.getCallCount()).toBe(1)
    await expect(
      failCommand(transaction.transaction, forged, {}),
    ).rejects.toBeInstanceOf(RepositoryInputValidationError)
    expect(transaction.getCallCount()).toBe(1)
    await expect(
      failCommand(transaction.transaction, acquired, errorResponse(false)),
    ).resolves.toBeUndefined()
  })
})
