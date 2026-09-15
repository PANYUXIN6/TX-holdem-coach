// 编译独立验收目录；产品 build:web 的入口和产物保持独立。
import { build } from 'vite'
import { fileURLToPath } from 'node:url'
const outDir = process.argv[2]
if (!outDir) throw new Error('请提供独立的验收输出目录。')
await build({
  root: fileURLToPath(new URL('..', import.meta.url)),
  build: {
    outDir,
    emptyOutDir: false,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('../index.html', import.meta.url)),
        settings: fileURLToPath(new URL('./settings.html', import.meta.url)),
        statistics: fileURLToPath(new URL('./statistics.html', import.meta.url)),
        history: fileURLToPath(new URL('./history.html', import.meta.url)),
        aiStatus: fileURLToPath(new URL('./ai-status.html', import.meta.url)),
        table: fileURLToPath(new URL('./table.html', import.meta.url)),
        home: fileURLToPath(new URL('./home.html', import.meta.url)),
        feedback: fileURLToPath(new URL('./feedback.html', import.meta.url)),
        visual: fileURLToPath(new URL('./visual.html', import.meta.url)),
        acceptance: fileURLToPath(new URL('./browser.html', import.meta.url)),
      },
    },
  },
})
