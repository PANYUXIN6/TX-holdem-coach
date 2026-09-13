import { useEffect, useId } from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import type { AgentPersonaStyle } from '@tx-holdem-coach/contracts'
import type { UseQueryResult } from '@tanstack/react-query'
import { Button, StatusBadge } from '../components/controls.js'
import { Avatar } from '../components/identity.js'
import { LoadingFeedback, RequestError } from '../components/feedback.js'
import { ApiError } from '../api/errors.js'
import {
  newSessionPath,
  parseRosterSource,
  paths,
  resourcePath,
} from '../navigation.js'
import { localTime } from '../home/model.js'
import { useSetup } from './react.js'
import { previewMatches, readReady } from './model.js'

const styles: [keyof AgentPersonaStyle, string][] = [
  ['tightness', '松紧度 · 越高越紧'],
  ['aggression', '激进度'],
  ['bluffTendency', '诈唬倾向'],
  ['pressureCallTendency', '抗压跟注倾向'],
  ['riskPreference', '风险偏好'],
]
function ReadFeedback({ query }: { query: UseQueryResult<unknown> }) {
  return (
    <>
      {query.isPending || query.isFetching ? (
        <LoadingFeedback refreshing={query.data !== undefined} />
      ) : null}
      {query.isError ? (
        <RequestError
          error={query.error}
          hasData={query.data !== undefined}
          busy={query.isFetching}
          retry={() => void query.refetch()}
        />
      ) : null}
    </>
  )
}
function PersonaCard({
  persona,
  selected,
  disabled,
  onChange,
}: {
  persona: {
    name: string
    avatarColor: string
    backgroundDescription: string
    teachingSummary: string
    style: AgentPersonaStyle
  }
  selected?: boolean
  disabled?: boolean
  onChange?: () => void
}) {
  const id = useId()
  return (
    <article className={`persona-card${selected ? ' persona-selected' : ''}`}>
      <div className="persona-heading">
        <Avatar
          displayName={persona.name}
          avatarColor={persona.avatarColor}
          size={48}
          decorative
        />
        <h3 id={`${id}-title`}>{persona.name}</h3>
        {onChange ? (
          <label className="persona-choice">
            <input
              type="checkbox"
              aria-labelledby={`${id}-title ${id}-choice`}
              checked={selected ?? false}
              disabled={disabled}
              onChange={onChange}
            />
            <span id={`${id}-choice`}>{selected ? '已选' : '选择'}</span>
          </label>
        ) : null}
      </div>
      <p>{persona.backgroundDescription}</p>
      <p className="persona-teaching">{persona.teachingSummary}</p>
      <dl className="persona-style">
        {styles.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            <dd>
              {persona.style[key]}/100
              <span className="persona-meter" aria-hidden="true">
                <span style={{ width: `${persona.style[key]}%` }} />
              </span>
            </dd>
          </div>
        ))}
      </dl>
    </article>
  )
}
function SetupContent({ confirm }: { confirm: boolean }) {
  const { source, draft, dispatch, catalog, preview, active, canContinue } =
    useSetup()
  const navigate = useNavigate()
  const hasDraft =
    source === 'current' ? draft.selections.length >= 5 : draft.preview !== null
  useEffect(() => {
    if (confirm && !hasDraft) {
      dispatch({ type: 'notice' })
      navigate(newSessionPath(source), { replace: true })
    }
  }, [confirm, hasDraft, dispatch, navigate, source])
  if (confirm && !hasDraft) return null
  const sourceQuery = source === 'current' ? catalog : preview
  const noHistory =
    preview.error instanceof ApiError &&
    preview.error.code === 'ROSTER_SOURCE_NOT_FOUND'
  const inactiveHistory =
    preview.error instanceof ApiError &&
    preview.error.code === 'ROSTER_MODEL_INACTIVE'
  const count =
    source === 'current'
      ? draft.selections.length
      : (preview.data?.agents.length ?? 0)
  const matched = previewMatches(draft.preview, preview.data)
  const reason = !readReady(active)
    ? '请先完成活动场次读取'
    : active.data
      ? '请先完成当前训练场'
      : !readReady(sourceQuery)
        ? '请先成功读取当前阵容'
        : source === 'latestEnded' && !matched
          ? '来源已变化，请确认更新后的阵容'
          : count < 5
            ? `再选 ${5 - count} 位即可继续`
            : !canContinue
              ? '已选人物已失效，请移除后重新选择'
              : '阵容已准备好'
  return (
    <div className="session-setup">
      <section className="setup-intro">
        <p className="step-label">
          组桌准备 / {confirm ? '02 确认开场' : '01 选择阵容'}
        </p>
        <h2>
          {confirm
            ? '你的同桌阵容'
            : source === 'current'
              ? '选择你的对手'
              : '沿用上次已结束训练场'}
        </h2>
        <p>
          {source === 'current'
            ? '选择 5–8 位 AI 对手，与你组成 6–9 人桌'
            : '保留原人物版本，不继承上一场记忆；下一步可调整座位'}
        </p>
        {draft.notice && !confirm ? <p role="status">请先确认阵容</p> : null}
        <ReadFeedback query={active} />
        {active.data ? (
          <Link
            className="primary-link"
            to={resourcePath('table', active.data)}
          >
            进入当前训练场 ↗
          </Link>
        ) : null}
      </section>
      <ReadFeedback query={sourceQuery} />
      {source === 'latestEnded' ? (
        <>
          {noHistory ? (
            <p>尚无已结束场次，可从当前目录选择人物。</p>
          ) : inactiveHistory ? (
            <p>该历史阵容当前无法用于新训练，可重新选择。</p>
          ) : null}
          {preview.data ? (
            <p className="home-muted">
              结束于{' '}
              <time dateTime={preview.data.endedAt}>
                {localTime(preview.data.endedAt)}
              </time>{' '}
              · {count} 位 AI
            </p>
          ) : null}
          {!matched && readReady(preview) && preview.data ? (
            <Button
              onClick={() => {
                if (readReady(preview) && preview.data)
                  dispatch({ type: 'accept', preview: preview.data })
              }}
            >
              使用更新后的阵容
            </Button>
          ) : null}
          <Link className="button button-secondary" to={newSessionPath()}>
            从当前目录重新选择
          </Link>
          <p className="home-muted">会清空本次沿用选择</p>
        </>
      ) : !confirm ? (
        <section className="setup-source">
          {readReady(preview) ? (
            <Link
              className="button button-secondary"
              to={newSessionPath('latestEnded')}
            >
              沿用上一场阵容
            </Link>
          ) : (
            <Button variant="secondary" disabled>
              沿用上一场阵容
            </Button>
          )}
          <p className="home-muted">
            {noHistory ? '尚无已结束场次' : '用完整历史阵容替换已选人物'}
          </p>
          {!noHistory ? <ReadFeedback query={preview} /> : null}
        </section>
      ) : null}
      <section className="setup-summary" aria-label="已选阵容">
        <p aria-live="polite">
          <strong>已选 {count} 位 AI</strong> / 共 {count + 1} 人
        </p>
        {source === 'current' ? (
          <ul>
            {draft.selections.map((s) => {
              const persona = catalog.data?.personas.find(
                (p) => p.personaId === s.personaId,
              )
              const valid = persona?.personaVersion === s.personaVersion
              return (
                <li key={s.personaId}>
                  <span>
                    {persona?.name ?? '人物已不在当前目录'}
                    {!valid ? ' · 已失效，请重新选择' : ''}
                    {confirm && valid ? ` · 版本 ${s.personaVersion}` : ''}
                  </span>
                  {!confirm ? (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        dispatch({ type: 'remove', personaId: s.personaId })
                      }
                    >
                      移除
                    </Button>
                  ) : null}
                </li>
              )
            })}
          </ul>
        ) : confirm && matched ? (
          <ul>
            {draft.preview?.assignments.map((a) => {
              const persona = preview.data!.agents.find(
                (p) => p.sourceSeatNumber === a.sourceSeatNumber,
              )!
              return (
                <li key={a.sourceSeatNumber}>
                  {persona.name} · 版本 {persona.personaVersion} · 座位{' '}
                  {a.seatNumber}
                </li>
              )
            })}
          </ul>
        ) : null}
      </section>
      {confirm ? (
        <section className="notice">
          <StatusBadge>开场功能待接入</StatusBadge>
          <p>此处为阵容只读摘要。排座、配置检测与正式开场将在下一阶段开放。</p>
          <p>{reason}</p>
          <Link to={newSessionPath(source)}>返回选择阵容</Link>
        </section>
      ) : (
        <>
          <p className="home-muted">
            人物设定倾向，非实战统计；除松紧度外，数值越高表示倾向越强。
          </p>
          {source === 'current' &&
          readReady(catalog) &&
          (catalog.data?.personas.length ?? 0) < 5 ? (
            <p>
              {catalog.data?.personas.length === 0
                ? '暂无可选人物'
                : '当前可选人物不足五位，暂不能开桌'}
            </p>
          ) : null}
          {source === 'current' && count === 8 ? (
            <p>已选满八位，先取消一人才能选入其他人物。</p>
          ) : null}
          <div className="persona-list">
            {source === 'current'
              ? catalog.data?.personas.map((persona) => {
                  const selected = draft.selections.some(
                    (p) => p.personaId === persona.personaId,
                  )
                  return (
                    <PersonaCard
                      key={persona.personaId}
                      persona={persona}
                      selected={selected}
                      disabled={
                        !selected && (!readReady(catalog) || count >= 8)
                      }
                      onChange={() => {
                        if (selected)
                          dispatch({
                            type: 'remove',
                            personaId: persona.personaId,
                          })
                        else if (readReady(catalog))
                          dispatch({
                            type: 'select',
                            personaId: persona.personaId,
                            personaVersion: persona.personaVersion,
                          })
                      }}
                    />
                  )
                })
              : preview.data?.agents.map((persona) => (
                  <PersonaCard
                    key={persona.sourceSeatNumber}
                    persona={persona}
                  />
                ))}
          </div>
          <div className="setup-actions">
            <p>{reason}</p>
            <Button
              disabled={!canContinue}
              onClick={() => {
                if (canContinue)
                  navigate(
                    `${paths.confirm}${source === 'latestEnded' ? '?rosterSource=latestEnded' : ''}`,
                  )
              }}
            >
              下一步：确认开场
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
export function SetupPage({ confirm = false }: { confirm?: boolean }) {
  const location = useLocation()
  if (parseRosterSource(location.search) === 'invalid')
    return (
      <section className="notice">
        <h2>组桌入口参数无效</h2>
        <p>请返回普通组桌重新选择入口。</p>
        <Link to={paths.newSession}>返回普通组桌</Link>
      </section>
    )
  return <SetupContent confirm={confirm} />
}
