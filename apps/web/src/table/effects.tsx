import { useContext, useLayoutEffect, type RefObject } from 'react'
import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { ModalEnvironment } from '../components/modal.js'
import { useTableAnimation, useTableScope } from '../ui/react.js'

/** Authority is rendered immediately; animations only decorate current DOM. */
export function TableEffects({
  root,
  snapshot,
  status,
}: {
  root: RefObject<HTMLElement | null>
  snapshot: PublicSessionSnapshot
  status: string
}) {
  const batch = useTableAnimation((s) => s.batch)
  const scope = useTableScope()
  const { rotated } = useContext(ModalEnvironment)
  useLayoutEffect(() => {
    if (!batch) return
    const ack = () => scope.animation.getState().ack(batch)
    // Query notifications may render just after the synchronous effect store.
    // Let the already accepted newer snapshot render before consuming its batch.
    if (
      batch.sessionId === snapshot.sessionId &&
      batch.stateVersion > snapshot.stateVersion &&
      status === 'ready' &&
      !rotated
    )
      return
    const animations: Animation[] = []
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const finish = () => {
      animations.forEach((animation) => animation.cancel())
      ack()
    }
    const stop = () => {
      if (document.hidden || media.matches) finish()
    }
    if (
      rotated ||
      document.hidden ||
      media.matches ||
      status !== 'ready' ||
      snapshot.lifecycleStatus !== 'active' ||
      batch.sessionId !== snapshot.sessionId ||
      batch.stateVersion !== snapshot.stateVersion ||
      batch.handId !== (snapshot.hand?.handId ?? null)
    ) {
      ack()
      return
    }
    const animate = (selector: string, deal = false) => {
      const element = root.current?.querySelector<HTMLElement>(selector)
      if (!element) return
      const bounds = element.getBoundingClientRect()
      const viewport = root.current
        ?.closest('.page-content')
        ?.getBoundingClientRect()
      if (
        bounds.top < Math.max(0, viewport?.top ?? 0) ||
        bounds.bottom >
          Math.min(
            window.innerHeight,
            viewport?.bottom ?? window.innerHeight,
          ) ||
        bounds.left < 0 ||
        bounds.right > window.innerWidth
      )
        return
      try {
        const animation = element.animate(
          deal
            ? [
                { opacity: 0.45, transform: 'translateY(-8px)' },
                { opacity: 1, transform: 'translateY(0)' },
              ]
            : [{ filter: 'brightness(1.6)' }, { filter: 'brightness(1)' }],
          { duration: 220, easing: 'ease-out' },
        )
        animations.push(animation)
      } catch {
        /* An unavailable DOM effect never blocks acknowledgement. */
      }
    }
    for (const effect of batch.effects) {
      if (effect.type === 'deal')
        effect.positions.forEach((position) =>
          animate(`[data-effect="${position}"]`, true),
        )
      if (effect.type === 'chips') {
        effect.seats.forEach((seat) => animate(`[data-effect="chips:${seat}"]`))
        if (effect.pot) animate('[data-effect="pot"]')
      }
      if (
        effect.type === 'turn' &&
        effect.seatNumber === snapshot.hand?.currentActorSeatNumber
      )
        animate(`[data-seat="${effect.seatNumber}"]`)
      if (
        effect.type === 'settlement' &&
        effect.handId === snapshot.lastCompletedHandSummary?.handId
      ) {
        // With no separate on-screen pot anchors, simultaneously emphasize actual recipients.
        animate('[data-effect="pot"]')
        const recipients = new Set(
          snapshot.lastCompletedHandSummary.pots.flatMap((pot) =>
            pot.awards.map((award) => award.seatNumber),
          ),
        )
        recipients.forEach((seat) => animate(`[data-seat="${seat}"]`))
      }
    }
    document.addEventListener('visibilitychange', stop)
    media.addEventListener('change', stop)
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() => ack())
    return () => {
      document.removeEventListener('visibilitychange', stop)
      media.removeEventListener('change', stop)
      finish()
    }
  }, [scope, batch, root, rotated, snapshot, status])
  return null
}
