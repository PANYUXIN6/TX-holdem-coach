import {
  createContext,
  useContext,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from 'react'
import { Button } from './controls.js'
import { DrawerSurface } from './surfaces.js'

export const ModalEnvironment = createContext({
  rotated: false,
  routeKey: '',
  confirmationOpen: false,
})
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  initialFocus = 'cancel',
  closeOnBackdrop = false,
}: {
  open: boolean
  onClose: () => void
  title: string
  children: ReactNode
  actions?: ReactNode
  initialFocus?: 'cancel' | 'title'
  closeOnBackdrop?: boolean
}) {
  const environment = useContext(ModalEnvironment)
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  useLayoutEffect(() => {
    close.current = onClose
  })
  const titleId = useId()
  const startedOutside = useRef(false)
  useLayoutEffect(() => {
    const element = dialog.current!
    if (!open || environment.rotated) {
      if (element.open) element.close()
      if (open) close.current()
      return
    }
    const trigger = document.activeElement as HTMLElement | null
    const pathname = window.location.pathname
    const background = document.querySelector<HTMLElement>('.page-content')
    const overflow = background?.style.overflow ?? ''
    const scroll = background?.scrollTop ?? 0
    if (background) background.style.overflow = 'hidden'
    if (!element.open) element.showModal()
    const focus =
      initialFocus === 'title'
        ? element.querySelector<HTMLElement>('h2')
        : element.querySelector<HTMLElement>('[data-modal-cancel]')
    if (focus) {
      if (initialFocus === 'title') focus.tabIndex = -1
      focus.focus()
    }
    return () => {
      if (element.open) element.close()
      if (background) {
        background.style.overflow = overflow
        background.scrollTop = scroll
      }
      const rotation = document.querySelector<HTMLElement>(
        '.rotation-notice:not([hidden]) h1',
      )
      const valid =
        pathname === window.location.pathname &&
        trigger?.isConnected &&
        trigger.getClientRects().length &&
        !trigger.closest('[inert], [hidden], :disabled')
      ;(
        rotation ??
        (valid ? trigger : document.querySelector<HTMLElement>('#page-title'))
      )?.focus({ preventScroll: true })
    }
  }, [open, environment.rotated, environment.routeKey, initialFocus])
  return (
    <dialog
      ref={dialog}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClose={() => {
        if (dialog.current && !dialog.current.open) close.current()
      }}
      onPointerDown={(event) => {
        startedOutside.current = event.target === event.currentTarget
      }}
      onPointerUp={(event) => {
        if (
          closeOnBackdrop &&
          startedOutside.current &&
          event.target === event.currentTarget
        )
          onClose()
        startedOutside.current = false
      }}
    >
      <DrawerSurface
        title={title}
        titleId={titleId}
        closeAction={
          <Button variant="secondary" aria-label="关闭弹窗" onClick={onClose}>
            关闭
          </Button>
        }
        actions={actions}
      >
        {children}
      </DrawerSurface>
    </dialog>
  )
}
export function FilterDrawer({
  open,
  onClose,
  title = '筛选',
  children,
  onReset,
  onApply,
  searchKey,
}: {
  open: boolean
  onClose: () => void
  title?: string
  children: ReactNode
  onReset: () => void
  onApply: () => boolean
  searchKey: string
}) {
  const environment = useContext(ModalEnvironment)
  const previous = useRef(searchKey)
  useLayoutEffect(() => {
    if (
      open &&
      (previous.current !== searchKey || environment.confirmationOpen)
    )
      onClose()
    previous.current = searchKey
  }, [searchKey, environment.confirmationOpen, open, onClose])
  return (
    <Modal
      open={open && !environment.confirmationOpen}
      onClose={onClose}
      title={title}
      initialFocus="title"
      closeOnBackdrop
      actions={
        <>
          <Button variant="secondary" onClick={onReset}>
            重置
          </Button>
          <Button
            onClick={() => {
              if (onApply()) onClose()
            }}
          >
            应用筛选
          </Button>
        </>
      }
    >
      {children}
    </Modal>
  )
}
