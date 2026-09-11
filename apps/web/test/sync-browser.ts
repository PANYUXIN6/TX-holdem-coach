import { MutationObserver, type QueryClient } from '@tanstack/react-query'
import type { SessionRuntime } from '../src/session-sync/runtime.js'
import { ids } from './fixtures.js'
import { keys } from '../src/query/keys.js'
export function installSyncAcceptance(
  get: () => {
    client: QueryClient | undefined
    runtime: SessionRuntime | undefined
  },
) {
  const panel = document.getElementById('checks')!
  const button = document.createElement('button')
  button.textContent = '运行 M6.3 验收'
  panel.append(button)
  const output = document.createElement('pre')
  output.style.whiteSpace = 'pre-wrap'
  panel.append(output)
  const fixture = async (action: string) =>
    (await fetch(`/api/__fixture/${action}`, { method: 'POST' })).json()
  const navigate = (path: string) => {
    history.pushState(null, '', path)
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  const until = async (predicate: () => boolean) => {
    const start = Date.now()
    while (!predicate()) {
      if (Date.now() - start > 8000) throw new Error('等待超时')
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
  const inspect = document.createElement('button')
  inspect.textContent = '检查原生生命周期'
  panel.append(inspect)
  const live = document.createElement('pre')
  panel.append(live)
  let unsubscribe: (() => void) | undefined
  let visibilityEvents = 0
  document.addEventListener('visibilitychange', () => {
    visibilityEvents++
  })
  inspect.onclick = () => {
    void (async () => {
      const { runtime } = get()
      if (!runtime) return
      unsubscribe?.()
      navigate('/')
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fixture('reset')
      const update = () => {
        live.textContent = `同步状态 ${runtime.getStatus(ids.session)}；原生隐藏 ${document.hidden}；可见性事件 ${visibilityEvents}`
      }
      unsubscribe = runtime.subscribe(ids.session, update)
      navigate(`/sessions/${ids.session}`)
    })()
  }
  button.onclick = () => {
    button.disabled = true
    output.textContent = ''
    const pass = (message: string) => {
      output.textContent += `✓ ${message}\n`
    }
    const assert = (condition: unknown, message: string) => {
      if (!condition) throw new Error(message)
      pass(message)
    }
    void (async () => {
      const { client, runtime } = get()
      if (!client || !runtime) throw new Error('应用运行时未挂载')
      navigate('/')
      await new Promise((resolve) => setTimeout(resolve, 100))
      await fixture('reset')
      await client.fetchQuery(runtime.activeOptions())
      assert(client.getQueryData(keys.active()) === null, 'active 初始为 null')
      const create = new MutationObserver(client, runtime.createOptions())
      await create
        .mutate({ rosterSource: { type: 'latestEnded' } })
        .catch(() => {})
      assert(
        create.getCurrentResult().status === 'error' &&
          runtime.getCreateTarget() === ids.session,
        '创建冲突保持失败并提供继续入口',
      )
      navigate(`/sessions/${runtime.getCreateTarget()}`)
      await until(() => runtime.getStatus(ids.session) === 'ready')
      pass('真实 App 路由完成 snapshot + GET 屏障')
      for (const suffix of ['/current-hand', '/agents', '']) {
        navigate(`/sessions/${ids.session}${suffix}`)
        await new Promise((resolve) => setTimeout(resolve, 100))
        await until(() => runtime.getStatus(ids.session) === 'ready')
      }
      pass('牌桌 / 本手 / AI 路由恢复可用')
      await fixture('disconnect')
      await until(() => runtime.getStatus(ids.session) === 'reconnecting')
      const before = await fixture('metrics')
      await new MutationObserver(client, runtime.commandOptions(ids.session))
        .mutate({ type: 'endSession', payload: {} })
        .catch(() => {})
      assert(
        (await fixture('metrics')).commands === before.commands,
        '断线提交未发出 POST',
      )
      await fixture('recover')
      runtime.online()
      await until(() => runtime.getStatus(ids.session) === 'ready')
      assert(
        (await fixture('metrics')).cursors.at(-1) === '8',
        '重连携带已接收 Last-Event-ID',
      )
      await fixture('hold')
      const reading = runtime.read(ids.session).catch(() => {})
      await until(() => true)
      await new Promise((resolve) => setTimeout(resolve, 60))
      await fixture('advance')
      await until(
        () =>
          client.getQueryData<{ eventSeq: number }>(keys.session(ids.session))
            ?.eventSeq === 9,
      )
      await fixture('release')
      await reading
      assert(
        client.getQueryData<{ stateVersion: number }>(keys.session(ids.session))
          ?.stateVersion === 5,
        '旧 GET 晚到不覆盖 SSE',
      )
      await fixture('pause')
      await until(
        () =>
          client.getQueryData<{ agentRunState: string }>(
            keys.session(ids.session),
          )?.agentRunState === 'paused',
      )
      pass('同版本 AI 协调状态已更新')
      const historyKey = ['hands', 'list', { sessionId: ids.session }, null]
      client.setQueryData(historyKey, { rows: [] })
      await fixture('complete')
      await until(
        () => client.getQueryState(historyKey)?.isInvalidated === true,
      )
      pass('无用户 Mutation 的 AI 完成失效历史')
      Object.defineProperty(document, 'hidden', {
        configurable: true,
        value: true,
      })
      document.dispatchEvent(new Event('visibilitychange'))
      assert(
        runtime.getStatus(ids.session) === 'suspended',
        '隐藏生命周期关闭闸门',
      )
      Reflect.deleteProperty(document, 'hidden')
      document.dispatchEvent(new Event('visibilitychange'))
      await until(() => runtime.getStatus(ids.session) === 'ready')
      const beforeBad = (await fixture('metrics')).connections
      await fixture('bad')
      await until(() => runtime.getStatus(ids.session) === 'ready')
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert(
        (await fixture('metrics')).connections > beforeBad,
        '坏帧关闭流并经诊断重建连接',
      )
      await fixture('rollback')
      await until(() => runtime.getStatus(ids.session) === 'blocked')
      assert(
        runtime.getError(ids.session)?.message === 'API protocol' &&
          client.getQueryData<{ stateVersion: number }>(
            keys.session(ids.session),
          )?.stateVersion === 6,
        '真实版本回退阻塞且错误脱敏',
      )
      await fixture('hold')
      const late = runtime.read(ids.session).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 60))
      await new MutationObserver(client, runtime.mutations.clearData()).mutate({
        confirmation: '永久清空全部数据',
      })
      await fixture('release')
      await late
      assert(
        client.getQueryData(keys.session(ids.session)) === undefined &&
          client.getQueryData(keys.active()) === null,
        `清空后迟到合法 GET 不复活缓存（快照=${client.getQueryData<{ eventSeq: number }>(keys.session(ids.session))?.eventSeq ?? '无'}，active=${String(client.getQueryData(keys.active()))}）`,
      )
      const metrics = await fixture('metrics')
      assert(metrics.creates === 1, '创建未自动重发')
      assert(
        metrics.hosts.every((host: string) => host === '127.0.0.1:18787') &&
          metrics.origins.includes(location.origin),
        '同源代理 Host / 浏览器 Origin 正确',
      )
      navigate('/')
      await new Promise((resolve) => setTimeout(resolve, 100))
      pass(
        `全部通过；连接高水位 ${metrics.maxConnections}，GET ${metrics.gets}`,
      )
    })()
      .catch((error) => {
        output.textContent += `失败：${error instanceof Error ? error.message : 'unknown'}\n`
      })
      .finally(() => {
        button.disabled = false
      })
  }
}
