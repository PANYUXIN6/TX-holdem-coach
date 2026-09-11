import { describe, expect, it } from 'vitest'
import { PublicSessionSnapshotSchema } from '@tx-holdem-coach/contracts'
import { createQueryClient } from '../src/query/client.js'
import { keys } from '../src/query/keys.js'
import { createReceiver } from '../src/query/session-receiver.js'
import { ids, publicSnapshot } from './fixtures.js'
const snapshot = (eventSeq: number, stateVersion: number) =>
  PublicSessionSnapshotSchema.parse({
    ...publicSnapshot,
    eventSeq,
    stateVersion,
  })
describe('唯一场次接收器', () => {
  it.each([
    [10, 3, 'duplicate'],
    [11, 4, 'accepted'],
    [11, 6, 'accepted'],
    [12, 5, 'gap'],
    [11, 3, 'protocol'],
  ])('增量 (%s,%s) → %s', (seq, version, expected) => {
    const client = createQueryClient()
    const receiver = createReceiver(client)
    const context = receiver.begin(ids.session)
    receiver.receive(ids.session, snapshot(10, 4), 'calibration', context)
    expect(
      receiver.receive(
        ids.session,
        snapshot(seq, version),
        'incremental',
        context,
      ).kind,
    ).toBe(expected)
    client.clear()
  })
  it('区分在途竞速与请求开始前已倒退，并接受同游标校准', () => {
    const client = createQueryClient()
    const receiver = createReceiver(client)
    receiver.receive(
      ids.session,
      snapshot(10, 4),
      'calibration',
      receiver.begin(ids.session),
    )
    const before = receiver.begin(ids.session)
    receiver.receive(ids.session, snapshot(11, 5), 'incremental', before)
    expect(
      receiver.receive(ids.session, snapshot(10, 4), 'calibration', before)
        .kind,
    ).toBe('superseded')
    expect(
      receiver.receive(
        ids.session,
        snapshot(10, 4),
        'calibration',
        receiver.begin(ids.session),
      ).kind,
    ).toBe('protocol')
    expect(
      receiver.receive(ids.session, snapshot(11, 5), 'calibration', before)
        .kind,
    ).toBe('accepted')
    receiver.invalidate(ids.session)
    expect(
      receiver.receive(ids.session, snapshot(12, 5), 'calibration', before)
        .kind,
    ).toBe('invalidated')
    client.clear()
  })
  it('真实 Query 自动写回不覆盖较新 SSE；cancel revert:false 不回滚', async () => {
    const client = createQueryClient()
    const receiver = createReceiver(client)
    const context = receiver.begin(ids.session)
    receiver.receive(ids.session, snapshot(10, 4), 'calibration', context)
    await client.fetchQuery({
      queryKey: keys.session(ids.session),
      queryFn: () => {
        const selected = receiver.receive(
          ids.session,
          snapshot(10, 4),
          'calibration',
          context,
        ).snapshot!
        queueMicrotask(() =>
          receiver.receive(
            ids.session,
            snapshot(11, 5),
            'incremental',
            context,
          ),
        )
        return selected
      },
    })
    expect(client.getQueryData(keys.session(ids.session))).toEqual(
      snapshot(11, 5),
    )
    const pending = client
      .fetchQuery({
        queryKey: keys.session(ids.session),
        queryFn: ({ signal }) =>
          new Promise((_, reject) =>
            signal.addEventListener('abort', () => reject(new Error('abort'))),
          ),
      })
      .catch(() => {})
    receiver.receive(ids.session, snapshot(12, 5), 'incremental', context)
    await client.cancelQueries(
      { queryKey: keys.session(ids.session) },
      { revert: false },
    )
    await pending
    expect(client.getQueryData(keys.session(ids.session))).toEqual(
      snapshot(12, 5),
    )
    client.clear()
  })
})
