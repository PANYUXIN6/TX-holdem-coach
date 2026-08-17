import type { RuntimeType } from './runtime-definition.js'

export type AgentRunEventKind =
  | 'queued'
  | 'leased'
  | 'running'
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

export interface RuntimeCommitAuthority<
  TRuntime extends RuntimeType = RuntimeType,
> {
  readonly runtimeType: TRuntime
  readonly runId: string
  readonly leaseOwner: string
  readonly fencingToken: number
  readonly [runtimeCommitAuthorityBrand]: never
}

const runtimeCommitAuthorities = new WeakSet<object>()

const LeaseOwnerPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/

export function issueRuntimeCommitAuthority<
  TRuntime extends RuntimeType,
>(input: {
  readonly runtimeType: TRuntime
  readonly runId: string
  readonly leaseOwner: string
  readonly fencingToken: number
}): RuntimeCommitAuthority<TRuntime> {
  if (
    (input.runtimeType !== 'player' && input.runtimeType !== 'coach') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.runId,
    ) ||
    !LeaseOwnerPattern.test(input.leaseOwner) ||
    !Number.isSafeInteger(input.fencingToken) ||
    input.fencingToken <= 0
  ) {
    throw new TypeError('Runtime 提交授权输入无效。')
  }

  const authority = Object.freeze({
    runtimeType: input.runtimeType,
    runId: input.runId,
    leaseOwner: input.leaseOwner,
    fencingToken: input.fencingToken,
  }) as RuntimeCommitAuthority<TRuntime>
  runtimeCommitAuthorities.add(authority)
  return authority
}

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
