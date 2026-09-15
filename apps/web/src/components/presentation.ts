import type { Card, CardSuit } from '@tx-holdem-coach/contracts'

export function avatarMark(displayName: string): string {
  return Array.from(displayName.trim()).slice(0, 2).join('')
}
const suits: Record<CardSuit, { file: string; name: string }> = {
  clubs: { file: 'club', name: '梅花' },
  diamonds: { file: 'diamond', name: '方块' },
  hearts: { file: 'heart', name: '红桃' },
  spades: { file: 'spade', name: '黑桃' },
}
export function cardPresentation(card: Card) {
  const suit = suits[card.suit]
  const rank = card.rank === 'T' ? '10' : card.rank
  return {
    src: `/poker/${suit.file}_${rank}.png`,
    label: `${suit.name} ${rank}`,
  }
}
