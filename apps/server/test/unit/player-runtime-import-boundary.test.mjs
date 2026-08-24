import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'

async function recursiveSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) return recursiveSourceFiles(path)
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
    }),
  )
  return nested.flat()
}

async function combinedSource(directories) {
  const files = (
    await Promise.all(directories.map(recursiveSourceFiles))
  ).flat()
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join(
    '\n',
  )
}

describe('Player runtime import boundary', () => {
  test('recursively scans runtime boundary directories', async () => {
    const source = await combinedSource(['src/agents'])
    expect(source).toContain('PlayerObservationAuthorityPort')
  })

  test('keeps private table facts and PostgreSQL adapters out of agents/player', async () => {
    const source = await combinedSource(['src/agents/player'])
    expect(source).not.toMatch(
      /private-table-state|poker\/state|private-event(?:-codec)?|player-observation-authority/,
    )
    expect(source).toContain('player-visible-state')
  })

  test('keeps Foundation and ModelGateway independent from Player observations', async () => {
    const source = await combinedSource([
      'src/agents/foundation',
      'src/agents/model-gateway',
    ])
    expect(source).not.toMatch(/player-visible-state|player-observation/)
  })

  test('keeps the shared poker projection kernel independent from runtime and persistence layers', async () => {
    const source = await combinedSource(['src/poker'])
    expect(source).not.toMatch(
      /sessions\/authoritative-state|agents\/|persistence\/|providers\/|http\//,
    )
  })

  test('does not expose server-private observations through shared Contracts', async () => {
    const source = await readFile(
      '../../packages/contracts/src/index.ts',
      'utf8',
    )
    expect(source).not.toMatch(/PlayerVisibleState|player-visible-state/)
  })

  test('keeps observation construction and certification authority-only in production', async () => {
    const files = await recursiveSourceFiles('src')
    const allowedBySymbol = new Map([
      [
        'buildPlayerObservationDraft',
        new Set([
          'src/persistence/player-observation-authority.ts',
          'src/sessions/authoritative-state/player-observation-builder.ts',
        ]),
      ],
      [
        'certifyPlayerVisibleState',
        new Set([
          'src/persistence/player-observation-authority.ts',
          'src/sessions/authoritative-state/player-information-boundary-guard.ts',
        ]),
      ],
      [
        'isPlayerObservationDraft',
        new Set([
          'src/sessions/authoritative-state/player-observation-builder.ts',
          'src/sessions/authoritative-state/player-information-boundary-guard.ts',
        ]),
      ],
      [
        'createCommittedActionProof',
        new Set([
          'src/poker/betting-projection.ts',
          'src/poker/betting.ts',
          'src/sessions/authoritative-state/player-observation-builder.ts',
        ]),
      ],
      [
        'verifyBettingActionEvidence',
        new Set([
          'src/poker/betting-projection.ts',
          'src/sessions/authoritative-state/player-information-boundary-guard.ts',
        ]),
      ],
    ])

    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const [symbol, allowedFiles] of allowedBySymbol) {
        if (source.includes(symbol)) expect(allowedFiles.has(file)).toBe(true)
      }
    }
  })
})
