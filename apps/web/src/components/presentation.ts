import type { Card, CardSuit } from '@tx-holdem-coach/contracts'

export function avatarMark(displayName: string): string {
  return Array.from(displayName.trim()).slice(0, 2).join('')
}
const suits: Record<
  CardSuit,
  { file: string; name: string; symbol: string; red: boolean }
> = {
  clubs: { file: 'club', name: '梅花', symbol: '♣', red: false },
  diamonds: { file: 'diamond', name: '方块', symbol: '♦', red: true },
  hearts: { file: 'heart', name: '红桃', symbol: '♥', red: true },
  spades: { file: 'spade', name: '黑桃', symbol: '♠', red: false },
}
export function cardPresentation(card: Card) {
  const suit = suits[card.suit]
  const rank = card.rank === 'T' ? '10' : card.rank
  return {
    src: `/poker/${suit.file}_${rank}.png`,
    label: `${suit.name} ${rank}`,
    text: `${suit.symbol}${rank}`,
    red: suit.red,
  }
}
