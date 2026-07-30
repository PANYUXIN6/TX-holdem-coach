import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createDatabaseTargetsManifest } from '../dist/db/migration-artifact.js'

await rm('dist/db/migrations', { force: true, recursive: true })
await rm('dist/db/config', { force: true, recursive: true })
await rm('dist/db/database-targets.manifest.json', { force: true })
await cp('src/db/migrations', 'dist/db/migrations', { recursive: true })
await mkdir('dist/db/config', { recursive: true })
await cp('config/database-targets.json', 'dist/db/config/database-targets.json')

const databaseTargets = JSON.parse(
  await readFile('config/database-targets.json', 'utf8'),
)
const manifest = createDatabaseTargetsManifest(databaseTargets)
await writeFile(
  'dist/db/database-targets.manifest.json',
  `${JSON.stringify(manifest, null, 2)}\n`,
)
