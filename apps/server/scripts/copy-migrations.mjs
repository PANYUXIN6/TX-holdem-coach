import { cp, rm } from 'node:fs/promises'

await rm('dist/db/migrations', { force: true, recursive: true })
await cp('src/db/migrations', 'dist/db/migrations', { recursive: true })
