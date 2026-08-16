import type { RuntimeType } from './runtime-definition.js'

export type AgentRunEventKind =
  | 'queued'
  | 'leased'
  | 'started'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'stale'

export type PersistedAgentRunEvent =
  | {
      readonly runtimeType: 'player'
      readonly kind: AgentRunEventKind
      readonly runId: string
    }
  | {
      readonly runtimeType: 'coach'
      readonly kind: AgentRunEventKind
      readonly runId: string
    }

export interface AgentRunEventPort {
  publish(events: readonly PersistedAgentRunEvent[]): Promise<void>
}

declare const runtimeCommitAuthorityBrand: unique symbol

export interface RuntimeCommitAuthority<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly runId: string
  readonly leaseOwner: string
  readonly fencingToken: number
  readonly [runtimeCommitAuthorityBrand]: never
}

const runtimeCommitAuthorities = new WeakSet<object>()

export function isRuntimeCommitAuthority<TRuntime extends RuntimeType>(
  value: unknown,
  runtimeType: TRuntime,
): value is RuntimeCommitAuthority<TRuntime> {
  return (
    typeof value === 'object' &&
    value !== null &&
    runtimeCommitAuthorities.has(value) &&
    (value as { readonly runtimeType?: unknown }).runtimeType === runtimeType
  )
}
