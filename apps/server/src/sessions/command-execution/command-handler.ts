import type { TransactionSql } from 'postgres'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { LockedSessionView } from '../../persistence/session-mutation-repository.js'
import type {
  PrivateTableState,
  PrivateTableStateContent,
} from '../authoritative-state/private-table-state.js'
import type { PrivateEventV2 } from '../authoritative-state/private-event-v2.js'
import type { StableCommandRejection } from './command-rejection.js'

type PokerPrivateEvent = Extract<
  PrivateEventV2,
  {
    type:
      | 'handStarted'
      | 'actionCommitted'
      | 'uncalledBetReturned'
      | 'handCompleted'
  }
>

export type EventDraftForCommand<Type extends LedgerCommand['type']> =
  Type extends 'playerAction' | 'aiAction'
    ? PokerPrivateEvent
    : Type extends 'startNextHand'
      ? Extract<PrivateEventV2, { type: 'aiAutoRebuy' | 'handStarted' }>
      : Type extends 'rebuy'
        ? Extract<PrivateEventV2, { type: 'userRebuy' }>
        : Type extends 'endSession'
          ? Extract<PrivateEventV2, { type: 'handAborted' | 'sessionEnded' }>
          : never

export interface PlayerCoordinationState {
  readonly agentRunState: 'idle' | 'thinking' | 'paused'
  readonly activePlayerRunId: string | null
  readonly activeDecisionRequestId: string | null
}

export type PreparedStateEffect =
  | {
      readonly kind: 'stateChanged'
      readonly stateContent: PrivateTableStateContent
    }
  | { readonly kind: 'stateUnchanged' }

export interface PreparedDomainMutationCandidate<
  RelationPlan = unknown,
  EventDraft = PrivateEventV2,
> {
  readonly stateEffect: PreparedStateEffect
  readonly lifecycleAfter: 'active' | 'ended'
  readonly currentHandIdAfter: string | null
  readonly playerCoordinationAfter: PlayerCoordinationState
  readonly privateEventDrafts: readonly [EventDraft, ...EventDraft[]]
  readonly relationPlan: RelationPlan
}

export type PrepareCommandResult<
  RelationPlan = unknown,
  EventDraft = PrivateEventV2,
  Rejection = StableCommandRejection,
> =
  | {
      readonly kind: 'rejected'
      readonly rejection: Rejection
    }
  | {
      readonly kind: 'prepared'
      readonly mutation: PreparedDomainMutationCandidate<
        RelationPlan,
        EventDraft
      >
    }

export interface PrepareCommandContext<
  Command extends LedgerCommand = LedgerCommand,
  ReadPort = unknown,
> {
  readonly command: Command
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly reads: ReadPort
}

export interface ApplyRelationsContext<WritePort = unknown> {
  readonly writes: WritePort
  readonly commandAt: string
}

declare const preparedMutationCapabilityBrand: unique symbol

export interface PreparedMutationCapability<RelationPlan = unknown> {
  readonly relationPlan: RelationPlan
  readonly [preparedMutationCapabilityBrand]: never
}

export interface SessionCommandHandler<
  Command extends LedgerCommand = LedgerCommand,
  ReadPort = unknown,
  WritePort = unknown,
  RelationPlan = unknown,
> {
  prepare(
    context: PrepareCommandContext<Command, ReadPort>,
  ): Promise<
    PrepareCommandResult<
      RelationPlan,
      EventDraftForCommand<Command['type']>,
      StableCommandRejection
    >
  >
  applyRelations(
    context: ApplyRelationsContext<WritePort>,
    capability: PreparedMutationCapability<RelationPlan>,
  ): Promise<void>
}

export interface SessionCommandHandlerBinding<
  Command extends LedgerCommand = LedgerCommand,
  ReadPort = unknown,
  WritePort = unknown,
  RelationPlan = unknown,
> {
  readonly commandType: Command['type']
  readonly handler: SessionCommandHandler<
    Command,
    ReadPort,
    WritePort,
    RelationPlan
  >
  bindReadPort(transaction: TransactionSql): ReadPort
  bindWritePort(transaction: TransactionSql): WritePort
}

export function defineSessionCommandHandlerBinding<
  Command extends LedgerCommand,
  ReadPort,
  WritePort,
  RelationPlan,
>(
  binding: SessionCommandHandlerBinding<
    Command,
    ReadPort,
    WritePort,
    RelationPlan
  >,
): SessionCommandHandlerBinding<Command, ReadPort, WritePort, RelationPlan> {
  return snapshotSessionCommandHandlerBinding(binding)
}

export function snapshotSessionCommandHandlerBinding<
  Command extends LedgerCommand = LedgerCommand,
  ReadPort = unknown,
  WritePort = unknown,
  RelationPlan = unknown,
