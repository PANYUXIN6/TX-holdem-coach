import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { SessionCommandHandlerBinding } from './command-handler.js'
import { snapshotSessionCommandHandlerBinding } from './command-handler.js'

const COMMAND_TYPES = Object.freeze([
  'playerAction',
  'startNextHand',
  'rebuy',
  'endSession',
  'retryAgent',
  'aiAction',
] as const satisfies readonly LedgerCommand['type'][])
const commandTypes = new Set<string>(COMMAND_TYPES)

export class SessionCommandCompositionError extends Error {
  public constructor() {
    super('Session 命令组合无效。')
    this.name = 'SessionCommandCompositionError'
  }
}

export interface SessionCommandHandlerMap {
  readonly enabledCommandTypes: readonly LedgerCommand['type'][]
  has(commandType: LedgerCommand['type']): boolean
  get(commandType: LedgerCommand['type']): SessionCommandHandlerBinding
}

export function createSessionCommandHandlerMap(input: {
  readonly enabledCommandTypes: readonly LedgerCommand['type'][]
  readonly bindings: readonly SessionCommandHandlerBinding[]
}): SessionCommandHandlerMap {
  if (typeof input !== 'object' || input === null) {
    throw new SessionCommandCompositionError()
  }
  const enabled = [...input.enabledCommandTypes]
  const enabledSet = new Set(enabled)
  const byType = new Map<LedgerCommand['type'], SessionCommandHandlerBinding>()
  for (const binding of input.bindings) {
    if (
      typeof binding !== 'object' ||
      binding === null ||
      !commandTypes.has(binding.commandType) ||
      byType.has(binding.commandType) ||
      typeof binding.handler?.prepare !== 'function' ||
      typeof binding.handler?.applyRelations !== 'function' ||
      typeof binding.bindReadPort !== 'function' ||
      typeof binding.bindWritePort !== 'function'
    ) {
      throw new SessionCommandCompositionError()
    }
    byType.set(
      binding.commandType,
      snapshotSessionCommandHandlerBinding(binding),
    )
  }
  if (
    enabledSet.size !== enabled.length ||
    enabled.some((type) => !commandTypes.has(type)) ||
    enabled.some((type) => !byType.has(type)) ||
    [...byType.keys()].some((type) => !enabledSet.has(type))
  ) {
    throw new SessionCommandCompositionError()
  }

  return Object.freeze({
    enabledCommandTypes: Object.freeze(enabled),
    has: (commandType: LedgerCommand['type']) => enabledSet.has(commandType),
    get(commandType: LedgerCommand['type']) {
      const binding = byType.get(commandType)
      if (binding === undefined) throw new SessionCommandCompositionError()
      return binding
    },
  })
}
