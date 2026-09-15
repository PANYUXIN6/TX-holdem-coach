import assert from 'node:assert/strict'
export async function verifySettings(page, baseUrl, screenshotDir) {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const go = async () => {
    await page.goto(baseUrl + '/settings')
    await page.waitForFunction(() => !!window.settingsFixture)
    await page
      .getByRole('button', { name: '保存时间预算', exact: true })
      .waitFor()
  }
  const fixture = (method, value) =>
    page.evaluate(
      ([method, value]) => window.settingsFixture[method](value),
      [method, value],
    )
  const button = (name) => page.getByRole('button', { name, exact: true })
  const requests = () => page.evaluate(() => window.settingsFixture.requests)
  const text = () => page.locator('main').innerText()
  await go()
  assert.equal(
    await page.evaluate(
      () =>
        window.settingsFixture.requests.filter((r) =>
          r.startsWith('GET /api/sessions?'),
        ).length -
        window.settingsFixture.aborted.filter((r) =>
          r.startsWith('GET /api/sessions?'),
        ).length,
    ),
    1,
  )
  assert.equal(
    (await requests()).filter(
      (r) =>
        r.startsWith('POST') ||
        r.includes('/events') ||
        /GET \/api\/sessions\/[a-f0-9-]+$/.test(r),
    ).length,
    0,
  )
  for (const [state, label] of [
    ['notConfigured', '尚未配置'],
    ['notChecked', '尚未检测'],
    ['available', '检测可用'],
    ['unavailable', '检测不可用'],
  ]) {
    await fixture('provider', state)
    await button('刷新摘要').click()
    await page.getByText(label, { exact: true }).waitFor()
  }
  await fixture('hold', 'check')
  await button('检测连接').click()
  await button('正在检测').waitFor()
  await fixture('release')
  await button('检测连接').waitFor()
  await page.getByText('可创建场次', { exact: true }).waitFor()
  await fixture('failure', 'check-network')
  await button('检测连接').click()
  await page.getByText('检测未完成', { exact: true }).waitFor()
  await page.getByText('已配置', { exact: true }).waitFor()
  await fixture('failure', '')
  await fixture('afterWriteFailure', 'providers')
  await button('检测连接').click()
  await page
    .getByText('检测请求已完成，但最新摘要读取失败', { exact: true })
    .waitFor()
  await fixture('failure', '')
  await fixture('afterWriteFailure', '')
  await button('刷新摘要').click()
  const attempt = page.getByLabel('单次尝试超时（秒）', { exact: true }),
    deadline = page.getByLabel('完整决策 deadline（秒）', { exact: true })
  for (const value of ['', '31', '5.5']) {
    await attempt.fill(value)
    await attempt.press('Tab')
    assert(await button('保存时间预算').isDisabled())
  }
  assert.equal(
    (await requests()).filter((r) => r.startsWith('PATCH')).length,
    0,
  )
  await attempt.fill('30')
  await deadline.fill('15')
  await deadline.press('Tab')
  assert(await button('保存时间预算').isDisabled())
  await attempt.fill('20')
  await deadline.fill('45')
  await button('保存时间预算').click()
  await page.getByText('时间预算已保存', { exact: true }).waitFor()
  assert.deepEqual(
    await page.evaluate(() =>
      window.settingsFixture.bodies.filter((b) => b.settings),
    ),
    [{ settings: { attemptTimeoutSeconds: 20 } }],
  )
  await attempt.fill('25')
  await fixture('settings', {
    attemptTimeoutSeconds: 20,
    decisionDeadlineSeconds: 60,
  })
  await button('刷新时间预算').click()
  await page
    .getByText('服务端设置已更新，可放弃草稿并重新载入', { exact: true })
    .waitFor()
  assert.equal(await attempt.inputValue(), '25')
  await button('取消修改并重新载入').click()
  assert.equal(await deadline.inputValue(), '60')
  await attempt.fill('24')
  await fixture('afterWriteFailure', 'agent')
  await button('保存时间预算').click()
  await page
    .getByText('保存已完成，但最新读取未完成', { exact: true })
    .waitFor()
  assert.equal(await attempt.inputValue(), '24')
  await fixture('failure', '')
  await fixture('afterWriteFailure', '')
  await button('刷新时间预算').click()
  await fixture('failure', 'health')
  await button('重新检测数据存储').click()
  await page.getByText('数据存储不可用', { exact: true }).waitFor()
  assert(!(await text()).includes('SENSITIVE_RAW'))
  await fixture('failure', '')
  await button('重新检测数据存储').click()
  assert.equal(await button('删除本场').count(), 1)
  await button('下一页').click()
  await page
    .getByText('e206c895-73d6-46c6-8237-5e6d7d943b57', { exact: true })
    .waitFor()
  assert.equal(
    await page
      .getByText('2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e', { exact: true })
      .count(),
    0,
  )
  await button('回到首页').click()
  await button('删除本场').waitFor()
  await fixture('hold', 'detail')
  await button('删除本场').click()
  await button('正在确认场次状态').waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await fixture('release')
  await page.locator('dialog[open]').waitFor()
  await button('取消').click()
  assert.equal(
    (await requests()).filter((r) => r.startsWith('DELETE')).length,
    0,
  )
  await fixture('failure', 'detail404')
  await button('删除本场').click()
  await page.getByText('资源已不可用', { exact: true }).waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await go()
  await fixture('detailLifecycle', 'active')
  await button('删除本场').click()
  await page
    .getByText('只能删除已结束的场次，请重新读取场次状态。', { exact: true })
    .waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await go()
  await fixture('hold', 'detail')
  await button('删除本场').click()
  await button('正在确认场次状态').waitFor()
  await page.getByRole('link', { name: '进入调用审计 ↗' }).click()
  await page.getByRole('link', { name: '返回设置', exact: true }).waitFor()
  await fixture('release')
  await page.goBack()
  await button('保存时间预算').waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await go()
  await fixture('hold', 'detail')
  await button('删除本场').click()
  await button('正在确认场次状态').waitFor()
  await button('清空全部应用数据').click()
  await button('取消').click()
  await fixture('release')
  await button('删除本场').waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 0)
  await go()
  await attempt.fill('20')
  await fixture('failure', 'patch-field')
  await button('保存时间预算').click()
  await page.getByText('保存未完成', { exact: true }).waitFor()
  assert.equal(await deadline.getAttribute('aria-invalid'), 'true')
  assert(await deadline.evaluate((el) => el === document.activeElement))
  assert(!(await text()).includes('SENSITIVE_RAW'))
  await go()
  await fixture('hold', 'delete')
  await button('删除本场').click()
  await page.locator('dialog[open]').waitFor()
  await button('永久删除本场').click()
  await button('取消').click()
  await page.getByRole('link', { name: '进入调用审计 ↗' }).click()
  await page.getByRole('link', { name: '返回设置', exact: true }).waitFor()
  await page.goBack()
  await button('清空全部应用数据').click()
  await fixture('release')
  await page.getByText(/已删除本场 .*已使 2 个/).waitFor()
  assert.equal(await page.locator('dialog[open]').count(), 1)
  await button('取消').click()
  await go()
  await fixture('seed')
  await fixture('hold', 'statistics')
  await fixture('startStatistics')
  await fixture('hold', 'sessions')
  await button('刷新目录').click()
  await button('删除本场').click()
  await page.locator('dialog[open]').waitFor()
  await button('永久删除本场').click()
  await page.getByText(/已删除本场 .*已使 2 个/).waitFor()
  await fixture('release')
  assert.equal(
    await page
      .locator('.settings-session')
      .filter({ hasText: '2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e' })
      .count(),
    0,
  )
  assert(!JSON.stringify(await fixture('cached')).includes('old-statistics'))
  assert(
    !JSON.stringify(await fixture('cached')).includes(
      'participantSessionCount',
    ),
  )
  await fixture('failure', 'sessions')
  await button('刷新目录').click()
  await button('清空全部应用数据').click()
  const phrase = page.getByLabel('请输入：永久清空全部数据', { exact: true })
  await phrase.fill('永久清空全部数据 ')
  assert(await button('永久清空全部数据').isDisabled())
  await phrase.fill('永久清空全部数据')
  await fixture('failure', '')
  await button('永久清空全部数据').click()
  await page
    .getByText('已清空 2 个场次；已使 4 个未终态模型运行失效。', {
      exact: true,
    })
    .waitFor()
  await page.getByText('还没有训练数据', { exact: true }).waitFor()
  await page.getByText('已配置', { exact: true }).waitFor()
  await button('清空全部应用数据').click()
  await phrase.fill('永久清空全部数据')
  await button('永久清空全部数据').click()
  await page
    .getByText('已清空 0 个场次；已使 0 个未终态模型运行失效。', {
      exact: true,
    })
    .waitFor()
  await go()
  await fixture('failure', 'delete-network')
  await button('清空全部应用数据').click()
  await phrase.fill('永久清空全部数据')
  await button('永久清空全部数据').click()
  await page.getByText(/操作结果尚未确认，请先重新读取状态/).waitFor()
  assert(await button('永久清空全部数据').isDisabled())
  await button('重新读取状态').click()
  await page
    .getByText('已重新读取状态。若仍需操作，请重新打开并确认。', {
      exact: true,
    })
    .waitFor()
  assert.equal(
    (await requests()).filter((r) => r.startsWith('DELETE')).length,
    1,
  )
  await go()
  for (const [width, height, scale] of [
    [360, 640, 1],
    [390, 844, 1],
    [430, 850, 1],
    [360, 480, 2],
  ]) {
    await page.setViewportSize({ width, height })
    await page.evaluate(
      (scale) => (document.documentElement.style.fontSize = `${scale * 100}%`),
      scale,
    )
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `overflow ${width}/${scale}`,
    )
    await button('清空全部应用数据').scrollIntoViewIfNeeded()
    await button('清空全部应用数据').click()
    await page.locator('dialog[open]').waitFor()
    await button('取消').scrollIntoViewIfNeeded()
    await button('取消').click()
    await page
      .getByRole('heading', { name: 'DeepSeek', exact: true })
      .scrollIntoViewIfNeeded()
    await page.screenshot({
      path: `${screenshotDir}/m79-${width}-${scale}.png`,
      fullPage: true,
    })
  }
  assert.deepEqual(errors, [])
  console.log('M7.9 设置页浏览器验收通过', baseUrl)
}
