import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AgentRunPathParamsSchema,
  HandHistoryPathParamsSchema,
  type AgentCallPageRequest,
  type AgentRunDetailResponse,
} from '@tx-holdem-coach/contracts'
import { Button, EmptyState } from '../components/controls.js'
import { RequestError } from '../components/feedback.js'
import { callsSearch } from '../api/search.js'
import { queries } from '../query/options.js'
import { paths, resourcePath } from '../navigation.js'
import { useSessionRuntime } from '../session-sync/react.js'
import { useDebugStore, useDebugUi } from '../ui/react.js'
import { useDebugRows } from '../ui/debug-rows.js'
import { useReadForeground } from '../ai-status/queries.js'
import { AuditFields, AttemptFields, CapabilityFields } from './AuditFields.js'
import { useRunAudit } from './queries.js'
import '../ai-status/ai-status.css'

export function DebugEntry() {
  const runtime = useSessionRuntime()
  const active = useQuery(runtime.activeOptions())
  return (
    <section className="audit-card">
      <h2>调用审计</h2>
      <p>这里展示已记录的技术摘要。请从本场 AI 或手牌进入具体请求。</p>
      {active.error ? (
        <RequestError
          error={active.error}
          retry={() => void active.refetch()}
        />
      ) : null}
      {active.data ? (
        <Link className="audit-link" to={resourcePath('agents', active.data)}>
          活动场次 AI 状态 ↗
        </Link>
      ) : (
        <p>没有已确认的活动场次，可从手牌调用入口查看已有记录。</p>
      )}
      <Link className="audit-link" to={paths.settings}>
        返回设置
      </Link>
    </section>
  )
}
export function HandRunsPage() {
  const parsed = HandHistoryPathParamsSchema.safeParse(useParams())
  return parsed.success ? (
    <HandRuns id={parsed.data.handId.toLowerCase()} />
  ) : (
    <EmptyState title="手牌地址无效" description="请从场次或手牌进入。" />
  )
}
function HandRuns({ id }: { id: string }) {
  const location = useLocation()
  const navigate = useNavigate()
  const page = callsSearch.decode(location.search)
  const foreground = useReadForeground()
  const client = useQueryClient()
  const options = queries.handCalls(id, page)
  const query = useQuery({
    ...options,
    enabled: foreground,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (q) =>
      foreground && !q.state.error && q.state.data?.hand.status === 'inProgress'
        ? 3000
        : false,
    refetchIntervalInBackground: false,
  })
  const [previous, setPrevious] = useState<string[]>([])
  const key = JSON.stringify(options.queryKey)
  useEffect(() => {
    if (!foreground)
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    return () => {
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    }
  }, [client, key, foreground])
  return (
    <div className="ai-status-page">
      {query.error ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {query.data ? (
        <>
          <section className="audit-card">
            <h2>
              第 {query.data.hand.handNumber} 手 · {query.data.hand.status}
            </h2>
            <Link
              className="audit-link"
              to={resourcePath('agents', query.data.hand.sessionId)}
            >
              返回本场 AI
            </Link>
            {query.data.hand.status !== 'aborted' ? (
              <Link
                className="audit-link"
                to={
                  query.data.hand.status === 'completed'
                    ? resourcePath('hand', id)
                    : resourcePath('currentHand', query.data.hand.sessionId)
                }
              >
                {query.data.hand.status === 'completed'
                  ? '返回已完成手详情'
                  : '返回本手流程'}
              </Link>
            ) : (
              <p>此手已中止，仅保留技术记录。</p>
            )}
            <p>按创建时间升序排列；本页不代表最新请求。</p>
            <p>
              最近读取：{new Date(query.dataUpdatedAt).toLocaleTimeString()}
            </p>
          </section>
          {query.data.items.length === 0 ? (
            <p>尚无调用记录</p>
          ) : (
            query.data.items.map((run) => (
              <article className="audit-card" key={run.runId}>
                <Link
                  className="audit-link"
                  to={resourcePath('run', run.runId)}
                  state={{
                    pathname: location.pathname,
                    search: location.search,
                  }}
                >
                  查看请求 {run.decisionRequestId ?? run.runId}
                </Link>
                <AuditFields
                  fields={[
                    ['Run ID', run.runId],
                    ['角色 / 状态', `${run.runtime} / ${run.lifecycle}`],
                    ['执行模式', run.executionMode],
                    ['开始时间', run.startedAt],
                    ['终止原因', run.terminationReasonCode],
                  ]}
                />
              </article>
            ))
          )}
          <div className="audit-pagination">
            <Button
              variant="secondary"
              disabled={!previous.length}
              onClick={() => {
                const search = previous.at(-1)!
                setPrevious(previous.slice(0, -1))
                void navigate({ search })
              }}
            >
              前页
            </Button>
            <Button
              variant="secondary"
              disabled={
                !query.data.nextCursor || query.isFetching || query.isError
              }
              onClick={() => {
                setPrevious([...previous, location.search])
                void navigate({
                  search: callsSearch.encode({
                    query: page.query,
                    cursor: query.data!.nextCursor,
                  }),
                })
              }}
            >
              后续记录
            </Button>
          </div>
        </>
      ) : !query.error ? (
        <p role="status">正在读取调用记录…</p>
      ) : null}
    </div>
  )
}
export function RunPage() {
  const parsed = AgentRunPathParamsSchema.safeParse(useParams())
  return parsed.success ? (
    <RunContent key={parsed.data.runId} id={parsed.data.runId.toLowerCase()} />
  ) : (
    <EmptyState title="请求地址无效" description="请从手牌或 AI 状态进入。" />
  )
}
function RunContent({ id }: { id: string }) {
  const audit = useRunAudit(id)
  const { parent, hand } = audit
  const store = useDebugStore()
  const tab = useDebugUi((s) => s.tab)
  const [attemptPages, setAttemptPages] = useState<(string | null)[]>([null])
  const [capabilityPages, setCapabilityPages] = useState<(string | null)[]>([
    null,
  ])
  const move = (pages: (string | null)[], cursor: string | null) => {
    const index = pages.indexOf(cursor)
    return index === -1 ? [...pages, cursor] : pages.slice(0, index + 1)
  }
  const setAttemptCursor = (cursor: string | null) =>
    setAttemptPages((pages) => move(pages, cursor))
  const setCapabilityCursor = (cursor: string | null) =>
    setCapabilityPages((pages) => move(pages, cursor))
  const attemptCursor = attemptPages.at(-1)!
  const capabilityCursor = capabilityPages.at(-1)!
  useEffect(() => {
    if (!parent.data) {
      setAttemptCursor(null)
      setCapabilityCursor(null)
      store.getState().reset()
    }
  }, [parent.data, store])
  useEffect(() => {
    if (!audit.allowChildren) store.getState().select(null)
  }, [audit.allowChildren, store])
  return (
    <div className="ai-status-page">
      {parent.error ? (
        <RequestError
          error={parent.error}
          retry={() => void parent.refetch()}
        />
      ) : null}
      {hand.error ? (
        <RequestError error={hand.error} retry={() => void hand.refetch()} />
      ) : null}
      {parent.data ? (
        <>
          <Link
            className="audit-link"
            to={resourcePath('agents', parent.data.sessionId)}
          >
            返回本场 AI
          </Link>
          <p>
            最近读取：{new Date(parent.dataUpdatedAt).toLocaleTimeString()}
            {parent.isError || hand.isError
              ? ' · 读取失败，以下为旧技术摘要'
              : ''}
          </p>
          <div className="audit-tabs" aria-label="调用视图">
            {(['summary', 'attempts', 'invocations'] as const).map((value) => (
              <Button
                key={value}
                variant={tab === value ? 'primary' : 'secondary'}
                aria-pressed={tab === value}
                onClick={() => store.getState().setTab(value)}
              >
                {
                  {
                    summary: '摘要',
                    attempts: '模型尝试',
                    invocations: '能力调用',
                  }[value]
                }
              </Button>
            ))}
          </div>
          {tab === 'summary' ? (
            <RunSummary run={parent.data} allowAction={audit.allowAction} />
          ) : audit.allowChildren ? (
            <AuditChildren
              key={`${id}:${tab}`}
              id={id}
              tab={tab}
              polling={audit.polling}
              foreground={audit.foreground}
              terminalKey={`${parent.data.lifecycle}:${hand.data?.hand.status}`}
              previousCursor={(tab === 'attempts'
                ? attemptPages
                : capabilityPages
              ).at(-2)}
              cursor={tab === 'attempts' ? attemptCursor : capabilityCursor}
              setCursor={
                tab === 'attempts' ? setAttemptCursor : setCapabilityCursor
              }
            />
          ) : (
            <p>正在重新验证资源可见性，暂不展示子记录。</p>
          )}
        </>
      ) : !parent.error ? (
        <p role="status">正在读取请求摘要…</p>
      ) : null}
    </div>
  )
}
export function RunSummary({
  run: r,
  allowAction,
}: {
  run: AgentRunDetailResponse
  allowAction: boolean
}) {
  const decision = r.decision
  const action =
    decision.kind === 'summary' ? decision.normalizedAction : undefined
  return (
    <section className="audit-card">
      <AuditFields
        fields={[
          ['Run ID', r.runId],
          ['请求 ID', r.decisionRequestId],
          ['场次 ID', r.sessionId],
          ['手牌 ID', r.handId],
          ['角色', r.runtime],
          ['执行模式', r.executionMode],
          ['生命周期', r.lifecycle],
          ['来源状态版本', r.sourceStateVersion],
          ['创建时间', r.createdAt],
          ['开始时间', r.startedAt],
          ['完成时间', r.completedAt],
          ['终止原因', r.terminationReasonCode],
          [
            '本次命令事件序号',
            r.commandEventRange
              ? `${r.commandEventRange.firstEventSeq}–${r.commandEventRange.lastEventSeq}`
              : '暂无已提交命令事件',
          ],
          [
            'Decision',
            decision.kind === 'none' ? 'none · 尚无决策记录' : decision.status,
          ],
          [
            '终态结果',
            decision.kind === 'summary' ? decision.terminalOutcome : null,
          ],
          [
            '公开行动',
            !allowAction
              ? '可见性待重新验证或此手状态下不展示'
              : action?.status === 'visible'
                ? `${action.action.type}${'targetStreetCommitment' in action.action ? ` ${action.action.targetStreetCommitment}` : ''}（${decision.kind === 'summary' && decision.status === 'committed' ? '已提交' : '尚未提交'}）`
                : action?.status === 'withheld'
                  ? '此手状态下不展示'
                  : '尚无合法选择',
          ],
        ]}
      />
      {(
        [
          ['前序运行', r.parentRunId],
          ['替代运行', r.replacementRunId],
          ['重执行来源', r.reexecutionSourceRunId],
        ] as const
      ).map(([label, id]) =>
        id ? (
          <Link className="audit-link" key={label} to={resourcePath('run', id)}>
            {label}：{id}
          </Link>
        ) : null,
      )}
      <p>请求正文：本版本未提供（{r.contentAvailability.requestBody}）。</p>
      <p>原始响应：本版本未提供（{r.contentAvailability.rawResponse}）。</p>
      <p>
        逐项校验详情：本版本未提供（{r.contentAvailability.validationDetails}
        ）。
      </p>
    </section>
  )
}
function AuditChildren({
  id,
  tab,
  cursor,
  setCursor,
  previousCursor,
  polling,
  foreground,
  terminalKey,
}: {
  id: string
  tab: 'attempts' | 'invocations'
  cursor: string | null
  setCursor: (cursor: string | null) => void
  previousCursor: string | null | undefined
  polling: boolean
  foreground: boolean
  terminalKey: string
}) {
  return tab === 'attempts' ? (
    <Attempts
      id={id}
      cursor={cursor}
      setCursor={setCursor}
      previousCursor={previousCursor}
      polling={polling}
      foreground={foreground}
      terminalKey={terminalKey}
    />
  ) : (
    <Capabilities
      id={id}
      cursor={cursor}
      setCursor={setCursor}
      previousCursor={previousCursor}
      polling={polling}
      foreground={foreground}
      terminalKey={terminalKey}
    />
  )
}
type ChildProps = Omit<Parameters<typeof AuditChildren>[0], 'tab'>
function Attempts({
  id,
  cursor,
  setCursor,
  previousCursor,
  polling,
  foreground,
  terminalKey,
}: ChildProps) {
  const client = useQueryClient()
  const [options, setOptions] = useState<Awaited<
    ReturnType<typeof queries.attempts>
  > | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  const page: AgentCallPageRequest = { query: { limit: 20 }, cursor }
  useEffect(() => {
    let active = true
    setOptions(null)
    setError(null)
    if (foreground)
      void queries.attempts(client, id, page).then(
        (o) => {
          if (active) setOptions(o)
        },
        (e) => {
          if (active) setError(e)
        },
      )
    return () => {
      active = false
    }
  }, [client, id, cursor, foreground, terminalKey, reload])
  return options ? (
    <AttemptRows
      options={options}
      setCursor={setCursor}
      previousCursor={previousCursor}
      polling={polling}
      foreground={foreground}
    />
  ) : error ? (
    <RequestError error={error} retry={() => setReload((value) => value + 1)} />
  ) : (
    <p>正在验证并读取模型尝试…</p>
  )
}
function AttemptRows({
  options,
  setCursor,
  previousCursor,
  polling,
  foreground,
}: {
  options: Awaited<ReturnType<typeof queries.attempts>>
  setCursor: ChildProps['setCursor']
  previousCursor: string | null | undefined
  polling: boolean
  foreground: boolean
}) {
  const client = useQueryClient()
  const query = useQuery({
    ...options,
    enabled: foreground,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (q) => (polling && !q.state.error ? 3000 : false),
    refetchIntervalInBackground: false,
  })
  const selection = useDebugRows(
    'attempt',
    query.data?.items.map((a) => a.attemptId) ?? [],
    JSON.stringify(options.queryKey),
  )
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    },
    [client, options],
  )
  return (
    <>
      {query.error ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {query.data?.items.length === 0 ? (
        <p>尚无模型尝试，尚未开始供应商请求。</p>
      ) : null}
      {query.data?.items.map((a) => (
        <article className="audit-card" key={a.attemptId}>
          <Button
            variant="secondary"
            aria-expanded={selection.selectedId === a.attemptId}
            onClick={() => selection.select(a.attemptId)}
          >
            尝试 {a.attemptNumber} · {a.lifecycle}
            {a.routingReasonCode === 'content_correction' ? ' · 内容纠错' : ''}
          </Button>
          <AttemptFields
            attempt={a}
            expanded={selection.selectedId === a.attemptId}
          />
        </article>
      ))}
      <ChildPagination
        next={query.data?.nextCursor}
        disabled={query.isFetching || query.isError}
        setCursor={setCursor}
        previousCursor={previousCursor}
      />
    </>
  )
}
function Capabilities({
  id,
  cursor,
  setCursor,
  previousCursor,
  polling,
  foreground,
  terminalKey,
}: ChildProps) {
  const client = useQueryClient()
  const [options, setOptions] = useState<Awaited<
    ReturnType<typeof queries.capabilities>
  > | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setOptions(null)
    setError(null)
    if (foreground)
      void queries
        .capabilities(client, id, { query: { limit: 20 }, cursor })
        .then(
          (o) => {
            if (active) setOptions(o)
          },
          (e) => {
            if (active) setError(e)
          },
        )
    return () => {
      active = false
    }
  }, [client, id, cursor, foreground, terminalKey, reload])
  return options ? (
    <CapabilityRows
      options={options}
      setCursor={setCursor}
      previousCursor={previousCursor}
      polling={polling}
      foreground={foreground}
    />
  ) : error ? (
    <RequestError error={error} retry={() => setReload((value) => value + 1)} />
  ) : (
    <p>正在验证并读取能力调用…</p>
  )
}
function CapabilityRows({
  options,
  setCursor,
  previousCursor,
  polling,
  foreground,
}: {
  options: Awaited<ReturnType<typeof queries.capabilities>>
  setCursor: ChildProps['setCursor']
  previousCursor: string | null | undefined
  polling: boolean
  foreground: boolean
}) {
  const client = useQueryClient()
  const query = useQuery({
    ...options,
    enabled: foreground,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (q) => (polling && !q.state.error ? 3000 : false),
    refetchIntervalInBackground: false,
  })
  const selection = useDebugRows(
    'invocation',
    query.data?.items.map((a) => a.invocationId) ?? [],
    JSON.stringify(options.queryKey),
  )
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    },
    [client, options],
  )
  return (
    <>
      {query.error ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {query.data?.items.length === 0 ? <p>尚无能力调用记录</p> : null}
      {query.data?.items.map((c) => (
        <article className="audit-card" key={c.invocationId}>
          <Button
            variant="secondary"
            aria-expanded={selection.selectedId === c.invocationId}
            onClick={() => selection.select(c.invocationId)}
          >
            调用 {c.invocationNumber} · {c.capabilityName}
          </Button>
          {selection.selectedId === c.invocationId ? (
            <CapabilityFields invocation={c} />
          ) : (
            <p>
              {c.authorized ? '已授权' : '未授权'} ·{' '}
              {c.errorCode ?? '无错误记录'}
            </p>
          )}
        </article>
      ))}
      <ChildPagination
        next={query.data?.nextCursor}
        disabled={query.isFetching || query.isError}
        setCursor={setCursor}
        previousCursor={previousCursor}
      />
    </>
  )
}
function ChildPagination({
  next,
  disabled,
  setCursor,
  previousCursor,
}: {
  next?: string | null | undefined
  disabled: boolean
  setCursor: (cursor: string | null) => void
  previousCursor: string | null | undefined
}) {
  return (
    <div className="audit-pagination">
      <Button
        variant="secondary"
        disabled={previousCursor === undefined || disabled}
        onClick={() => {
          if (previousCursor !== undefined) setCursor(previousCursor)
        }}
      >
        前页
      </Button>
      <Button
        variant="secondary"
        disabled={!next || disabled}
        onClick={() => {
          setCursor(next!)
        }}
      >
        后续记录
      </Button>
    </div>
  )
}
