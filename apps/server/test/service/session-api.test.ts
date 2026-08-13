import { expect, test, vi } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/app.js'
import { getProviderSettingsResponse, ServerConfig } from '../../src/config.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import {
  CommandPayloadConflictError,
  DatabaseOperationError,
} from '../../src/persistence/errors.js'

const origin = 'http://localhost:5173'
const baseUrl = 'http://127.0.0.1:8787'
const sessionId = '2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e'
const otherSessionId = '7c63940e-696c-4476-a128-c9d1e6f6eb36'

function snapshot() {
  return {
    protocolVersion: 1 as const,
    sessionId,
    stateVersion: 1,
    eventSeq: 2,
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

test('adapts injectable session ports without installing a production projector', async () => {
  const providerResponse = getProviderSettingsResponse(
    new ServerConfig({ port: 8787, databaseUrl: 'postgresql://runtime' }),
  )
  const create = vi.fn(async () => ({
    kind: 'created' as const,
    response: {
      protocolVersion: 1 as const,
      snapshot: snapshot(),
      warnings: [],
    },
  }))
  const execute = vi.fn(async () => ({ kind: 'processing' as const }))
  const runtime = {
    health: { read: async () => ({}) },
    providerHealth: {
      read: () => providerResponse,
      check: async () => providerResponse,
    },
    playerAgentSettings: { read: async () => ({}), update: async () => ({}) },
    personaCatalog: loadAndValidatePersonaCatalog(),
    deletion: {
      deleteEndedSession: async () => ({}),
      clearAll: async () => ({}),
    },
    sessionHttp: {
      creation: { create },
      query: {
        findActive: async () => snapshot(),
        getById: async () => snapshot(),
      },
      commands: { execute },
    },
  } as unknown as ApiRuntime
  const logRequest = vi.fn()
  const app = createApp(runtime, {
    port: 8787,
    allowedOrigins: new Set([origin]),
    logRequest,
  })

  const created = await app.request(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      rosterSource: {
        type: 'currentCatalog',
        selections: [
          ['nit_fish', 1],
          ['lag_rec', 2],
          ['tag_pro', 3],
          ['short_shark', 4],
          ['calling_station', 5],
        ].map(([personaId, seatNumber]) => ({ personaId, seatNumber })),
      },
    }),
  })
  expect(created.status).toBe(201)
  expect(create).toHaveBeenCalledOnce()

  const active = await app.request(`${baseUrl}/api/sessions/active`)
  expect(active.status).toBe(200)
  expect(logRequest).toHaveBeenCalledWith(
    expect.objectContaining({ route: '/api/sessions/active' }),
  )

  const processing = await app.request(
    `${baseUrl}/api/sessions/${sessionId}/commands`,
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        command: {
          sessionId,
          commandId: 'c3887350-23c5-440f-9b12-4b8be9131a88',
          expectedStateVersion: 1,
          type: 'endSession',
          payload: {},
        },
      }),
    },
  )
  expect(processing.status).toBe(409)
  expect(processing.headers.get('retry-after')).toBe('1')

  const mismatch = await app.request(
    `${baseUrl}/api/sessions/${otherSessionId}/commands`,
    {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        command: {
          sessionId,
          commandId: '4907e1bc-26d9-403e-9bcb-e18a7bedf10a',
          expectedStateVersion: 1,
          type: 'endSession',
          payload: {},
        },
      }),
    },
  )
  expect(mismatch.status).toBe(400)
  expect(execute).toHaveBeenCalledOnce()
})

function commandRequest(commandId: string) {
  return {
    protocolVersion: 1,
    command: {
      sessionId,
      commandId,
      expectedStateVersion: 1,
      type: 'endSession',
      payload: {},
    },
  }
}

function sessionRuntime(input: {
  readonly create?: () => Promise<unknown>
  readonly execute?: () => Promise<unknown>
}): ApiRuntime {
  const providerResponse = getProviderSettingsResponse(
    new ServerConfig({ port: 8787, databaseUrl: 'postgresql://runtime' }),
  )
  return {
    health: { read: async () => ({}) },
    providerHealth: {
      read: () => providerResponse,
      check: async () => providerResponse,
    },
    playerAgentSettings: { read: async () => ({}), update: async () => ({}) },
    personaCatalog: loadAndValidatePersonaCatalog(),
    deletion: {
      deleteEndedSession: async () => ({}),
      clearAll: async () => ({}),
    },
    sessionHttp: {
      creation: {
        create:
          (input.create as never) ??
          (async () => ({
            kind: 'created',
            response: {
              protocolVersion: 1,
              snapshot: snapshot(),
              warnings: [],
            },
          })),
      },
      query: {
        findActive: async () => snapshot(),
        getById: async () => snapshot(),
      },
      commands: {
        execute:
          (input.execute as never) ??
          (async () => ({
            kind: 'completed',
            origin: 'newCommit',
            response: { protocolVersion: 1, snapshot: snapshot() },
            newlyPersistedEvents: [],
          })),
      },
    },
  } as unknown as ApiRuntime
}

