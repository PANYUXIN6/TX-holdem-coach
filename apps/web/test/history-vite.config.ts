import { defineConfig, mergeConfig, type Connect } from 'vite'
import config from '../vite.config.js'
// 独立历史页验收服务的页面回写；刷新历史 URL 时仍从测试入口注入传输。
const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
  if (req.headers.accept?.includes('text/html')) {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    req.url = `/test/history.html${url.search}`
  }
  next()
}
export default mergeConfig(
  config,
  defineConfig({
    plugins: [
      {
        name: 'history-fixture-navigation',
        configureServer(server) {
          server.middlewares.use(rewrite)
        },
        configurePreviewServer(server) {
          server.middlewares.use(rewrite)
        },
      },
    ],
  }),
)
