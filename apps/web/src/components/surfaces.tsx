import { useId, type ReactNode } from 'react'

/** Visual section only. M6.6 owns modal host, dismissal and focus lifecycle. */
export function DrawerSurface({
  title,
  closeAction,
  children,
  actions,
}: {
  title: string
  closeAction?: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  const titleId = useId()
  return (
    <section className="drawer-surface" aria-labelledby={titleId}>
      <header className="drawer-header">
        <h2 id={titleId}>{title}</h2>
        <div className="drawer-close">{closeAction}</div>
      </header>
      <div className="drawer-content">{children}</div>
      {actions ? <footer className="drawer-actions">{actions}</footer> : null}
    </section>
  )
}
