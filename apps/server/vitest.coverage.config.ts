import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/unit/**/*.{test,spec}.{ts,mjs}',
      'test/service/**/*.{test,spec}.{ts,mjs}',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
    },
  },
})
