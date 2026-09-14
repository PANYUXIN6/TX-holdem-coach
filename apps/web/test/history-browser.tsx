import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, useRoutes } from 'react-router'
import {
  HandHistoryResponseSchema,
  HandHistoryListResponseSchema,
  PublicSessionSnapshotSchema,
} from '@tx-holdem-coach/contracts'
import { Page } from '../src/Pages.js'
import { Shell } from '../src/Shell.js'
import { routes } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { sessionsSearch } from '../src/api/search.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import { OverlayUiProvider } from '../src/ui/react.js'
import { tableSnapshot, completeTable } from './table-fixtures.js'
import { ids } from './fixtures.js'
import fixtures from './hand-fixtures.json'
import showdownFixture from './history-showdown-fixture.json'
import '../src/styles.css'

const publicData = HandHistoryResponseSchema.parse(fixtures.public)
const auditData = HandHistoryResponseSchema.parse(fixtures.auditReveal)
const handId = publicData.history.handId
const sessionId = publicData.history.sessionId
const secondId = '10000000-0000-4000-8000-000000000002'
const otherSession = '22222222-2222-4222-8222-222222222223'
let snapshot = tableSnapshot(
  Number(new URLSearchParams(location.search).get('count') ?? 6),
)
snapshot = {
  ...snapshot,
  sessionId,
  hand: { ...snapshot.hand!, handId },
  tableDisplay: {
    ...snapshot.tableDisplay!,
    hand: { ...snapshot.tableDisplay!.hand!, handId },
  },
}
let removed = false
let auditError = 0
let hold = false
const held: (() => void)[] = []
const requests: string[] = []
const errors: string[] = []
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
const client = createQueryClient()
client.setQueryData(keys.hand(handId, 'auditReveal'), auditData)
const runtime = createSessionRuntime(client)
window.addEventListener('unhandledrejection', (e) =>
  errors.push(String(e.reason)),
)
function frame(
  stream: ReadableStreamDefaultController<Uint8Array>,
  type = 'snapshot',
) {
  stream.enqueue(
    new TextEncoder().encode(
      `id: ${snapshot.eventSeq}\ndata: ${JSON.stringify({ eventId: ids.event, sessionId, stateVersion: snapshot.stateVersion, eventSeq: snapshot.eventSeq, type, payload: { snapshot } })}\n\n`,
    ),
  )
}
function emit(type = 'snapshot') {
  snapshot = PublicSessionSnapshotSchema.parse(snapshot)
  streams.forEach((s) => frame(s, type))
}
const terminal = publicData.history.phases.at(-1)!
if (terminal.phase !== 'showdown') throw new Error('result required')
const item = {
  handId,
  sessionId,
  handNumber: 1,
  startedAt: '2026-09-14T01:02:03.123456Z',
  completedAt: '2026-09-14T01:03:03.123456Z',
  user: {
    position: 'BTN',
    holeCards: terminal.revealedHands.find((h) => h.seatNumber === 0)!
      .holeCards,
    startingHandCategory: 'A8o',
    netChange: publicData.history.participants[0]!.netChange,
  },
  board: terminal.communityCards,
  result: {
    terminationReason: terminal.terminationReason,
    winnerSeatNumbers: [
      ...new Set(terminal.pots.flatMap((p) => p.winningSeatNumbers)),
    ].sort(),
    userAwardAmount: terminal.pots
      .flatMap((p) => p.awards)
      .filter((p) => p.seatNumber === 0)
      .reduce((sum, p) => sum + p.amount, 0),
  },
  aiParticipants: publicData.history.participants
    .filter((p) => !p.isUser)
    .map((p) => ({
      seatNumber: p.seatNumber,
      personaId: `historical-${p.seatNumber}`,
      personaVersion: 1,
      displayName: `历史长姓名${'林间听雨'.repeat(12)}`,
      avatarColor: p.avatarColor,
      configSnapshotKey: String(p.seatNumber).repeat(64),
    })),
}
const error = (status: number) =>
  Response.json(
    {
      code: status === 404 ? 'RESOURCE_NOT_FOUND' : 'SERVICE_UNAVAILABLE',
      message: '受控响应',
    },
    { status },
  )
