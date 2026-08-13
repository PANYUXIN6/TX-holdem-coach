import type { Context } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { z } from 'zod'

export class HttpOutputValidationError extends Error {
  public constructor() {
    super('HTTP 输出不符合公开契约。')
    this.name = 'HttpOutputValidationError'
  }
}

export function jsonResponse<Output>(
  context: Context,
  schema: z.ZodType<Output>,
  value: unknown,
  status: ContentfulStatusCode = 200,
): Response {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new HttpOutputValidationError()
  return context.json(parsed.data, status)
}
