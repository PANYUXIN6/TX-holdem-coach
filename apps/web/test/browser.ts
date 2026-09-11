// 手工浏览器验收入口，Vite 产品 build 不包含它。通过 DevTools hook 观察实际 Provider。
import type { SessionRuntime } from '../src/session-sync/runtime.js'
import type { QueryClient } from '@tanstack/react-query'
type Fiber = {
  child?: Fiber
  sibling?: Fiber
  memoizedProps?: { client?: QueryClient; runtime?: SessionRuntime }
  memoizedState?: { failed?: boolean }
  stateNode?: { setState?: (state: { failed: boolean }) => void }
}
const boundaries: NonNullable<Fiber['stateNode']>[] = []
let runtime: SessionRuntime | undefined
let current: QueryClient | undefined
let first: QueryClient | undefined
function visit(fiber: Fiber | undefined): void {
  if (!fiber) return
  if (
    typeof fiber.memoizedState?.failed === 'boolean' &&
    fiber.stateNode?.setState
  )
    boundaries.push(fiber.stateNode)
  runtime = fiber.memoizedProps?.runtime ?? runtime
  const client = fiber.memoizedProps?.client
  if (client && typeof client.getQueryCache === 'function') {
    current = client
    first ??= client
  }
  visit(fiber.child)
  visit(fiber.sibling)
}
Object.assign(window, {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    supportsFiber: true,
    inject: () => 1,
    onCommitFiberRoot: (_id: number, root: { current: Fiber }) => {
      boundaries.length = 0
      current = undefined
      visit(root.current)
    },
    onCommitFiberUnmount: () => {},
  },
})
// 桌面验收只模拟 coarse 指针；尺寸和 change 事件仍由浏览器原生驱动。
const nativeMatchMedia = window.matchMedia.bind(window)
window.matchMedia = (query) =>
  nativeMatchMedia(query.replace('(pointer: coarse) and ', ''))
if (new URLSearchParams(location.search).has('ui')) {
  await import('./ui-browser.js')
} else {
  await import('../src/main.js')
  const { api } = await import('../src/api/client.js')
  const { errorMessage } = await import('../src/api/errors.js')
  const result = document.getElementById('result')!
  document.getElementById('read')!.onclick = () => {
    void api.health().then(
      (data) => {
        result.textContent = `GET: ${data.status}/${data.database}`
      },
      (error: unknown) => {
        result.textContent = errorMessage(error)
      },
    )
  }
  document.getElementById('write')!.onclick = () => {
    void api.checkProvider('deepseek', {}).then(
      (data) => {
        result.textContent = `POST: ${data.deepSeek.checkStatus}`
      },
      (error: unknown) => {
        result.textContent = errorMessage(error)
      },
    )
  }
  document.getElementById('identity')!.onclick = () => {
    document.getElementById('client')!.textContent =
      first && first === current ? 'QueryClient 同实例' : 'QueryClient 实例异常'
  }

  document.getElementById('page-error')!.onclick = () =>
    boundaries.at(-1)?.setState?.({ failed: true })
  document.getElementById('root-error')!.onclick = () =>
    boundaries[0]?.setState?.({ failed: true })

  const { installSyncAcceptance } = await import('./sync-browser.js')
  installSyncAcceptance(() => ({ client: current, runtime }))
}
