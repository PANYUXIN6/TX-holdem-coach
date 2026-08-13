import type { Hono } from 'hono'

export interface ApiVariables {
  requestId: string
}

export type ApiHono = Hono<{ Variables: ApiVariables }>
