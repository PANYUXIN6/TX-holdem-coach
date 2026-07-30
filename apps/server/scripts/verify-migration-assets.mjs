import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { verifyDatabaseTargetsManifest } from '../dist/db/migration-artifact.js'
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

const [sourceTargetsContents, distTargetsContents, manifestContents] =
  await Promise.all([
    readFile('config/database-targets.json', 'utf8'),
    readFile('dist/db/config/database-targets.json', 'utf8'),
    readFile('dist/db/database-targets.manifest.json', 'utf8'),
  ])

if (sourceTargetsContents !== distTargetsContents) {
  throw new Error('数据库目标注册表构建资产不一致。')
}

const sourceTargets = JSON.parse(sourceTargetsContents)
const artifactTargets = verifyDatabaseTargetsManifest(
  JSON.parse(manifestContents),
)

if (JSON.stringify(sourceTargets) !== JSON.stringify(artifactTargets)) {
  throw new Error('迁移制品中的数据库目标注册表不一致。')
}
