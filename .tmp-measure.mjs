import { chromium } from 'playwright-core'

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
const md = []
page.on('request', (r) => {
  const u = r.url()
  if (u.includes('/functions/v1/market-data')) {
    try { md.push(JSON.parse(r.postData() || '{}')) } catch { md.push({ raw: true }) }
  }
})

try {
  await page.goto('http://localhost:5173/auth', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const email = page.locator('input[type="email"], input[name="email"], input[autocomplete="email"]').first()
  if (await email.count()) {
    await email.fill('demo@ana24.app')
    await page.locator('input[type="password"]').first().fill('Ana24Qa!2pnzKx9')
    const btn = page.getByRole('button', { name: 'Sign in' }).last()
    await btn.click()
    await page.waitForURL('**/trading', { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(2500)
  }
  md.length = 0

  await page.goto('http://localhost:5173/trading', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(7000)

  const res = await page.evaluate(() =>
    performance.getEntriesByType('resource')
      .filter((e) => e.duration > 25)
      .map((e) => ({
        name: decodeURIComponent(e.name)
          .replace('https://xopygzpepikerwqxzqzu.supabase.co/rest/v1/', '[sb] ')
          .replace('https://xopygzpepikerwqxzqzu.supabase.co/functions/v1/', '[fn] ')
          .replace('http://localhost:5173/', ''),
        dur: Math.round(e.duration),
      }))
      .filter((r) => r.name.startsWith('[fn]') || r.name.startsWith('[sb] paper_'))
      .sort((a, b) => b.dur - a.dur),
  )

  console.log(JSON.stringify({
    marketDataCalls: md.map((m) => m.action ?? '?'),
    marketDataCallCount: md.length,
    slowResources: res.slice(0, 15),
  }, null, 1))
} finally {
  await browser.close()
}