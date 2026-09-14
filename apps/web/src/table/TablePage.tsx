import { AiStatusPanel } from '../ai-status/AiStatusPage.js'
import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import {
  SessionPathParamsSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { Avatar, ChipAmount, PlayingCard } from '../components/identity.js'
import { Button, EmptyState } from '../components/controls.js'
import { Modal, ModalEnvironment } from '../components/modal.js'
import { resourcePath, sessionHistoryPath } from '../navigation.js'
import { useSession } from '../session-sync/react.js'
import { useTableUi, useTableScope } from '../ui/react.js'
import { seatAnchors, streetLabel } from './presentation.js'
import { TableEffects } from './effects.js'
import './table.css'

export function TablePage() {
  const parsed = SessionPathParamsSchema.safeParse(useParams())
  return parsed.success ? (
    <TableContent id={parsed.data.sessionId.toLowerCase()} />
  ) : (
    <EmptyState title="场次地址无效" description="请从训练首页进入有效场次。" />
  )
}
export { TableFooter } from './TableFooter.js'
function TableContent({ id }: { id: string }) {
  const { data: snapshot, status, runtime } = useSession(id)
  const [detailHand, setDetailHand] = useState<string | null>(null)
  const [refreshError, setRefreshError] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const environment = useContext(ModalEnvironment)
  const root = useRef<HTMLElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const toolsOpen = useTableUi((s) => s.toolsOpen)
  const scope = useTableScope()
  const openTools = () => scope.table.getState().openTools()
  const closeTools = () => scope.table.getState().closeTools()
  const handId =
    snapshot?.hand?.handId ?? snapshot?.lastCompletedHandSummary?.handId ?? null
  useLayoutEffect(() => {
    if (
      detailHand &&
      (detailHand !== handId ||
        status === 'missing' ||
        environment.confirmationOpen)
    )
      setDetailHand(null)
  }, [handId, detailHand, status, environment.confirmationOpen])
  if (!snapshot || status === 'missing') return null
  const hand = snapshot.hand
  const summary = snapshot.lastCompletedHandSummary
  const display = snapshot.tableDisplay
  const mapping = seatAnchors(snapshot.seats)
  const board = hand?.board ?? summary?.board ?? []
  const positions = display?.hand?.seats ?? summary?.positions ?? []
  const pots = hand ? display?.hand?.potBreakdown.pots : summary?.pots
  const amount =
    hand?.pot ?? summary?.pots.reduce((sum, pot) => sum + pot.amount, 0)
  const currentPath = hand
    ? resourcePath('currentHand', id)
    : summary
      ? resourcePath('hand', summary.handId)
      : null
  return (
    <section className="table-page" ref={root} aria-label="公开牌桌">
      {snapshot.agentRunState === 'paused' ? (
        <AiStatusPanel id={id} compact />
      ) : null}
      <div className="table-summary">
        <span>
          {display
            ? `盲注 ${display.blinds.smallBlind}/${display.blinds.bigBlind}`
            : '牌桌信息待校准'}
        </span>
        <span>
          {display
            ? hand
              ? `第 ${display.completedHandCount + 1} 手`
              : `已完成 ${display.completedHandCount} 手`
            : ''}
        </span>
        <strong>
          {hand
            ? streetLabel[hand.street]
            : summary
              ? '最近完成手'
              : '尚无已完成手牌'}
        </strong>
      </div>
      {!display ? (
        <div className="table-calibration">
          <p>位置、投入及底池分层等待校准；持续缺失时请更新服务端。</p>
          <Button
            variant="secondary"
            disabled={refreshing}
            onClick={() => {
              setRefreshing(true)
              setRefreshError(false)
              void runtime
                .refresh(id)
                .catch(() => setRefreshError(true))
                .finally(() => setRefreshing(false))
            }}
          >
            重新读取牌桌信息
          </Button>
          {refreshError ? <p role="alert">重新读取失败，请稍后再试。</p> : null}
        </div>
      ) : null}
      <div
        className="table-tools"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && toolsOpen) {
            closeTools()
            trigger.current?.focus()
          }
        }}
      >
        <Button
          ref={trigger}
          variant="secondary"
          className="table-tools-toggle"
          aria-expanded={toolsOpen}
          aria-controls="table-tools-nav"
          onClick={() => (toolsOpen ? closeTools() : openTools())}
        >
          工具 {toolsOpen ? '−' : '+'}
        </Button>
        <nav
          id="table-tools-nav"
          className={toolsOpen ? 'is-open' : ''}
          aria-label="牌桌工具"
        >
          {currentPath ? (
            <Link
              to={currentPath}

              onClick={closeTools}
            >
              {hand ? '本手' : '最近一手'}
            </Link>
          ) : (
            <span>暂无手牌</span>
          )}
          <Link to={resourcePath('agents', id)} onClick={closeTools}>
            AI
            {snapshot.agentRunState === 'paused'
              ? ' · 已暂停'
              : snapshot.agentRunState === 'thinking' && status === 'ready'
                ? ' · 思考中'
                : ''}
          </Link>
          <Link to={sessionHistoryPath(id)} onClick={closeTools}>
            本场历史
          </Link>
          <Link
            to={hand ? resourcePath('handRuns', hand.handId) : '/debug'}
            onClick={closeTools}
          >
            调试
          </Link>
        </nav>
      </div>
      <div className="table-felt">
        <ol className="table-seats" aria-label="按实际座位顺序排列">
          {snapshot.seats.map((seat) => {
            const position = positions.find(
              (item) => item.seatNumber === seat.seatNumber,
            )
            const contribution = display?.hand?.seats.find(
              (item) => item.seatNumber === seat.seatNumber,
            )?.streetContribution
            const revealed = summary?.revealedHands.find(
              (item) => item.seatNumber === seat.seatNumber,
            )
            const cards = hand
              ? seat.isUser
                ? hand.heroHoleCards
                : null
              : revealed?.holeCards
            const dealt = hand
              ? seat.isUser || seat.status !== 'out'
              : revealed !== undefined
            const acting =
              snapshot.lifecycleStatus === 'active' &&
              hand?.currentActorSeatNumber === seat.seatNumber
            const activity = acting
              ? snapshot.agentRunState === 'paused'
                ? '已暂停'
                : snapshot.agentRunState === 'thinking' && status === 'ready'
                  ? '思考中'
                  : '行动中'
              : ''
            return (
              <li
                key={seat.seatNumber}
                className={`table-seat anchor-${mapping.get(seat.seatNumber)} ${acting ? 'is-acting' : ''}`}
                data-seat={seat.seatNumber}
              >
                {dealt ? (
                  <div
                    className="seat-cards"
                    data-effect={`seat:${seat.seatNumber}`}
                    role="group"
                    aria-label={
                      seat.isUser ? '你的底牌' : `${seat.displayName}的底牌`
                    }
                  >
                    {[0, 1].map((index) =>
                      cards?.[index] ? (
                        <PlayingCard
                          key={index}
                          state="face"
                          card={cards[index]!}
                          size={seat.isUser ? 44 : 36}
                        />
                      ) : (
                        <PlayingCard
                          key={index}
                          state="back"
                          size={seat.isUser ? 44 : 36}
                        />
                      ),
                    )}
                  </div>
                ) : null}
                <div className="seat-identity">
                  <Avatar
                    displayName={seat.displayName}
                    avatarColor={seat.avatarColor}
                    size={32}
                    decorative
                  />
                  <strong title={seat.displayName}>{seat.displayName}</strong>
                </div>
                <div className="seat-position">
                  {position?.position === 'BTN'
                    ? '◉ BTN'
                    : (position?.position ?? '—')}
                </div>
                <div data-effect={`chips:${seat.seatNumber}`}>
                  <ChipAmount amount={seat.stack} />
                </div>
                <div className="seat-state">
                  {activity ||
                    (hand
                      ? {
                          active: '',
                          folded: '已弃牌',
                          allIn: '全下',
                          out: '未参与',
                        }[seat.status]
                      : '')}
                </div>
                {hand && contribution !== undefined && contribution > 0 ? (
                  <div className="seat-contribution">
                    本街投入 {contribution.toLocaleString('zh-CN')}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
        <div className="table-center">
          <span className="felt-wordmark" aria-hidden="true">
            ♠ POKER PRACTICE
          </span>
          <div className="table-board" role="group" aria-label="公共牌">
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index} data-effect={`board:${index}`}>
                {board[index] ? (
                  <PlayingCard state="face" card={board[index]!} size={36} />
                ) : (
                  <PlayingCard
                    state="empty"
                    label={
                      hand
                        ? `第 ${index + 1} 张公共牌尚未发出`
                        : `第 ${index + 1} 个公共牌位无公开牌面`
                    }
                    size={36}
                  />
                )}
              </span>
            ))}
          </div>
          {amount !== undefined ? (
            <div className="table-pot" data-effect="pot">
              <span>{hand ? '底池合计' : '本手已分配'}</span>
              <strong>{amount.toLocaleString('zh-CN')}</strong>
              {hand ? <small>含本街投入</small> : null}
            </div>
          ) : null}
          {pots?.slice(0, 2).map((pot) => (
            <span className="table-pot-line" key={pot.potIndex}>
              {pot.kind === 'main' ? '主池' : `边池 ${pot.potIndex}`}{' '}
              {pot.amount.toLocaleString('zh-CN')}
            </span>
          ))}
          {pots && pots.length > 2 ? (
            <span>共 {pots.length - 1} 个边池</span>
          ) : null}
          {hand && display?.hand?.potBreakdown.unmatchedContribution ? (
            <small>
              未匹配投入{' '}
              {display.hand.potBreakdown.unmatchedContribution.amount.toLocaleString(
                'zh-CN',
              )}
            </small>
          ) : null}
          {handId && pots ? (
            <Button variant="secondary" onClick={() => setDetailHand(handId)}>
              查看底池明细
            </Button>
          ) : null}
        </div>
      </div>
      <Modal
        open={
          detailHand !== null &&
          detailHand === handId &&
          !environment.confirmationOpen
        }
        onClose={() => setDetailHand(null)}
        title={hand ? '当前底池明细' : '本手已分配'}
        initialFocus="title"
      >
        <PotDetails snapshot={snapshot} />
      </Modal>
      {!hand && summary ? (
        <details
          key={summary.handId}
          id="completed-summary"
          className="completed-summary"
          aria-controls="completed-summary-content"
        >
          <summary>本手结算 · 查看逐席净变化</summary>
          <div id="completed-summary-content">
            <PotDetails snapshot={snapshot} />
            {summary.uncalledBetReturns.length === 0 ? (
              <p>无未跟注返还</p>
            ) : null}
            <h3>各席净变化</h3>
            {summary.seatResults
              .slice()
              .sort((a, b) => a.seatNumber - b.seatNumber)
              .map((result) => {
                const name =
                  snapshot.seats.find(
                    (seat) => seat.seatNumber === result.seatNumber,
                  )?.displayName ?? `座位 ${result.seatNumber}`
                const category = summary.revealedHands.find(
                  (item) => item.seatNumber === result.seatNumber,
                )?.handEvaluation?.category
                const categories = {
                  highCard: '高牌',
                  onePair: '一对',
                  twoPair: '两对',
                  threeOfAKind: '三条',
                  straight: '顺子',
                  flush: '同花',
                  fullHouse: '葫芦',
                  fourOfAKind: '四条',
                  straightFlush: '同花顺',
                }
                return (
                  <section key={result.seatNumber} className="settlement-seat">
                    <strong>{name}</strong>
                    <span>
                      {result.startingStack.toLocaleString('zh-CN')} →{' '}
                      {result.endingStack.toLocaleString('zh-CN')}
                    </span>
                    <b>
                      {result.netChange > 0 ? '+' : ''}
                      {result.netChange.toLocaleString('zh-CN')}
                    </b>
                    <small>
                      {summary.terminationReason === 'complete' &&
                      summary.pots.some((pot) =>
                        pot.winningSeatNumbers.includes(result.seatNumber),
                      )
                        ? '其余玩家弃牌获胜'
                        : category
                          ? categories[category]
                          : '牌型未公开'}
                    </small>
                  </section>
                )
              })}
            <Link to={resourcePath('hand', summary.handId)}>查看本手详情</Link>
          </div>
        </details>
      ) : null}
      <TableEffects root={root} snapshot={snapshot} status={status} />
    </section>
  )
}
function PotDetails({ snapshot }: { snapshot: PublicSessionSnapshot }) {
  const name = (seatNumber: number) =>
    snapshot.seats.find((seat) => seat.seatNumber === seatNumber)
      ?.displayName ?? `座位 ${seatNumber}`
  if (snapshot.hand) {
    const breakdown = snapshot.tableDisplay?.hand?.potBreakdown
    return (
      <>
        <p>
          底池合计 {snapshot.hand.pot.toLocaleString('zh-CN')}
          ，含本街投入。按当前投入划分，后续行动可能变化。
        </p>
        {breakdown?.pots.map((pot) => (
          <p key={pot.potIndex}>
            {pot.kind === 'main' ? '主池' : `边池 ${pot.potIndex}`}：
            {pot.amount.toLocaleString('zh-CN')}
          </p>
        ))}
        {breakdown?.unmatchedContribution ? (
          <p>
            未匹配投入：{name(breakdown.unmatchedContribution.seatNumber)} ·{' '}
            {breakdown.unmatchedContribution.amount.toLocaleString('zh-CN')}
          </p>
        ) : null}
      </>
    )
  }
  const summary = snapshot.lastCompletedHandSummary
  return (
    <>
      {summary?.pots.map((pot) => (
        <section key={pot.potIndex}>
          <h3>
            {pot.kind === 'main' ? '主池' : `边池 ${pot.potIndex}`} ·{' '}
            {pot.amount.toLocaleString('zh-CN')}
          </h3>
          {pot.awards.map((award) => (
            <p key={award.seatNumber}>
              {name(award.seatNumber)} 获得{' '}
              {award.amount.toLocaleString('zh-CN')}
            </p>
          ))}
        </section>
      ))}
      {summary?.uncalledBetReturns.map((item) => (
        <p key={item.seatNumber}>
          已返还 {name(item.seatNumber)}：{item.amount.toLocaleString('zh-CN')}
        </p>
      ))}
    </>
  )
}
