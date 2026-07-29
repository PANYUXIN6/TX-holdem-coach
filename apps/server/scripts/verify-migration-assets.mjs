import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildExpectedMigrationSequence } from '../dist/db/migration-compatibility.js'

const sourceDirectory = 'src/db/migrations'
const distDirectory = 'dist/db/migrations'

async function listFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    const relativePath = join(prefix, entry.name)

    if (entry.isDirectory()) {
      files.push(
        ...(await listFiles(join(directory, entry.name), relativePath)),
      )
    } else if (entry.isFile()) {
      files.push(relativePath)
    }
  }

  return files.sort()
}

await access(join(distDirectory, 'meta', '_journal.json'))
const [sourceFiles, distFiles] = await Promise.all([
  listFiles(sourceDirectory),
  listFiles(distDirectory),
])

if (JSON.stringify(sourceFiles) !== JSON.stringify(distFiles)) {
  throw new Error('迁移构建资产不完整。')
}

await Promise.all(
  sourceFiles.map(async (file) => {
    const [source, dist] = await Promise.all([
      readFile(join(sourceDirectory, file)),
      readFile(join(distDirectory, file)),
    ])

    if (!source.equals(dist)) {
      throw new Error('迁移构建资产不一致。')
    }
  }),
)

await buildExpectedMigrationSequence(distDirectory)
