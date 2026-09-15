import assert from 'node:assert/strict'

export async function verifyStatistics(page, baseUrl, screenshotDir) {
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  const go = async (path = '/statistics') => {
    await page.goto(baseUrl + path)
    await page.waitForFunction(() => !!window.statisticsFixture)
  }
  const fixture = async (method, value) =>
    page.evaluate(
      ([method, value]) => window.statisticsFixture[method](value),
      [method, value],
    )
  const ready = () =>
    page.getByRole('heading', { name: '完成手总计', exact: true }).waitFor()
  const statsRequests = () =>
    page.evaluate(() =>
      window.statisticsFixture.requests.filter((r) =>
        r.startsWith('GET /api/statistics'),
      ),
    )
  const button = (name) => page.getByRole('button', { name, exact: true })
  await verifyStatisticsNotice(page, baseUrl)
  await go('/statistics?from=2026-09-14T01:02:03.123456Z')
  await ready()
  assert.equal(
    await page.locator('.statistics-rates').first().locator('article').count(),
    5,
  )
  await button('筛选').click()
  await page.getByLabel('我的开手位置').selectOption('BB')
  await page.getByLabel('结束日期（含当天）').fill('2026-09-20')
  await button('查找历史场次与人物').click()
  await button('按此人物配置筛选').first().waitFor()
  assert.equal(await button('按此人物配置筛选').count(), 2)
  const before = (await statsRequests()).length
  await button('下一批').click()
  await button('下一批').isDisabled()
  await button('按此场次筛选').click()
  await button('按此人物配置筛选').first().click()
  assert.equal((await statsRequests()).length, before)
  await button('应用筛选').click()
  await ready()
  const combined = page.url()
  const params = new URL(combined).searchParams
  assert.equal(params.get('from'), '2026-09-14T01:02:03.123456Z')
  assert(params.get('sessionId'))
  assert.equal(params.get('configSnapshotKey'), 'a'.repeat(64))
  assert.equal(params.has('cursor'), false)
  assert.equal(
    await button('筛选').evaluate((el) => document.activeElement === el),
    true,
  )
  await page.getByLabel('AI 数据', { exact: true }).click()
  await page.getByText('AI 参与者手数', { exact: true }).waitFor()
  await button('筛选').click()
  await page.getByLabel('结果分组').selectOption('position')
  await button('应用筛选').click()
  await page.locator('.statistics-positions details').first().waitFor()
  assert.equal(await page.locator('.statistics-positions details').count(), 9)
  await page.locator('.statistics-positions summary').first().click()
  assert.match(
    await page.locator('.statistics-positions details').first().innerText(),
    /无样本/,
  )
  await page.getByLabel('已结束场次账务', { exact: true }).click()
  await page
    .getByRole('heading', { name: '已结束场次账务', exact: true })
    .waitFor()
  assert.equal(await page.locator('.statistics-rates').count(), 0)
  assert.match(
    await page.locator('.statistics-totals').innerText(),
    /2,700[\s\S]*3,000/,
  )
  assert.match(await page.locator('.statistics-totals').innerText(), /-300/)
  assert.equal(new URL(page.url()).searchParams.has('position'), false)
  assert.equal(new URL(page.url()).searchParams.get('groupBy'), 'none')
  await page.getByLabel('完成手统计', { exact: true }).click()
  await ready()
  assert.equal(new URL(page.url()).searchParams.has('position'), false)
  await page.goBack()
  await page
    .getByRole('heading', { name: '已结束场次账务', exact: true })
    .waitFor()
  await page.goForward()
  await ready()
  const reload = page.url()
  await page.reload()
  await ready()
  assert.equal(page.url(), reload)
  await button('筛选').click()
  await page.getByLabel('场次标识').fill('invalid')
  await button('应用筛选').click()
  await page.getByRole('alert').waitFor()
  await page.waitForFunction(
    () => document.activeElement?.id === 'statistics-filter-error',
  )
  await button('关闭弹窗').click()
  assert.equal(page.url(), reload)
  console.log(
    'PASS combined filters, bounded options, AI/grouping, scope, URL/back/reload, validation/focus',
  )

  await fixture('failure', true)
  await button('刷新').click()
  await page
    .getByText('更新失败，以下为上次成功结果', { exact: true })
    .waitFor()
  assert.equal(await page.locator('.statistics-rates').count(), 1)
  await fixture('failure', false)
  await button('重新读取').click()
  await ready()
  await go('/statistics?scope=sessions&position=BB')
  await page.getByText('统计筛选参数无效', { exact: true }).waitFor()
  assert.equal((await statsRequests()).length, 0)
  await page.getByRole('link', { name: '返回默认统计' }).click()
  await ready()
  await fixture('failure', true)
  await page.getByLabel('已结束场次账务', { exact: true }).click()
  await page.getByText('统计读取失败', { exact: true }).waitFor()
  assert.equal(await page.locator('.statistics-totals').count(), 0)
  await fixture('failure', false)
  await button('重新读取').click()
  await page
    .getByRole('heading', { name: '已结束场次账务', exact: true })
    .waitFor()
  await fixture('even')
  await button('刷新').click()
  await page.waitForFunction(
    () =>
      document.querySelector('.statistics-totals dd')?.textContent === '0筹码',
  )
  assert.equal(
    await page.getByText('暂无符合条件的已结束场次', { exact: true }).count(),
    0,
  )
  await fixture('empty', true)
  await button('刷新').click()
  await page.getByText('暂无符合条件的已结束场次', { exact: true }).waitFor()
  await page.getByLabel('完成手统计', { exact: true }).click()
  await page.getByText('暂无符合条件的完成手', { exact: true }).waitFor()
  console.log(
    'PASS refresh failure, invalid URL without GET, first error/retry, empty modes',
  )

  await go()
  await ready()
  await fixture('hold', true)
  await button('刷新').click()
  await fixture('hold', false)
  await page.getByLabel('AI 数据', { exact: true }).click()
  await page.getByText('AI 参与者手数', { exact: true }).waitFor()
  await fixture('release')
  assert.match(
    await page.locator('.statistics-totals').innerText(),
    /AI 参与者手数\s*5/,
  )
  for (const method of ['remove', 'clear']) {
    await go()
    await ready()
    await fixture('hold', true)
    await button('刷新').click()
    await page.evaluate((method) => {
      window.statisticsFixture[method]().catch((error) => {
        window.m78MutationError = String(error)
      })
    }, method)
    await page.waitForFunction(
      () => !document.querySelector('.statistics-totals'),
    )
    await fixture('hold', false)
    await fixture('release')
    await page.getByText('暂无符合条件的完成手', { exact: true }).waitFor()
    assert.equal(await page.evaluate(() => window.m78MutationError), undefined)
  }
  console.log(
    'PASS late query switch, delete and clear revoke old cards with delayed GET',
  )

  await go(
    '/statistics?personaName=' + encodeURIComponent('历史条件'.repeat(40)),
  )
  await ready()
  await button('筛选').evaluate((el) => {
    const content = document.querySelector('.page-content')
    content.scrollTop +=
      el.getBoundingClientRect().bottom -
      content.getBoundingClientRect().bottom +
      20
  })
  await button('筛选').click()
  const scroll = await page
    .locator('.page-content')
    .evaluate((el) => el.scrollTop)
  assert(
    await page
      .getByRole('heading', { name: '完成手总计', exact: true })
      .evaluate(
        (el) =>
          el.getBoundingClientRect().top >=
          document.querySelector('.page-content').getBoundingClientRect()
            .bottom,
      ),
  )
  await page.getByLabel('我的开手位置').selectOption('BTN')
  await fixture('hold', true)
  await button('应用筛选').focus()
  await page.keyboard.press('Enter')
  await page.getByRole('dialog').waitFor({ state: 'hidden' })
  assert.equal(
    await page.locator('.page-content').evaluate((el) => el.scrollTop),
    scroll,
  )
  assert.equal(
    await button('筛选').evaluate((el) => el === document.activeElement),
    true,
  )
  await fixture('hold', false)
  await fixture('release')
  await ready()
  assert.equal(
    await page.locator('.page-content').evaluate((el) => el.scrollTop),
    scroll,
  )
  assert.equal(
    await button('筛选').evaluate((el) => el === document.activeElement),
    true,
  )
  console.log(
    'PASS keyboard apply restores trigger and preserves scroll before/after response',
  )

  await go(
    '/statistics?personaName=' +
      encodeURIComponent('很长的历史人物名称'.repeat(16)) +
      '&configSnapshotKey=' +
      'a'.repeat(64),
  )
  await ready()
  await fixture('large')
  await button('刷新').click()
  await page.getByText('+9,007,199,254,740,991', { exact: false }).waitFor()
  for (const [width, height] of [
    [360, 640],
    [390, 844],
    [430, 850],
  ]) {
    await page.setViewportSize({ width, height })
    for (const zoom of [1, 2]) {
      await page.evaluate(
        (zoom) => (document.documentElement.style.fontSize = `${zoom * 100}%`),
        zoom,
      )
      for (const drawer of [false, true]) {
        if (drawer) await button('筛选').click()
        const overflow = await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              '.page-content,.statistics-card,.statistics-value,.modal[open],.history-filter-fields',
            ),
          ]
            .filter((el) => el.scrollWidth > el.clientWidth + 1)
            .map((el) => el.className),
        )
        assert.deepEqual(overflow, [], `${width} ${zoom} ${drawer}: overflow`)
        if (drawer) {
          await page.screenshot({
            path: `${screenshotDir}/m78-${width}-${zoom}-drawer.png`,
          })
          await page.keyboard.press('Escape')
        }
      }
    }
  }
  await page.evaluate(() => (document.documentElement.style.fontSize = '100%'))
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.statistics-value').last().scrollIntoViewIfNeeded()
  await page.screenshot({ path: `${screenshotDir}/m78-results.png` })
  assert.deepEqual(errors, [])
  console.log(
    'PASS 360/390/430, 200% text, full safe integer and long conditions; no page errors',
  )
}

