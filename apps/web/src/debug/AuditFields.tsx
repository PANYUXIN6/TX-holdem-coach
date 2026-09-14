import type { ReactNode } from 'react'
import type {
  AgentAttemptSummary,
  AgentCapabilityInvocationSummary,
} from '@tx-holdem-coach/contracts'

export function AuditFields({
  fields,
}: {
  fields: ReadonlyArray<readonly [string, ReactNode]>
}) {
  return (
    <dl className="audit-fields">
      {fields.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value ?? '未记录'}</dd>
        </div>
      ))}
    </dl>
  )
}
export function AttemptFields({
  attempt: a,
  expanded = true,
}: {
  attempt: AgentAttemptSummary
  expanded?: boolean
}) {
  const accounting = {
    providerReported: '供应商报告',
    reservedUpperBound: '预留上界',
    pending: '待记录',
    notIncurred: '未发生调用',
  }
  return (
    <AuditFields
      fields={[
        ['尝试序号', a.attemptNumber],
        ['最后记录阶段', a.stage],
        ['状态', a.lifecycle],
        ['供应商 / 模型', `${a.provider} / ${a.model}`],
        ['尝试类型', a.attemptType],
        [
          '路由原因',
          a.routingReasonCode === 'content_correction'
            ? '内容纠错'
            : a.routingReasonCode,
        ],
        ['已接受', a.accepted ? '是' : '否'],
        ['校验状态', a.validationStatus],
        ['错误码', a.errorCode],
        [
          '持久耗时',
          a.durationMs === null ? '未记录 / 尚未完成' : `${a.durationMs} ms`,
        ],
        ['Token 记账', accounting[a.usage.accounting]],
        [
          '输入 / 输出 Token',
          a.usage.accounting === 'pending'
            ? '待记录'
            : `${a.usage.inputTokens} / ${a.usage.outputTokens}`,
        ],
        ...(expanded
          ? ([
              ['Attempt ID', a.attemptId],
              ['开始时间', a.startedAt],
              ['结束时间', a.completedAt],
              ['请求摘要 hash', a.requestProjectionHash],
              ['响应摘要 hash', a.responseProjectionHash],
            ] as const)
          : []),
      ]}
    />
  )
}
export function CapabilityFields({
  invocation: c,
}: {
  invocation: AgentCapabilityInvocationSummary
}) {
  return (
    <AuditFields
      fields={[
        ['调用序号', c.invocationNumber],
        ['能力', `${c.capabilityName} v${c.capabilityVersion}`],
        ['已授权', c.authorized ? '是' : '否'],
        ['开始时间', c.startedAt],
        ['结束时间', c.completedAt],
        [
          '持久耗时',
          c.durationMs === null ? '未记录 / 尚未完成' : `${c.durationMs} ms`,
        ],
        [
          '输入 / 输出 Schema 版本',
          `${c.inputSchemaVersion} / ${c.outputSchemaVersion ?? '未记录'}`,
        ],
        ['调用 ID', c.invocationId],
        ['输入 hash', c.inputHash],
        ['输出 hash', c.outputHash],
        ['错误码', c.errorCode],
      ]}
    />
  )
}
