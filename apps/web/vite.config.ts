import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const port = process.env.API_PROXY_PORT ?? '8787'
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
  throw new Error('API_PROXY_PORT 必须是有效端口。')
const localServer = {
  host: '127.0.0.1',
  port: 5173,
  strictPort: true,
  proxy: {
    '/api/': { target: `http://127.0.0.1:${port}`, changeOrigin: true },
  },
}
export default defineConfig({
  plugins: [react()],
  server: localServer,
  preview: localServer,
})
