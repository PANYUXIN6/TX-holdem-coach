import { expect, test } from 'vitest'
import { assertRosterPreviewBinding } from '../../src/sessions/roster-preparation.js'
import { RosterSourceChangedError } from '../../src/persistence/errors.js'
const snapshots = [1, 2, 3, 4, 6].map((seatNumber) => ({
  seatNumber,
  configSnapshotKey: String(seatNumber).repeat(64),
}))
const binding = {
  sourceSessionId: 'source',
  assignments: snapshots.map((s) => ({
    sourceSeatNumber: s.seatNumber,
    seatNumber: s.seatNumber,
    configSnapshotKey: s.configSnapshotKey,
  })),
}
test('结构合法但来源、配置、全员集合或占用座位集合不匹配时拒绝', () => {
  expect(() =>
    assertRosterPreviewBinding('source', snapshots, binding),
  ).not.toThrow()
  for (const changed of [
    { ...binding, sourceSessionId: 'other' },
    { ...binding, assignments: binding.assignments.slice(1) },
    {
      ...binding,
      assignments: binding.assignments.map((a, i) =>
        i === 0 ? { ...a, configSnapshotKey: 'a'.repeat(64) } : a,
      ),
    },
    {
      ...binding,
      assignments: binding.assignments.map((a, i) =>
        i === 0 ? { ...a, seatNumber: 5 } : a,
      ),
    },
  ])
    expect(() =>
      assertRosterPreviewBinding('source', snapshots, changed),
    ).toThrow(RosterSourceChangedError)
})
