import { createRef } from 'react'
import { Button } from '../src/components/controls'

// Compiled by typecheck:web: callers can retain the native button for focus management.
export const buttonWithRef = (
  <Button ref={createRef<HTMLButtonElement>()}>确认</Button>
)
