import type { Context } from 'hono'
import type { z } from 'zod'

export interface PublicFieldError {
  readonly path: readonly string[]
  readonly message: string
}

export class HttpBoundaryError extends Error {
  public constructor(
    public readonly status: 400 | 403 | 404 | 413 | 415,
    public readonly code: string,
    message: string,
    public readonly fieldErrors?: readonly PublicFieldError[],
  ) {
    super(message)
    this.name = 'HttpBoundaryError'
  }
}

function fieldErrors(error: z.ZodError): readonly PublicFieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String),
    message: issue.message,
  }))
}

export function parseInput<Output>(
  schema: z.ZodType<Output>,
  value: unknown,
): Output {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new HttpBoundaryError(
      400,
      'INVALID_REQUEST',
      '请求参数无效。',
      fieldErrors(parsed.error),
    )
  }
  return parsed.data
}

export async function parseJsonBody<Output>(
  context: Context,
  schema: z.ZodType<Output>,
): Promise<Output> {
  const declaredLength = Number(context.req.header('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > 65_536) {
    try {
      await context.req.raw.body?.cancel()
    } catch {
      // The stable public result remains REQUEST_TOO_LARGE.
    }
    throw new HttpBoundaryError(
      413,
      'REQUEST_TOO_LARGE',
      '请求正文不得超过 64 KiB。',
    )
  }
  const reader = context.req.raw.body?.getReader()
  const chunks: Uint8Array[] = []
  let byteLength = 0
  if (reader !== undefined) {
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        byteLength += chunk.value.byteLength
        if (byteLength > 65_536) {
          try {
            await reader.cancel()
          } catch {
            // The stable public result remains REQUEST_TOO_LARGE.
          }
          throw new HttpBoundaryError(
            413,
            'REQUEST_TOO_LARGE',
            '请求正文不得超过 64 KiB。',
          )
        }
        chunks.push(chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
  }
  const bytes = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpBoundaryError(
      400,
      'INVALID_REQUEST',
      '请求正文必须是有效 JSON。',
    )
  }
  return parseInput(schema, value)
}