export async function verifyStatisticsNotice(page, baseUrl) {
  await page.goto(baseUrl + '/statistics?position=BB&groupBy=position')
  await page.getByRole('heading', { name: '完成手总计', exact: true }).waitFor()
  const source = page.url()
  const notice = page.getByText('已清除位置条件与位置分组。', { exact: true })
  await page.getByLabel('已结束场次账务', { exact: true }).click()
  await page
    .getByRole('heading', { name: '已结束场次账务', exact: true })
    .waitFor()
  await notice.waitFor()
  const target = page.url()
  await page.goBack()
  await page.getByRole('heading', { name: '完成手总计', exact: true }).waitFor()
  assert.equal(page.url(), source)
  assert.match(await page.locator('.history-filter-summary').innerText(), /BB/)
  assert.equal(await notice.count(), 0, '恢复位置条件后不得保留位置清除提示')
  await page.goForward()
  await page
    .getByRole('heading', { name: '已结束场次账务', exact: true })
    .waitFor()
  assert.equal(page.url(), target)
  await notice.waitFor()
  assert.equal(new URL(page.url()).searchParams.has('position'), false)
  await page.getByLabel('AI 数据', { exact: true }).click()
  await page.waitForURL((url) => url.searchParams.get('subject') === 'ai')
  await notice.waitFor({ state: 'hidden' })
  console.log(
    'PASS notice belongs to target query across back/forward and subject changes',
  )
}
