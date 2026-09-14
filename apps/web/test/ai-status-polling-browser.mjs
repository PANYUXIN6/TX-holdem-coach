import assert from 'node:assert/strict'

// 使用现有 AI 页面 fixture；由浏览器验收调用方传入 Playwright Page。
export async function verifyAiStatusPolling(page, baseUrl) {
  await page.goto(`${baseUrl}/test/ai-status.html`)
  await page.waitForFunction(() =>
    window.aiFixture?.requests.some((x) => x.includes('attempts')),
  )
  const counts = () =>
    page.evaluate(() => {
      const r = window.aiFixture.requests
      return {
        run: r.filter((x) => /agent-runs\/[^/]+$/.test(x)).length,
        hand: r.filter((x) => x.includes('agent-calls')).length,
        attempt: r.filter((x) => x.includes('attempts')).length,
      }
    })
  await page.waitForTimeout(500)
  let a = await counts()
  await page.waitForTimeout(3500)
  let b = await counts()
  console.log('thinking', a, b)
  assert(b.run > a.run && b.attempt > a.attempt)
  await page.evaluate(() => window.aiFixture.pause())
  await page.getByText('AI 已暂停', { exact: true }).first().waitFor()
  await page.waitForTimeout(700)
  a = await counts()
  assert(a.run > b.run && a.hand > b.hand && a.attempt > b.attempt)
  await page.waitForTimeout(6500)
  b = await counts()
  console.log('paused', a, b)
  assert.deepEqual(b, a)
  await page.getByRole('button', { name: '重新读取技术摘要' }).click()
  await page.waitForTimeout(300)
  b = await counts()
  assert(b.attempt > a.attempt)
  await page.evaluate(() => window.aiFixture.replacement())
  await page.getByText('AI 思考中', { exact: true }).first().waitFor()
  await page.waitForTimeout(700)
  a = await counts()
  await page.waitForTimeout(3500)
  b = await counts()
  console.log('resumed', a, b)
  assert(b.run > a.run && b.attempt > a.attempt)
  await page.evaluate(() => window.aiFixture.pause())
  await page.getByText('AI 已暂停', { exact: true }).first().waitFor()
  await page.getByRole('link', { name: '查看调试信息 ↗' }).click()
  await page.waitForTimeout(700)
  a = await counts()
  await page.waitForTimeout(3500)
  b = await counts()
  console.log('debug failed/inProgress', a, b)
  assert(b.run > a.run && b.hand > a.hand)
  await page.goto(`${baseUrl}/test/ai-status.html`)
  await page.waitForFunction(() =>
    window.aiFixture?.requests.some((x) => x.includes('attempts')),
  )
  await page.evaluate(() => window.aiFixture.completeAttempt())
  await page.waitForTimeout(4000)
  a = await counts()
  await page.waitForTimeout(6500)
  b = await counts()
  console.log('terminal', a, b)
  assert.deepEqual(b, a)
  assert.deepEqual(await page.evaluate(() => window.aiFixture.errors), [])
}
