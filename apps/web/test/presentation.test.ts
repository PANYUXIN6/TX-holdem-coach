import { describe, expect, it } from 'vitest'
import { avatarMark, cardPresentation } from '../src/components/presentation.js'

describe('人物与牌面展示契约', () => {
  it('使用去空格后的前两个 Unicode 码点，保留单字姓名', () => {
    expect(avatarMark('  陈小明  ')).toBe('陈小')
    expect(avatarMark('李')).toBe('李')
    expect(avatarMark('🂡小明')).toBe('🂡小')
  })
  it('将共享四种花色和 T 映射到既有资源与中文名称', () => {
    expect(cardPresentation({ suit: 'hearts', rank: 'T' })).toEqual({
      src: '/poker/heart_10.png',
      label: '红桃 10',
    })
    expect(cardPresentation({ suit: 'clubs', rank: 'A' }).src).toBe(
      '/poker/club_A.png',
    )
    expect(cardPresentation({ suit: 'diamonds', rank: '2' }).src).toBe(
      '/poker/diamond_2.png',
    )
    expect(cardPresentation({ suit: 'spades', rank: 'K' }).src).toBe(
      '/poker/spade_K.png',
    )
  })
})