async function postCommand(app: ReturnType<typeof createApp>, index: number) {
  return app.request(`${baseUrl}/api/sessions/${sessionId}/commands`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(
      commandRequest(
        `c3887350-23c5-440f-9b12-${index.toString().padStart(12, '0')}`,
      ),
    ),
  })
}

test('maps the complete session creation and command result matrix', async () => {
  const conflictApp = createApp(
    sessionRuntime({
      create: async () => ({
        kind: 'activeSessionExists',
        response: {
          protocolVersion: 1,
          code: 'ACTIVE_SESSION_EXISTS',
          message: '已有活动场次。',
          latestSnapshot: snapshot(),
        },
      }),
    }),
    { port: 8787, allowedOrigins: new Set([origin]) },
  )
  const createConflict = await conflictApp.request(`${baseUrl}/api/sessions`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      rosterSource: {
        type: 'currentCatalog',
        selections: [
          'nit_fish',
          'lag_rec',
          'tag_pro',
          'short_shark',
          'calling_station',
        ].map((personaId, index) => ({ personaId, seatNumber: index + 1 })),
      },
    }),
  })
  expect(createConflict.status).toBe(409)
  await expect(createConflict.json()).resolves.toMatchObject({
    code: 'ACTIVE_SESSION_EXISTS',
  })

  const commandCases = [
    {
      result: {
        kind: 'completed',
        origin: 'newCommit',
        response: { protocolVersion: 1, snapshot: snapshot() },
        newlyPersistedEvents: [],
      },
      status: 200,
    },
    {
      result: {
        kind: 'completed',
        origin: 'replay',
        response: { protocolVersion: 1, snapshot: snapshot() },
      },
      status: 200,
    },
    ...[
      'STATE_VERSION_CONFLICT',
      'COMMAND_NOT_ALLOWED_IN_PHASE',
      'PLAYER_NOT_CURRENT_ACTOR',
      'POKER_ACTION_NOT_LEGAL',
      'POKER_ACTION_TARGET_OUT_OF_RANGE',
      'REBUY_AMOUNT_NOT_ALLOWED',
      'USER_REBUY_REQUIRED',
      'SESSION_ENDED',
      'SESSION_READONLY_DIAGNOSTIC',
    ].map((code) => ({
      result: {
        kind: 'rejected',
        origin: 'ledgerCommit',
        response: {
          protocolVersion: 1,
          code,
          message: '稳定拒绝。',
          latestSnapshot: snapshot(),
        },
      },
      status: 409,
    })),
  ]
  for (const [index, commandCase] of commandCases.entries()) {
    const app = createApp(
      sessionRuntime({ execute: async () => commandCase.result }),
      { port: 8787, allowedOrigins: new Set([origin]) },
    )
    expect((await postCommand(app, index + 1)).status).toBe(commandCase.status)
  }

  const payloadConflictApp = createApp(
    sessionRuntime({
      execute: async () => {
        throw new CommandPayloadConflictError()
      },
    }),
    { port: 8787, allowedOrigins: new Set([origin]) },
  )
  const payloadConflict = await postCommand(payloadConflictApp, 100)
  expect(payloadConflict.status).toBe(409)
  await expect(payloadConflict.json()).resolves.toMatchObject({
    code: 'COMMAND_ID_CONFLICT',
  })

  const databaseFailureApp = createApp(
    sessionRuntime({
      execute: async () => {
        throw new DatabaseOperationError()
      },
    }),
    { port: 8787, allowedOrigins: new Set([origin]) },
  )
  const databaseFailure = await postCommand(databaseFailureApp, 101)
  expect(databaseFailure.status).toBe(503)
  await expect(databaseFailure.json()).resolves.toMatchObject({
    code: 'SERVICE_UNAVAILABLE',
  })
})
