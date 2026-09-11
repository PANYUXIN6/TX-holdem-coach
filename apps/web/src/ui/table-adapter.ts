import { mutationOptions, type QueryClient } from '@tanstack/react-query'
import {
  PokerActionSchema,
  type PublicSessionSnapshot,
} from '@tx-holdem-coach/contracts'
import { writePolicy } from '../query/client.js'
import { keys } from '../query/keys.js'
import type { SessionRuntime } from '../session-sync/runtime.js'
import {
  createTableUiStore,
  createTableAnimationStore,
  type BetDraft,
} from './stores.js'

export function createTableScope(
  id: string,
  client: QueryClient,
  runtime: SessionRuntime,
) {
  const table = createTableUiStore()
  const animation = createTableAnimationStore()
  let mounted = false
  let hidden = false
  let reduced = false
  const snapshot = () =>
    client.getQueryData<PublicSessionSnapshot>(keys.session(id))
  const legalAction = (action: BetDraft['action']) => {
    const current = snapshot()
    if (
      !mounted ||
      hidden ||
      runtime.getStatus(id) !== 'ready' ||
      runtime.isSubmitting(id) ||
      current?.lifecycleStatus !== 'active' ||
      current.pokerPhase !== 'inHand' ||
      current.agentRunState !== 'idle' ||
      current.hand?.currentActorSeatNumber !== 0
    )
      return undefined
    return current.hand.legalActions.find(
      (candidate) =>
        candidate.type === action &&
        (candidate.type === 'bet' || candidate.type === 'raise'),
    )
  }
  const validDraft = (draft: BetDraft) => {
    const current = snapshot()
    return (
      current?.hand?.handId === draft.handId &&
      current.stateVersion === draft.stateVersion &&
      !!legalAction(draft.action)
    )
  }
  function reconcile() {
    const current = snapshot()
    if (
      !current ||
      current.lifecycleStatus !== 'active' ||
      ['readonly', 'missing'].includes(runtime.getStatus(id))
    )
      table.getState().reset()
    else {
      const draft = table.getState().betDraft
      if (draft && !validDraft(draft)) table.getState().clearDraft()
    }
    const batch = animation.getState().batch
    if (
      !mounted ||
      hidden ||
      reduced ||
      runtime.getStatus(id) !== 'ready' ||
      !current ||
      current.lifecycleStatus !== 'active' ||
      (batch &&
        (batch.stateVersion !== current.stateVersion ||
          batch.handId !== (current.hand?.handId ?? null)))
    )
      animation.getState().clear()
  }
  const original = runtime.commandOptions(id)
  return {
    id,
    table,
    animation,
    mount() {
      mounted = true
      const offRuntime = runtime.subscribe(id, reconcile)
      const offQuery = client.getQueryCache().subscribe((event) => {
        if (
          event.query.queryKey[0] === 'session' &&
          event.query.queryKey[1] === id
        )
          reconcile()
      })
      const offEffects = runtime.subscribeEffects(id, (batch) => {
        reconcile()
        if (
          mounted &&
          !hidden &&
          !reduced &&
          runtime.getStatus(id) === 'ready' &&
          snapshot()?.lifecycleStatus === 'active'
        )
          animation.getState().enqueue(batch)
      })
      reconcile()
      return () => {
        mounted = false
        offRuntime()
        offQuery()
        offEffects()
        table.getState().reset()
        animation.getState().clear()
      }
    },
    environment(nextHidden: boolean, nextReduced: boolean) {
      hidden = nextHidden
      reduced = nextReduced
      reconcile()
    },
    begin(action: BetDraft['action']) {
      const legal = legalAction(action)
      const current = snapshot()
      if (
        !current?.hand ||
        !legal ||
        (legal.type !== 'bet' && legal.type !== 'raise')
      )
        return false
      table.getState().startDraft({
        handId: current.hand.handId,
        stateVersion: current.stateVersion,
        action,
        input: String(legal.suggestedTargets[0]!.targetStreetCommitment),
      })
      return true
    },
    suggest(target: number) {
      const draft = table.getState().betDraft
      if (!draft || !validDraft(draft)) return false
      const legal = legalAction(draft.action)
      if (
        !legal ||
        (legal.type !== 'bet' && legal.type !== 'raise') ||
        !legal.suggestedTargets.some(
          (item) => item.targetStreetCommitment === target,
        )
      )
        return false
      table.getState().editDraft(String(target))
      return true
    },
    currentDraft() {
      const draft = table.getState().betDraft
      return draft && validDraft(draft) ? draft : null
    },
    commandOptions: () =>
      mutationOptions({
        ...writePolicy,
        mutationFn: (draft: BetDraft, context) => {
          const live = table.getState().betDraft
          // 输入对象本身是本次编辑的引用；清除后重新输入同值也不是旧意图。
          if (!validDraft(draft) || live !== draft)
            throw new Error('下注草稿已失效，请重新输入。')
          const legal = legalAction(draft.action)
          const amount = Number(draft.input)
          if (
            !/^[1-9]\d*$/.test(draft.input) ||
            !Number.isSafeInteger(amount) ||
            !legal ||
            (legal.type !== 'bet' && legal.type !== 'raise') ||
            amount < legal.minTarget ||
            amount > legal.maxTarget
          )
            throw new Error('请输入合法范围内的正整数金额。')
          const action = PokerActionSchema.parse({
            type: draft.action,
            targetStreetCommitment: amount,
          })
          // 核对和原命令入口处于同一同步段；禁止在此 await 或预生成请求。
          return original.mutationFn!(
            { type: 'playerAction', payload: { action } },
            context,
          )
        },
      }),
  }
}
export type TableScope = ReturnType<typeof createTableScope>
