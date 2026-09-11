import { createStore } from 'zustand/vanilla'
import type { EffectBatch } from '../session-sync/effects.js'
export type Tool = 'currentHand' | 'agents' | 'history'
export type BetDraft = Readonly<{
  handId: string
  stateVersion: number
  action: 'bet' | 'raise'
  input: string
}>
export type TableUiState = {
  toolsOpen: boolean
  selectedTool: Tool | null
  betDraft: BetDraft | null
  openTools(): void
  closeTools(): void
  selectTool(tool: Tool): void
  startDraft(draft: BetDraft): void
  editDraft(input: string): void
  clearDraft(): void
  reset(): void
}
export const createTableUiStore = () =>
  createStore<TableUiState>()((set) => ({
    toolsOpen: false,
    selectedTool: null,
    betDraft: null,
    openTools: () => set((s) => (s.toolsOpen ? s : { toolsOpen: true })),
    closeTools: () =>
      set((s) =>
        !s.toolsOpen && !s.selectedTool
          ? s
          : { toolsOpen: false, selectedTool: null },
      ),
    selectTool: (selectedTool) =>
      set((s) =>
        !s.toolsOpen || s.selectedTool === selectedTool ? s : { selectedTool },
      ),
    startDraft: (betDraft) => set({ betDraft: { ...betDraft } }),
    editDraft: (input) =>
      set((s) =>
        !s.betDraft || s.betDraft.input === input
          ? s
          : { betDraft: { ...s.betDraft, input } },
      ),
    clearDraft: () =>
      set((s) => (s.betDraft === null ? s : { betDraft: null })),
    reset: () =>
      set((s) =>
        !s.toolsOpen && !s.selectedTool && !s.betDraft
          ? s
          : { toolsOpen: false, selectedTool: null, betDraft: null },
      ),
  }))
export type TableAnimationState = {
  batch: EffectBatch | null
  enqueue(batch: EffectBatch): void
  ack(batch: Pick<EffectBatch, 'sessionId' | 'stateVersion'>): void
  clear(): void
}
export const createTableAnimationStore = () =>
  createStore<TableAnimationState>()((set) => ({
    batch: null,
    enqueue: (batch) =>
      set((s) =>
        s.batch &&
        s.batch.sessionId === batch.sessionId &&
        s.batch.stateVersion >= batch.stateVersion
          ? s
          : { batch },
      ),
    ack: (batch) =>
      set((s) =>
        s.batch?.sessionId === batch.sessionId &&
        s.batch.stateVersion === batch.stateVersion
          ? { batch: null }
          : s,
      ),
    clear: () => set((s) => (s.batch ? { batch: null } : s)),
  }))
export type DebugSelection = { kind: 'attempt' | 'invocation'; id: string }
export type DebugUiState = {
  tab: 'summary' | 'attempts' | 'invocations'
  selection: DebugSelection | null
  setTab(tab: DebugUiState['tab']): void
  select(selection: DebugSelection | null): void
  reset(): void
}
export const createDebugUiStore = () =>
  createStore<DebugUiState>()((set) => ({
    tab: 'summary',
    selection: null,
    setTab: (tab) => set((s) => (s.tab === tab ? s : { tab, selection: null })),
    select: (selection) =>
      set((s) =>
        s.selection?.kind === selection?.kind &&
        s.selection?.id === selection?.id
          ? s
          : { selection },
      ),
    reset: () =>
      set((s) =>
        s.tab === 'summary' && !s.selection
          ? s
          : { tab: 'summary', selection: null },
      ),
  }))
export type OverlayTarget =
  | { kind: 'clearData' }
  | { kind: 'deleteSession'; sessionId: string }
  | {
      kind: 'abortHandAndEndSession'
      sessionId: string
      handId: string
      stateVersion: number
    }
export type OverlayDescriptor = OverlayTarget & {
  scope: string
  instanceId: number
}
export type OverlayUiState = {
  active: OverlayDescriptor | null
  open(scope: string, target: OverlayTarget): number | null
  close(instanceId: number): void
  closeOwned(scope: string): void
}
export const createOverlayUiStore = () => {
  let nextId = 0
  return createStore<OverlayUiState>()((set, get) => ({
    active: null,
    open: (scope, target) => {
      if (get().active) return null
      const instanceId = ++nextId
      set({ active: { ...target, scope, instanceId } })
      return instanceId
    },
    close: (instanceId) =>
      set((s) => (s.active?.instanceId === instanceId ? { active: null } : s)),
    closeOwned: (scope) =>
      set((s) => (s.active?.scope === scope ? { active: null } : s)),
  }))
}
