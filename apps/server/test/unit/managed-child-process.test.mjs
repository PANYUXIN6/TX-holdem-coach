import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, test } from 'vitest'
import { runManagedChildProcess } from '../../scripts/managed-child-process.mjs'

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') {
      return false
    }
    throw error
  }
}

async function waitForProcessExit(pid, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs
  while (isProcessAlive(pid) && Date.now() < deadline) {
    await delay(10)
  }
  return !isProcessAlive(pid)
}

describe('managed child process', () => {
  test('forwards termination, waits for the child, and reports cancellation', async () => {
    const childCode = `
      process.on('SIGTERM', () => {
        process.stdout.write('terminated')
        process.exit(0)
      })
      process.stdout.write('ready')
      setInterval(() => {}, 1_000)
    `
    const run = runManagedChildProcess(process.execPath, ['-e', childCode], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [ready] = await once(run.child.stdout, 'data')

    expect(ready.toString()).toBe('ready')
    process.emit('SIGTERM', 'SIGTERM')

    await expect(run.completion).rejects.toThrow('子进程异常终止。')
  })

  test('forwards AbortSignal cancellation to the child process group', async () => {
    const controller = new AbortController()
    const childCode = `
      process.on('SIGTERM', () => {
        process.stdout.write('terminated')
        process.exit(0)
      })
      process.stdout.write('ready')
      setInterval(() => {}, 1_000)
    `
    const run = runManagedChildProcess(process.execPath, ['-e', childCode], {
      signal: controller.signal,
      signalErrorMessage: '测试子进程已取消。',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [ready] = await once(run.child.stdout, 'data')

    expect(ready.toString()).toBe('ready')
    controller.abort()

    await expect(run.completion).rejects.toThrow('测试子进程已取消。')
  })

  test('forcefully terminates a child that ignores graceful cancellation', async () => {
    const controller = new AbortController()
    const childCode = `
      process.on('SIGTERM', () => {})
      process.stdout.write('ready')
      setInterval(() => {}, 1_000)
    `
    const run = runManagedChildProcess(process.execPath, ['-e', childCode], {
      signal: controller.signal,
      signalErrorMessage: '测试子进程已强制取消。',
      terminationGracePeriodMs: 20,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [ready] = await once(run.child.stdout, 'data')

    expect(ready.toString()).toBe('ready')
    controller.abort()

    await expect(run.completion).rejects.toThrow('测试子进程已强制取消。')
  })

  test.skipIf(process.platform === 'win32')(
    'forcefully terminates descendants after their direct parent exits',
    async () => {
      const controller = new AbortController()
      const grandchildCode = `
        process.on('SIGTERM', () => {})
        setInterval(() => {}, 1_000)
      `
      const childCode = `
        const { spawn } = require('node:child_process')
        const grandchild = spawn(
          process.execPath,
          ['-e', ${JSON.stringify(grandchildCode)}],
          { stdio: 'ignore' },
        )
        process.on('SIGTERM', () => process.exit(0))
        process.stdout.write(String(grandchild.pid))
        setInterval(() => {}, 1_000)
      `
      const run = runManagedChildProcess(process.execPath, ['-e', childCode], {
        signal: controller.signal,
        signalErrorMessage: '测试进程树已强制取消。',
        terminationGracePeriodMs: 30,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const parentPid = run.child.pid
      const [grandchildPidOutput] = await once(run.child.stdout, 'data')
      const grandchildPid = Number.parseInt(grandchildPidOutput.toString(), 10)

      try {
        expect(Number.isSafeInteger(grandchildPid)).toBe(true)
        controller.abort()
        await expect(run.completion).rejects.toThrow('测试进程树已强制取消。')
        expect(await waitForProcessExit(grandchildPid)).toBe(true)
      } finally {
        if (parentPid !== undefined) {
          try {
            process.kill(-parentPid, 'SIGKILL')
          } catch (error) {
            if (error?.code !== 'ESRCH') {
              throw error
            }
          }
        }
      }
    },
  )

  test('treats ESRCH during an exit race as an already exited process', async () => {
    const controller = new AbortController()
    const childCode = `
      process.stdout.write('ready')
      setTimeout(() => process.exit(0), 20)
    `
    const run = runManagedChildProcess(process.execPath, ['-e', childCode], {
      signal: controller.signal,
      signalErrorMessage: '测试子进程已取消。',
      terminationGracePeriodMs: 100,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [ready] = await once(run.child.stdout, 'data')
    const originalKill = process.kill
    process.kill = (pid, signal) => {
      if (pid === -(run.child.pid ?? 0)) {
        throw Object.assign(new Error('process group already exited'), {
          code: 'ESRCH',
        })
      }
      return originalKill(pid, signal)
    }

    try {
      expect(ready.toString()).toBe('ready')
      controller.abort()
      await expect(run.completion).rejects.toThrow('测试子进程已取消。')
    } finally {
      process.kill = originalKill
    }
  })
})
