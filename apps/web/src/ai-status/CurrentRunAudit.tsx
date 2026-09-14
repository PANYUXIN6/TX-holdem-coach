import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { queries } from '../query/options.js'
import { RequestError } from '../components/feedback.js'
import { Button } from '../components/controls.js'
import { useRunAudit } from '../debug/queries.js'
import { AttemptFields, AuditFields } from '../debug/AuditFields.js'

export function CurrentRunAudit({
  id,
  state,
}: {
  id: string
  state: 'thinking' | 'paused'
}) {
  const audit = useRunAudit(id, state)
  const client = useQueryClient()
  const [options, setOptions] = useState<Awaited<
    ReturnType<typeof queries.attempts>
  > | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let active = true
    setOptions(null)
    if (audit.foreground && audit.allowChildren) {
      setError(null)
      void queries
        .attempts(client, id, { query: { limit: 20 }, cursor: null })
        .then(
          (value) => {
            if (active) setOptions(value)
          },
          (value) => {
            if (active) setError(value)
          },
        )
    }
    return () => {
      active = false
    }
  }, [
    client,
    id,
    audit.foreground,
    audit.allowChildren,
    audit.parent.data?.lifecycle,
    reload,
  ])
  return (
    <div>
      {audit.parent.error ? (
        <RequestError
          error={audit.parent.error}
          retry={() => void audit.parent.refetch()}
        />
      ) : null}
      {audit.hand.error ? (
        <RequestError
          error={audit.hand.error}
          retry={() => void audit.hand.refetch()}
        />
      ) : null}
      {audit.parent.data ? (
        <AuditFields
          fields={[
            ['运行状态', audit.parent.data.lifecycle],
            [
              '最后记录 Decision 阶段',
              audit.parent.data.decision.kind === 'none'
                ? '尚无记录'
                : audit.parent.data.decision.status,
            ],
          ]}
        />
      ) : null}
      {error ? (
        <RequestError error={error} retry={() => setReload((n) => n + 1)} />
      ) : null}
      {options ? (
        <CurrentAttempts options={options} polling={audit.polling} />
      ) : null}
    </div>
  )
}
function CurrentAttempts({
  options,
  polling,
}: {
  options: Awaited<ReturnType<typeof queries.attempts>>
  polling: boolean
}) {
  const client = useQueryClient()
  const query = useQuery({
    ...options,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchInterval: (q) => (polling && !q.state.error ? 3000 : false),
    refetchIntervalInBackground: false,
  })
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: options.queryKey, exact: true })
    },
    [client, options],
  )
  const last = query.data?.items.at(-1)
  return (
    <>
      {query.error ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {last ? (
        <>
          <p>
            最后记录尝试 {last.attemptNumber}
            {last.routingReasonCode === 'content_correction'
              ? ' · 内容纠错'
              : ''}
          </p>
          <details>
            <summary>模型尝试详情</summary>
            <AttemptFields attempt={last} expanded={false} />
          </details>
        </>
      ) : query.data ? (
        <p>尚未开始供应商请求。</p>
      ) : null}
      {query.data?.nextCursor ? (
        <p>当前页并非完整调用链，请在调试页查看后续记录。</p>
      ) : null}
      <Button
        variant="secondary"
        disabled={query.isFetching}
        onClick={() => void query.refetch()}
      >
        重新读取技术摘要
      </Button>
    </>
  )
}
