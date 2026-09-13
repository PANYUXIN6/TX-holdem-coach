import { useLayoutEffect, type RefObject } from 'react'
/** Shell owns the visible canvas; only a focused table amount opts in. */
export function useTableKeyboardViewport(
  canvas: RefObject<HTMLDivElement | null>,
  active: boolean,
) {
  useLayoutEffect(() => {
    const element = canvas.current
    const viewport = window.visualViewport
    if (!active || !element || !viewport) return
    let listening = false
    const clear = () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
      listening = false
      element.style.removeProperty('height')
      element.style.removeProperty('transform')
      element.classList.remove('table-keyboard')
    }
    const update = () => {
      if (
        document.hidden ||
        !(document.activeElement instanceof HTMLInputElement) ||
        !document.activeElement.hasAttribute('data-table-amount')
      ) {
        clear()
        return
      }
      if (viewport.scale !== 1) {
        element.style.removeProperty('height')
        element.style.removeProperty('transform')
        element.classList.remove('table-keyboard')
        return
      }
      element.style.height = `${viewport.height}px`
      element.style.transform = `translateY(${viewport.offsetTop}px)`
      element.classList.add('table-keyboard')
    }
    const focus = () => {
      if (
        document.activeElement instanceof HTMLInputElement &&
        document.activeElement.hasAttribute('data-table-amount') &&
        !listening
      ) {
        listening = true
        viewport.addEventListener('resize', update)
        viewport.addEventListener('scroll', update)
      }
      update()
    }
    const blur = () => clear()
    element.addEventListener('focusin', focus)
    element.addEventListener('focusout', blur)
    document.addEventListener('visibilitychange', update)
    return () => {
      clear()
      element.removeEventListener('focusin', focus)
      element.removeEventListener('focusout', blur)
      document.removeEventListener('visibilitychange', update)
    }
  }, [canvas, active])
}
