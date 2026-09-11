import { useLayoutEffect } from 'react'
import { useDebugStore, useDebugUi } from './react.js'
import type { DebugSelection } from './stores.js'
/** rows 必须来自当前 Query 结果；pageKey 使用当前分页 Query Key 的稳定标识。 */
export function useDebugRows(
  kind: DebugSelection['kind'],
  ids: readonly string[],
  pageKey: string,
) {
  const store = useDebugStore()
  const selection = useDebugUi((state) => state.selection)
  useLayoutEffect(() => {
    store.getState().select(null)
  }, [store, pageKey])
  useLayoutEffect(() => {
    const current = store.getState().selection
    if (current?.kind === kind && !ids.includes(current.id))
      store.getState().select(null)
  }, [store, kind, ids])
  return {
    selectedId:
      selection?.kind === kind && ids.includes(selection.id)
        ? selection.id
        : null,
    select(id: string) {
      if (ids.includes(id)) store.getState().select({ kind, id })
    },
  }
}
