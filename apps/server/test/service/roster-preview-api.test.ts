import { LatestEndedRosterPreviewResponseSchema } from '@tx-holdem-coach/contracts'
import { expect, test } from 'vitest'
import { createApp, type ApiRuntime } from '../../src/http/create-app.js'
import { createRosterPreviewService } from '../../src/sessions/roster-preview-service.js'
import { loadAndValidatePersonaCatalog } from '../../src/personas/catalog.js'
import { createConfigSnapshotKey } from '../../src/personas/config.js'
import { ResourceNotFoundError } from '../../src/persistence/errors.js'
const sourceSessionId = '11111111-1111-4111-8111-111111111111'
test('真实 HTTP 仅投影历史公开字段，不依赖 Provider；无来源返回稳定 404', async () => {
  let missing = false
  const snapshots = loadAndValidatePersonaCatalog()
    .list()
    .slice(0, 5)
    .map((entry, i) => {
      const configPayload = { ...entry, name: `历史人物 ${i}` }
      return {
        participantId: sourceSessionId,
        seatNumber: i + 1,
        displayName: configPayload.name,
        avatarColor: entry.avatarColor,
        personaId: entry.personaId,
        personaVersion: entry.personaVersion,
        configPayload,
        configPayloadVersion: 1 as const,
        configSnapshotKey: createConfigSnapshotKey(1, configPayload),
      }
    })
  const rosterPreview = createRosterPreviewService(async () => {
    if (missing) throw new ResourceNotFoundError()
    return {
      session: {
        id: sourceSessionId,
        lifecycleStatus: 'ended',
        stateVersion: 1,
        nextEventSeq: 2,
        currentHandId: null,
        agentRunState: 'idle',
        activePlayerRunId: null,
        activeDecisionRequestId: null,
        createdAt: '2026-09-01T00:00:00.000000Z',
        updatedAt: '2026-09-13T00:00:00.000000Z',
        endedAt: '2026-09-13T00:00:00.000000Z',
      },
      snapshots,
    }
  })
  const app = createApp(
    { sessionHttp: { rosterPreview } } as unknown as ApiRuntime,
    { port: 8787, allowedOrigins: new Set(['http://localhost:5173']) },
  )
  const url = 'http://127.0.0.1:8787/api/sessions/roster-preview/latest-ended'
  const response = await app.request(url)
  expect(response.status).toBe(200)
  const body = LatestEndedRosterPreviewResponseSchema.parse(
    await response.json(),
  )
  expect(body.agents[0]!.name).toBe('历史人物 0')
  expect(Object.keys(body.agents[0]!).sort()).toEqual(
    [
      'sourceSeatNumber',
      'configSnapshotKey',
      'personaId',
      'personaVersion',
      'name',
      'avatarColor',
      'backgroundDescription',
      'teachingSummary',
      'style',
    ].sort(),
  )
  expect(
    await (
      await app.request(`${url}?sourceSessionId=${sourceSessionId}`)
    ).json(),
  ).toMatchObject({ code: 'INVALID_REQUEST' })
  const preflight = await app.request(url, {
    method: 'OPTIONS',
    headers: {
      Origin: 'http://localhost:5173',
      'Access-Control-Request-Method': 'GET',
    },
  })
  expect(preflight.status).toBe(204)
  missing = true
  const absent = await app.request(url)
  expect(absent.status).toBe(404)
  expect(await absent.json()).toMatchObject({ code: 'ROSTER_SOURCE_NOT_FOUND' })
})
