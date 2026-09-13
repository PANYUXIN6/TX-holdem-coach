import { SetupPage } from './session-setup/SetupPage.js'
import { EmptyState, StatusBadge } from './components/controls.js'
import { Home } from './home/Home.js'
import { Link, useParams } from 'react-router'
import { paths, resourcePath, sessionHistoryPath } from './navigation.js'
import type { PageId } from './navigation.js'

const descriptions: Partial<Record<PageId, string>> = {
  table:
    '牌桌控件将在后续接入。此地址指定目标场次，场次是否可用以服务端状态为准。',
  currentHand: '本手流程视图将在后续接入。',
  agents: 'AI 状态详情将在调用查询接入后显示。',
  history: '历史列表与筛选将在查询功能接入后开放。当前尚未读取手牌记录。',
  hand: '手牌详情将在查询功能接入后显示。手牌是否存在及是否已完成，以服务端响应为准。',
  statistics: '统计将在聚合查询接入后显示。这里将帮助你回看练习表现。',
  settings: '人物、模型供应商与数据管理设置将在后续接入。',
  debug: '调用查询接入后，可从手牌或 AI 状态进入对应的调用记录。',
  handRuns: '手牌关联调用将在查询功能接入后显示。当前尚未读取调用记录。',
  run: '调用详情将在查询功能接入后显示。当前尚未读取调用结果。',
}

export function Page({ id }: { id: PageId }) {
  const params = useParams()
  if (id === 'home') return <Home />
  if (id === 'newSession' || id === 'confirm')
    return <SetupPage confirm={id === 'confirm'} />
  if (id === 'notFound')
    return (
      <EmptyState
        title="这条路径没有对应页面"
        description="请使用上方入口返回训练首页，继续浏览。"
        action={
          <Link className="primary-link" to={paths.home}>
            返回训练首页 <span aria-hidden="true">↗</span>
          </Link>
        }
      />
    )
  const resourceId = params.sessionId ?? params.handId ?? params.runId
  return (
    <>
      <section className="notice">
        <StatusBadge>功能待接入</StatusBadge>
        <h2>这里将承载下一步练习</h2>
        <p>{descriptions[id]}</p>
        {resourceId ? (
          <p className="resource-label">
            目标标识 <span>{resourceId}</span>
          </p>
        ) : null}
      </section>
      <div className="page-links">
        {id === 'settings' ? (
          <Link to={paths.debug}>
            调试入口说明 <span aria-hidden="true">↗</span>
          </Link>
        ) : null}
        {id === 'table' ? (
          <>
            <Link to={resourcePath('currentHand', params.sessionId!)}>
              本手流程 <span aria-hidden="true">↗</span>
            </Link>
            <Link to={resourcePath('agents', params.sessionId!)}>
              AI 状态 <span aria-hidden="true">↗</span>
            </Link>
            <Link to={sessionHistoryPath(params.sessionId!)}>
              本场历史 <span aria-hidden="true">↗</span>
            </Link>
          </>
        ) : null}
      </div>
    </>
  )
}
