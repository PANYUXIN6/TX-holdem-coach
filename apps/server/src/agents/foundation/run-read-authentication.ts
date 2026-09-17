import type { PersistedAgentRun } from './agent-run-types.js'
import type { RuntimeCommitAuthority } from './runtime-ports.js'
import { isRuntimeCommitAuthority } from './runtime-ports.js'

export interface AuthenticatedRunRead {
  readonly run: PersistedAgentRun<'coach'>
  readonly authority: RuntimeCommitAuthority<'coach'>
}
const authenticated = new WeakSet<object>()
export function assertAuthenticatedRunRead(value: AuthenticatedRunRead): void {
  if (!authenticated.has(value)) throw new TypeError('unauthenticated_run_read')
}

/** The persistence adapter supplies the authority-filtered, current-codec row reader. */
export function createRunReadAuthenticator<TBudget>(
  read: (
    authority: RuntimeCommitAuthority<'coach'>,
    sessionId: string,
    handId: string,
    budget: TBudget,
  ) => Promise<PersistedAgentRun<'coach'>>,
) {
  return async (
    authority: RuntimeCommitAuthority<'coach'>,
    sessionId: string,
    handId: string,
    budget: TBudget,
  ): Promise<AuthenticatedRunRead> => {
    if (!isRuntimeCommitAuthority(authority, 'coach'))
      throw new TypeError('unauthenticated_run_authority')
    const run = await read(authority, sessionId, handId, budget)
    if (
      run.runtimeType !== 'coach' ||
      run.runId !== authority.runId ||
      run.sessionId !== sessionId ||
      run.handId !== handId ||
      run.leaseOwner !== authority.leaseOwner ||
      run.fencingToken !== authority.fencingToken ||
      !['leased', 'running'].includes(run.lifecycle)
    )
      throw new TypeError('run_read_binding_mismatch')
    const result = Object.freeze({ run, authority })
    authenticated.add(result)
    return result
  }
}
