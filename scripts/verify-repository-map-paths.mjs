import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mapDocuments = ['docs/REPO_MAP.md', 'docs/ARCHITECTURE.md']
const repositoryPathPattern =
  /^(?:(?:apps|packages|docs|scripts)\/[A-Za-z0-9._/-]+\/?|\.agents\/[A-Za-z0-9._/-]+\/?|package\.json|pnpm-workspace\.yaml|tsconfig\.base\.json)$/

const declaredPaths = new Set()

for (const documentPath of mapDocuments) {
  const document = readFileSync(resolve(repositoryRoot, documentPath), 'utf8')

  for (const match of document.matchAll(/`([^`\n]+)`/g)) {
    const candidate = match[1]

    if (repositoryPathPattern.test(candidate)) {
      declaredPaths.add(candidate)
    }
  }
}

if (declaredPaths.size === 0) {
  console.error('仓库地图中未找到可校验的关键路径声明。')
  process.exitCode = 1
} else {
  const missingPaths = [...declaredPaths]
    .filter((declaredPath) => !existsSync(resolve(repositoryRoot, declaredPath)))
    .sort()

  if (missingPaths.length > 0) {
    console.error('仓库地图声明了不存在的关键路径：')
    for (const missingPath of missingPaths) {
      console.error(`- ${missingPath}`)
    }
    process.exitCode = 1
  } else {
    console.log(`仓库地图关键路径校验通过（${declaredPaths.size} 项）。`)
  }
}
