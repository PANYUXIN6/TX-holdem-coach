import { SetupScope, SetupErrorReset } from './session-setup/react.js'
import { ConfirmationHost } from './ui/confirmation-host.js'
import { useOverlayUi } from './ui/react.js'
import { ModalEnvironment } from './components/modal.js'
import { SessionRouteFeedback } from './session-sync/feedback.js'
import { StatusBadge } from './components/controls.js'
import { PageUiProvider } from './ui/react.js'
import { SessionRouteBridge } from './session-sync/react.js'
import {
  useState,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Link, matchRoutes, Outlet, useLocation } from 'react-router'
import { ErrorBoundary, PageError } from './ErrorBoundary.js'
import { paths, returnTarget, routes } from './navigation.js'

const orientationQuery =
  '(pointer: coarse) and (min-width: 431px) and (max-height: 430px) and (orientation: landscape)'
let orientationMedia: MediaQueryList | undefined
function getMedia() {
  return (orientationMedia ??= window.matchMedia(orientationQuery))
}
function subscribeOrientation(listener: () => void) {
  const media = getMedia()
  media.addEventListener('change', listener)
  return () => media.removeEventListener('change', listener)
}
function getOrientation() {
  return getMedia().matches
}

const tabs = [
  { id: 'training', to: paths.home, label: '训练', mark: '♠' },
  { id: 'history', to: paths.history, label: '历史', mark: '≡' },
  { id: 'statistics', to: paths.statistics, label: '统计', mark: '↗' },
] as const

export function Shell({ tableActions }: { tableActions?: ReactNode } = {}) {
  const [destructivePending, setDestructivePending] = useState(false)
  const confirmationOpen = useOverlayUi((state) => state.active !== null)
  const location = useLocation()
  const matched = matchRoutes(routes, location)!.at(-1)!
  const { id, handle } = matched.route
  const target = returnTarget(
    id,
    matched.params,
    location.state,
    location.search,
  )
  const rotated = useSyncExternalStore(
    subscribeOrientation,
    getOrientation,
    () => false,
  )
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLElement>(null)
  const rotationHeading = useRef<HTMLHeadingElement>(null)

  useLayoutEffect(() => {
    document.title = `${handle.title} · 德州扑克 AI 练习`
    content.current?.scrollTo(0, 0)
    heading.current?.focus({ preventScroll: true })
  }, [location.pathname, handle.title])

  useLayoutEffect(() => {
    const next = rotated ? rotationHeading.current : heading.current
    next?.focus({ preventScroll: true })
  }, [rotated])

  return (
    <ModalEnvironment
      value={{ rotated, routeKey: location.pathname, confirmationOpen }}
    >
      <div className="phone-canvas">
        <div
          className={`page-layout layout-${handle.layout}`}
          hidden={rotated}
          inert={rotated}
        >
          <header className="page-header">
            <div className="header-topline">
              {id === 'home' ? (
                <span className="wordmark">♠ 扑克练习室</span>
              ) : (
                <Link className="back-link" to={target}>
                  ← {target.label}
                </Link>
              )}
              {id === 'home' ? (
                <Link className="settings-link" to={paths.settings}>
                  设置 ↗
                </Link>
              ) : null}
            </div>
            <h1 id="page-title" ref={heading} tabIndex={-1}>
              {handle.title}
            </h1>
          </header>
          <SetupScope>
            <ErrorBoundary
              key={location.pathname}
              fallback={(reset) => (
                <main
                  ref={content}
                  className="page-content"
                  aria-labelledby="page-title"
                >
                  <SetupErrorReset />
                  <PageError reset={reset} target={target} />
                </main>
              )}
            >
              <PageUiProvider>
                <SessionRouteBridge />
                <SessionRouteFeedback destructivePending={destructivePending}>
                  <main
                    ref={content}
                    className="page-content"
                    aria-labelledby="page-title"
                  >
                    <Outlet />
                  </main>
                  {handle.layout === 'table' ? (
                    <footer className="table-actions">
                      {tableActions ?? (
                        <>
                          <StatusBadge>功能待接入</StatusBadge>
                          牌桌操作将在功能接入后开放
                        </>
                      )}
                    </footer>
                  ) : null}
                </SessionRouteFeedback>
              </PageUiProvider>
            </ErrorBoundary>
          </SetupScope>
          <ConfirmationHost
            rotated={rotated}
            onPending={setDestructivePending}
          />
          {handle.layout === 'regular' ? (
            <nav className="main-nav" aria-label="主导航">
              {tabs.map((tab) => (
                <Link
                  key={tab.id}
                  to={tab.to}
                  aria-current={handle.tab === tab.id ? 'page' : undefined}
                >
                  <span className="nav-mark" aria-hidden="true">
                    {tab.mark}
                  </span>
                  <span>{tab.label}</span>
                </Link>
              ))}
            </nav>
          ) : null}
        </div>
        <section
          className="rotation-notice"
          hidden={!rotated}
          aria-labelledby="rotation-title"
        >
          <span className="rotation-symbol" aria-hidden="true">
            ↻
          </span>
          <h1 id="rotation-title" tabIndex={-1} ref={rotationHeading}>
            请旋转至竖屏
          </h1>
          <p>竖屏呈现完整的练习界面。</p>
        </section>
      </div>
    </ModalEnvironment>
  )
}
