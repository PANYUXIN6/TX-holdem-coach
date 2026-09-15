import { useState, type CSSProperties } from 'react'
import type { Card } from '@tx-holdem-coach/contracts'
import { avatarMark, cardPresentation } from './presentation.js'

export function Avatar({
  displayName,
  avatarColor,
  size = 40,
  decorative = false,
}: {
  displayName: string
  avatarColor: string
  size?: 32 | 40 | 48
  decorative?: boolean
}) {
  return (
    <span
      className="avatar"
      style={
        {
          '--avatar-size': `${size / 16}rem`,
          backgroundColor: avatarColor,
        } as CSSProperties
      }
      role={decorative ? undefined : 'img'}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : displayName}
    >
      {avatarMark(displayName)}
    </span>
  )
}
export type PlayingCardProps = { size?: 36 | 44 | 56 } & (
  | { state: 'face'; card: Card; label?: never }
  | { state: 'back'; card?: never; label?: never }
  | { state: 'empty'; card?: never; label: string }
)
function CardImage({ src }: { src: string }) {
  const [failed, setFailed] = useState(false)
  return failed ? (
    <span className="card-image-error">牌图不可用</span>
  ) : (
    <img
      src={src}
      alt=""
      width={153}
      height={216}
      onError={() => setFailed(true)}
    />
  )
}
/** Pass only a visible Card; back/empty cannot carry concealed values. */
export function PlayingCard(props: PlayingCardProps) {
  const face = props.state === 'face' ? cardPresentation(props.card) : undefined
  const label =
    face?.label ?? (props.state === 'empty' ? props.label : '未公开底牌')
  const src =
    face?.src ?? (props.state === 'back' ? '/poker/card_back.png' : undefined)
  return (
    <span
      role="img"
      aria-label={label}
      className={`playing-card card-${props.state}`}
      style={{ '--card-width': `${props.size ?? 44}px` } as CSSProperties}
    >
      <span className="card-art" aria-hidden="true">
        {src ? (
          <CardImage key={src} src={src} />
        ) : (
          <span className="card-slot-mark">—</span>
        )}
      </span>
    </span>
  )
}
const amountFormat = new Intl.NumberFormat('zh-CN')
export function ChipAmount({
  amount,
  unit = '筹码',
}: {
  amount: number
  unit?: string
}) {
  return (
    <span className="chip-amount">
      {amountFormat.format(amount)} <span className="chip-unit">{unit}</span>
    </span>
  )
}
