import { z } from 'zod'
import { PositiveSafeIntegerSchema } from '../audit/audit-primitives.js'
import { FoundationProtocolError } from './errors.js'
import { RuntimeTypeSchema, type RuntimeType } from './runtime-definition.js'

export interface RuntimeTransition<TState extends string> {
  readonly from: TState
  readonly event: string
  readonly to: TState
}

export interface RuntimeStateMachineDefinition<
  TRuntime extends RuntimeType,
  TState extends string,
> {
  readonly runtimeType: TRuntime
  readonly stateMachineVersion: number
  readonly initialState: TState
  readonly states: readonly TState[]
  readonly checkpointStates: readonly TState[]
  readonly terminalStates: readonly TState[]
  readonly transitions: readonly RuntimeTransition<TState>[]
}

const CanonicalStateOrEventSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z][A-Za-z0-9]*$/)

const forbiddenDynamicControlNames = new Set([
  'toolRequestedByModel',
  'delegate',
  'messageAgent',
])

const forbiddenModelOutputControlFields = new Set([
  'nextState',
  'capabilityName',
  'toolCall',
  'retry',
  'commit',
])

function deepFreeze<Value>(value: Value): Value {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nestedValue of Object.values(value)) deepFreeze(nestedValue)
    Object.freeze(value)
  }
  return value
}

function reachesTerminal<TState extends string>(
  start: TState,
  terminalStates: ReadonlySet<TState>,
  transitions: readonly RuntimeTransition<TState>[],
): boolean {
  const pending = [start]
  const visited = new Set<TState>()
  while (pending.length > 0) {
    const current = pending.shift()
    if (current === undefined || visited.has(current)) continue
    if (terminalStates.has(current)) return true
    visited.add(current)
    for (const transition of transitions) {
      if (transition.from === current) pending.push(transition.to)
    }
  }
  return false
}

export function createRuntimeStateMachineDefinition<
  TRuntime extends RuntimeType,
  TState extends string,
>(
  input: RuntimeStateMachineDefinition<TRuntime, TState>,
): RuntimeStateMachineDefinition<TRuntime, TState> {
  if (
    !RuntimeTypeSchema.safeParse(input.runtimeType).success ||
    !PositiveSafeIntegerSchema.safeParse(input.stateMachineVersion).success ||
    !CanonicalStateOrEventSchema.safeParse(input.initialState).success ||
    input.states.length === 0 ||
    input.terminalStates.length === 0
  ) {
    throw new FoundationProtocolError('runtimeTransitionRejected')
  }

  const states = new Set(input.states)
  const checkpoints = new Set(input.checkpointStates)
  const terminals = new Set(input.terminalStates)
  if (
    states.size !== input.states.length ||
    checkpoints.size !== input.checkpointStates.length ||
    terminals.size !== input.terminalStates.length ||
    !states.has(input.initialState) ||
    terminals.has(input.initialState)
  ) {
    throw new FoundationProtocolError('runtimeTransitionRejected')
  }
  for (const state of input.states) {
    if (!CanonicalStateOrEventSchema.safeParse(state).success) {
      throw new FoundationProtocolError('runtimeTransitionRejected')
    }
  }
  for (const checkpoint of checkpoints) {
    if (!states.has(checkpoint) || terminals.has(checkpoint)) {
      throw new FoundationProtocolError('runtimeCheckpointRejected')
    }
  }
  for (const terminal of terminals) {
    if (!states.has(terminal)) {
      throw new FoundationProtocolError('runtimeTransitionRejected')
    }
  }

  const transitionKeys = new Set<string>()
  for (const transition of input.transitions) {
    if (
      !states.has(transition.from) ||
      !states.has(transition.to) ||
      terminals.has(transition.from) ||
      !CanonicalStateOrEventSchema.safeParse(transition.event).success ||
      forbiddenDynamicControlNames.has(transition.event)
    ) {
      throw new FoundationProtocolError('runtimeTransitionRejected')
    }
    const key = `${transition.from}:${transition.event}`
    if (transitionKeys.has(key)) {
      throw new FoundationProtocolError('runtimeTransitionRejected')
    }
    transitionKeys.add(key)
  }

  const reachable = new Set<TState>([input.initialState])
  let changed = true
  while (changed) {
    changed = false
    for (const transition of input.transitions) {
      if (reachable.has(transition.from) && !reachable.has(transition.to)) {
        reachable.add(transition.to)
        changed = true
      }
    }
  }
  if (reachable.size !== states.size) {
    throw new FoundationProtocolError('runtimeTransitionRejected')
  }
  for (const state of input.states) {
    if (
      !terminals.has(state) &&
      !reachesTerminal(state, terminals, input.transitions)
    ) {
      throw new FoundationProtocolError('runtimeTransitionRejected')
    }
  }

  return deepFreeze(structuredClone(input))
}

export function transitionRuntimeState<
  TRuntime extends RuntimeType,
  TState extends string,
>(
  definition: RuntimeStateMachineDefinition<TRuntime, TState>,
  current: TState,
  event: string,
): TState {
  const transition = definition.transitions.find(
    (candidate) => candidate.from === current && candidate.event === event,
  )
  if (transition === undefined) {
    throw new FoundationProtocolError('runtimeTransitionRejected')
  }
  return transition.to
}

export function assertRuntimeCheckpoint<
  TRuntime extends RuntimeType,
  TState extends string,
>(
  definition: RuntimeStateMachineDefinition<TRuntime, TState>,
  state: TState,
): void {
  if (!definition.checkpointStates.includes(state)) {
    throw new FoundationProtocolError('runtimeCheckpointRejected')
  }
}

export function assertModelOutputHasNoRuntimeControlFields(
  value: unknown,
): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new FoundationProtocolError('runtimeTransitionRejected')
  }
  if (
    Object.keys(value).some((key) => forbiddenModelOutputControlFields.has(key))
  ) {
    throw new FoundationProtocolError('runtimeTransitionRejected')
  }
}
