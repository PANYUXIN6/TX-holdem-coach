import { SessionCommandSchema } from '@tx-holdem-coach/contracts'
import type { LedgerCommand } from '../../persistence/command-ledger-repository.js'
import type { SessionCommandHandlerBinding } from './command-handler.js'
import { snapshotSessionCommandHandlerBinding } from './command-handler.js'

const commandTypes = new Set(
  SessionCommandSchema.options.map((option) => option.shape.type.value),
)

export class SessionCommandCompositionError extends Error {
  public constructor() {
    super('Session 命令组合无效。')
    this.name = 'SessionCommandCompositionError'
  }
}

export interface SessionCommandHandlerMap {
  has(commandType: LedgerCommand['type']): boolean
  get(commandType: LedgerCommand['type']): SessionCommandHandlerBinding
}

export function createSessionCommandHandlerMap(input: {
  readonly bindings: readonly SessionCommandHandlerBinding[]
}): SessionCommandHandlerMap {
  if (typeof input !== 'object' || input === null) {
    throw new SessionCommandCompositionError()
  }
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
  return Object.freeze({
    has: (commandType: LedgerCommand['type']) => byType.has(commandType),
    get(commandType: LedgerCommand['type']) {
      const binding = byType.get(commandType)
      if (binding === undefined) throw new SessionCommandCompositionError()
      return binding
    },
  })
}
