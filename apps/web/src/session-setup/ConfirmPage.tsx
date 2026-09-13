import {
  useContext,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import {
  ApiError,
  providerErrorMessages,
  providerStatusMessages,
} from '../api/errors.js'
import { Button, Field, StatusBadge } from '../components/controls.js'
import { Avatar } from '../components/identity.js'
import { RequestError } from '../components/feedback.js'
import { ModalEnvironment } from '../components/modal.js'
import { localTime } from '../home/model.js'
import { newSessionPath, resourcePath } from '../navigation.js'
import { queries } from '../query/options.js'
import { useSessionRuntime } from '../session-sync/react.js'
import {
  AI_SEATS,
  createRequest,
  previewMatches,
  readReady,
  shuffleSeats,
} from './model.js'
import { useSetup, useSetupQuery } from './react.js'
import { freshRead, OpeningError, openingOptions } from './opening.js'

export function ConfirmPage() {
  const setup = useSetup()
  const { source, draft, dispatch, catalog, preview, active, canContinue } =
    setup
  const client = useQueryClient()
  const runtime = useSessionRuntime()
  const navigate = useNavigate()
  const environment = useContext(ModalEnvironment)
  const providers = useSetupQuery({
    ...queries.providers(),
    refetchOnMount: 'always',
  })
  const check = useMutation(runtime.mutations.checkProvider())
  const create = useMutation(openingOptions(client, runtime))
  const subscribeOperations = useCallback(
    (listener: () => void) => runtime.subscribeOperations(listener),
    [runtime],
  )
  const creating = useSyncExternalStore(subscribeOperations, runtime.isCreating)
  const target = useSyncExternalStore(
    subscribeOperations,
    runtime.getCreateTarget,
  )
  const [message, setMessage] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [uncertain, setUncertain] = useState(false)
  const [recovering, setRecovering] = useState(false)
  const pendingFocus = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (pendingFocus.current) {
      document
        .getElementById(pendingFocus.current)
        ?.focus({ preventScroll: true })
      pendingFocus.current = null
    }
  })
  const locked = useRef(false)
  const detecting = useRef(false)
  const live = useRef({ draft, rotated: environment.rotated, mounted: false })
  useLayoutEffect(() => {
    live.current = { draft, rotated: environment.rotated, mounted: true }
  })
  useLayoutEffect(
    () => () => {
      live.current.mounted = false
    },
    [],
  )
  const valid = (captured = draft) =>
    live.current.mounted && live.current.draft === captured
  const interactive = () => valid() && !live.current.rotated && !document.hidden
  const hasDraft =
    source === 'current' ? draft.selections.length > 0 : draft.preview !== null
  useEffect(() => {
    if (!hasDraft) {
      dispatch({ type: 'notice' })
      void navigate(newSessionPath(source), { replace: true })
    }
  }, [hasDraft, dispatch, navigate, source])
  const busy = create.isPending || creating
  const provider = providers.data?.deepSeek
  const matched = previewMatches(draft.preview, preview.data)
  const rows =
    source === 'current'
      ? draft.selections.map((s) => ({
          ...s,
          key: s.personaId,
          persona: catalog.data?.personas.find(
            (p) =>
              p.personaId === s.personaId &&
              p.personaVersion === s.personaVersion,
          ),
        }))
      : (draft.preview?.assignments.map((a) => ({
          ...a,
          key: `${draft.preview!.sourceSessionId}-${a.sourceSeatNumber}`,
          personaVersion: matched
            ? preview.data?.agents.find(
                (p) => p.sourceSeatNumber === a.sourceSeatNumber,
              )?.personaVersion
            : undefined,
          persona: matched
            ? preview.data?.agents.find(
                (p) => p.sourceSeatNumber === a.sourceSeatNumber,
              )
            : undefined,
        })) ?? [])
  const allowedSeats =
    source === 'current'
      ? AI_SEATS
      : (draft.preview?.assignments
          .map((a) => a.sourceSeatNumber)
          .sort((a, b) => a - b) ?? [])
  const activeReady = readReady(active)
  const continueTarget = activeReady ? active.data : target
  const recoveryReady = activeReady && active.data === null
  const eligible =
    canContinue &&
    readReady(providers) &&
    provider?.canCreateSession &&
    !busy &&
    !check.isPending &&
    !recovering &&
    (!uncertain || recoveryReady)
  const go = (id: string) => {
    // 导航离开两步流程即卸载草稿；提前 reset 会触发确认直达保护抢先返回选择页。
    void navigate(resourcePath('table', id), { replace: true })
  }
  async function submit() {
    if (!eligible || locked.current || detecting.current || !interactive())
      return
    locked.current = true
    const captured = draft
    setMessage('')
    setUncertain(false)
    try {
      const result = await create.mutateAsync({
        ...createRequest(
          captured,
          source,
          catalog.data?.personas,
          preview.data,
        ),
        draft: captured,
        source,
        valid: () =>
          valid(captured) &&
          !live.current.rotated &&
          !document.hidden &&
          !detecting.current,
      })
      if (!valid(captured)) return
      if (result.sessionId) go(result.sessionId)
      else {
        setUncertain(true)
        setMessage('当前未发现活动训练场，请重新读取后确认')
      }
    } catch (error) {
      if (
        !valid(captured) ||
        (error instanceof ApiError && error.kind === 'cancelled')
      )
        return
      const found = runtime.getCreateTarget()
      if (!(error instanceof OpeningError) && found) {
        if (error instanceof ApiError && error.code === 'ACTIVE_SESSION_EXISTS')
          go(found)
        else {
          setUncertain(true)
          setMessage('开场结果未确认，已找到活动训练场')
        }
      } else if (error instanceof OpeningError) {
        setMessage(error.message)
        if (error.reason === 'source') {
          dispatch({ type: 'notice', message: error.message })
          void navigate(newSessionPath(source), { replace: true })
        }
      } else if (
        error instanceof ApiError &&
        ['ROSTER_SOURCE_CHANGED', 'ROSTER_SOURCE_NOT_FOUND'].includes(
          error.code ?? '',
        )
      ) {
        dispatch({ type: 'clearHistory' })
        dispatch({
          type: 'notice',
          message: '历史来源已变化，请确认更新后的阵容',
        })
        void client.invalidateQueries({
          queryKey: queries.rosterPreview().queryKey,
        })
        void navigate(newSessionPath(source), { replace: true })
      } else if (
        error instanceof ApiError &&
        error.code === 'DEEPSEEK_NOT_CONFIGURED'
      ) {
        setMessage('尚未配置 DeepSeek，请按下方说明配置后重新确认')
        void providers.refetch()
      } else if (
        error instanceof ApiError &&
        error.code === 'ROSTER_MODEL_INACTIVE'
      ) {
        setMessage('历史阵容当前无法开场，请从当前目录重新选择')
      } else if (
        error instanceof ApiError &&
        (error.kind === 'input' || error.code === 'INVALID_REQUEST')
      ) {
        setMessage('阵容或座位无效，请返回选择或调整')
      } else {
        // 原 runtime 已等待创建后的活动定位；再显式读一次，不以旧 null 证明未创建。
        setUncertain(true)
        setMessage('暂无法确认是否已创建')
        await recover(captured)
      }
    } finally {
      locked.current = false
    }
  }
  async function recover(captured = draft) {
    if (recovering || !valid(captured)) return
    setRecovering(true)
    try {
      const read = await freshRead(client, runtime.activeOptions())
      if (!valid(captured)) return
      setMessage(
        read.valid()
          ? read.data
            ? '开场结果未确认，已找到活动训练场'
            : '当前未发现活动训练场，可重新确认开场'
          : '暂无法确认是否已创建',
      )
    } catch {
      if (valid(captured)) setMessage('暂无法确认是否已创建')
    } finally {
      // 排座可使捕获的草稿失效，但当前页面的读取操作仍须结束。
      if (live.current.mounted) setRecovering(false)
    }
  }
  if (!hasDraft) return null
  return (
    <div className="session-setup">
      <section className="setup-intro">
        <p className="step-label">组桌准备 / 02 确认开场</p>
        <h2>确认你的训练场</h2>
        <p>
          共 {rows.length + 1} 人 · 你和 {rows.length} 位 AI
        </p>
      </section>
      <section className="setup-summary" aria-label="固定规则">
        <h3>固定规则</h3>
        <p>小盲 10 · 大盲 20</p>
        <p>每席初始筹码 2,000（100BB）</p>
        <p>首手庄位由系统随机决定，开场后阵容锁定</p>
      </section>
      <section aria-label="阵容来源">
        <h3>{source === 'current' ? '来自当前人物目录' : '沿用上次阵容'}</h3>
        {source === 'latestEnded' ? (
          <>
            <p>保留原人物版本，不继承上一场记忆</p>
            {matched && preview.data ? (
              <p>结束于 {localTime(preview.data.endedAt)}</p>
            ) : (
              <p role="status">来源已变化，请返回选择阵容重新确认</p>
            )}
          </>
        ) : (
          <p>以当前人物创建新 AI，每位 AI 从空记忆开始</p>
        )}
      </section>
      <section aria-label="最终座位" className="confirm-seats">
        <h3>最终座位</h3>
        <p>你 · 座位 0 · 固定</p>
        <p className="home-muted">
          选择已有人的座位会交换两人
          {source === 'latestEnded' ? '；沿用阵容仅可交换原有座位' : ''}
        </p>
        {[...rows]
          .sort((a, b) => a.seatNumber - b.seatNumber)
          .map((row) => (
            <article key={row.key} className="setup-summary confirm-seat">
              <div className="persona-heading">
                <Avatar
                  displayName={row.persona?.name ?? '待重新确认'}
                  avatarColor={row.persona?.avatarColor ?? '#666666'}
                  decorative
                  size={40}
                />
                <h3>{row.persona?.name ?? '人物来源已失效'}</h3>
                <span>版本 {row.personaVersion ?? '待确认'}</span>
              </div>
              <Field
                as="select"
                id={`seat-${row.key}`}
                label={`${row.persona?.name ?? '此人物'}的目标座位`}
                value={row.seatNumber}
                disabled={busy || !row.persona}
                onChange={(event) => {
                  pendingFocus.current = event.currentTarget.id
                  const to = Number(event.target.value)
                  const other = rows.find((p) => p.seatNumber === to)
                  dispatch({ type: 'seat', source, from: row.seatNumber, to })
                  setAnnouncement(
                    other && other !== row
                      ? `${row.persona?.name}与${other.persona?.name}已交换座位`
                      : `${row.persona?.name}已移到座位 ${to}`,
                  )
                }}
              >
                {allowedSeats.map((n) => (
                  <option key={n} value={n}>
                    座位 {n} ·{' '}
                    {rows.find((p) => p.seatNumber === n)?.persona?.name ??
                      '空位'}
                  </option>
                ))}
              </Field>
            </article>
          ))}
        <p aria-live="polite">{announcement}</p>
        <Button
          variant="secondary"
          disabled={busy || rows.some((r) => !r.persona)}
          onClick={() => {
            dispatch({
              type: 'shuffle',
              source,
              seats: shuffleSeats(rows.map((r) => r.seatNumber)),
            })
            setAnnouncement('已随机排列 AI 座位')
          }}
        >
          随机排座
        </Button>
        <p className="home-muted">随机交换当前 AI 座位</p>
      </section>
      <section className="setup-summary" aria-label="DeepSeek 配置与连接">
        <h3>DeepSeek 配置与连接</h3>
        {provider ? (
          <>
            <StatusBadge tone={provider.configured ? 'neutral' : 'danger'}>
              {provider.configured ? '已配置 · ' : ''}
              {providerStatusMessages[provider.checkStatus]}
            </StatusBadge>
            {!provider.configured ? (
              <p>
                尚未配置 DeepSeek，暂不能开场。在后端私有环境配置 DeepSeek API
                Key，重启服务后点击“重新读取配置”。
              </p>
            ) : null}
            {provider.lastCheckedAt ? (
              <p>
                上次检测 {localTime(provider.lastCheckedAt)} ·
                仅代表上次检测结果
              </p>
            ) : null}
            {provider.errorCode ? (
              <p>{providerErrorMessages[provider.errorCode]}</p>
            ) : null}
            {provider.checkStatus === 'unavailable' ? (
              <p>仍可开场，实际 AI 调用失败时牌桌会暂停</p>
            ) : null}
          </>
        ) : null}
        {providers.isFetching ? <p role="status">正在读取配置…</p> : null}
        {providers.isError ? (
          <>
            <p>
              {check.isSuccess
                ? '检测请求已完成，状态读取失败'
                : '配置读取失败，重新读取成功前暂不能开场'}
            </p>
            <RequestError error={providers.error} hasData={!!provider} />
          </>
        ) : null}
        {check.isError ? <RequestError error={check.error} /> : null}
        <div className="setup-provider-actions">
          <Button
            variant="secondary"
            disabled={busy || check.isPending || providers.isFetching}
            onClick={() => void providers.refetch()}
          >
            重新读取配置
          </Button>
          <Button
            variant="secondary"
            disabled={
              busy ||
              check.isPending ||
              !provider?.configured ||
              !readReady(providers)
            }
            onClick={() => {
              if (detecting.current || locked.current || !interactive()) return
              detecting.current = true
              void check
                .mutateAsync({ provider: 'deepseek', body: {} })
                .catch(() => {})
                .finally(() => {
                  detecting.current = false
                })
            }}
          >
            {check.isPending ? '正在检测…' : '检测连接（可选）'}
          </Button>
        </div>
      </section>
      <div className="setup-actions">
        <p role="status">
          {creating
            ? '正在确认开场结果'
            : create.isPending
              ? '正在复核阵容与配置…'
              : message ||
                (!canContinue
                  ? '请完成活动场次与阵容读取，或返回选择阵容修复'
                  : !readReady(providers)
                    ? '请先成功读取配置'
                    : !provider?.canCreateSession
                      ? '请先配置 DeepSeek'
                      : check.isPending
                        ? '正在等待检测及状态刷新'
                        : '阵容已准备好')}
        </p>
        {continueTarget ? (
          <Button disabled={busy} onClick={() => go(continueTarget)}>
            继续当前训练场
          </Button>
        ) : null}
        {uncertain || active.isError ? (
          <Button
            variant="secondary"
            disabled={busy || recovering}
            onClick={() => void recover()}
          >
            重新读取活动场次
          </Button>
        ) : null}
        <Button disabled={!eligible} onClick={() => void submit()}>
          {uncertain ? '重新确认开场' : '确认开场'}
        </Button>
        <p className="home-muted">创建后直接发出第一手</p>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => navigate(newSessionPath(source))}
        >
          返回选择阵容
        </Button>
        {source === 'latestEnded' ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => navigate(newSessionPath())}
          >
            从当前目录重新选择
          </Button>
        ) : null}
        {create.isError &&
        !(create.error instanceof OpeningError) &&
        !message ? (
          <RequestError error={create.error} />
        ) : null}
      </div>
    </div>
  )
}
