import { describe, expect, test, vi } from 'vitest'
import { createProviderCheckTransport } from '../../src/providers/provider-check-transport.js'

describe('provider check transport', () => {
  test('uses the fixed authenticated models endpoint and accepts the target model', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ data: [{ id: 'deepseek-v4-flash' }] }),
    )
    const transport = createProviderCheckTransport({ fetch: fetchMock })

    await expect(
      transport.check('deepseek', 'private-key'),
    ).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.deepseek.com/models',
      expect.objectContaining({
        method: 'GET',
        headers: { Authorization: 'Bearer private-key' },
      }),
    )
  })

  test('classifies HTTP failures without retaining response bodies', async () => {
    let cancelled = false
    const transport = createProviderCheckTransport({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          { status: 401 },
        ),
    })

    await expect(
      transport.check('deepseek', 'private-key'),
    ).rejects.toMatchObject({
      name: 'ProviderCheckFailure',
      kind: 'auth',
      message: 'Provider 检测失败。',
    })
    expect(cancelled).toBe(true)
  })

  test.each([
    [402, 'billing'],
    [429, 'rateLimited'],
    [503, 'serviceUnavailable'],
  ] as const)('maps HTTP %s to %s', async (status, kind) => {
    const transport = createProviderCheckTransport({
      fetch: async () => new Response(null, { status }),
    })

    await expect(
      transport.check('deepseek', 'private-key'),
    ).rejects.toMatchObject({ kind })
  })

  test.each([
    ['network', async () => Promise.reject(new TypeError('network detail'))],
    ['unknown', async () => new Response('{invalid-json')],
    [
      'serviceUnavailable',
      async () => Response.json({ data: [{ id: 'another-model' }] }),
    ],
  ] as const)(
    'maps provider content failure to %s',
    async (kind, fetchMock) => {
      const transport = createProviderCheckTransport({
        fetch: fetchMock as typeof fetch,
      })

      await expect(
        transport.check('deepseek', 'private-key'),
      ).rejects.toMatchObject({ kind })
    },
  )

  test('rejects oversized successful responses before public projection', async () => {
    let cancelled = false
    const transport = createProviderCheckTransport({
      fetch: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true
            },
          }),
          {
            status: 200,
            headers: { 'Content-Length': String(300 * 1_024) },
          },
        ),
    })

    await expect(
      transport.check('deepseek', 'private-key'),
    ).rejects.toMatchObject({ kind: 'unknown' })
    await vi.waitFor(() => expect(cancelled).toBe(true))
  })

  test('cancels a chunked response as soon as it exceeds 256 KiB', async () => {
    let cancelled = false
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(200_000))
          controller.enqueue(new Uint8Array(62_145))
        },
        cancel() {
          cancelled = true
        },
      }),
    )
    expect(response.headers.has('content-length')).toBe(false)
    const transport = createProviderCheckTransport({
      fetch: async () => response,
    })

    await expect(
      transport.check('deepseek', 'private-key'),
    ).rejects.toMatchObject({ kind: 'unknown' })
    expect(cancelled).toBe(true)
  })

  test('keeps the timeout active while reading a stalled response body', async () => {
    const fetchMock = (async (_input, init) => {
      const signal = init?.signal
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"data":['))
            signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('aborted', 'AbortError')),
              { once: true },
            )
          },
        }),
      )
    }) as typeof fetch
    const transport = createProviderCheckTransport({
      fetch: fetchMock,
      timeoutMs: 10,
    })

    await expect(
      transport.check('deepseek', 'private-key'),
    ).rejects.toMatchObject({ kind: 'timeout' })
  })
})
