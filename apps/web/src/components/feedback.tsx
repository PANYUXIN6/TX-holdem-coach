import type { ReactNode } from 'react'
import { ApiError, errorMessage } from '../api/errors.js'
import { Button } from './controls.js'

export function Feedback({
  title,
  description,
  action,
  busy = false,
  alert = false,
}: {
  title: string
  description?: ReactNode
  action?: ReactNode
  busy?: boolean
  alert?: boolean
}) {
  return (
    <section className="feedback" aria-busy={busy}>
      <div role={alert ? 'alert' : 'status'}>
        <strong>{title}</strong>
        {description ? <p>{description}</p> : null}
      </div>
      {action ? <div className="feedback-actions">{action}</div> : null}
    </section>
  )
}
export function LoadingFeedback({
  refreshing = false,
}: {
  refreshing?: boolean
}) {
  return <Feedback title={refreshing ? '正在更新…' : '正在加载…'} busy />
}
export function RequestError({
  error,
  hasData = false,
  retry,
  busy = false,
}: {
  error: unknown
  hasData?: boolean
  retry?: () => void
  busy?: boolean
}) {
  const message = errorMessage(error)
  if (!message) return null
  const missing = error instanceof ApiError && error.status === 404
  return (
    <Feedback
      title={
        missing
          ? '资源已不可用'
          : hasData
            ? '更新失败，当前显示上次读取结果'
            : '读取未完成'
      }
      description={message}
      action={
        !missing && retry ? (
          <Button variant="secondary" disabled={busy} onClick={retry}>
            重新读取
          </Button>
        ) : undefined
      }
    />
  )
}
/** 表单只传入已知字段；提交失败后由调用者执行。 */
export function focusFirstInvalid(form: HTMLFormElement) {
  form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
}
