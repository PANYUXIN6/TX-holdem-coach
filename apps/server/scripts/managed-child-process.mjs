import { spawn } from 'node:child_process'

const DEFAULT_TERMINATION_GRACE_PERIOD_MS = 5_000

function isProcessMissingError(error) {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ESRCH'
  )
}

export function runManagedChildProcess(
  command,
  arguments_,
  {
    signal: abortSignal,
    signalErrorMessage = '子进程异常终止。',
    terminationGracePeriodMs = DEFAULT_TERMINATION_GRACE_PERIOD_MS,
    ...options
  } = {},
) {
  if (
    !Number.isSafeInteger(terminationGracePeriodMs) ||
    terminationGracePeriodMs < 0
  ) {
    throw new TypeError('子进程终止宽限期必须是非负安全整数。')
  }
  const child = spawn(command, arguments_, {
    ...options,
    detached: process.platform !== 'win32',
  })
  let receivedSignal = null
  let terminationFailure = null
  let terminationCompletion = null
  let finishTermination = null
  let forceKillTimer = null
  const windowsTerminationTasks = new Set()

  const recordTerminationFailure = (error) => {
    if (!isProcessMissingError(error)) {
      terminationFailure ??= error
    }
  }

  const terminateWindowsTree = (pid, force) => {
    const task = new Promise((resolve) => {
      const killer = spawn(
        'taskkill.exe',
        ['/pid', String(pid), '/t', ...(force ? ['/f'] : [])],
        {
          stdio: 'ignore',
          windowsHide: true,
        },
      )
      killer.once('error', (error) => {
        recordTerminationFailure(error)
        resolve()
      })
      killer.once('exit', (code) => {
        if (
          code !== 0 &&
          child.exitCode === null &&
          child.signalCode === null
        ) {
          recordTerminationFailure(
            new Error(`强制终止子进程树失败，退出码 ${code ?? 1}。`),
          )
        }
        resolve()
      })
    })
    windowsTerminationTasks.add(task)
    void task.then(() => windowsTerminationTasks.delete(task))
    return task
  }

  const forwardUnixSignal = (signal) => {
    if (child.pid === undefined) {
      return
    }
    try {
      process.kill(-child.pid, signal)
    } catch (error) {
      recordTerminationFailure(error)
    }
  }

  const completeTermination = () => {
    if (finishTermination === null) {
      return
    }
    if (forceKillTimer !== null) {
      clearTimeout(forceKillTimer)
      forceKillTimer = null
    }
    const resolveTermination = finishTermination
    finishTermination = null
    resolveTermination()
  }

  const completeTerminationIfUnixProcessGroupExited = () => {
    if (
      process.platform === 'win32' ||
      child.pid === undefined ||
      finishTermination === null
    ) {
      return
    }
    try {
      process.kill(-child.pid, 0)
    } catch (error) {
      if (isProcessMissingError(error)) {
        completeTermination()
      } else {
        recordTerminationFailure(error)
      }
    }
  }

  const requestTermination = (signal) => {
    if (terminationCompletion !== null) {
      return
    }
    receivedSignal = signal
    terminationCompletion = new Promise((resolve) => {
      finishTermination = resolve
    })

    if (process.platform === 'win32') {
      if (child.pid !== undefined) {
        void terminateWindowsTree(child.pid, false)
      }
    } else {
      forwardUnixSignal(signal)
      completeTerminationIfUnixProcessGroupExited()
    }

    if (finishTermination !== null) {
      forceKillTimer = setTimeout(async () => {
        forceKillTimer = null
        if (child.pid !== undefined) {
          if (process.platform === 'win32') {
            void terminateWindowsTree(child.pid, true)
            await Promise.all(windowsTerminationTasks)
          } else {
            forwardUnixSignal('SIGKILL')
          }
        }
        completeTermination()
      }, terminationGracePeriodMs)
    }
  }
  const handleInterrupt = () => requestTermination('SIGINT')
  const handleTermination = () => requestTermination('SIGTERM')
  const handleAbort = () => requestTermination('SIGTERM')

  const targetExit = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })

  const completion = targetExit
    .then(async ({ code, signal }) => {
      if (terminationCompletion !== null) {
        completeTerminationIfUnixProcessGroupExited()
        await terminationCompletion
      }
      if (
        terminationFailure !== null ||
        signal !== null ||
        receivedSignal !== null
      ) {
        throw new Error(signalErrorMessage)
      }
      return code ?? 1
    })
    .finally(() => {
      if (forceKillTimer !== null) {
        clearTimeout(forceKillTimer)
        forceKillTimer = null
      }
      process.removeListener('SIGINT', handleInterrupt)
      process.removeListener('SIGTERM', handleTermination)
      abortSignal?.removeEventListener('abort', handleAbort)
    })

  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleTermination)
  if (abortSignal?.aborted) {
    handleAbort()
  } else {
    abortSignal?.addEventListener('abort', handleAbort, { once: true })
  }

  return { child, completion }
}
