import { describe, expect, it } from 'vitest'
import {
  createTableUiStore,
  createTableAnimationStore,
  createDebugUiStore,
  createOverlayUiStore,
} from '../src/ui/stores.js'

describe('领域 UI Store', () => {
  it('页面实例隔离，菜单关闭不清草稿，重置不影响另一页面', () => {
    const a = createTableUiStore(),
      b = createTableUiStore()
    const draft = {
      handId: 'hand',
      stateVersion: 4,
      action: 'raise' as const,
      input: '60',
    }
    a.getState().startDraft(draft)
    a.getState().openTools()
    a.getState().selectTool('agents')
    a.getState().closeTools()
    expect(a.getState().betDraft).toEqual(draft)
    expect(a.getState().selectedTool).toBeNull()
    expect(b.getState().betDraft).toBeNull()
    a.getState().reset()
    expect(a.getState().betDraft).toBeNull()
    const debug = createDebugUiStore()
    debug.getState().select({ kind: 'attempt', id: 'a' })
    debug.getState().setTab('invocations')
    expect(debug.getState().selection).toBeNull()
    debug.getState().reset()
    expect(debug.getState().tab).toBe('summary')
  })
  it('动画只保留最新批次；旧 ack 和 close 不影响新目标', () => {
    const animation = createTableAnimationStore()
    const batch = {
      sessionId: 'session',
      handId: 'hand',
      stateVersion: 4,
      effects: [{ type: 'turn' as const, seatNumber: 0 }],
    }
    animation.getState().enqueue(batch)
    animation.getState().enqueue({ ...batch, stateVersion: 5 })
    animation.getState().ack(batch)
    expect(animation.getState().batch?.stateVersion).toBe(5)
    const overlay = createOverlayUiStore()
    const first = overlay.getState().open('page', { kind: 'clearData' })!
    expect(overlay.getState().open('other', { kind: 'clearData' })).toBeNull()
    overlay.getState().close(first)
    const second = overlay.getState().open('other', { kind: 'clearData' })!
    overlay.getState().close(first)
    overlay.getState().closeOwned('page')
    expect(overlay.getState().active?.instanceId).toBe(second)
    overlay.getState().closeOwned('other')
    expect(overlay.getState().active).toBeNull()
  })
})
