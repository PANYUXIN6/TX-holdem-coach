import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, useRoutes } from 'react-router'
import {
  AgentRunDetailResponseSchema,
  CommandRequestSchema,
  PublicSessionSnapshotSchema,
  type AgentAttemptSummary,
  type AgentCapabilityInvocationSummary,
  type AgentRunDetailResponse,
} from '@tx-holdem-coach/contracts'
import { Page } from '../src/Pages.js'
import { Shell } from '../src/Shell.js'
import { routes, resourcePath } from '../src/navigation.js'
import { createQueryClient } from '../src/query/client.js'
import { createSessionRuntime } from '../src/session-sync/runtime.js'
import { SessionRuntimeProvider } from '../src/session-sync/react.js'
import { OverlayUiProvider } from '../src/ui/react.js'
import { tableSnapshot } from './table-fixtures.js'
import { aiStatusFixture, uniquePlayers } from './ai-fixtures.js'
import { ids } from './fixtures.js'
import '../src/styles.css'

const search = new URLSearchParams(location.search)
const fixedId = (n: number) =>
  `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const timestamp = '2026-09-13T00:00:00.000000Z'
let snapshot = uniquePlayers(tableSnapshot(Number(search.get('count') ?? 6)))
let currentRunId = fixedId(1)
const olderRunId = fixedId(99)
const runs = new Map<string, AgentRunDetailResponse>()
let handStatus: 'inProgress' | 'completed' | 'aborted' = 'inProgress'
let failedRunId = currentRunId
let trigger: 'initial' | 'manualRetry' | 'processRestart' = 'initial'
let mode = 'normal'
let runFailure = 0
let aiFailure = 0
let hidden = false
const requests: string[] = []
const commands: unknown[] = []
const errors: string[] = []
const responses = new Map<string, { snapshot: typeof snapshot }>()
const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
let abortedReads = 0
let holdReads = false
const heldReads: (() => void)[] = []
let releasePost: (() => void) | null = null
if (search.has('zoom')) document.documentElement.style.fontSize = '32px'
const nativeHidden = Object.getOwnPropertyDescriptor(
  Document.prototype,
  'hidden',
)!
Object.defineProperty(document, 'hidden', {
  get: () => hidden || nativeHidden.get?.call(document),
})
window.addEventListener('unhandledrejection', (e) =>
  errors.push(String(e.reason)),
)
function run(
  id: string,
  lifecycle: AgentRunDetailResponse['lifecycle'],
  parentRunId: string | null = null,
) {
  const actor = snapshot.seats.find(
    (s) => s.seatNumber === snapshot.hand!.currentActorSeatNumber,
  )!
  return AgentRunDetailResponseSchema.parse({
    runId: id,
    sessionId: ids.session,
    handId: ids.hand,
    runtime: 'player',
    executionMode: 'live',
    lifecycle,
    participantId: actor.playerId,
    seatNumber: actor.seatNumber,
    sourceStateVersion: snapshot.stateVersion,
    decisionRequestId: fixedId(Number(id.slice(-12)) + 100),
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: lifecycle === 'running' ? null : timestamp,
    terminationReasonCode: lifecycle === 'failed' ? 'provider_timeout' : null,
    parentRunId,
    replacementRunId: null,
    reexecutionSourceRunId: null,
    decision:
      lifecycle === 'completed'
        ? {
            kind: 'summary',
            decisionId: fixedId(800),
            status: 'committed',
            terminalOutcome: null,
            terminalReasonCode: null,
            acceptedAttemptId: null,
            commandLedgerId: fixedId(801),
            sourceDecisionId: null,
            normalizedAction: { status: 'visible', action: { type: 'fold' } },
          }
        : { kind: 'none' },
    commandEventRange:
      lifecycle === 'completed' ? { firstEventSeq: 1, lastEventSeq: 1 } : null,
    contentAvailability: {
      requestBody: 'notExposed',
      rawResponse: 'notRecorded',
      validationDetails: 'notRecorded',
    },
  })
}
runs.set(currentRunId, run(currentRunId, 'running'))
runs.set(olderRunId, run(olderRunId, 'completed'))
snapshot = PublicSessionSnapshotSchema.parse({
  ...snapshot,
  agentRunState: 'thinking',
  activeDecision: {
    decisionRequestId: runs.get(currentRunId)!.decisionRequestId,
    actorSeatNumber: snapshot.hand!.currentActorSeatNumber,
  },
})
const attempt = (
  number: number,
  lifecycle: AgentAttemptSummary['lifecycle'] = 'started',
): AgentAttemptSummary => ({
  attemptId: fixedId(1000 + number),
  attemptNumber: number,
  stage: 'model',
  lifecycle,
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  attemptType: 'initial',
  routingReasonCode: number > 1 ? 'content_correction' : null,
  startedAt: timestamp,
  completedAt: lifecycle === 'started' ? null : timestamp,
  durationMs: lifecycle === 'started' ? null : 12,
  accepted: false,
  stale: false,
  interrupted: false,
  validationStatus: number > 1 ? 'invalid' : 'notRun',
  errorCode: number > 1 ? 'response_schema_error' : null,
  requestProjectionHash: 'abcdef0123456789'.repeat(4),
  responseProjectionHash:
    lifecycle === 'started' ? null : 'fedcba9876543210'.repeat(4),
  usage: { accounting: 'pending', inputTokens: null, outputTokens: null },
})
let attempts: AgentAttemptSummary[] = [attempt(1)]
const capabilities: AgentCapabilityInvocationSummary[] = Array.from(
  { length: 21 },
  (_, i) => ({
    invocationId: fixedId(2000 + i),
    invocationNumber: i + 1,
    capabilityName: 'read-public-context',
    capabilityVersion: 1,
    authorized: true,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 3,
    inputSchemaVersion: 1,
    outputSchemaVersion: 1,
    inputHash: 'abcdef0123456789'.repeat(4),
    outputHash: 'fedcba9876543210'.repeat(4),
    errorCode: null,
  }),
)
if (search.has('pagination')) {
  const old = runs.get(currentRunId)!
  runs.set(currentRunId, {
    ...old,
    runtime: 'coach',
    participantId: null,
    seatNumber: null,
    sourceStateVersion: null,
    decisionRequestId: null,
    lifecycle: 'completed',
  })
  handStatus = 'completed'
  attempts = Array.from({ length: 21 }, (_, i) => ({
    ...attempt(i + 1, 'completed'),
    usage:
      i % 4 === 0
        ? { accounting: 'providerReported', inputTokens: 100, outputTokens: 10 }
        : i % 4 === 1
          ? {
              accounting: 'reservedUpperBound',
              inputTokens: 200,
              outputTokens: 20,
            }
          : i % 4 === 2
            ? { accounting: 'pending', inputTokens: null, outputTokens: null }
            : { accounting: 'notIncurred', inputTokens: 0, outputTokens: 0 },
  }))
}
function frame(
  stream: ReadableStreamDefaultController<Uint8Array>,
  type = 'snapshot',
) {
  stream.enqueue(
    new TextEncoder().encode(
      `id: ${snapshot.eventSeq}\ndata: ${JSON.stringify({ eventId: ids.event, sessionId: ids.session, stateVersion: snapshot.stateVersion, eventSeq: snapshot.eventSeq, type, payload: { snapshot } })}\n\n`,
    ),
  )
}
function emit(type = 'snapshot') {
  streams.forEach((stream) => frame(stream, type))
}
function pause() {
  const previous = runs.get(currentRunId)!
  runs.set(currentRunId, {
    ...previous,
    lifecycle: 'failed',
    completedAt: timestamp,
    terminationReasonCode: 'provider_timeout',
  })
  attempts = attempts.map((a) => ({
    ...a,
    lifecycle: 'failed',
    completedAt: timestamp,
    durationMs: 12,
  }))
  failedRunId = currentRunId
  snapshot = PublicSessionSnapshotSchema.parse({
    ...snapshot,
    eventSeq: snapshot.eventSeq + 1,
    agentRunState: 'paused',
    activeDecision: null,
  })
  emit('agentPaused')
}
function replacement(nextTrigger: typeof trigger = 'manualRetry') {
  const previous = currentRunId
  currentRunId = fixedId(Number(previous.slice(-12)) + 1)
  runs.set(previous, {
    ...runs.get(previous)!,
    replacementRunId: currentRunId,
    ...(nextTrigger === 'processRestart'
      ? {
          lifecycle: 'cancelled' as const,
          terminationReasonCode: 'process_restart' as const,
        }
      : {}),
  })
  runs.set(currentRunId, run(currentRunId, 'running', previous))
  trigger = nextTrigger
  attempts = [attempt(1)]
  snapshot = PublicSessionSnapshotSchema.parse({
    ...snapshot,
    eventSeq: snapshot.eventSeq + 1,
    agentRunState: 'thinking',
    activeDecision: {
      decisionRequestId: runs.get(currentRunId)!.decisionRequestId,
      actorSeatNumber: snapshot.hand!.currentActorSeatNumber,
    },
  })
  emit('agentStarted')
}
function abort() {
  handStatus = 'aborted'
  snapshot = PublicSessionSnapshotSchema.parse({
    ...snapshot,
    eventSeq: snapshot.eventSeq + 1,
    stateVersion: snapshot.stateVersion + 1,
    lifecycleStatus: 'ended',
    pokerPhase: 'betweenHands',
    agentRunState: 'idle',
    activeDecision: null,
    hand: null,
    seats: snapshot.seats.map((s) => ({ ...s, stack: 2000 })),
    tableDisplay: { ...snapshot.tableDisplay!, hand: null },
  })
  emit('sessionEnded')
}
const error = (status: number, code = 'SERVICE_UNAVAILABLE') =>
  Response.json({ code, message: '受控测试响应' }, { status })
window.fetch = async (input, init) => {
  const url = new URL(
    input instanceof Request ? input.url : input.toString(),
    location.origin,
  )
  const path = url.pathname
  requests.push(`${init?.method ?? 'GET'} ${path}${url.search}`)
  if (init?.method === 'POST') {
    if (typeof init.body !== 'string')
      throw new Error('命令体必须是 JSON 字符串')
    const body = CommandRequestSchema.parse(JSON.parse(init.body))
    commands.push(body)
    const command = body.command
    if (responses.has(command.commandId))
      return Response.json(responses.get(command.commandId))
    if (mode === 'unknown') {
      mode = 'normal'
      throw new TypeError('受控未知提交')
    }
    if (mode === 'holdPost') {
      mode = 'normal'
      await new Promise<void>((resolve) => {
        releasePost = resolve
      })
    }
    if (mode === 'conflict') {
      mode = 'normal'
      replacement()
      pause()
    }
    if (
      !('expectedPausedRunId' in command.payload) ||
      command.payload.expectedPausedRunId !== currentRunId
    ) {
      return Response.json(
        {
          code: 'PAUSED_RUN_CONFLICT',
          message: '暂停请求已变化',
          latestSnapshot: snapshot,
        },
        { status: 409 },
      )
    }
    if (command.type === 'retryAgent') replacement()
    else if (command.type === 'endSession') abort()
    else throw new Error('意外命令')
    const response = { snapshot }
    responses.set(command.commandId, response)
    return Response.json(response)
  }
  if (path.endsWith('/events')) {
    let controller: ReadableStreamDefaultController<Uint8Array>
    return new Response(
      new ReadableStream({
        start(stream) {
          controller = stream
          streams.add(stream)
          frame(stream)
          init?.signal?.addEventListener(
            'abort',
            () => {
              streams.delete(stream)
              try {
                stream.close()
              } catch {}
            },
            { once: true },
          )
        },
        cancel() {
          streams.delete(controller)
        },
      }),
      { headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
  if (path.endsWith('/ai-status')) {
    if (aiFailure) return error(aiFailure)
    const result = aiStatusFixture(snapshot, currentRunId)
    if (result.coordination.state !== 'idle')
      result.coordination.run.trigger = trigger
    if (holdReads)
      await new Promise<void>((resolve, reject) => {
        heldReads.push(resolve)
        init?.signal?.addEventListener(
          'abort',
          () => {
            abortedReads++
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true },
        )
      })
    return Response.json(result)
  }
  if (path === '/api/sessions/active')
    return snapshot.lifecycleStatus === 'active'
      ? Response.json({ snapshot })
      : error(404, 'SESSION_NOT_FOUND')
  if (path === '/api/sessions')
    return Response.json({
      query: {
        lifecycle: url.searchParams.get('lifecycle') ?? 'all',
        from: null,
        to: null,
        sort: 'newest',
        limit: Number(url.searchParams.get('limit') ?? 20),
      },
      timeBasis: 'sessionCreatedAt',
      items: [],
      nextCursor: null,
    })
  if (path === `/api/sessions/${ids.session}`)
    return Response.json({ snapshot })
  if (path.endsWith('/agent-calls')) {
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const hand = {
      handId: ids.hand,
      sessionId: ids.session,
      handNumber: 1,
      status: handStatus,
      ...(handStatus === 'aborted'
        ? {
            abortedAt: timestamp,
            abortReasonCode: 'provider_timeout',
            abortedByAgentRunId: failedRunId,
          }
        : {}),
    }
    const list = [...runs.values()]
      .filter((r) => handStatus !== 'aborted' || r.runId === failedRunId)
      .map(
        ({
          parentRunId: _parent,
          replacementRunId: _replacement,
          reexecutionSourceRunId: _source,
          decision: _decision,
          commandEventRange: _range,
          contentAvailability: _content,
          ...summary
        }) => summary,
      )
    return Response.json({
      query: { limit },
      hand,
      items: list.slice(0, limit),
      nextCursor: null,
    })
  }
  if (path.startsWith('/api/agent-runs/')) {
    if (runFailure)
      return error(
        runFailure,
        runFailure === 404 ? 'AGENT_RUN_NOT_FOUND' : undefined,
      )
    const runId = path.split('/')[3]!
    const r = runs.get(runId)
    if (!r || (handStatus === 'aborted' && runId !== failedRunId))
      return error(404, 'AGENT_RUN_NOT_FOUND')
    const limit = Number(url.searchParams.get('limit') ?? 20)
    const start = url.searchParams.get('cursor') ? 20 : 0
    if (path.endsWith('/attempts'))
      return Response.json({
        query: { limit },
        runId,
        items: attempts.slice(start, start + limit),
        nextCursor: start + limit < attempts.length ? 'page-two' : null,
      })
    if (path.endsWith('/capability-invocations'))
      return Response.json({
        query: { limit },
        runId,
        items: capabilities.slice(start, start + limit),
        nextCursor: start + limit < capabilities.length ? 'page-two' : null,
      })
    return Response.json(r)
  }
  if (path === '/api/settings/providers')
    return Response.json({
      deepSeek: {
        configured: false,
        checkStatus: 'notConfigured',
        lastCheckedAt: null,
        errorCode: null,
        canCreateSession: false,
      },
      activeProviders: [],
    })
  return error(404, 'RESOURCE_NOT_FOUND')
}
const client = createQueryClient()
const runtime = createSessionRuntime(client)
const page = search.get('page')
history.replaceState(
  null,
  '',
  resourcePath(
    page === 'run'
      ? 'run'
      : page === 'handRuns'
        ? 'handRuns'
        : page === 'table'
          ? 'table'
          : 'agents',
    page === 'run'
      ? search.has('older')
        ? olderRunId
        : currentRunId
      : page === 'handRuns'
        ? ids.hand
        : ids.session,
  ),
)
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
  aiFixture: {
    requests,
    commands,
    errors,
    runtime,
    snapshot: () => snapshot,
    currentRun: () => currentRunId,
    streams: () => streams.size,
    pause,
    abort,
    replacement,
    correction: () => {
      attempts = [
        {
          ...attempt(1, 'completed'),
          usage: {
            accounting: 'providerReported',
            inputTokens: 100,
            outputTokens: 10,
          },
        },
        attempt(2),
      ]
      snapshot = { ...snapshot, eventSeq: snapshot.eventSeq + 1 }
      emit('agentRepairAttempted')
    },
    completeAttempt: () => {
      attempts = attempts.map((a) => ({
        ...a,
        lifecycle: 'completed',
        completedAt: timestamp,
        durationMs: 12,
        usage: {
          accounting: 'providerReported',
          inputTokens: 100,
          outputTokens: 10,
        },
      }))
      runs.set(currentRunId, {
        ...runs.get(currentRunId)!,
        lifecycle: 'completed',
      })
      handStatus = 'completed'
    },
    mode: (value: string) => {
      mode = value
    },
    releasePost: () => releasePost?.(),
    runFailure: (value: number) => {
      runFailure = value
    },
    aiFailure: (value: number) => {
      aiFailure = value
    },
    hidden: (value: boolean) => {
      hidden = value
      document.dispatchEvent(new Event('visibilitychange'))
    },
    holdReads: (value: boolean) => {
      holdReads = value
      if (!value) heldReads.splice(0).forEach((resolve) => resolve())
    },
    abortedReads: () => abortedReads,
  },
})
