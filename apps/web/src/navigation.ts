import { generatePath, matchRoutes } from 'react-router'

export const paths = {
  home: '/',
  newSession: '/sessions/new',
  confirm: '/sessions/new/confirm',
  table: '/sessions/:sessionId',
  currentHand: '/sessions/:sessionId/current-hand',
  agents: '/sessions/:sessionId/agents',
  history: '/history',
  hand: '/hands/:handId',
  statistics: '/statistics',
  settings: '/settings',
  debug: '/debug',
  handRuns: '/debug/hands/:handId',
  run: '/debug/agent-runs/:runId',
  notFound: '*',
} as const

export type PageId = keyof typeof paths
export type Layout = 'regular' | 'table' | 'detail'
export type Tab = 'training' | 'history' | 'statistics'
type PageDefinition = {
  id: PageId
  path: string
  handle: { title: string; layout: Layout; tab: Tab | null }
}

function page(
  id: PageId,
  title: string,
  layout: Layout,
  tab: Tab | null = null,
): PageDefinition {
  return { id, path: paths[id], handle: { title, layout, tab } }
}

export const routes = [
  page('home', '训练', 'regular', 'training'),
  page('newSession', '选择阵容', 'regular', 'training'),
  page('confirm', '确认开场', 'regular', 'training'),
  page('table', '牌桌', 'table'),
  page('currentHand', '本手流程', 'detail'),
  page('agents', 'AI 状态', 'detail'),
  page('history', '历史', 'regular', 'history'),
  page('hand', '已完成手牌详情', 'detail'),
  page('statistics', '统计', 'regular', 'statistics'),
  page('settings', '设置', 'regular', 'training'),
  page('debug', '调试入口', 'detail'),
  page('handRuns', '手牌关联调用', 'detail'),
  page('run', '调用详情', 'detail'),
  page('notFound', '页面不存在', 'detail'),
]

export function resourcePath(
  id: 'table' | 'currentHand' | 'agents' | 'hand' | 'handRuns' | 'run',
  value: string,
) {
  return generatePath(paths[id], {
    sessionId: value,
    handId: value,
    runId: value,
  })
}

export function sessionHistoryPath(sessionId: string) {
  return `${paths.history}?${new URLSearchParams({ sessionId })}`
}

export type ReturnTarget = { pathname: string; search: string; label: string }
export function returnTarget(
  id: PageId,
  params: Record<string, string | undefined>,
  state: unknown,
): ReturnTarget {
  if (id === 'hand' || id === 'run') {
    const source = listReturnTarget(state)
    if (source) return source
  }
  if (id === 'currentHand' || id === 'agents') {
    return {
      pathname: resourcePath('table', params.sessionId!),
      search: '',
      label: '返回牌桌',
    }
  }
  if (id === 'hand')
    return { pathname: paths.history, search: '', label: '返回历史' }
  if (id === 'run' || id === 'handRuns')
    return { pathname: paths.debug, search: '', label: '返回调试入口' }
  if (id === 'debug')
    return { pathname: paths.settings, search: '', label: '返回设置' }
  if (id === 'confirm')
    return { pathname: paths.newSession, search: '', label: '返回选择阵容' }
  return {
    pathname: paths.home,
    search: '',
    label: id === 'table' ? '离开牌桌' : '返回训练首页',
  }
}

function listReturnTarget(state: unknown): ReturnTarget | undefined {
  if (
    !state ||
    typeof state !== 'object' ||
    !('pathname' in state) ||
    !('search' in state)
  )
    return
  const { pathname, search } = state
  if (typeof pathname !== 'string' || typeof search !== 'string') return
  if (
    !pathname.startsWith('/') ||
    pathname.startsWith('//') ||
    /[\\?#\s]/u.test(pathname)
  )
    return
  if (search !== '' && (!search.startsWith('?') || /[#\r\n]/u.test(search)))
    return
  // Browser URL normalization must not turn a matched resource path into another destination.
  if (new URL(pathname, 'https://navigation.invalid').pathname !== pathname)
    return
  const route = matchRoutes(routes, pathname)?.at(-1)?.route
  if (route?.id !== 'history' && route?.id !== 'handRuns') return
  return {
    pathname,
    search,
    label: route.id === 'history' ? '返回历史' : '返回手牌关联调用',
  }
}
