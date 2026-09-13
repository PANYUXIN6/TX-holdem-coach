import { setupPersonas, rosterPreview } from './setup-fixtures.js'
import {
  PublicSessionSnapshotSchema,
  type SessionManagementItem,
} from '@tx-holdem-coach/contracts'
import { publicSnapshot, ids } from './fixtures.js'
export function managementItem(
  lifecycle: 'ended' | 'active' | 'readonlyDiagnostic' = 'ended',
  id = ids.session,
): SessionManagementItem {
  return {
    sessionId: id,
    lifecycle,
    createdAt: '2026-09-11T10:00:00.000000Z',
    endedAt: lifecycle === 'ended' ? '2026-09-12T10:00:00.000000Z' : null,
    completedHandCount: 12,
    currentHandId: lifecycle === 'active' ? ids.hand : null,
    roster: publicSnapshot.seats.map((seat) =>
      seat.isUser
        ? { kind: 'user', seatNumber: 0, participantId: seat.playerId }
        : {
            kind: 'ai',
            seatNumber: seat.seatNumber,
            participantId: seat.playerId,
            personaId: 'tag_pro',
            personaVersion: 1,
            displayName: seat.displayName,
            avatarColor: seat.avatarColor,
            configSnapshotKey: 'a'.repeat(64),
          },
    ),
    accounting:
      lifecycle === 'readonlyDiagnostic'
        ? { status: 'unavailable', reason: 'readonlyDiagnostic' }
        : {
            status: 'available',
            stateVersion: 4,
            seats: publicSnapshot.seats.map((seat) => ({
              participantId: seat.playerId,
              seatNumber: seat.seatNumber,
              initialChips: 2000,
              currentChips: 2500,
              cumulativeBuyIn: 4000,
              finalChips: lifecycle === 'ended' ? 2500 : null,
              sessionNetChange: lifecycle === 'ended' ? -1500 : null,
            })),
          },
  }
}
export function homeTransport(initial = 'empty') {
  let scenario = initial
  let failure = ''
  let activeGate: Promise<void> | undefined
  let releaseActive: (() => void) | undefined
  const requests: string[] = []
  const bodies: unknown[] = []
  let created = false
  const snapshot = PublicSessionSnapshotSchema.parse(publicSnapshot)
  snapshot.seats = Array.from({ length: 9 }, (_, n) => ({
    ...snapshot.seats[n % 6]!,
    seatNumber: n,
    isUser: n === 0,
    displayName: n === 0 ? '玩家' : `善于思考的长名字对手 ${n}`,
  }))
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), 'http://fixture.local')
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const error = (code: string, status: number) =>
      Response.json({ code, message: '夹具错误' }, { status })
    if (init?.method === 'POST' && url.pathname === '/api/sessions') {
      bodies.push(JSON.parse(String(init.body)))
      if (scenario === 'late')
        await new Promise((resolve) => setTimeout(resolve, 1800))
      if (scenario === 'network-empty') throw new TypeError('offline')
      if (scenario === 'network-unknown') {
        failure = 'active'
        throw new TypeError('offline')
      }
      created = true
      if (scenario === 'network-found') throw new TypeError('offline')
      if (scenario === 'conflict')
        return Response.json(
          {
            code: 'ACTIVE_SESSION_EXISTS',
            message: '活动冲突',
            latestSnapshot: snapshot,
          },
          { status: 409 },
        )
      return Response.json({ snapshot }, { status: 201 })
    }
    if (url.pathname === '/api/settings/providers/deepseek/check') {
      if (scenario === 'check-refresh-error') failure = 'provider'
      return Response.json({
        deepSeek: {
          configured: true,
          canCreateSession: true,
          checkStatus: 'unavailable',
          lastCheckedAt: '2026-09-12T10:00:00.000Z',
          errorCode: 'provider_network_error',
        },
      })
    }
    if (url.pathname === '/api/agent-personas')
      return failure === 'catalog'
        ? error('SERVICE_UNAVAILABLE', 503)
        : Response.json({ personas: setupPersonas })
    if (url.pathname === '/api/sessions/roster-preview/latest-ended') {
      if (scenario === 'empty') return error('ROSTER_SOURCE_NOT_FOUND', 404)
      return Response.json(
        scenario === 'updated'
          ? {
              ...rosterPreview,
              sourceSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              agents: rosterPreview.agents.map((p) => ({
                ...p,
                name: `更新 · ${p.name}`,
              })),
            }
          : rosterPreview,
      )
    }
    if (url.pathname === '/api/sessions/active') {
      await activeGate
      if (failure === 'active') return error('SERVICE_UNAVAILABLE', 503)
      if (scenario === 'diagnostic')
        return error('SESSION_READONLY_DIAGNOSTIC', 409)
      return scenario === 'active' || created
        ? Response.json({ snapshot })
        : error('SESSION_NOT_FOUND', 404)
    }
    if (
      url.pathname === `/api/sessions/${ids.session}` &&
      (scenario === 'active' || created)
    )
      return Response.json({ snapshot })
    if (
      url.pathname === `/api/sessions/${ids.session}/events` &&
      (scenario === 'active' || created)
    )
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `id: ${snapshot.eventSeq}\ndata: ${JSON.stringify({ eventId: ids.event, sessionId: ids.session, stateVersion: snapshot.stateVersion, eventSeq: snapshot.eventSeq, type: 'snapshot', payload: { snapshot } })}\n\n`,
              ),
            )
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    if (url.pathname === '/api/settings/providers') {
      if (failure === 'provider') return error('SERVICE_UNAVAILABLE', 503)
      return Response.json({
        deepSeek: {
          configured: scenario !== 'unconfigured',
          checkStatus:
            scenario === 'unconfigured'
              ? 'notConfigured'
              : scenario === 'not-checked'
                ? 'notChecked'
                : 'unavailable',
          lastCheckedAt: ['unconfigured', 'not-checked'].includes(scenario)
            ? null
            : '2026-09-12T10:00:00.000Z',
          errorCode: ['unconfigured', 'not-checked'].includes(scenario)
            ? null
            : 'provider_network_error',
          canCreateSession: scenario !== 'unconfigured',
        },
      })
    }
    if (url.pathname === '/api/sessions') {
      const lifecycle = url.searchParams.get('lifecycle')!
      if (failure === lifecycle) return error('SERVICE_UNAVAILABLE', 503)
      const query = {
        lifecycle,
        from: null,
        to: null,
        sort: 'newest',
        limit: Number(url.searchParams.get('limit')),
      }
      let items: SessionManagementItem[] = []
      if (scenario !== 'empty') {
        if (lifecycle === 'ended') items = [managementItem()]
        else if (lifecycle === 'active')
          items =
            scenario === 'active' || created
              ? [
                  managementItem(
                    'active',
                    failure === 'mismatch'
                      ? '3a0dc0dd-843a-4e53-a62e-e5ac22f90a3e'
                      : ids.session,
                  ),
                ]
              : []
        else
          items =
            scenario === 'active' || created
              ? [managementItem('active')]
              : scenario === 'diagnostic'
                ? [managementItem('readonlyDiagnostic')]
                : [
                    managementItem(),
                    managementItem(
                      'ended',
                      '3a0dc0dd-843a-4e53-a62e-e5ac22f90a3e',
                    ),
                  ]
      }
      return Response.json({
        query,
        timeBasis: 'sessionCreatedAt',
        items,
        nextCursor: null,
      })
    }
    return error('SESSION_NOT_FOUND', 404)
  }
  return {
    fetcher,
    requests,
    bodies,
    holdActive() {
      activeGate = new Promise<void>((resolve) => {
        releaseActive = resolve
      })
    },
    releaseActive() {
      releaseActive?.()
      activeGate = undefined
      releaseActive = undefined
    },
    scenario(value: string) {
      scenario = value
    },
    fail(value: string) {
      failure = value
    },
  }
}
