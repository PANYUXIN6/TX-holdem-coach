import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useLocation, useParams } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import {
  HandHistoryPathParamsSchema,
  SessionPathParamsSchema,
  type HandHistoryResponse,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { handSearch } from '../api/search.js'
import { ApiError } from '../api/errors.js'
import { queries } from '../query/options.js'
import { Button, EmptyState } from '../components/controls.js'
import { LoadingFeedback, RequestError } from '../components/feedback.js'
import { resourcePath, sessionHistoryPath } from '../navigation.js'
import { useSession } from '../session-sync/react.js'
import { Cards, CompletedFlow, StreetFlow } from './HandFlow.js'
import './history.css'

function MissingHand() {
  return (
    <EmptyState
      title="这手不在可查看的已完成记录中"
      description="请返回历史查看其他已完成手牌。"
    />
  )
}
function missing(error: unknown) {
  return error instanceof ApiError && error.status === 404
}
export function HandPage() {
  const location = useLocation()
  const parsed = HandHistoryPathParamsSchema.safeParse(useParams())
  let view
  try {
    view = handSearch.decode(location.search).view
  } catch {
    return (
      <EmptyState
        title="手牌查询参数无效"
        description="请重置查询参数。"
        action={<Link to={location.pathname}>恢复默认查看</Link>}
      />
    )
  }
  if (!parsed.success) return <MissingHand />
  if (view === 'auditReveal')
    return <Navigate replace to={location.pathname} state={location.state} />
  return (
    <CompletedHand
      key={`${location.key}:${parsed.data.handId}:${location.search}`}
      id={parsed.data.handId.toLowerCase()}
      revealAllowed
    />
  )
}
export function CompletedHand({
  id,
  revealAllowed = false,
}: {
  id: string
  revealAllowed?: boolean
}) {
  const query = useQuery(queries.hand(id))
  const [reveal, setReveal] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  useEffect(() => {
    if (!query.data || query.error) setReveal(false)
  }, [query.data, query.error])
  if (unavailable || missing(query.error)) return <MissingHand />
  if (!query.data)
    return query.error ? (
      <RequestError error={query.error} retry={() => void query.refetch()} />
    ) : (
      <LoadingFeedback />
    )
  return (
    <div className="history-page">
      <nav className="history-links">
        <Link to={resourcePath('table', query.data.history.sessionId)}>
          返回本场牌桌
        </Link>
        <Link to={resourcePath('handRuns', id)}>关联调用</Link>
      </nav>
      {query.error ? (
        <RequestError
          error={query.error}
          hasData
          retry={() => void query.refetch()}
        />
      ) : null}
      {reveal && !query.error ? (
        <AuditHand
          id={id}
          publicData={query.data}
          hide={() => setReveal(false)}
          unavailable={() => setUnavailable(true)}
        />
      ) : (
        <>
          {revealAllowed ? (
            <section className="history-panel">
              <p>审计查看，将显示这手所有参与者的底牌</p>
              <Button disabled={!!query.error} onClick={() => setReveal(true)}>
                揭示全部底牌
              </Button>
            </section>
          ) : null}
          <CompletedFlow data={query.data} />
        </>
      )}
    </div>
  )
}
function AuditHand({
  id,
  publicData,
  hide,
  unavailable,
}: {
  id: string
  publicData: HandHistoryResponse
  hide: () => void
  unavailable: () => void
}) {
  const [failed, setFailed] = useState(false)
  const query = useQuery({
    ...queries.hand(id, 'auditReveal', true),
    enabled: !failed,
  })
  useEffect(() => {
    if (query.error) setFailed(true)
  }, [query.error])
  useEffect(() => {
    if (missing(query.error)) unavailable()
  }, [query.error, unavailable])
  if (missing(query.error)) return <MissingHand />
  return (
    <>
      <section className="history-panel">
        <strong>
          {query.error ? '揭牌读取失败，已恢复默认隐藏' : '审计揭牌'}
        </strong>
        <Button variant="secondary" onClick={hide}>
          恢复默认隐藏
        </Button>
      </section>
      {query.error ? (
        <RequestError
          error={query.error}
          retry={() => {
            setFailed(false)
            void query.refetch()
          }}
        />
      ) : !query.data ? (
        <LoadingFeedback />
      ) : null}
      <CompletedFlow
        data={!failed && !query.error && query.data ? query.data : publicData}
      />
    </>
  )
}
export function CurrentHandPage() {
  const parsed = SessionPathParamsSchema.safeParse(useParams())
  return parsed.success ? (
    <CurrentHand
      key={parsed.data.sessionId}
      id={parsed.data.sessionId.toLowerCase()}
    />
  ) : (
    <EmptyState title="场次地址无效" description="请从牌桌进入本手流程。" />
  )
}
function CurrentHand({ id }: { id: string }) {
  const query = useSession(id)
  const currentId = query.data?.hand?.handId ?? null
  const [seen, setSeen] = useState<{ id: string; wasLive: boolean } | null>(
    null,
  )
  const seenId = seen?.id ?? null
  const summary = query.data?.lastCompletedHandSummary
  const completed =
    !currentId && summary && (!seenId || summary.handId === seenId)
      ? summary.handId
      : null
  const displayedId = currentId ?? completed
  const [changed, setChanged] = useState(false)
  useEffect(() => {
    if (displayedId && displayedId !== seenId) {
      setChanged(seenId !== null)
      setSeen({ id: displayedId, wasLive: currentId !== null })
    }
  }, [displayedId, currentId, seenId])
  if (query.status === 'missing')
    return <EmptyState title="场次已不可用" description="请返回训练首页。" />
  if (!query.data)
    return query.error ? (
      <RequestError error={query.error} />
    ) : (
      <LoadingFeedback />
    )
  const snapshot = query.data
  return (
    <div className="history-page">
      <nav className="history-links">
        <Link to={resourcePath('table', id)}>返回牌桌</Link>
        <Link to={sessionHistoryPath(id)}>本场历史</Link>
        <Link to={resourcePath('agents', id)}>本场 AI</Link>
      </nav>
      {snapshot.hand ? (
        <>
          {changed ? <p role="status">场次已进入新的一手</p> : null}
          <LiveFlow key={snapshot.hand.handId} snapshot={snapshot} />
        </>
      ) : completed ? (
        <>
          <p>
            {seen?.wasLive ? '本手已完成' : '当前无进行中手牌，以下为上一手'}
          </p>
          <Link to={resourcePath('hand', completed)}>打开已完成手详情</Link>
          <CompletedHand key={completed} id={completed} />
        </>
      ) : (
        <>
          <p>当前没有进行中的手牌</p>
          {seenId ? (
            <Link to={resourcePath('handRuns', seenId)}>
              查看此前手牌的调用
            </Link>
          ) : null}
        </>
      )}
    </div>
  )
}
function LiveFlow({ snapshot }: { snapshot: PublicSessionSnapshot }) {
  const hand = snapshot.hand!
  const end = useRef<HTMLDivElement>(null)
  const [seen, setSeen] = useState(hand.actionTimeline.at(-1)?.eventSeq ?? 0)
  const latest = hand.actionTimeline.at(-1)?.eventSeq ?? 0
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting) setSeen(latest)
    })
    if (end.current) observer.observe(end.current)
    return () => observer.disconnect()
  }, [latest])
  const phases = ['preflop', 'flop', 'turn', 'river'] as const
  return (
    <>
      <section className="history-panel">
        <h2>当前手流程</h2>
        <p>
          {snapshot.agentRunState === 'thinking'
            ? 'AI 正在思考'
            : snapshot.agentRunState === 'paused'
              ? 'AI 已暂停'
              : '等待下一行动'}
        </p>
        <p>
          {snapshot.tableDisplay
            ? `盲注 ${snapshot.tableDisplay.blinds.smallBlind}/${snapshot.tableDisplay.blinds.bigBlind}`
            : '盲注待校准'}{' '}
          · 当前底池 {hand.pot}
        </p>
        <Cards cards={hand.heroHoleCards} />
        <Cards cards={hand.board} />
        <Link to={resourcePath('handRuns', hand.handId)}>关联调用</Link>
      </section>
      {!hand.actionTimeline.length ? <p>等待首次行动</p> : null}
      {latest > seen ? (
        <div className="history-new" role="status">
          <Button
            onClick={() => {
              end.current?.scrollIntoView({ block: 'end' })
              setSeen(latest)
            }}
          >
            有新动作，查看最新记录
          </Button>
        </div>
      ) : null}
      {phases
        .filter(
          (phase, index) =>
            index === 0 ||
            hand.board.length >= [0, 3, 4, 5][index]! ||
            hand.actionTimeline.some((a) => a.streetBefore === phase),
        )
        .map((phase) => (
          <StreetFlow
            key={phase}
            phase={phase}
            cards={hand.board.slice(
              0,
              { preflop: 0, flop: 3, turn: 4, river: 5 }[phase],
            )}
            actions={hand.actionTimeline.flatMap((action, index) =>
              action.streetBefore === phase
                ? [
                    {
                      eventSeq: action.eventSeq,
                      actionNumber: index + 1,
                      name:
                        snapshot.seats.find(
                          (s) => s.seatNumber === action.actorSeatNumber,
                        )?.displayName ?? `座位 ${action.actorSeatNumber}`,
                      position: snapshot.tableDisplay?.hand?.seats.find(
                        (s) => s.seatNumber === action.actorSeatNumber,
                      )?.position,
                      action: action.action,
                      display: action.actionDisplay,
                      stack: action.seatStatesAfter.find(
                        (s) => s.seatNumber === action.actorSeatNumber,
                      )?.stack,
                      pot: action.potAfter,
                    },
                  ]
                : [],
            )}
          />
        ))}
      <div ref={end} />
    </>
  )
}
