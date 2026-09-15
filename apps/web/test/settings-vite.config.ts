import { defineConfig, mergeConfig, type Connect } from 'vite'
import config from '../vite.config.js'
// 独立设置页验收服务的页面回写；刷新设置 URL 时仍从测试入口注入传输。
const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
  if (req.headers.accept?.includes('text/html')) {
    const url = new URL(req.url ?? '/', 'http://fixture.local')
    req.url = `/test/settings.html${url.search}`
  }
  next()
}
export default mergeConfig(
  config,
  defineConfig({
    plugins: [
      {
        name: 'settings-fixture-navigation',
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
