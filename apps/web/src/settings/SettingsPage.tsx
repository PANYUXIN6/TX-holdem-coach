import { SettingsTime } from './SettingsTime.js'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { queries } from '../query/options.js'
import { useSessionRuntime } from '../session-sync/react.js'
import { Button, DangerSection, StatusBadge } from '../components/controls.js'
import {
  Feedback,
  LoadingFeedback,
  RequestError,
} from '../components/feedback.js'
import { providerErrorMessages } from '../api/errors.js'
import { useOverlayStore, usePageScope } from '../ui/react.js'
import { paths } from '../navigation.js'
import { providerSummary } from './adapter.js'
import { BudgetForm } from './BudgetForm.js'
import { SessionDirectory } from './SessionDirectory.js'
import './settings.css'
function ProviderSection() {
  const query = useQuery(queries.providers())
  const runtime = useSessionRuntime()
  const check = useMutation(runtime.mutations.checkProvider())
  const provider = query.data?.deepSeek
  const summary = provider ? providerSummary(provider) : null
  return (
    <section className="settings-section" aria-labelledby="provider-heading">
      <p className="eyebrow">连接配置</p>
      <h2 id="provider-heading">DeepSeek</h2>
      {query.isPending ? <LoadingFeedback /> : null}
      {provider && summary ? (
        <dl>
          <div>
            <dt>API Key</dt>
            <dd>{summary.key}</dd>
          </div>
          <div>
            <dt>开场能力</dt>
            <dd>{summary.capacity}</dd>
          </div>
          <div>
            <dt>最近检测</dt>
            <dd>
              <StatusBadge>{summary.status}</StatusBadge>
            </dd>
          </div>
          {provider.lastCheckedAt ? (
            <div>
              <dt>检测时间</dt>
              <dd>
                <SettingsTime value={provider.lastCheckedAt} />
              </dd>
            </div>
          ) : null}
          {provider.errorCode ? (
            <div>
              <dt>诊断代码</dt>
              <dd>
                {providerErrorMessages[provider.errorCode]} ·{' '}
                {provider.errorCode}
              </dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      <p>摘要只读取本机配置。点击检测连接才会请求供应商。</p>
      {query.error ? (
        <RequestError error={query.error} hasData={!!query.data} />
      ) : null}
      {check.isError ? (
        <Feedback
          alert
          title="检测未完成"
          description="已有摘要保持不变，请重新读取或手动检测。"
        />
      ) : null}
      {check.isSuccess ? (
        <Feedback
          title={
            query.isError
              ? '检测请求已完成，但最新摘要读取失败'
              : '检测请求已完成'
          }
        />
      ) : null}
      <div className="settings-actions">
        <Button
          variant="secondary"
          disabled={query.isFetching || check.isPending}
          onClick={() => void query.refetch()}
        >
          刷新摘要
        </Button>
        <Button
          disabled={check.isPending}
          onClick={() => check.mutate({ provider: 'deepseek', body: {} })}
        >
          {check.isPending ? '正在检测' : '检测连接'}
        </Button>
      </div>
    </section>
  )
}
function StorageSection() {
  const query = useQuery(queries.health())
  return (
    <section className="settings-section">
      <h2>数据存储</h2>
      {query.isPending ? (
        <LoadingFeedback />
      ) : (
        <StatusBadge tone={query.isError ? 'danger' : 'active'}>
          {query.isError ? '数据存储不可用' : '数据存储可用'}
        </StatusBadge>
      )}
      <div className="settings-actions">
        <Button
          variant="secondary"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          重新检测数据存储
        </Button>
      </div>
    </section>
  )
}
export function SettingsPage() {
  const store = useOverlayStore()
  const scope = usePageScope()
  return (
    <div className="settings-page">
      <ProviderSection />
      <BudgetForm />
      <StorageSection />
      <SessionDirectory />
      <section className="settings-section">
        <h2>调用审计</h2>
        <Link className="primary-link" to={paths.debug}>
          进入调用审计 ↗
        </Link>
      </section>
      <DangerSection
        title="危险区域"
        description="永久删除在线训练数据，应用内无法恢复。"
        action={
          <Button
            variant="danger"
            onClick={() => store.getState().open(scope, { kind: 'clearData' })}
          >
            清空全部应用数据
          </Button>
        }
      />
    </div>
  )
}
