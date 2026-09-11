import type { ComponentPropsWithRef, ReactNode } from 'react'

export type ButtonVariant =
  'primary' | 'secondary' | 'fold' | 'call' | 'raise' | 'danger'
export function Button({
  variant = 'primary',
  type = 'button',
  className = '',
  ...props
}: ComponentPropsWithRef<'button'> & { variant?: ButtonVariant }) {
  return (
    <button
      {...props}
      type={type}
      className={`button button-${variant} ${className}`}
    />
  )
}

type FieldContent = {
  label: string
  hint?: ReactNode
  error?: ReactNode
  id: string
}
type FieldProps = FieldContent &
  (
    | ({ as?: 'input' } & ComponentPropsWithRef<'input'>)
    | ({ as: 'select' } & ComponentPropsWithRef<'select'>)
    | ({ as: 'textarea' } & ComponentPropsWithRef<'textarea'>)
  )
/** The caller owns the value and validation. Native props/ref belong to the control. */
export function Field({ label, hint, error, id, ...props }: FieldProps) {
  const describedBy =
    [
      props['aria-describedby'],
      hint ? `${id}-hint` : '',
      error ? `${id}-error` : '',
    ]
      .filter(Boolean)
      .join(' ') || undefined
  const common = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : props['aria-invalid'],
    className: `field-control ${props.className ?? ''}`,
  } as const
  let control: ReactNode
  if (props.as === 'select') {
    const { as: _, ...native } = props
    control = <select {...native} {...common} />
  } else if (props.as === 'textarea') {
    const { as: _, ...native } = props
    control = <textarea {...native} {...common} />
  } else {
    const { as: _, ...native } = props
    control = <input {...native} {...common} />
  }
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {control}
      {hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="field-error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  )
}

export function StatusBadge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: 'neutral' | 'active' | 'paused' | 'danger'
}) {
  return <span className={`status-badge status-${tone}`}>{children}</span>
}
export function EmptyState({
  title,
  description,
  action,
}: {
  title: string
  description: ReactNode
  action?: ReactNode
}) {
  return (
    <section className="notice empty-state">
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="page-links">{action}</div> : null}
    </section>
  )
}
export function DangerSection({
  title,
  description,
  action,
}: {
  title: string
  description: ReactNode
  action: ReactNode
}) {
  return (
    <section className="danger-section">
      <h2>{title}</h2>
      <p>{description}</p>
      <div className="page-links">{action}</div>
    </section>
  )
}
