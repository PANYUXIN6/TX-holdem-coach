import type { ChildProcess, SpawnOptions } from 'node:child_process'

export interface ManagedChildProcessOptions extends SpawnOptions {
  readonly signalErrorMessage?: string
  readonly terminationGracePeriodMs?: number
}

export interface ManagedChildProcessRun {
  readonly child: ChildProcess
  readonly completion: Promise<number>
}

export function runManagedChildProcess(
  command: string,
  arguments_: readonly string[],
  options?: ManagedChildProcessOptions,
): ManagedChildProcessRun
