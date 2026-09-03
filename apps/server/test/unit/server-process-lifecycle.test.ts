import { describe, expect, test, vi } from 'vitest'
import type { RunningServiceHandle } from '../../src/bootstrap.js'
import { startServiceProcess } from '../../src/server-process-lifecycle.js'

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

describe('server process lifecycle', () => {
  test('latches a non-zero exit code before clean shutdown after a runtime fatal', async () => {
    let resolveFatal!: (value: never) => void
    const fatal = new Promise<never>((resolve) => {
      resolveFatal = resolve
    })
    let resolveShutdown!: () => void
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve
        }),
    )
    const handle: RunningServiceHandle = {
      fatal,
      shutdown,
    }
    const processPort: {
      exitCode?: number
      once: ReturnType<typeof vi.fn>
    } = { once: vi.fn() }

    startServiceProcess({
      bootstrap: async () => handle,
      process: processPort,
    })
    await flushMicrotasks()
    resolveFatal(undefined as never)
    await flushMicrotasks()

    expect(processPort.exitCode).toBe(1)
    expect(shutdown).toHaveBeenCalledOnce()

    resolveShutdown()
    await flushMicrotasks()
    expect(processPort.exitCode).toBe(1)
  })

  test('records only the stable failed resource category for a runtime fatal', async () => {
    let resolveFatal!: (value: {
      readonly category: 'httpServerTerminatedUnexpectedly'
    }) => void
    const fatal = new Promise<{
      readonly category: 'httpServerTerminatedUnexpectedly'
    }>((resolve) => {
      resolveFatal = resolve
    })
    const onDiagnostic = vi.fn()
    const handle: RunningServiceHandle = {
      fatal,
      shutdown: vi.fn(async () => undefined),
    }
    const processPort: {
      exitCode?: number
      once: ReturnType<typeof vi.fn>
    } = { once: vi.fn() }

    startServiceProcess({
      bootstrap: async () => handle,
      process: processPort,
      onDiagnostic,
    } as never)
    await flushMicrotasks()
    resolveFatal({ category: 'httpServerTerminatedUnexpectedly' })
    await flushMicrotasks()

    expect(onDiagnostic).toHaveBeenCalledWith({
      category: 'service_runtime_resource_failed',
      resource: 'httpServer',
    })
    expect(processPort.exitCode).toBe(1)
  })
})
