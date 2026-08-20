import { readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const assetDirectory = resolve(repositoryRoot, 'apps/web/public/poker')
const suits = ['club', 'diamond', 'heart', 'spade']
const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A']
const expectedFilenames = [
  'card_back.png',
  'joker_black.png',
  'joker_red.png',
  ...suits.flatMap((suit) => ranks.map((rank) => `${suit}_${rank}.png`)),
].sort()
const entries = readdirSync(assetDirectory, { withFileTypes: true })
const actualFilenames = entries.map((entry) => entry.name).sort()

if (
  entries.some((entry) => !entry.isFile()) ||
  actualFilenames.length !== expectedFilenames.length ||
  actualFilenames.some(
    (filename, index) => filename !== expectedFilenames[index],
  )
) {
  console.error('扑克牌资源清单不完整或包含未声明条目。')
  process.exitCode = 1
} else {
  console.log(`扑克牌资源清单校验通过（${actualFilenames.length} 项）。`)
}