>(
  binding: SessionCommandHandlerBinding<
    Command,
    ReadPort,
    WritePort,
    RelationPlan
  >,
): SessionCommandHandlerBinding<Command, ReadPort, WritePort, RelationPlan> {
  const prepare = binding.handler.prepare
  const applyRelations = binding.handler.applyRelations
  const bindReadPort = binding.bindReadPort
  const bindWritePort = binding.bindWritePort
  const handlerReceiver = binding.handler
  const bindingReceiver = binding
  const handlerSnapshot: SessionCommandHandler<
    Command,
    ReadPort,
    WritePort,
    RelationPlan
  > = Object.freeze({
    prepare: (context: PrepareCommandContext<Command, ReadPort>) =>
      Reflect.apply(prepare, handlerReceiver, [context]),
    applyRelations: (
      context: ApplyRelationsContext<WritePort>,
      capability: PreparedMutationCapability<RelationPlan>,
    ) => Reflect.apply(applyRelations, handlerReceiver, [context, capability]),
  })
  const bindingSnapshot: SessionCommandHandlerBinding<
    Command,
    ReadPort,
    WritePort,
    RelationPlan
  > = Object.freeze({
    commandType: binding.commandType,
    handler: handlerSnapshot,
    bindReadPort: (transaction: TransactionSql) =>
      Reflect.apply(bindReadPort, bindingReceiver, [transaction]),
    bindWritePort: (transaction: TransactionSql) =>
      Reflect.apply(bindWritePort, bindingReceiver, [transaction]),
  })
  return bindingSnapshot
}

interface CapabilityMetadata {
  readonly transaction: TransactionSql
  readonly command: object
  readonly handler: object
  readonly relationPlan: unknown
  consumed: boolean
}

const capabilityMetadata = new WeakMap<object, CapabilityMetadata>()

export function createPreparedMutationCapability(
  transaction: TransactionSql,
  command: object,
  handler: object,
  relationPlan: unknown,
): PreparedMutationCapability {
  const capability = Object.freeze({
    relationPlan,
  }) as PreparedMutationCapability
  capabilityMetadata.set(capability, {
    transaction,
    command,
    handler,
    relationPlan,
    consumed: false,
  })
  return capability
}

export function consumePreparedMutationCapability(
  transaction: TransactionSql,
  command: object,
  handler: object,
  capability: PreparedMutationCapability,
): void {
  const metadata = capabilityMetadata.get(capability)
  if (
    metadata === undefined ||
    metadata.consumed ||
    metadata.transaction !== transaction ||
    metadata.command !== command ||
    metadata.handler !== handler ||
    metadata.relationPlan !== capability.relationPlan
  ) {
    throw new Error('Prepared mutation capability is invalid.')
  }
  metadata.consumed = true
}

export interface PortLifetime {
  active: boolean
}

export function createGuardedPort<Port>(
  port: Port,
  lifetime: PortLifetime,
): Port {
  const guardedValues = new WeakMap<object, object>()
  const sourceValues = new WeakMap<object, object>()
  const assertActive = () => {
    if (!lifetime.active) {
      throw new Error('Transaction port is no longer active.')
    }
  }
  const guard = (value: unknown): unknown => {
    if (
      (typeof value !== 'object' || value === null) &&
      typeof value !== 'function'
    ) {
      return value
    }
    const source = value as object
    const existing = guardedValues.get(source)
    if (existing !== undefined) return existing
    const facade =
      typeof source === 'function'
        ? function () {}
        : Object.create(Object.getPrototypeOf(source) as object | null)
    const proxy = new Proxy(facade as object, {
      get(_target, property, receiver) {
        assertActive()
        return guard(Reflect.get(source, property, source))
      },
      apply(_target, thisArgument, argumentsList) {
        assertActive()
        return Reflect.apply(
          source as (...args: readonly unknown[]) => unknown,
          sourceValues.get(thisArgument as object) ?? thisArgument,
          argumentsList,
        )
      },
      construct(_target, argumentsList, newTarget) {
        assertActive()
        return Reflect.construct(
          source as new (...args: readonly unknown[]) => object,
          argumentsList,
          newTarget,
        )
      },
      has(_target, property) {
        assertActive()
        return Reflect.has(source, property)
      },
    })
    for (const property of Reflect.ownKeys(source)) {
      const facadeDescriptor = Reflect.getOwnPropertyDescriptor(
        facade,
        property,
      )
      if (facadeDescriptor?.configurable === false) continue
      const sourceDescriptor = Reflect.getOwnPropertyDescriptor(
        source,
        property,
      )
      Object.defineProperty(facade, property, {
        configurable: true,
        enumerable: sourceDescriptor?.enumerable ?? false,
        get: () => {
          assertActive()
          return guard(Reflect.get(source, property, source))
        },
      })
    }
    guardedValues.set(source, proxy)
    sourceValues.set(proxy, source)
    return proxy
  }
  return guard(port) as Port
}
