import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { keys } from '../query/keys.js'
import { matchRoutes, useLocation } from 'react-router'
import { routes } from '../navigation.js'
import { useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import { ApiError, errorMessage } from '../api/errors.js'
import { Button, Field } from '../components/controls.js'
import {
  Feedback,
  LoadingFeedback,
  RequestError,
} from '../components/feedback.js'
import { Modal } from '../components/modal.js'
import { useSessionRuntime } from '../session-sync/react.js'
import { useOverlayStore, useOverlayUi, usePageScope } from './react.js'
import {
  abortConfirmationOptions,
  confirmationEligible,
  confirmationTargetMatches,
} from './confirmation.js'
import type { OverlayDescriptor } from './stores.js'

const labels = {
  deleteSession: '永久删除本场',
  clearData: '永久清空全部数据',
  abortHandAndEndSession: '中止本手并结束场次',
} as const
type Result = {
  target: OverlayDescriptor
  message: string
  unknown: boolean
  failed: boolean
  commandId?: string
}
/** 稳定在 pathname 错误边界外；局部表单卸载不丢弃 Mutation 生命周期。 */
export function ConfirmationHost({
  rotated,
  onPending,
}: {
  rotated: boolean
  onPending: (pending: boolean) => void
}) {
  const runtime = useSessionRuntime()
  const client = useQueryClient()
  const store = useOverlayStore()
  const active = useOverlayUi((s) => s.active)
  const location = useLocation()
  const route = matchRoutes(routes, location)?.at(-1)
  const deletion = useMutation(runtime.mutations.deleteSession())
  const clear = useMutation(runtime.mutations.clearData())
  const current = (target: OverlayDescriptor) =>
    store.getState().active === target
  const abort = useMutation(abortConfirmationOptions(client, runtime, current))
  const gate = useRef(false)
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<Result | null>(null)
  const [dismissed, setDismissed] = useState(false)
  useLayoutEffect(() => {
    if (active) setDismissed(false)
  }, [active])
  const [recovering, setRecovering] = useState(false)
  const previousTarget = useRef<OverlayDescriptor | null>(null)
  useLayoutEffect(() => {
    const previous = previousTarget.current
    previousTarget.current = active
    if (
      active ||
      !previous ||
      previous.kind === 'clearData' ||
      pending ||
      result?.target.instanceId === previous.instanceId
    )
      return
    if (
      !confirmationTargetMatches(
        previous,
        client.getQueryData<PublicSessionSnapshot>(
          keys.session(previous.sessionId),
        ),
      )
    )
      setResult({
        target: previous,
        message: '确认目标已变化，请重新读取后重新确认。',
        unknown: false,
        failed: true,
      })
  }, [active, pending, result, client])

  useLayoutEffect(() => {
    if (!result?.commandId || result.target.kind === 'clearData') return
    const id = result.target.sessionId
    const check = () => {
      if (
        !runtime
          .pendingOperations(id)
          .some((operation) => operation.command.commandId === result.commandId)
      )
        setResult((currentResult) =>
          currentResult === result ? null : currentResult,
        )
    }
    const unsubscribe = runtime.subscribe(id, check)
    check()
    return unsubscribe
  }, [result, runtime])
  const commandFeedbackVisible =
    !!result?.commandId &&
    route &&
    ['table', 'currentHand', 'agents'].includes(route.route.id) &&
    result.target.kind !== 'clearData' &&
    route.params.sessionId === result.target.sessionId

  useLayoutEffect(() => {
    onPending(deletion.isPending || clear.isPending)
  }, [deletion.isPending, clear.isPending, onPending])
  useLayoutEffect(() => {
    if (rotated && active) store.getState().close(active.instanceId)
  }, [rotated, active, store])
  const submit = async (target: OverlayDescriptor) => {
    if (
      gate.current ||
      result?.unknown ||
      !current(target) ||
      !confirmationEligible(target, client, runtime)
    )
      return
    gate.current = true
    setPending(true)
    setResult(null)
    try {
      if (target.kind === 'clearData')
        await clear.mutateAsync({ confirmation: labels.clearData })
      else if (target.kind === 'deleteSession')
        await deletion.mutateAsync({
          sessionId: target.sessionId,
          body: { confirmation: labels.deleteSession },
        })
      else await abort.mutateAsync(target)
      store.getState().close(target.instanceId)
      const unsynced =
        target.kind === 'abortHandAndEndSession' &&
        !['ready', 'ended'].includes(runtime.getStatus(target.sessionId))
      setResult({
        target,
        message: unsynced
          ? '操作已完成，最新状态暂未同步。请重新读取。'
          : `${labels[target.kind]}已完成。`,
        unknown: false,
        failed: false,
      })
    } catch (error) {
      const unknown =
        target.kind !== 'abortHandAndEndSession' &&
        error instanceof ApiError &&
        ['network', 'protocol'].includes(error.kind)
      const unresolved =
        target.kind === 'abortHandAndEndSession'
          ? runtime.pendingOperations(target.sessionId)[0]?.command.commandId
          : undefined
      setResult({
        target,
        message: unresolved
          ? '结束请求结果尚未确认，请关闭弹窗，使用牌局顶部的重新读取或原请求恢复操作。'
          : unknown
            ? '操作结果尚未确认，请先重新读取状态。若仍需删除或清空，请重新打开并完整确认。'
            : (errorMessage(error) ?? '本次操作未提交，请重新确认。'),
        ...(unresolved ? { commandId: unresolved } : {}),
        unknown,
        failed: true,
      })
    } finally {
      gate.current = false
      setPending(false)
    }
  }
  const recover = async () => {
    if (!result || recovering) return
    const previous = result
    setRecovering(true)
    try {
      if (result.target.kind === 'clearData') {
        await client.fetchQuery({ ...runtime.activeOptions(), staleTime: 0 })
        await client.refetchQueries(
          {
            predicate: (query) =>
              ['sessions', 'hands', 'statistics'].includes(
                String(query.queryKey[0]),
              ),
          },
          { throwOnError: true },
        )
      } else {
        try {
          await runtime.refresh(result.target.sessionId)
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error
        }
      }
      store.getState().close(previous.target.instanceId)
      setResult({
        ...previous,
        unknown: false,
        message: '已重新读取状态。若仍需操作，请重新打开并确认。',
      })
    } catch (error) {
      setResult({
        ...previous,
        message: `读取未完成。${errorMessage(error) ?? ''}`,
      })
    } finally {
      setRecovering(false)
    }
  }
  const resultView = result ? (
    <Feedback
      title={result.message}
      alert={result.failed}
      action={
        <>
          {result.unknown ? (
            <>
              <Button
                variant="secondary"
                disabled={recovering}
                onClick={() => void recover()}
              >
                重新读取状态
              </Button>
              {!active ? (
                <Button variant="secondary" onClick={() => setDismissed(true)}>
                  关闭提示
                </Button>
              ) : null}
            </>
          ) : (
            <Button variant="secondary" onClick={() => setResult(null)}>
              关闭提示
            </Button>
          )}
        </>
      }
    />
  ) : null
  return (
    <>
      {active && !rotated ? (
        <ConfirmationForm
          key={active.instanceId}
          target={active}
          pending={pending}
          blocked={!!result?.unknown}
          submit={submit}
          result={
            result?.target.instanceId === active.instanceId ? resultView : null
          }
        />
      ) : null}
      {(!active || result?.target.instanceId !== active.instanceId) &&
      result &&
      !dismissed &&
      !commandFeedbackVisible ? (
        <div className="host-result">{resultView}</div>
      ) : null}
      {!active && pending ? (
        <Feedback title="正在处理已确认的操作…" busy />
      ) : null}
    </>
  )
}
function ConfirmationForm({
  target,
  pending,
  blocked,
  submit,
  result,
}: {
  target: OverlayDescriptor
  pending: boolean
  blocked: boolean
  submit: (target: OverlayDescriptor) => Promise<void>
  result: React.ReactNode
}) {
  const runtime = useSessionRuntime()
  const client = useQueryClient()
  const store = useOverlayStore()
  const [phrase, setPhrase] = useState('')
  const [checked, setChecked] = useState(false)
  const composing = useRef(false)
  const close = () => store.getState().close(target.instanceId)
  const queries: ReturnType<typeof runtime.sessionOptions>[] =
    target.kind === 'clearData'
      ? []
      : [runtime.sessionOptions(target.sessionId)]
  const [query] = useQueries({ queries })
  useSyncExternalStore(
    (listener) =>
      target.kind === 'clearData'
        ? () => {}
        : runtime.subscribe(target.sessionId, listener),
    () =>
      target.kind === 'clearData'
        ? ''
        : `${runtime.getStatus(target.sessionId)}:${runtime.isSubmitting(target.sessionId)}`,
  )
  const confirmed =
    target.kind === 'clearData'
      ? phrase === labels.clearData
      : target.kind === 'abortHandAndEndSession'
        ? checked
        : true
  const eligible = confirmationEligible(target, client, runtime)
  return (
    <Modal
      open
      onClose={close}
      title={labels[target.kind]}
      actions={
        <>
          <Button data-modal-cancel variant="secondary" onClick={close}>
            取消
          </Button>
          <Button
            variant="danger"
            type="submit"
            form={`confirmation-${target.instanceId}`}
            disabled={pending || blocked || !confirmed || !eligible}
          >
            {pending ? `${labels[target.kind]}处理中…` : labels[target.kind]}
          </Button>
        </>
      }
    >
      <form
        id={`confirmation-${target.instanceId}`}
        onCompositionStart={() => {
          composing.current = true
        }}
        onCompositionEnd={() => {
          composing.current = false
        }}
        onKeyDown={(event) => {
          if (
            event.key === 'Enter' &&
            (composing.current || event.nativeEvent.isComposing)
          )
            event.preventDefault()
        }}
        onSubmit={(event) => {
          event.preventDefault()
          if (!confirmed || composing.current || pending || blocked) return
          void submit(target)
          setPhrase('')
          setChecked(false)
        }}
      >
        {target.kind === 'clearData' ? (
          <>
            <p>
              将删除当前活动场次、全部训练记录和统计，活动模型请求会失效。保留预设人物和设置。无法通过应用恢复。
            </p>
            <Field
              id="clear-confirmation"
              label="请输入：永久清空全部数据"
              autoComplete="off"
              disabled={pending}
              value={phrase}
              onChange={(event) => setPhrase(event.target.value)}
            />
          </>
        ) : (
          <>
            <p className="resource-label">场次 {target.sessionId}</p>
            <p>
              {query?.data?.seats.map((seat) => seat.displayName).join('、')}
            </p>
            {query?.isFetching ? (
              <LoadingFeedback refreshing={!!query?.data} />
            ) : null}
            {query?.error ? (
              <RequestError
                error={query.error}
                retry={() => void query.refetch()}
              />
            ) : null}
            {target.kind === 'deleteSession' ? (
              <p>整场手牌、调用记录和统计贡献将删除，无法通过应用恢复。</p>
            ) : (
              <>
                <p className="resource-label">本手 {target.handId}</p>
                <p>
                  筹码和场次摘要恢复到开手前；本手不计普通历史、统计和
                  Coach，技术审计保留。
                </p>
                <label className="confirmation-check">
                  <input
                    type="checkbox"
                    disabled={pending}
                    checked={checked}
                    onChange={(event) => setChecked(event.target.checked)}
                  />
                  我已了解本手会中止并恢复到开手前
                </label>
              </>
            )}
            {!eligible && !pending ? (
              <p>目标正在读取或已变化，请等待同步后重新确认。</p>
            ) : null}
          </>
        )}
        {pending ? (
          <p role="status">正在处理，关闭弹窗不会撤销已提交的请求。</p>
        ) : null}
        {blocked && !result ? (
          <p>上一操作结果尚未确认，请先关闭弹窗并重新读取状态。</p>
        ) : null}
        {result}
      </form>
    </Modal>
  )
}
/** 列表删除入口先读取唯一快照，不从列表摘要推断可删除资格。 */
export function DeleteSessionTrigger({ sessionId }: { sessionId: string }) {
  const runtime = useSessionRuntime()
  const query = useQuery(runtime.sessionOptions(sessionId))
  const store = useOverlayStore()
  const scope = usePageScope()
  return (
    <>
      {query.isPending ? <LoadingFeedback /> : null}
      {query?.error ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : null}
      <Button
        variant="danger"
        disabled={
          query.isFetching ||
          query.isError ||
          query.data?.lifecycleStatus !== 'ended'
        }
        onClick={() =>
          store.getState().open(scope, { kind: 'deleteSession', sessionId })
        }
      >
        删除本场
      </Button>
    </>
  )
}
