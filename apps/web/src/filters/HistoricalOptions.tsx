import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { sessionsSearch } from '../api/search.js'
import { queries } from '../query/options.js'
import { Button } from '../components/controls.js'
import { RequestError } from '../components/feedback.js'
export function HistoricalOptions({
  session,
  config,
}: {
  session: (id: string) => void
  config: (key: string) => void
}) {
  const [cursor, setCursor] = useState<string | null>(null)
  const query = useQuery(
    queries.sessions({ ...sessionsSearch.decode(''), cursor }),
  )
  const configs = new Map(
    query.data?.items.flatMap((item) =>
      item.roster.flatMap((person) =>
        person.kind === 'ai'
          ? [[person.configSnapshotKey, person] as const]
          : [],
      ),
    ),
  )
  return (
    <section>
      <h3>本批历史场次</h3>
      {query.error ? (
        <RequestError error={query.error} retry={() => void query.refetch()} />
      ) : null}
      {query.isPending ? <p role="status">正在读取历史选项…</p> : null}
      {query.data?.items.map((item) => (
        <div className="history-option" key={item.sessionId}>
          <p>
            {new Date(item.createdAt).toLocaleString()} · {item.sessionId}
          </p>
          <Button variant="secondary" onClick={() => session(item.sessionId)}>
            按此场次筛选
          </Button>
        </div>
      ))}
      <h3>本批场次中的人物</h3>
      {[...configs].map(([key, person]) => (
        <div className="history-option" key={key}>
          <p>
            {person.displayName} · {person.personaId} · v{person.personaVersion}
          </p>
          <details>
            <summary>完整配置键</summary>
            <p>{key}</p>
          </details>
          <Button variant="secondary" onClick={() => config(key)}>
            按此人物配置筛选
          </Button>
        </div>
      ))}
      {query.data?.items.length === 0 ? <p>没有历史场次</p> : null}
      <div className="history-links">
        <Button
          variant="secondary"
          disabled={!cursor}
          onClick={() => setCursor(null)}
        >
          回到首批
        </Button>
        <Button
          variant="secondary"
          disabled={
            !query.data?.nextCursor || query.isFetching || query.isError
          }
          onClick={() => setCursor(query.data!.nextCursor)}
        >
          下一批
        </Button>
      </div>
    </section>
  )
}
