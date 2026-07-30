import { spawn } from 'node:child_process'

export function runManagedChildProcess(
  command,
  arguments_,
  { signalErrorMessage = '子进程异常终止。', ...options } = {},
) {
  const child = spawn(command, arguments_, {
    ...options,
    detached: process.platform !== 'win32',
  })
  let receivedSignal = null

  const forwardSignal = (signal) => {
    receivedSignal ??= signal

    if (child.pid === undefined) {
      return
    }

    if (process.platform === 'win32') {
      child.kill(signal)
    } else {
      process.kill(-child.pid, signal)
    }
  }
  const handleInterrupt = () => forwardSignal('SIGINT')
  const handleTermination = () => forwardSignal('SIGTERM')

  process.once('SIGINT', handleInterrupt)
  process.once('SIGTERM', handleTermination)

  const completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null || receivedSignal !== null) {
        reject(new Error(signalErrorMessage))
        return
      }

      resolve(code ?? 1)
    })
  }).finally(() => {
    process.removeListener('SIGINT', handleInterrupt)
    process.removeListener('SIGTERM', handleTermination)
  })

  return { child, completion }
}
