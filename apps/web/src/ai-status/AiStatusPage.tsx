import { CurrentRunAudit } from './CurrentRunAudit.js'
import { useContext, useLayoutEffect, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router'
import { SessionPathParamsSchema } from '@tx-holdem-coach/contracts'
import { Button, EmptyState, StatusBadge } from '../components/controls.js'
import { RequestError } from '../components/feedback.js'
import { Avatar, ChipAmount } from '../components/identity.js'
import { ModalEnvironment } from '../components/modal.js'
import { resourcePath } from '../navigation.js'
import { useOverlayStore, usePageScope } from '../ui/react.js'
import {
  pauseCommandOptions,
  pauseIntentMatches,
  type PauseIntent,
} from './adapter.js'
import { useAiStatus } from './queries.js'
import './ai-status.css'

export function AiStatusPage() {
  const parsed = SessionPathParamsSchema.safeParse(useParams())
  return parsed.success ? (
    <AiStatusPanel id={parsed.data.sessionId.toLowerCase()} />
  ) : (
    <EmptyState title="场次地址无效" description="请从训练首页进入。" />
  )
}
export function AiStatusPanel({
  id,
  compact = false,
}: {
  id: string
  compact?: boolean
}) {
  const { ai, session, matches, foreground } = useAiStatus(id)
  const snapshot = session.data
  const scope = usePageScope()
  const overlay = useOverlayStore()
  const client = useQueryClient()
  const environment = useContext(ModalEnvironment)
  const active = useRef(false)
  const intentRef = useRef<PauseIntent | null>(null)
  useLayoutEffect(() => {
    active.current = foreground && !environment.rotated
    if (!active.current) {
      intentRef.current = null
      overlay.getState().closeOwned(scope)
    }
    return () => {
      active.current = false
      intentRef.current = null
    }
  }, [foreground, environment.rotated, scope, overlay])
  const retry = useMutation(
    pauseCommandOptions(
      client,
      session.runtime,
      (intent) =>
        active.current &&
        !document.hidden &&
        intentRef.current === intent &&
        intent.scope === scope,
    ),
  )
  const coordination = matches ? ai.data?.coordination : undefined
  const run =
    coordination && coordination.state !== 'idle' ? coordination.run : undefined
  const intent: PauseIntent | null =
    coordination?.state === 'paused' && snapshot?.hand
      ? {
          scope,
          sessionId: id,
          handId: snapshot.hand.handId,
          stateVersion: snapshot.stateVersion,
          eventSeq: snapshot.eventSeq,
          expectedPausedRunId: coordination.run.runId,
        }
      : null
  const eligible =
    intent !== null &&
    foreground &&
    !environment.rotated &&
    session.canSubmit &&
    !retry.isPending &&
    session.runtime.pendingOperations(id).length === 0 &&
    pauseIntentMatches(intent, client)
  const debug = run
    ? resourcePath('run', run.runId)
    : snapshot?.hand
      ? resourcePath('handRuns', snapshot.hand.handId)
      : null
  if (session.status === 'missing') return null
  const names = { idle: 'AI 空闲', thinking: 'AI 思考中', paused: 'AI 已暂停' }
  const triggerNames = {
    initial: '当前 AI 请求',
    manualRetry: '人工重新请求',
    processRestart: '服务重启后重新请求',
    staleReplacement: '旧请求失效，已重新请求',
  }
  return (
    <div className="ai-status-page">
      <section className="ai-status-card">
        <StatusBadge>
          {coordination ? names[coordination.state] : 'AI 状态更新中'}
        </StatusBadge>
        {!matches && snapshot ? (
          <p>上次确认：{names[snapshot.agentRunState]}。动态摘要等待同步。</p>
        ) : null}
        {coordination?.state === 'idle' ? (
          <p>
            {snapshot?.hand?.currentActorSeatNumber === 0
              ? '等待玩家行动。'
              : snapshot?.hand
                ? '等待 AI 调度，尚未建立模型请求。'
                : '当前没有运行中的 AI 请求。'}
          </p>
        ) : null}
        {run ? (
          <>
            <p>
              {triggerNames[run.trigger]} · 座位 {run.actorSeatNumber}
            </p>
            <dl className="audit-fields">
              <dt>请求 ID</dt>
              <dd>{run.decisionRequestId}</dd>
              <dt>场次当前事件序号</dt>
              <dd>{snapshot?.eventSeq}</dd>
            </dl>
          </>
        ) : null}
        {coordination?.state === 'paused' ? (
          <>
            <p role="alert">
              AI 行动暂停：{failureLabel(coordination.reasonCode)}
            </p>
            <p>DeepSeek · 精确失败阶段：本版本未提供。</p>
          </>
        ) : null}
        {run && coordination && coordination.state !== 'idle' && !compact ? (
          <CurrentRunAudit
            // 暂停时重新读取当前摘要，随后由 paused 策略关闭所有 interval。
            key={`${run.runId}:${coordination.state}`}
            id={run.runId}
            state={coordination.state}
          />
        ) : null}
        {ai.error ? (
          <RequestError error={ai.error} retry={() => void ai.refetch()} />
        ) : null}
        {!matches && !ai.error ? (
          <Button
            variant="secondary"
            disabled={ai.isFetching || !foreground}
            onClick={() => void ai.refetch()}
          >
            重新读取 AI 状态
          </Button>
        ) : null}
        {snapshot?.agentRunState === 'paused' ? (
          <div className="ai-actions">
            <Button
              disabled={!eligible}
              onClick={() => {
                if (!eligible || !intent) return
                intentRef.current = intent
                retry.mutate(intent)
              }}
            >
              {retry.isPending ? '正在重新请求…' : '重新请求当前 AI 行动'}
            </Button>
            <Button
              variant="danger"
              disabled={!eligible}
              onClick={() => {
                if (eligible && intent)
                  overlay
                    .getState()
                    .open(scope, { kind: 'abortHandAndEndSession', ...intent })
              }}
            >
              中止本手并结束场次
            </Button>
          </div>
        ) : null}
        {retry.error ? <RequestError error={retry.error} /> : null}
        {debug ? (
          <Link className="audit-link" to={debug}>
            查看调试信息 ↗
          </Link>
        ) : null}
      </section>
      {!compact && ai.data
        ? ai.data.personas
            .filter((p) =>
              snapshot?.seats.some(
                (s) =>
                  s.playerId === p.participantId &&
                  s.seatNumber === p.seatNumber,
              ),
            )
            .map((p) => {
              const seat = snapshot?.seats.find(
                (s) => s.playerId === p.participantId,
              )
              return (
                <article className="ai-persona-card" key={p.participantId}>
                  <header>
                    <Avatar
                      displayName={p.displayName}
                      avatarColor={p.avatarColor}
                    />
                    <div>
                      <h2>{p.displayName}</h2>
                      <p>
                        座位 {p.seatNumber} · v{p.personaVersion} ·{' '}
                        {run?.participantId === p.participantId
                          ? names[coordination!.state]
                          : 'idle'}
                      </p>
                    </div>
                  </header>
                  {seat ? (
                    <p>
                      <ChipAmount amount={seat.stack} /> · {seat.status}
                    </p>
                  ) : null}
                  <p>{p.backgroundDescription}</p>
                  <p>{p.teachingSummary}</p>
                  <details>
                    <summary>五维风格</summary>
                    <dl className="audit-fields">
                      {Object.entries(p.style).map(([key, value]) => (
                        <div key={key}>
                          <dt>
                            {
                              (
                                {
                                  tightness: '紧度',
                                  aggression: '进攻性',
                                  bluffTendency: '诈唬倾向',
                                  pressureCallTendency: '抗压跟注',
                                  riskPreference: '风险偏好',
                                } as Record<string, string>
                              )[key]
                            }
                          </dt>
                          <dd>{value}/100</dd>
                        </div>
                      ))}
                    </dl>
                  </details>
                </article>
              )
            })
        : null}
    </div>
  )
}
export function failureLabel(code: string) {
  const names: Record<string, string> = {
    provider_timeout: '供应商请求超时',
    provider_network_error: '供应商网络连接失败',
    provider_auth_error: '供应商认证失败',
    provider_rate_limited: '供应商请求受限',
    provider_billing_unavailable: '供应商额度不可用',
    content_correction_exhausted: '内容纠错后仍未获得合法行动',
    process_restart: '服务进程已重启',
    local_persistence_error: '运行记录保存失败',
  }
  return names[code] ?? `技术执行失败（${code}）`
}
