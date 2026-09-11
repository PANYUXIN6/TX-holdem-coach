import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Link, matchRoutes, useLocation } from 'react-router'
import { SessionPathParamsSchema } from '@tx-holdem-coach/contracts'
import { paths, routes } from '../navigation.js'
import { ApiError, errorMessage } from '../api/errors.js'
import { Button } from '../components/controls.js'
import { Feedback } from '../components/feedback.js'
import { useSession } from './react.js'

const messages = {
  idle: '正在连接牌局…',
  connecting: '正在连接牌局…',
  calibrating: '正在同步最新牌局…',
  reconnecting: '正在重新连接，当前内容等待同步',
  suspended: '正在恢复连接',
  ended: '场次已结束',
} as const
export function SessionFeedback({
  id,
  children,
  destructivePending = false,
}: {
  id: string
  children: ReactNode
  destructivePending?: boolean
}) {
  const session = useSession(id)
  const { runtime, status, syncError } = session
  // 通知只触发 render，未决数组在 render 读取，不作为 external-store snapshot。
  const [, update] = useState(0)
  useEffect(
    () => runtime.subscribe(id, () => update((n) => n + 1)),
    [id, runtime],
  )
  const pending = runtime.pendingOperations(id)
  const [actionError, setActionError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [operationResult, setOperationResult] = useState<string | null>(null)
  const gate = useRef(false)
  const hadFailure = useRef(false)
  const [recovered, setRecovered] = useState(false)
  useEffect(() => {
    if (['reconnecting', 'blocked', 'suspended', 'readonly'].includes(status))
      hadFailure.current = true
    if (status === 'ready') {
      setRecovered(hadFailure.current)
      hadFailure.current = false
    } else setRecovered(false)
  }, [status])
  const hidden = useSyncExternalStore(
    (listener) => {
      document.addEventListener('visibilitychange', listener)
      return () => document.removeEventListener('visibilitychange', listener)
    },
    () => document.hidden,
  )
  const act = async (operation: () => Promise<unknown>) => {
    if (gate.current) return
    gate.current = true
    setBusy(true)
    setActionError(null)
    try {
      await operation()
    } catch (error) {
      setActionError(error)
    } finally {
      gate.current = false
      setBusy(false)
    }
  }
  const refresh = (
    <Button
      variant="secondary"
      disabled={busy || destructivePending}
      onClick={() => void act(() => runtime.refresh(id))}
    >
      重新读取
    </Button>
  )
  let feedback: ReactNode
  if (status === 'missing')
    feedback = (
      <Feedback
        title="资源已不可用"
        action={<Link to={paths.home}>返回训练</Link>}
      />
    )
  else if (
    status === 'readonly' ||
    (status === 'blocked' && syncError?.kind === 'protocol')
  )
    feedback = (
      <Feedback
        title="只读诊断：暂不能继续操作"
        description={
          <>
            安全错误标识：<code>SESSION_READONLY_DIAGNOSTIC</code>
            {syncError?.code === 'SESSION_READONLY_DIAGNOSTIC'
              ? null
              : '（具体原因未提供）'}
            。请重新读取；若仍无法恢复，请保留此标识检查服务。可以返回并查看已校验内容。
          </>
        }
        action={refresh}
      />
    )
  else if (status === 'ended') feedback = <Feedback title={messages.ended} />
  else if (destructivePending)
    feedback = <Feedback title="正在删除或清空数据，牌局暂不可操作" busy />
  else if (status === 'blocked')
    feedback = (
      <Feedback
        title="同步暂不可用"
        description={errorMessage(syncError)}
        action={refresh}
      />
    )
  else if (status !== 'ready' && !hidden)
    feedback = <Feedback title={messages[status]} busy />
  else if (recovered)
    feedback = (
      <p className="sr-only" role="status">
        连接已恢复
      </p>
    )
  return (
    <>
      <div className="session-feedback">
        {feedback}
        {pending.length ? (
          <Feedback
            title="操作结果尚未确认，请先重新读取状态"
            description="重发会沿用原请求。停止跟踪不撤销服务端操作。"
            action={
              <>
                {refresh}
                {pending.map((operation) => (
                  <div key={operation.command.commandId}>
                    <Button
                      variant="secondary"
                      disabled={busy || !session.canSubmit}
                      onClick={() =>
                        void act(async () => {
                          await runtime.resend(id, operation.command.commandId)
                          setOperationResult(
                            ['ready', 'ended'].includes(runtime.getStatus(id))
                              ? '原请求已完成。'
                              : '操作已完成，最新状态暂未同步。请重新读取。',
                          )
                        })
                      }
                    >
                      重发原请求
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={busy || session.submitting}
                      onClick={() => {
                        runtime.abandon(id, operation.command.commandId)
                        setOperationResult(
                          '已停止跟踪此请求；这不撤销服务端操作。',
                        )
                      }}
                    >
                      停止跟踪此请求
                    </Button>
                  </div>
                ))}
              </>
            }
          />
        ) : null}
        {operationResult ? (
          <Feedback
            title={operationResult}
            action={
              <Button
                variant="secondary"
                onClick={() => setOperationResult(null)}
              >
                关闭提示
              </Button>
            }
          />
        ) : null}
        {actionError &&
        !(
          actionError instanceof ApiError && actionError.kind === 'cancelled'
        ) ? (
          <Feedback title={errorMessage(actionError)!} alert />
        ) : null}
      </div>
      {status !== 'missing' && session.data ? (
        children
      ) : status !== 'missing' ? (
        <div className="session-feedback">
          <Feedback
            title={session.isPending ? '正在加载…' : '尚无可验证的牌局内容'}
          />
        </div>
      ) : null}
    </>
  )
}
export function SessionRouteFeedback({
  children,
  destructivePending,
}: {
  children: ReactNode
  destructivePending: boolean
}) {
  const location = useLocation()
  const route = matchRoutes(routes, location)?.at(-1)
  const parsed = SessionPathParamsSchema.safeParse(route?.params)
  return route &&
    ['table', 'currentHand', 'agents'].includes(route.route.id) &&
    parsed.success ? (
    <SessionFeedback
      key={parsed.data.sessionId}
      id={parsed.data.sessionId.toLowerCase()}
      destructivePending={destructivePending}
    >
      {children}
    </SessionFeedback>
  ) : (
    children
  )
}
