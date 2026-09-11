import { Button } from './components/controls.js'
import { Component } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import type { ReturnTarget } from './navigation.js'

type Props = { children: ReactNode; fallback: (reset: () => void) => ReactNode }

export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  render() {
    return this.state.failed
      ? this.props.fallback(() => this.setState({ failed: false }))
      : this.props.children
  }
}

export function RootError() {
  return (
    <main
      style={{
        maxWidth: 430,
        margin: '0 auto',
        padding: 24,
        color: '#edf2ef',
        background: '#131b18',
        fontFamily: 'sans-serif',
      }}
    >
      <h1>应用暂时无法显示</h1>
      <p>请返回训练首页，或刷新页面后再试。</p>
      <a
        href="/"
        style={{ display: 'inline-block', padding: 12, color: '#8bd9be' }}
      >
        返回训练首页
      </a>
      <button
        type="button"
        onClick={() => window.location.reload()}
        style={{ minHeight: 44, padding: '8px 16px' }}
      >
        刷新页面
      </button>
    </main>
  )
}

export function PageError({
  reset,
  target,
}: {
  reset: () => void
  target: ReturnTarget
}) {
  return (
    <section className="notice error-notice" role="alert">
      <h2>此页面暂时无法显示</h2>
      <p>可以重新显示此页面，或返回上级入口。</p>
      <div className="page-links">
        <Button
          variant="secondary"
          onClick={() => {
            reset()
            document.getElementById('page-title')?.focus()
          }}
        >
          重新显示
        </Button>
        <Link to={target}>{target.label}</Link>
      </div>
    </section>
  )
}
