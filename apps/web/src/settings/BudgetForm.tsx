import { useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import type { PlayerAgentSettings } from '@tx-holdem-coach/contracts'
import { queries } from '../query/options.js'
import { useSessionRuntime } from '../session-sync/react.js'
import { ApiError, errorMessage, fieldMessages } from '../api/errors.js'
import { Button, Field } from '../components/controls.js'
import {
  Feedback,
  LoadingFeedback,
  RequestError,
  focusFirstInvalid,
} from '../components/feedback.js'
import {
  budgetCandidate,
  budgetDraft,
  budgetFields,
  budgetPatch,
  type BudgetDraft,
} from './adapter.js'
export function BudgetForm() {
  const query = useQuery(queries.agent())
  const runtime = useSessionRuntime()
  const mutation = useMutation(runtime.mutations.updateAgentSettings())
  const [baseline, setBaseline] = useState<PlayerAgentSettings | null>(null)
  const [draft, setDraft] = useState<BudgetDraft>({
    attemptTimeoutSeconds: '',
    decisionDeadlineSeconds: '',
  })
  const [errors, setErrors] = useState<Record<string, string>>({})
  const form = useRef<HTMLFormElement>(null)
  const focusRequested = useRef(false)
  const dirty =
    baseline !== null &&
    budgetFields.some((key) => draft[key] !== String(baseline[key]))
  const observed = useRef<PlayerAgentSettings | undefined>(undefined)
  const latest = query.data?.settings
  useLayoutEffect(() => {
    if (
      latest &&
      !mutation.isPending &&
      (latest !== observed.current || (!dirty && !mutation.isSuccess))
    ) {
      observed.current = latest
      if (!dirty) {
        setBaseline(latest)
        setDraft(budgetDraft(latest))
      }
    }
  }, [latest, dirty, mutation.isPending, mutation.isSuccess])
  useLayoutEffect(() => {
    if (focusRequested.current && Object.keys(errors).length && form.current) {
      focusFirstInvalid(form.current)
      focusRequested.current = false
    }
  }, [errors])
  const candidate = budgetCandidate(draft)
  const hasChanges =
    baseline &&
    candidate.success &&
    budgetFields.some((key) => baseline[key] !== candidate.data[key])
  const changedServer =
    baseline &&
    latest &&
    budgetFields.some((key) => baseline[key] !== latest[key])
  const reset = () => {
    const value = latest ?? baseline
    if (value) {
      setBaseline(value)
      setDraft(budgetDraft(value))
      setErrors({})
      mutation.reset()
    }
  }
  async function save() {
    if (!baseline || mutation.isPending) return
    if (!candidate.success) {
      focusRequested.current = true
      setErrors(
        Object.fromEntries(
          candidate.error.issues.map((issue) => [
            String(issue.path[0]),
            '请输入范围内的整数，且完整决策时间不得小于单次超时。',
          ]),
        ),
      )
      return
    }
    if (!hasChanges || query.isFetching) return
    setErrors({})
    try {
      const result = await mutation.mutateAsync(
        budgetPatch(baseline, candidate.data),
      )
      setBaseline(result.settings)
      setDraft(budgetDraft(result.settings))
    } catch (error) {
      if (error instanceof ApiError) {
        focusRequested.current = true
        setErrors(
          fieldMessages(
            error,
            budgetFields.map((key) => `settings.${key}`),
          ),
        )
      }
    }
  }
  return (
    <section className="settings-section">
      <p className="eyebrow">行动节奏</p>
      <h2>Player 响应时间</h2>
      {query.isPending ? <LoadingFeedback /> : null}
      {query.error ? (
        <RequestError error={query.error} hasData={!!query.data} />
      ) : null}
      {baseline ? (
        <form
          ref={form}
          noValidate
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {Object.keys(errors).length ? (
            <Feedback
              alert
              title="请检查时间预算"
              description={Object.values(errors).join(' ')}
            />
          ) : null}
          {budgetFields.map((key, index) => (
            <Field
              key={key}
              id={key}
              label={
                index === 0 ? '单次尝试超时（秒）' : '完整决策 deadline（秒）'
              }
              hint={
                index === 0
                  ? '5–30 秒，默认 15 秒'
                  : '15–120 秒，默认 45 秒；不得小于单次超时'
              }
              type="number"
              inputMode="numeric"
              min={index === 0 ? 5 : 15}
              max={index === 0 ? 30 : 120}
              step={1}
              value={draft[key]}
              disabled={mutation.isPending}
              error={errors[key] ?? errors[`settings.${key}`]}
              onChange={(event) => {
                setDraft({ ...draft, [key]: event.target.value })
                setErrors({})
                mutation.reset()
              }}
              onBlur={() => {
                if (!candidate.success)
                  setErrors(
                    Object.fromEntries(
                      candidate.error.issues.map((issue) => [
                        String(issue.path[0]),
                        '请输入范围内的整数，且完整决策时间不得小于单次超时。',
                      ]),
                    ),
                  )
              }}
            />
          ))}
          {changedServer && dirty ? (
            <Feedback title="服务端设置已更新，可放弃草稿并重新载入" />
          ) : null}
          <div className="settings-actions">
            <Button
              type="submit"
              disabled={
                !hasChanges ||
                !candidate.success ||
                query.isFetching ||
                mutation.isPending
              }
            >
              {mutation.isPending ? '正在保存' : '保存时间预算'}
            </Button>
            <Button
              variant="secondary"
              disabled={mutation.isPending}
              onClick={reset}
            >
              取消修改并重新载入
            </Button>
          </div>
        </form>
      ) : null}
      {mutation.isError ? (
        <Feedback
          alert
          title="保存未完成"
          description={errorMessage(mutation.error)}
        />
      ) : null}
      {mutation.isSuccess ? (
        <Feedback
          title={
            query.isError ? '保存已完成，但最新读取未完成' : '时间预算已保存'
          }
          description="只影响之后新建的 Player AgentRun，不改变正在运行或已完成的 Run。"
        />
      ) : null}
      <Button
        variant="secondary"
        disabled={query.isFetching || mutation.isPending}
        onClick={() => void query.refetch()}
      >
        刷新时间预算
      </Button>
      <p>
        初始请求和最多两次内容纠错共享总时间。每次尝试取单次上限与剩余时间的较小值；开始新尝试前剩余不足
        5 秒会暂停。
      </p>
      <p>修改只影响之后新建的 Player AgentRun。</p>
      <p>Coach 复盘使用独立队列和预算，不占用 Player 行动保留槽位。</p>
    </section>
  )
}
