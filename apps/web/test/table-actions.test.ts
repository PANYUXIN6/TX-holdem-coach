import { describe, expect, it } from 'vitest'
import {
  betweenHands,
  heroActions,
  positiveAmount,
  rebuyLimit,
} from '../src/table/actions.js'
import { tableSnapshot, completeTable } from './table-fixtures.js'
describe('操作展示派生', () => {
  it('普通目标使用精确正整数及服务端范围，全下不混入普通金额', () => {
    expect(positiveAmount('200', 200, 1999)).toBe(200)
    expect(positiveAmount('1999', 200, 1999)).toBe(1999)
    expect(positiveAmount('2000', 200, 1999)).toBeNull()
    expect(positiveAmount('1e3', 200, 1999)).toBeNull()
  })
  it('仅返回用户回合合法集合；补码上限读取当前余额', () => {
    const s = tableSnapshot()
    expect(heroActions(s)).toEqual([])
    s.hand!.currentActorSeatNumber = 0
    s.hand!.legalActions = [{ type: 'allIn', target: 2000 }]
    expect(heroActions(s)).toEqual([{ type: 'allIn', target: 2000 }])
    expect(betweenHands(completeTable(s))).toBe(true)
    expect([0, 1900, 2000, 2200].map(rebuyLimit)).toEqual([2000, 100, 0, 0])
  })
})
