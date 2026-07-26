import 'dotenv/config'
import { serve } from '@hono/node-server'
import { app } from './app.js'
import { loadServerConfig } from './config.js'

const config = loadServerConfig(process.env)

serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port: config.port,
})
