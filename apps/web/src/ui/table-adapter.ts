import {
  betweenHands,
  heroActions,
  positiveAmount,
  rebuyLimit,
  type TableAction,
} from '../table/actions.js'
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

export class TableIntentError extends Error {}
export type TableIntent = Readonly<{
  scope: symbol
  epoch: number
  sessionId: string
  stateVersion: number
  handId: string | null
  action: TableAction
  seenAmount: number | null
  stack: number
}>
export function createTableScope(
  id: string,
  client: QueryClient,
  runtime: SessionRuntime,
) {
  const table = createTableUiStore()
  const animation = createTableAnimationStore()
  const token = Symbol(id)
  let epoch = 0
  let lastSource = ''
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
      runtime.pendingOperations(id).length > 0 ||
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
  const available = () =>
    mounted &&
    !hidden &&
    runtime.getStatus(id) === 'ready' &&
    !runtime.isSubmitting(id) &&
    runtime.pendingOperations(id).length === 0
  const source = (current: PublicSessionSnapshot | undefined) =>
    JSON.stringify([
      available(),
      current?.stateVersion,
      current?.hand?.handId,
      current?.lastCompletedHandSummary?.handId,
      current?.lifecycleStatus,
      current?.pokerPhase,
      current?.agentRunState,
      current?.hand?.currentActorSeatNumber,
      current?.hand?.legalActions,
    ])
  function reconcile() {
    const current = snapshot()
    const nextSource = source(current)
    if (nextSource !== lastSource) {
      epoch++
      lastSource = nextSource
    }
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
    capture(
      action: TableAction,
      seen?: PublicSessionSnapshot,
    ): TableIntent | null {
      const current = snapshot()
      if (
        !current ||
        !available() ||
        (seen && source(seen) !== source(current))
      )
        return null
      const legal = heroActions(current).find(
        (item) => item.type === action.type,
      )
      if (!legal && !betweenHands(current)) return null
      return {
        scope: token,
        epoch,
        sessionId: id,
        stateVersion: current.stateVersion,
        handId:
          current.hand?.handId ??
          current.lastCompletedHandSummary?.handId ??
          null,
        action,
        seenAmount:
          legal?.type === 'call'
            ? legal.amount
            : legal?.type === 'allIn'
              ? legal.target
              : null,
        stack: current.seats.find((seat) => seat.isUser)!.stack,
      }
    },
    intentValid(this: void, intent: TableIntent) {
      const current = snapshot()
      if (
        !current ||
        !available() ||
        intent.scope !== token ||
        intent.epoch !== epoch ||
        intent.sessionId !== id ||
        intent.stateVersion !== current.stateVersion ||
        intent.handId !==
          (current.hand?.handId ??
            current.lastCompletedHandSummary?.handId ??
            null)
      )
        return false
      const action = intent.action
      if (['fold', 'check', 'call', 'allIn'].includes(action.type)) {
        const legal = heroActions(current).find(
          (item) => item.type === action.type,
        )
        return (
          !!legal &&
          (legal.type !== 'call' || legal.amount === intent.seenAmount) &&
          (legal.type !== 'allIn' || legal.target === intent.seenAmount)
        )
      }
      if (!betweenHands(current)) return false
      const stack = current.seats.find((seat) => seat.isUser)!.stack
      if (action.type === 'rebuy')
        return (
          stack === intent.stack &&
          (stack === 0
            ? action.amount === 2000
            : positiveAmount(String(action.amount), 1, rebuyLimit(stack)) !==
              null)
        )
      return (
        action.type === 'endSession' ||
        (action.type === 'startNextHand' && stack > 0)
      )
    },
    intentOptions(isCurrent: (intent: TableIntent) => boolean) {
      const valid = this.intentValid
      return mutationOptions({
        ...writePolicy,
        mutationFn: (intent: TableIntent, context) => {
          if (!valid(intent) || !isCurrent(intent))
            throw new TableIntentError('操作意图已失效，请重新选择。')
          const action = intent.action
          if (action.type === 'rebuy')
            return original.mutationFn!(
              { type: 'rebuy', payload: { amount: action.amount } },
              context,
            )
          if (action.type === 'startNextHand' || action.type === 'endSession')
            return original.mutationFn!(
              { type: action.type, payload: {} },
              context,
            )
          return original.mutationFn!(
            {
              type: 'playerAction',
              payload: { action: { type: action.type } },
            },
            context,
          )
        },
      })
    },
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
        epoch++
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
            throw new TableIntentError('下注草稿已失效，请重新输入。')
          const legal = legalAction(draft.action)
          const amount = Number(draft.input)
          if (
            !legal ||
            (legal.type !== 'bet' && legal.type !== 'raise') ||
            positiveAmount(draft.input, legal.minTarget, legal.maxTarget) ===
              null
          )
            throw new TableIntentError('请输入合法范围内的正整数金额。')
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
