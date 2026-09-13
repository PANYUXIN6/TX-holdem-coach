import type { PublicSessionSnapshot } from '@tx-holdem-coach/contracts'
import { ids } from './fixtures.js'
type Fixture = {
  hero(): void
  zero(): void
  hold(): void
  release(): void
  mode(mode: string): void
  actions: Record<string, () => void>
  commands: { command: { type: string; payload: unknown; commandId: string } }[]
  snapshot(): PublicSessionSnapshot
  errors: string[]
}
export function installActionChecks() {
  const fixture = (window as unknown as { tableFixture: Fixture }).tableFixture
  const run = document.createElement('button')
  run.textContent = '运行 M7.5 行动验收'
  const result = document.createElement('pre')
  result.id = 'action-check-result'
  document.body.append(run, result)
  const until = async (check: () => unknown) => {
    const start = Date.now()
    while (!check()) {
      if (Date.now() - start > 4000) throw new Error('等待界面超时')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent === text && !b.disabled,
    )
  const click = async (text: string) => {
    await until(() => button(text))
    button(text)!.click()
  }
  const input = (id: string, value: string) => {
    const node = document.getElementById(id) as HTMLInputElement
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!.call(node, value)
    node.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const assert = (ok: unknown, message: string) => {
    if (!ok) throw new Error(message)
    result.textContent += `✓ ${message}\n`
  }
  const payload = () => fixture.commands.at(-1)!.command.payload
  run.onclick = () => {
    run.disabled = true
    void (async () => {
      fixture.hero()
      await click('加注…')
      await until(() => document.getElementById('bet-target'))
      assert(
        document.getElementById('bet-target')!.getAttribute('inputmode') ===
          'numeric',
        '金额输入提供数字键盘提示',
      )
      input('bet-target', '2e2')
      await until(
        () =>
          document
            .getElementById('bet-target')!
            .getAttribute('aria-invalid') === 'true',
      )
      assert(!button('加到 —'), '非法金额不可提交')
      assert(
        !document.querySelector('.amount-shortcuts [aria-pressed="true"]'),
        '非法文本即使数值等于快捷目标也不选中快捷项',
      )
      await click('1/2 池 300')
      await until(() =>
        document
          .querySelector('.amount-shortcuts [aria-pressed="true"]')
          ?.textContent?.includes('300'),
      )
      fixture.hold()
      fixture.mode('sse-first')
      await click('加到 300')
      await until(() => fixture.commands.length === 1)
      assert(
        JSON.stringify(payload()) ===
          JSON.stringify({
            action: { type: 'raise', targetStreetCommitment: 300 },
          }),
        '选额发送普通总目标载荷',
      )
      await until(() => document.querySelector('.completion-teaser'))
      assert(
        !button('开始下一手') && !button('补码…'),
        'SSE 先到而 HTTP 未回时全部写入口禁用',
      )
      fixture.release()
      fixture.mode('normal')
      await click('补码…')
      input('rebuy-amount', '50')
      await until(() =>
        document.querySelector('.field-hint')?.textContent?.includes('1,950'),
      )
      await click('确认补码')
      await until(() => fixture.snapshot().seats[0]!.stack === 1950)
      assert(
        JSON.stringify(payload()) === JSON.stringify({ amount: 50 }),
        '部分补码只提交追加额 50',
      )
      assert(
        document
          .querySelector('.completion-teaser')
          ?.textContent?.includes('-100'),
        '补码后上一手净变化保持 -100',
      )
      ;(
        document.querySelector('.completion-teaser a') as HTMLAnchorElement
      ).click()
      await until(
        () =>
          (document.getElementById('completed-summary') as HTMLDetailsElement)
            .open,
      )
      assert(
        document.querySelectorAll('.settlement-seat').length ===
          fixture.snapshot().seats.length,
        '正文结算展示全部参与席',
      )
      await click('开始下一手')
      await until(() => fixture.snapshot().hand)
      assert(
        fixture.commands.at(-1)!.command.type === 'startNextHand',
        '下一手只使用原 startNextHand 命令',
      )
      fixture.hero()
      await click('全下')
      assert(fixture.commands.length === 3, '选择全下不发送命令')
      await click('取消全下')
      await click('全下')
      const allInButton = button('全下至 2,000')!
      allInButton.click()
      allInButton.click()
      await until(() => fixture.commands.length === 4)
      assert(
        JSON.stringify(payload()) ===
          JSON.stringify({ action: { type: 'allIn' } }),
        '全下独立载荷且双击仅一条命令',
      )
      await until(() => button('开始下一手'))
      const nextSummary = document.getElementById(
        'completed-summary',
      ) as HTMLDetailsElement
      assert(
        !nextSummary.open &&
          nextSummary.getAttribute('aria-expanded') !== 'true',
        '新一手结算保持关闭，辅助状态不继承上一手展开',
      )
      await click('开始下一手')
      await until(() => fixture.snapshot().hand)
      fixture.zero()
      await click('买入 2,000')
      await until(() => fixture.snapshot().seats[0]!.stack === 2000)
      assert(
        JSON.stringify(payload()) === JSON.stringify({ amount: 2000 }),
        '归零买入固定 2,000，未自动下一手',
      )
      assert(
        fixture.snapshot().seats[1]!.stack === 0,
        '买入不会提前补入 AI 筹码',
      )
      fixture.zero()
      await click('结束场次')
      await until(() => document.querySelector('dialog[open]'))
      const version = fixture.snapshot().stateVersion
      await click('确认结束')
      await until(() =>
        document
          .querySelector('.action-panel')
          ?.textContent?.includes('返回训练'),
      )
      assert(
        fixture.snapshot().stateVersion === version &&
          fixture.snapshot().lifecycleStatus === 'ended',
        '正常结束同版本更高事件序号进入只读',
      )
      assert(fixture.snapshot().seats[1]!.stack === 0, '直接结束不买入归零 AI')
      assert(!button('开始下一手') && !button('买入 2,000'), '结束后无写操作')
      assert(
        document.querySelector(`a[href="/sessions/${ids.session}/history"]`) ||
          document
            .querySelector('.action-panel')
            ?.textContent?.includes('本场历史'),
        '结束后保留本场历史入口',
      )
      assert(fixture.errors.length === 0, '无未处理异步拒绝')
      result.textContent += '全部通过\n'
    })()
      .catch((error) => {
        result.textContent += `失败：${String(error)}\n`
      })
      .finally(() => {
        fixture.release()
        run.disabled = false
      })
  }
}
