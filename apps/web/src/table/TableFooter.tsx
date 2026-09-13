import { useContext, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Button, Field } from '../components/controls.js'
import { Modal, ModalEnvironment } from '../components/modal.js'
import { errorMessage } from '../api/errors.js'
import { paths, sessionHistoryPath } from '../navigation.js'
import { useSession } from '../session-sync/react.js'
import { useTableScope, useTableUi } from '../ui/react.js'
import { TableIntentError, type TableIntent } from '../ui/table-adapter.js'
import {
  betweenHands,
  heroActions,
  positiveAmount,
  rebuyLimit,
  type TableAction,
} from './actions.js'
import { tableStatus } from './presentation.js'
const number = (n: number) => n.toLocaleString('zh-CN')
export function TableFooter({ id }: { id: string }) {
  const session = useSession(id)
  const scope = useTableScope()
  const client = useQueryClient()
  const environment = useContext(ModalEnvironment)
  const draft = useTableUi((s) => s.betDraft)
  const [selection, setSelection] = useState<TableIntent | null>(null)
  const selected = useRef<TableIntent | null>(null)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const alive = useRef(false)
  const title = useRef<HTMLHeadingElement>(null)
  const intentMutation = useMutation(
    scope.intentOptions((intent) => selected.current === intent),
  )
  const betMutation = useMutation(scope.commandOptions())
  const select = (intent: TableIntent | null) => {
    selected.current = intent
    setSelection(intent)
  }
  useLayoutEffect(() => {
    alive.current = true
    const check = () => {
      if (selected.current && !scope.intentValid(selected.current)) select(null)
    }
    const offQuery = client.getQueryCache().subscribe(check)
    const offRuntime = session.runtime.subscribe(id, check)
    const visibility = () => {
      if (document.hidden) select(null)
    }
    document.addEventListener('visibilitychange', visibility)
    return () => {
      alive.current = false
      selected.current = null
      offQuery()
      offRuntime()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [client, scope, session.runtime, id])
  useLayoutEffect(() => {
    if (environment.rotated || environment.confirmationOpen) select(null)
  }, [environment.rotated, environment.confirmationOpen])
  const pending =
    intentMutation.isPending || betMutation.isPending || session.submitting
  const disabled =
    pending ||
    !session.canSubmit ||
    session.runtime.pendingOperations(id).length > 0 ||
    document.hidden ||
    environment.rotated ||
    environment.confirmationOpen
  async function submit(intent?: TableIntent) {
    if (disabled || busy.current) return
    busy.current = true
    setError(null)
    try {
      if (intent) {
        select(intent)
        await intentMutation.mutateAsync(intent)
      } else if (draft) await betMutation.mutateAsync(draft)
      if (alive.current) {
        if (!['ready', 'ended'].includes(session.runtime.getStatus(id)))
          setError('操作已完成，最新状态暂未同步，请重新读取')
        title.current?.focus({ preventScroll: true })
      }
    } catch (cause) {
      if (alive.current)
        setError(
          cause instanceof TableIntentError
            ? '牌局已变化，请重新选择'
            : errorMessage(cause),
        )
    } finally {
      busy.current = false
    }
  }
  const act = (action: TableAction, confirm = false) => {
    if (disabled || busy.current) return
    const intent = scope.capture(action, session.data)
    if (!intent) {
      setError('牌局已变化，请重新选择')
      return
    }
    scope.table.getState().clearDraft()
    select(intent)
    if (!confirm) void submit(intent)
  }
  if (!session.data || session.status === 'missing') return null
  const snapshot = session.data
  const actions = heroActions(snapshot)
  const ordinary = actions.find((a) => a.type === 'bet' || a.type === 'raise')
  const allIn = actions.find((a) => a.type === 'allIn')
  const amount =
    draft && ordinary
      ? positiveAmount(draft.input, ordinary.minTarget, ordinary.maxTarget)
      : null
  const stack = snapshot.seats.find((s) => s.isUser)!.stack
  const summary = snapshot.hand ? null : snapshot.lastCompletedHandSummary
  const net = summary?.seatResults.find((s) => s.seatNumber === 0)?.netChange
  const winners = new Set(summary?.pots.flatMap((p) => p.winningSeatNumbers))
  const contribution = snapshot.tableDisplay?.hand?.seats.find(
    (s) => s.seatNumber === 0,
  )?.streetContribution
  const rebuyAmount = positiveAmount(input, 1, rebuyLimit(stack))
  return (
    <section className="action-panel" aria-label="牌桌操作">
      <h2 ref={title} tabIndex={-1}>
        {tableStatus(snapshot)}
      </h2>
      {pending ? <p role="status">正在提交…</p> : null}
      {session.runtime.pendingOperations(id).length ? (
        <p>操作结果待确认，请通过顶部恢复入口处理。</p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {actions.length ? (
        <>
          {draft && ordinary ? (
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (amount !== null) void submit()
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && event.nativeEvent.isComposing)
                  event.preventDefault()
              }}
            >
              <Field
                id="bet-target"
                data-table-amount
                label="本街投入到"
                type="text"
                inputMode="numeric"
                value={draft.input}
                disabled={disabled}
                onChange={(event) =>
                  scope.table.getState().editDraft(event.target.value)
                }
                hint={
                  <>
                    {number(ordinary.minTarget)}–{number(ordinary.maxTarget)}
                    ，这是本街总投入
                    {contribution !== undefined && amount !== null
                      ? `；本街已投入 ${number(contribution)}，本次再投入 ${number(amount - contribution)}`
                      : ''}
                  </>
                }
                error={
                  amount === null
                    ? allIn &&
                      positiveAmount(
                        draft.input,
                        allIn.target,
                        allIn.target,
                      ) !== null
                      ? '全下请选全下'
                      : '请输入合法范围内的正整数金额'
                    : undefined
                }
              />
              <div className="amount-shortcuts">
                {ordinary.suggestedTargets.map((item) => (
                  <Button
                    key={item.kind}
                    variant="secondary"
                    disabled={disabled}
                    aria-pressed={amount === item.targetStreetCommitment}
                    onClick={() => scope.suggest(item.targetStreetCommitment)}
                  >
                    {item.kind === 'minimum'
                      ? ordinary.type === 'bet'
                        ? '最小下注'
                        : '最小加注'
                      : {
                          halfPot: '1/2 池',
                          twoThirdsPot: '2/3 池',
                          pot: '满池',
                        }[item.kind]}{' '}
                    {number(item.targetStreetCommitment)}
                  </Button>
                ))}
                {allIn ? (
                  <Button
                    variant="raise"
                    disabled={disabled}
                    onClick={() => act({ type: 'allIn' }, true)}
                  >
                    全下
                  </Button>
                ) : null}
              </div>
              <Button
                className="amount-submit"
                variant="raise"
                type="submit"
                disabled={disabled || amount === null}
              >
                {ordinary.type === 'bet' ? '下注到' : '加到'}{' '}
                {amount === null ? '—' : number(amount)}
              </Button>
            </form>
          ) : null}
          {selection?.action.type === 'allIn' ? (
            <div className="action-row">
              <Button
                variant="raise"
                disabled={disabled}
                onClick={() => void submit(selection)}
              >
                全下至 {number(selection.seenAmount!)}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => select(null)}
              >
                取消全下
              </Button>
            </div>
          ) : null}
          <div className="action-row">
            {actions.map((action) => {
              if (action.type === 'bet' || action.type === 'raise')
                return (
                  <Button
                    key={action.type}
                    variant="raise"
                    disabled={disabled}
                    onClick={() => {
                      select(null)
                      scope.begin(action.type)
                    }}
                  >
                    {action.type === 'bet' ? '下注…' : '加注…'}
                  </Button>
                )
              if (action.type === 'allIn')
                return !draft && selection?.action.type !== 'allIn' ? (
                  <Button
                    key="allIn"
                    variant="raise"
                    disabled={disabled}
                    aria-pressed={false}
                    onClick={() => act({ type: 'allIn' }, true)}
                  >
                    全下
                  </Button>
                ) : null
              return (
                <Button
                  key={action.type}
                  variant={action.type === 'fold' ? 'fold' : 'call'}
                  disabled={disabled}
                  onClick={() => act({ type: action.type })}
                >
                  {action.type === 'fold'
                    ? '弃牌'
                    : action.type === 'check'
                      ? '过牌'
                      : `跟注 ${number(action.amount)}`}
                </Button>
              )
            })}
          </div>
          {actions.find((a) => a.type === 'call') ? (
            <small>跟注金额为本次再投入</small>
          ) : null}
        </>
      ) : null}
      {!snapshot.hand ? (
        <>
          <div className="completion-teaser">
            {summary ? (
              <>
                <strong>
                  本手净变化{' '}
                  {net !== undefined
                    ? `${net > 0 ? '+' : ''}${number(net)}`
                    : '未参与'}
                </strong>
                <span>
                  {winners.size > 1
                    ? '多人获分配，查看结算'
                    : `${snapshot.seats.find((s) => winners.has(s.seatNumber))?.displayName ?? '本手'}获分配`}
                </span>
                <a
                  href="#completed-summary"
                  onClick={(event) => {
                    event.preventDefault()
                    const panel = document.getElementById(
                      'completed-summary',
                    ) as HTMLDetailsElement | null
                    if (panel) {
                      panel.open = true
                      panel.scrollIntoView({ block: 'start' })
                      panel.querySelector('summary')?.focus()
                    }
                  }}
                >
                  查看结算
                </a>
              </>
            ) : (
              <span>暂无完成手摘要</span>
            )}
          </div>
          {betweenHands(snapshot) ? (
            <>
              {stack === 0 ? <p>筹码已用完，请买入或结束</p> : null}
              {selection?.action.type === 'rebuy' && stack > 0 ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    if (rebuyAmount !== null) {
                      const intent = {
                        ...selection,
                        action: { type: 'rebuy' as const, amount: rebuyAmount },
                      }
                      void submit(intent)
                    }
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && event.nativeEvent.isComposing)
                      event.preventDefault()
                  }}
                >
                  <Field
                    id="rebuy-amount"
                    data-table-amount
                    label="本次补入"
                    type="text"
                    inputMode="numeric"
                    value={input}
                    disabled={disabled}
                    onChange={(event) => setInput(event.target.value)}
                    hint={
                      rebuyAmount === null
                        ? `可补入 1–${number(rebuyLimit(stack))}`
                        : `补入 ${number(rebuyAmount)}，补后 ${number(stack + rebuyAmount)}`
                    }
                    error={
                      rebuyAmount === null
                        ? '请输入范围内的正整数金额'
                        : undefined
                    }
                  />
                  <div className="action-row">
                    <Button
                      type="submit"
                      disabled={disabled || rebuyAmount === null}
                    >
                      确认补码
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={disabled}
                      onClick={() => select(null)}
                    >
                      取消补码
                    </Button>
                  </div>
                </form>
              ) : null}
              <div className="action-row">
                {stack === 0 ? (
                  <Button
                    disabled={disabled}
                    onClick={() => act({ type: 'rebuy', amount: 2000 })}
                  >
                    买入 2,000
                  </Button>
                ) : (
                  <Button
                    disabled={disabled}
                    onClick={() => act({ type: 'startNextHand' })}
                  >
                    开始下一手
                  </Button>
                )}
                {stack > 0 && stack < 2000 ? (
                  <Button
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => {
                      setInput(String(rebuyLimit(stack)))
                      act({ type: 'rebuy', amount: rebuyLimit(stack) }, true)
                    }}
                  >
                    补码…
                  </Button>
                ) : null}
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => act({ type: 'endSession' }, true)}
                >
                  结束场次
                </Button>
              </div>
              {snapshot.seats.some((s) => !s.isUser && s.stack === 0) ? (
                <small>开始下一手时，归零 AI 自动买入 2,000</small>
              ) : null}
            </>
          ) : null}
          {snapshot.lifecycleStatus === 'ended' ? (
            <div className="action-row">
              <Link to={paths.home}>返回训练</Link>
              <Link to={sessionHistoryPath(id)}>本场历史</Link>
            </div>
          ) : null}
        </>
      ) : null}
      <Modal
        open={
          selection?.action.type === 'endSession' &&
          !environment.rotated &&
          !environment.confirmationOpen
        }
        onClose={() => select(null)}
        title="结束场次"
        initialFocus="title"
      >
        <p>结束后本场不能继续；已完成手牌会保留，归零 AI 不会买入。</p>
        <div className="action-row">
          <Button variant="secondary" onClick={() => select(null)}>
            继续留在牌桌
          </Button>
          <Button
            disabled={disabled}
            onClick={() => {
              if (selection) void submit(selection)
            }}
          >
            确认结束
          </Button>
        </div>
      </Modal>
    </section>
  )
}
