import { useId, type ReactNode } from 'react'

/** Visual section only. M6.6 owns modal host, dismissal and focus lifecycle. */
export function DrawerSurface({
  title,
  titleId: suppliedTitleId,
  closeAction,
  children,
  actions,
}: {
  title: string
  titleId?: string
  closeAction?: ReactNode
  children: ReactNode
  actions?: ReactNode
}) {
  const generatedTitleId = useId()
  const titleId = suppliedTitleId ?? generatedTitleId
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
