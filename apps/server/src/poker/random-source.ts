import { randomInt } from 'node:crypto'

export interface RandomSource {
  nextInt(maxExclusive: number): number
}

function assertPositiveInteger(maxExclusive: number): void {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError('随机上界必须为正整数。')
  }
}

export const SECURE_RANDOM_SOURCE: RandomSource = Object.freeze({
  nextInt(maxExclusive: number): number {
    assertPositiveInteger(maxExclusive)
    return randomInt(maxExclusive)
  },
})
