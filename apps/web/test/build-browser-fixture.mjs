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
        acceptance: fileURLToPath(new URL('./browser.html', import.meta.url)),
      },
    },
  },
})
