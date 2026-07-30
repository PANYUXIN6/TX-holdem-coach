import { once } from 'node:events'
import { describe, expect, test } from 'vitest'
import { runManagedChildProcess } from '../../scripts/managed-child-process.mjs'

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
})
