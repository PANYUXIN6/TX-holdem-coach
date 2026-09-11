import {
  mutationOptions,
  queryOptions,
  type QueryClient,
} from '@tanstack/react-query'
import {
  CommandRequestSchema,
  type CommandRequest,
  type CreateSessionRequest,
  type PublicSessionSnapshot,
  type SseEvent,
} from '@tx-holdem-coach/contracts'
import { api as defaultApi, sessionId, type Api } from '../api/client.js'
import { ApiError, parseInput } from '../api/errors.js'
import { createSessionStream, type SessionStream } from '../api/sse.js'
import { readPolicy, writePolicy } from '../query/client.js'
import { keys } from '../query/keys.js'
import {
  createReceiver,
  sessionStructuralSharing,
  type ReceiveContext,
  type ReceiveMode,
} from '../query/session-receiver.js'
import { maintainSessionResources } from '../query/session-resources.js'
import { createMutations } from '../query/mutations.js'
import { describeEffects, type EffectBatch } from './effects.js'
import { SessionConnection, terminal } from './connection.js'

type Command = CommandRequest['command']
export type CommandIntent = Command extends infer T
  ? T extends Command
    ? Pick<T, 'type' | 'payload'>
    : never
  : never
export type PendingOperation = {
  readonly body: CommandRequest
  readonly context: ReceiveContext
}
type Entry = {
  connection: SessionConnection
  listeners: Set<() => void>
  busy: boolean
  frozen: boolean
  unavailable: boolean
  pending: Map<string, PendingOperation>
  read?:
    | { controller: AbortController; promise: Promise<PublicSessionSnapshot> }
    | undefined
}
export function createSessionRuntime(
  client: QueryClient,
  api: Api = defaultApi,
  stream: SessionStream = createSessionStream(),
) {
  const entries = new Map<string, Entry>()
  let globalGeneration = 0
  let activeGeneration = 0
  let hidden = false
  let creating = false
  let clearing = false
  let createTarget: string | null = null
  const effectListeners = new Map<string, Set<(batch: EffectBatch) => void>>()
  let effectSource = false
  const operationListeners = new Set<() => void>()
  const notifyOperations = () =>
    operationListeners.forEach((listener) => listener())
  const receiver = createReceiver(
    client,
    (previous, next, recovery, eventType) => {
      const id = sessionId(next.sessionId)
      const context = receiver.begin(id)
      const wasReady = !hidden && entries.get(id)?.connection.status === 'ready'
      maintainSessionResources(
        client,
        previous,
        next,
        recovery,
        () =>
          receiver.valid(id, context) && !clearing && !entries.get(id)?.frozen,
        eventType,
      )
      if (next.lifecycleStatus === 'ended') {
        // 在途定位可能已发现后继场次，不能先依据旧缓存写 null。
        if (client.getQueryState(keys.active())?.fetchStatus === 'fetching') {
          invalidateActive()
          void client
            .invalidateQueries({
              queryKey: keys.active(),
              exact: true,
              refetchType: 'all',
            })
            .catch(() => {})
        } else if (client.getQueryData(keys.active()) === id) locate(null)
        entries.get(id)?.connection.finish('ended', undefined, true)
      } else if (next.lifecycleStatus === 'readonlyDiagnostic')
        entries.get(id)?.connection.finish('readonly', undefined, true)
      if (
        effectSource &&
        wasReady &&
        !hidden &&
        entries.get(id)?.connection.status === 'ready' &&
        !recovery &&
        previous &&
        next.stateVersion > previous.stateVersion
      ) {
        const batch = describeEffects(previous, next)
        for (const listener of effectListeners.get(id) ?? []) {
          try {
            listener(batch)
          } catch {
            /* UI failure must not change acceptance. */
          }
        }
      }
    },
  )
  function invalidateActive() {
    activeGeneration++
    void client.cancelQueries(
      { queryKey: keys.active(), exact: true },
      { revert: false },
    )
  }
  function locate(id: string | null) {
    invalidateActive()
    client.setQueryData(keys.active(), id)
  }
  function cancelRead(id: string) {
    const entry = entries.get(id)
    entry?.read?.controller.abort()
    if (entry) entry.read = undefined
    void client.cancelQueries(
      { queryKey: keys.session(id), exact: true },
      { revert: false },
    )
  }
  function receive(
    id: string,
    snapshot: PublicSessionSnapshot,
    mode: ReceiveMode,
    context: ReceiveContext,
    recovery = false,
    eventType?: string,
    source: 'read' | 'sse' | 'command' = 'read',
  ) {
    if (clearing || entries.get(id)?.frozen) throw new ApiError('cancelled')
    const previousSource = effectSource
    effectSource =
      source === 'command' || (source === 'sse' && eventType !== 'snapshot')
    let result
    try {
      result = receiver.receive(
        id,
        snapshot,
        mode,
        context,
        recovery,
        eventType,
      )
    } finally {
      effectSource = previousSource
    }
    if (result.kind === 'protocol') throw new ApiError('protocol')
    if (result.kind === 'invalidated') throw new ApiError('cancelled')
    return result
  }
  function handleError(id: string, error: ApiError, context: ReceiveContext) {
    if (!receiver.valid(id, context)) return undefined
    if (error.latestSnapshot)
      receive(id, error.latestSnapshot, 'calibration', context)
    if (error.kind === 'http' && error.status === 404) {
      entryFor(id).unavailable = true
      receiver.invalidate(id)
      const query = client
        .getQueryCache()
        .find({ queryKey: keys.session(id), exact: true })
      query?.setState({
        data: undefined,
        dataUpdatedAt: 0,
        status: 'error',
        error,
      })
      return 'missing' as const
    }
    if (
      error.code === 'SESSION_READONLY_DIAGNOSTIC' ||
      receiver.current(id)?.lifecycleStatus === 'readonlyDiagnostic'
    )
      return 'readonly' as const
    if (receiver.current(id)?.lifecycleStatus === 'ended')
      return 'ended' as const
    return undefined
  }
  function entryFor(input: string): Entry {
    const id = sessionId(input)
    let entry = entries.get(id)
    if (entry) return entry
    const listeners = new Set<() => void>()
    const connection = new SessionConnection(id, {
      stream,
      cursor: () => receiver.current(id)?.eventSeq,
      begin: () => receiver.begin(id),
      cancelRead: () => cancelRead(id),
      notify: () => listeners.forEach((listener) => listener()),
      handleError: (error, context) =>
        handleError(id, error, context as ReceiveContext),
      read: (recovery) => read(id, recovery),
      receive(event: SseEvent, context) {
        const result = receive(
          id,
          event.payload.snapshot,
          event.type === 'snapshot' ? 'calibration' : 'incremental',
          context as ReceiveContext,
          false,
          event.type,
          'sse',
        )
        return result.kind === 'gap' ? 'gap' : 'ok'
      },
    })
    entry = {
      connection,
      listeners,
      busy: false,
      frozen: false,
      unavailable: false,
      pending: new Map(),
    }
    entries.set(id, entry)
    return entry
  }
  function read(
    input: string,
    recovery = false,
  ): Promise<PublicSessionSnapshot> {
    const id = sessionId(input)
    const entry = entryFor(id)
    if (clearing || entry.frozen)
      return Promise.reject(new ApiError('cancelled'))
    if (entry.read) return entry.read.promise
    const controller = new AbortController()
    const context = receiver.begin(id)
    const promise = api
      .session(id, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) throw new ApiError('cancelled')
        const selected = receive(
          id,
          data.snapshot,
          'calibration',
          context,
          recovery,
        ).snapshot!
        entry.unavailable = false
        return selected
      })
      .catch((error) => {
        if (
          !controller.signal.aborted &&
          receiver.valid(id, context) &&
          error instanceof ApiError
        ) {
          const status = handleError(id, error, context)
          if (status) entry.connection.finish(status, error, true)
          else if (
            error.kind === 'protocol' &&
            entry.connection.status === 'ready'
          )
            entry.connection.fail(error, context)
        }
        throw error
      })
      .finally(() => {
        if (entry.read?.controller === controller) entry.read = undefined
      })
    entry.read = { controller, promise }
    return promise
  }
  function sessionOptions(input: string) {
    const id = sessionId(input)
    return queryOptions({
      ...readPolicy,
      queryKey: keys.session(id),
      structuralSharing: sessionStructuralSharing,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      meta: { resourceDetail: true, sessionId: id },
      queryFn: async ({ signal }) => {
        if (entryFor(id).unavailable)
          throw new ApiError('http', 404, 'RESOURCE_DELETED')
        const context = receiver.begin(id)
        const abort = () => {
          const entry = entries.get(id)
          entry?.read?.controller.abort()
          if (entry) entry.read = undefined
        }
        signal.addEventListener('abort', abort, { once: true })
        try {
          const selected = await read(id)
          if (signal.aborted || !receiver.valid(id, context))
            throw new ApiError('cancelled')
          return selected
        } finally {
          signal.removeEventListener('abort', abort)
        }
      },
    })
  }
  function activeOptions() {
    return queryOptions({
      ...readPolicy,
      queryKey: keys.active(),
      queryFn: async ({ signal }) => {
        const generation = activeGeneration
        const global = globalGeneration
        // 不知道 active ID，提前为已存在场保存数值上下文，绝不保存快照副本。
        const contexts = new Map(
          [
            ...entries.keys(),
            ...client
              .getQueryCache()
              .findAll({ queryKey: ['session'] })
              .map((query) => String(query.queryKey[1])),
          ].map((id) => [id, receiver.begin(id)]),
        )
        const check = () => {
          if (
            signal.aborted ||
            generation !== activeGeneration ||
            global !== globalGeneration ||
            clearing
          )
            throw new ApiError('cancelled')
        }
        try {
          check()
          const data = await api.activeSession({ signal })
          check()
          const id = sessionId(data.snapshot.sessionId)
          const context = contexts.get(id) ?? { generation: 0, revision: 0 }
          const result = receive(id, data.snapshot, 'calibration', context)
          check()
          return result.snapshot?.lifecycleStatus === 'ended' ? null : id
        } catch (error) {
          check()
          if (
            error instanceof ApiError &&
            error.kind === 'http' &&
            error.status === 404 &&
            error.code === 'SESSION_NOT_FOUND'
          )
            return null
          throw error
        }
      },
    })
  }
  async function resolveActive() {
    invalidateActive()
    try {
      createTarget = await client.fetchQuery(activeOptions())
    } catch {
      createTarget = null
    }
    notifyOperations()
    return createTarget
  }
  function gate(id: string) {
    const entry = entryFor(id)
    if (
      clearing ||
      entry.frozen ||
      entry.busy ||
      entry.connection.status !== 'ready' ||
      receiver.current(id)?.lifecycleStatus !== 'active'
    )
      throw new ApiError('input', undefined, 'SESSION_NOT_READY')
    return entry
  }
  function validateAction(
    snapshot: PublicSessionSnapshot,
    body: CommandRequest,
  ) {
    if (body.command.type !== 'playerAction') return
    const action = body.command.payload.action
    const legal = snapshot.hand?.legalActions.find(
      (candidate) => candidate.type === action.type,
    )
    if (
      snapshot.agentRunState !== 'idle' ||
      snapshot.hand?.currentActorSeatNumber !== 0 ||
      !legal
    )
      throw new ApiError('input')
    if (
      (action.type === 'bet' || action.type === 'raise') &&
      (legal.type === 'bet' || legal.type === 'raise') &&
      (action.targetStreetCommitment < legal.minTarget ||
        action.targetStreetCommitment > legal.maxTarget)
    )
      throw new ApiError('input')
  }
  async function send(id: string, operation: PendingOperation) {
    const entry = gate(id)
    if (!receiver.valid(id, operation.context)) throw new ApiError('cancelled')
    entry.busy = true
    entry.listeners.forEach((listener) => listener())
    try {
      let data
      try {
        data = await api.command(id, operation.body)
      } catch (error) {
        if (!receiver.valid(id, operation.context) || entry.frozen || clearing)
          throw new ApiError('cancelled')
        if (error instanceof ApiError && error.kind === 'input') throw error
        const failure =
          error instanceof ApiError ? error : new ApiError('network')
        try {
          const status = handleError(id, failure, operation.context)
          if (status) entry.connection.finish(status, failure)
          else if (failure.kind !== 'http' || !failure.latestSnapshot) {
            if (failure.kind !== 'http')
              entry.pending.set(operation.body.command.commandId, operation)
            await entry.connection.calibrate()
          }
        } catch (calibrationError) {
          entry.connection.fail(
            calibrationError instanceof ApiError
              ? calibrationError
              : new ApiError('protocol'),
          )
        }
        throw failure
      }
      if (!receiver.valid(id, operation.context) || entry.frozen || clearing)
        throw new ApiError('cancelled')
      // HTTP 已确认成功；同步异常单独锁闸诊断，不能把成功命令改报失败。
      try {
        receive(
          id,
          data.snapshot,
          'calibration',
          operation.context,
          false,
          operation.body.command.type,
          'command',
        )
        const current = receiver.current(id)
        if (current)
          maintainSessionResources(
            client,
            current,
            current,
            false,
            () =>
              receiver.valid(id, operation.context) &&
              !entry.frozen &&
              !clearing,
            operation.body.command.type,
          )
      } catch (error) {
        entry.connection.fail(
          error instanceof ApiError ? error : new ApiError('protocol'),
        )
      }
      entry.pending.delete(operation.body.command.commandId)
      return data
    } finally {
      entry.busy = false
      entry.listeners.forEach((listener) => listener())
    }
  }
  function command(input: string, intent: CommandIntent) {
    const id = sessionId(input)
    gate(id)
    const snapshot = receiver.current(id)!
    const body = parseInput(CommandRequestSchema, {
      command: {
        ...intent,
        sessionId: id,
        commandId: crypto.randomUUID().toLowerCase(),
        expectedStateVersion: snapshot.stateVersion,
      },
    })
    validateAction(snapshot, body)
    return send(id, { body, context: receiver.begin(id) })
  }
  function freeze(input?: string) {
    const id = input === undefined ? undefined : sessionId(input)
    if (
      clearing ||
      (id === undefined &&
        (creating || [...entries.values()].some((entry) => entry.frozen))) ||
      (id !== undefined && entryFor(id).frozen)
    )
      throw new ApiError('input')
    if (id === undefined) {
      clearing = true
      globalGeneration++
      createTarget = null
    }
    invalidateActive()
    const affected = id
      ? [id]
      : [
          ...new Set([
            ...entries.keys(),
            ...client
              .getQueryCache()
              .findAll({ queryKey: ['session'] })
              .map((query) => String(query.queryKey[1])),
          ]),
        ]
    for (const key of affected) {
      const entry = entryFor(key)
      entry.frozen = true
      receiver.invalidate(key)
      entry.connection.finish('blocked')
    }
    return {
      finish(success: boolean) {
        if (!id) clearing = false
        for (const key of affected) {
          const entry = entryFor(key)
          entry.frozen = false
          if (success) {
            entry.unavailable = true
            entry.connection.finish('missing')
          } else {
            void read(key, true)
              .then(() => {
                if (
                  entry.connection.hasConsumers() &&
                  !terminal(entry.connection.status)
                )
                  entry.connection.restart()
              })
              .catch((error) => {
                if (!terminal(entry.connection.status))
                  entry.connection.finish(
                    'blocked',
                    error instanceof ApiError ? error : new ApiError('network'),
                  )
              })
          }
        }
        if (success && (!id || client.getQueryData(keys.active()) === id))
          locate(null)
        notifyOperations()
      },
    }
  }
  const mutations = createMutations(client, api, { freeze })
  return {
    subscribeEffects(input: string, listener: (batch: EffectBatch) => void) {
      const id = sessionId(input)
      let listeners = effectListeners.get(id)
      if (!listeners) effectListeners.set(id, (listeners = new Set()))
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (!listeners.size) effectListeners.delete(id)
      }
    },
    sessionOptions,
    activeOptions,
    read,
    mutations,
    getStatus: (id: string) => entryFor(id).connection.status,
    getError: (id: string) => entryFor(id).connection.error,
    isSubmitting: (id: string) => entryFor(id).busy,
    pendingOperations: (id: string) =>
      [...entryFor(id).pending.values()].map((operation) =>
        structuredClone(operation.body),
      ),
    subscribe(id: string, listener: () => void) {
      const listeners = entryFor(id).listeners
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    acquire(input: string) {
      const id = sessionId(input)
      const entry = entryFor(id)
      entry.connection.visibility(hidden)
      const cached = receiver.current(id)
      if (cached?.lifecycleStatus === 'ended') entry.connection.finish('ended')
      if (cached?.lifecycleStatus === 'readonlyDiagnostic')
        entry.connection.finish('readonly')
      const release = entry.connection.acquire()
      if (terminal(entry.connection.status))
        void read(id)
          .then(() => {
            if (
              receiver.current(id)?.lifecycleStatus === 'active' &&
              entry.connection.hasConsumers()
            )
              entry.connection.restart()
          })
          .catch(() => {})
      return () => {
        release()
        if (!entry.connection.hasConsumers()) {
          receiver.invalidate(id)
          cancelRead(id)
        }
      }
    },
    visibility(value: boolean) {
      hidden = value
      entries.forEach((entry) => entry.connection.visibility(value))
    },
    online() {
      entries.forEach((entry) => entry.connection.online())
    },
    focus() {
      entries.forEach((entry) => {
        if (
          entry.connection.hasConsumers() &&
          entry.connection.status === 'ready'
        )
          void entry.connection.calibrate()
      })
    },
    async refresh(input: string) {
      const id = sessionId(input)
      const entry = entryFor(id)
      if (entry.frozen || clearing) throw new ApiError('cancelled')
      const context = receiver.begin(id)
      // 无实时连接的消费者仍可显式读取 ended/readonly 详情。
      if (
        !entry.connection.hasConsumers() ||
        hidden ||
        terminal(entry.connection.status)
      ) {
        await read(id, true)
        if (!receiver.valid(id, context)) throw new ApiError('cancelled')
        if (
          !entry.connection.hasConsumers() ||
          hidden ||
          receiver.current(id)?.lifecycleStatus !== 'active'
        )
          return receiver.current(id)!
      }
      // 订阅完整恢复结果；snapshot 正常替换旧 GET 不等于刷新失败。
      const restored = new Promise<void>((resolve, reject) => {
        const check = () => {
          const { status, error } = entry.connection
          let failure: ApiError | undefined
          if (
            entry.frozen ||
            clearing ||
            status === 'idle' ||
            status === 'suspended'
          ) {
            failure = new ApiError('cancelled')
          } else if (status === 'missing' || status === 'blocked') {
            // 确认的 404 会递增数据代次，仍应保留真实读取错误。
            failure =
              error ??
              (status === 'missing'
                ? new ApiError('http', 404, 'RESOURCE_DELETED')
                : new ApiError('protocol'))
          } else if (!receiver.valid(id, context)) {
            failure = new ApiError('cancelled')
          } else if (
            status !== 'ready' &&
            status !== 'ended' &&
            status !== 'readonly'
          ) {
            return
          }
          entry.listeners.delete(check)
          if (failure) reject(failure)
          else resolve()
        }
        entry.listeners.add(check)
      })
      entry.connection.restart()
      await restored
      if (!receiver.valid(id, context) || entry.frozen || clearing)
        throw new ApiError('cancelled')
      return receiver.current(id)!
    },
    commandOptions: (id: string) =>
      mutationOptions({
        ...writePolicy,
        mutationFn: (intent: CommandIntent) => command(id, intent),
      }),
    resend(input: string, commandId: string) {
      const id = sessionId(input)
      const operation = entryFor(id).pending.get(commandId)
      if (!operation) return Promise.reject(new ApiError('input'))
      return send(id, operation)
    },
    abandon(input: string, commandId: string) {
      const entry = entryFor(input)
      entry.pending.delete(commandId)
      entry.listeners.forEach((listener) => listener())
    },
    subscribeOperations(listener: () => void) {
      operationListeners.add(listener)
      return () => {
        operationListeners.delete(listener)
      }
    },
    getCreateTarget: () => createTarget,
    isCreating: () => creating,
    createOptions: () =>
      mutationOptions({
        ...writePolicy,
        mutationFn: async (body: CreateSessionRequest) => {
          if (creating || clearing) throw new ApiError('input')
          creating = true
          createTarget = null
          notifyOperations()
          const global = globalGeneration
          const contexts = new Map(
            [
              ...new Set([
                ...entries.keys(),
                ...client
                  .getQueryCache()
                  .findAll({ queryKey: ['session'] })
                  .map((query) => String(query.queryKey[1])),
              ]),
            ].map((id) => [id, receiver.begin(id)]),
          )
          const check = () => {
            if (global !== globalGeneration || clearing)
              throw new ApiError('cancelled')
          }
          const accept = (snapshot: PublicSessionSnapshot) => {
            check()
            const id = sessionId(snapshot.sessionId)
            const context = contexts.get(id) ?? { generation: 0, revision: 0 }
            const result = receive(
              id,
              snapshot,
              'calibration',
              context,
              false,
              'sessionCreated',
            )
            if (result.snapshot?.lifecycleStatus === 'ended') return null
            locate(id)
            createTarget = id
            return id
          }
          try {
            let data
            try {
              data = await api.createSession(body)
            } catch (error) {
              check()
              if (error instanceof ApiError && error.kind === 'input')
                throw error
              if (
                error instanceof ApiError &&
                error.status === 409 &&
                error.code === 'ACTIVE_SESSION_EXISTS' &&
                error.latestSnapshot
              ) {
                if (!accept(error.latestSnapshot)) await resolveActive()
              } else await resolveActive()
              check()
              throw error
            }
            const id = accept(data.snapshot)
            if (!id) await resolveActive()
            check()
            return { sessionId: createTarget }
          } finally {
            creating = false
            notifyOperations()
          }
        },
      }),
  }
}
export type SessionRuntime = ReturnType<typeof createSessionRuntime>