window.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : String(input),
    location.origin,
  )
  requests.push(url.pathname + url.search)
  if (removed) return error(404)
  if (url.pathname.endsWith('/events')) {
    let stream: ReadableStreamDefaultController<Uint8Array>
    return new Response(
      new ReadableStream({
        start(c) {
          stream = c
          streams.add(c)
          frame(c)
          init?.signal?.addEventListener(
            'abort',
            () => {
              streams.delete(c)
              try {
                c.close()
              } catch {}
            },
            { once: true },
          )
        },
        cancel() {
          streams.delete(stream)
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  if (url.pathname === '/api/hands') {
    const second = url.searchParams.has('cursor')
    return Response.json(
      HandHistoryListResponseSchema.parse({
        items: second
          ? [{ ...item, handId: secondId, handNumber: 4 }]
          : [
              item,
              {
                ...item,
                handId: secondId,
                handNumber: 2,
                sessionId: otherSession,
              },
              {
                ...item,
                handId: '10000000-0000-4000-8000-000000000003',
                handNumber: 3,
              },
            ],
        nextCursor: second ? null : 'next-batch',
      }),
    )
  }
  if (url.pathname.endsWith('/agent-calls'))
    return Response.json({
      query: { limit: 20 },
      hand: {
        handId: url.pathname.split('/')[3],
        sessionId,
        handNumber: 1,
        status: snapshot.hand ? 'inProgress' : 'completed',
      },
      items: [],
      nextCursor: null,
    })
  if (url.pathname.startsWith('/api/hands/')) {
    const result = structuredClone(
      url.pathname.endsWith('000000000002')
        ? HandHistoryResponseSchema.parse(showdownFixture)
        : url.searchParams.get('view') === 'auditReveal'
          ? auditData
          : publicData,
    )
    result.history.handId = url.pathname.split('/')[3]!
    const status =
      url.searchParams.get('view') === 'auditReveal' ? auditError : 0
    if (hold) await new Promise<void>((resolve) => held.push(resolve))
    return status ? error(status) : Response.json(result)
  }
  if (url.pathname === '/api/sessions/active')
    return Response.json({ snapshot })
  if (url.pathname === '/api/sessions') {
    const query = sessionsSearch.decode(url.search).query
    return Response.json({
      query,
      timeBasis: 'sessionCreatedAt',
      items: [
        {
          sessionId,
          lifecycle: 'active',
          createdAt: item.startedAt,
          endedAt: null,
          completedHandCount: 1,
          currentHandId: handId,
          roster: [
            {
              kind: 'user',
              participantId: publicData.history.participants[0]!.playerId,
              seatNumber: 0,
            },
            ...item.aiParticipants.map((p) => ({
              ...p,
              kind: 'ai',
              participantId:
                publicData.history.participants[p.seatNumber]!.playerId,
            })),
          ],
          accounting: {
            status: 'available',
            stateVersion: 1,
            seats: publicData.history.participants.map((p) => ({
              participantId: p.playerId,
              seatNumber: p.seatNumber,
              initialChips: 2000,
              currentChips: 2000,
              cumulativeBuyIn: 2000,
              finalChips: null,
              sessionNetChange: null,
            })),
          },
        },
      ],
      nextCursor: url.searchParams.has('cursor') ? null : 'option-next',
    })
  }
  if (url.pathname === `/api/sessions/${sessionId}`)
    return Response.json({ snapshot })
  return error(404)
}
if (location.pathname.startsWith('/test/'))
  history.replaceState(null, '', '/history')
function Application() {
  return useRoutes([
    {
      element: <Shell />,
      children: routes.map((route) => ({
        ...route,
        element: <Page id={route.id} />,
      })),
    },
  ])
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      <SessionRuntimeProvider runtime={runtime}>
        <OverlayUiProvider>
          <BrowserRouter>
            <Application />
          </BrowserRouter>
        </OverlayUiProvider>
      </SessionRuntimeProvider>
    </QueryClientProvider>
  </StrictMode>,
)
Object.assign(window, {
  historyFixture: {
    requests,
    errors,
    handId,
    secondId,
    sessionId,
    client,
    hold: (value: boolean) => {
      hold = value
      if (!value) held.splice(0).forEach((resolve) => resolve())
    },
    auditError: (value: number) => {
      auditError = value
    },
    advance: () => {
      const hand = snapshot.hand!
      snapshot = {
        ...snapshot,
        stateVersion: snapshot.stateVersion + 1,
        eventSeq: snapshot.eventSeq + 2,
        hand: {
          ...hand,
          actionTimeline: [
            ...hand.actionTimeline,
            {
              handId: hand.handId,
              eventSeq: snapshot.eventSeq + 2,
              streetBefore: 'preflop',
              streetAfter: 'preflop',
              actorSeatNumber: 2,
              action: { type: 'call' },
              actionDisplay: {
                committedAmount: 40,
                streetContributionAfterAction: 60,
              },
              boardAfter: [],
              seatStatesAfter: snapshot.seats.map((s) => ({
                seatNumber: s.seatNumber,
                stack: 1940,
                status: s.status,
                streetContribution: 60,
                totalContribution: 60,
              })),
              potAfter: 360,
              currentActorSeatNumberAfter: 0,
            },
          ],
        },
      }
      emit('actionCommitted')
    },
    complete: () => {
      snapshot = {
        ...completeTable(snapshot),
        stateVersion: snapshot.stateVersion + 1,
        eventSeq: snapshot.eventSeq + 1,
      }
      emit('handCompleted')
    },
    next: () => {
      const next = tableSnapshot()
      snapshot = {
        ...next,
        sessionId,
        stateVersion: snapshot.stateVersion + 1,
        eventSeq: snapshot.eventSeq + 1,
        hand: { ...next.hand!, handId: secondId },
        tableDisplay: {
          ...next.tableDisplay!,
          hand: { ...next.tableDisplay!.hand!, handId: secondId },
        },
      }
      emit('handStarted')
    },
    abort: () => {
      snapshot = {
        ...snapshot,
        stateVersion: snapshot.stateVersion + 1,
        eventSeq: snapshot.eventSeq + 1,
        hand: null,
        lastCompletedHandSummary: null,
        lifecycleStatus: 'ended',
        pokerPhase: 'betweenHands',
        tableDisplay: { ...snapshot.tableDisplay!, hand: null },
      }
      emit('sessionEnded')
    },
    remove: () => {
      removed = true
      void client.invalidateQueries()
    },
    disconnect: () => {
      streams.forEach((s) => s.close())
      streams.clear()
    },
  },
})
