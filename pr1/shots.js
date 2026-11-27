// Usage: node shots.js <label> <outdir>
// Renders the real widget and island pages (stub bridge, live avatar CSS)
// and writes a contact sheet per colour scheme: dock idle + working, quick
// chat header, the "+" picker's seat rows, and the island pill for every shape.
const fs = require('fs'); const path = require('path')
const H = require('/home/user/configure-my-ai-desktop/test/support/cfa-harness.js')
const [label, out] = process.argv.slice(2)
;(async () => {
  const browser = await H.loadPlaywright().chromium.launch()
  const tiles = {}
  for (const scheme of ['light', 'dark']) {
    const t = (tiles[scheme] = [])
    const shot = async (page, clip, name) => { const f = path.join(out, `${label}-${scheme}-${name}.png`); await page.screenshot({ path: f, clip, animations: 'allow' }); t.push({ name, f }) }
    // Dock + quick chat, idle faces; then working faces.
    for (const st of ['idle', 'working']) {
      const { page, context } = await H.openPage(browser, H.WIDGET_URL, { colorScheme: scheme, scale: 2, width: 520, height: 560 })
      await page.evaluate((s) => { document.body.style.background = s === 'dark' ? '#3a3f47' : '#dfe3ea' }, scheme)
      const bots = H.SHAPES.map((s) => H.botFor(s, st))
      await H.showWidget(page, { bots, chatWith: st === 'idle' ? 'bot-samurai' : 'bot-astronaut' })
      await page.waitForTimeout(400)
      await shot(page, { x: 0, y: 0, width: 520, height: 560 }, `dock-chat-${st}`)
      await context.close()
    }
    // The "+" picker: seat rows for every shape.
    {
      const { page, context } = await H.openPage(browser, H.WIDGET_URL, { colorScheme: scheme, scale: 2, width: 520, height: 560 })
      await page.evaluate((s) => { document.body.style.background = s === 'dark' ? '#3a3f47' : '#dfe3ea' }, scheme)
      const candidates = H.SHAPES.map((s, i) => H.botFor(s, i % 2 ? 'working' : 'idle', { id: `cand-${s}` }))
      await H.showWidget(page, { bots: [H.botFor('circle')], candidates, picker: true })
      await page.waitForTimeout(400)
      await shot(page, { x: 0, y: 0, width: 520, height: 560 }, 'picker')
      await context.close()
    }
    // The island, one pill per shape.
    for (const [i, s] of H.SHAPES.entries()) {
      const { page, context } = await H.openPage(browser, H.ISLAND_URL, { colorScheme: scheme, scale: 2, width: 380, height: 64 })
      await page.evaluate((s) => { document.body.style.background = s === 'dark' ? '#3a3f47' : '#dfe3ea' }, scheme)
      await H.showIsland(page, { bot: H.botFor(s, i % 2 ? 'working' : 'idle'), chip: i % 2 ? { kind: 'working', label: 'Working…' } : { kind: 'question', label: 'Questions' } })
      await page.waitForTimeout(400)
      await shot(page, { x: 0, y: 0, width: 380, height: 64 }, `island-${s}`)
      await context.close()
    }
  }
  // Contact sheets.
  for (const scheme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width: 1640, height: 1000 }, deviceScaleFactor: 1 })
    const img = (f, w) => `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}" style="width:${w}px;display:block">`
    const big = tiles[scheme].filter((x) => !x.name.startsWith('island'))
    const isl = tiles[scheme].filter((x) => x.name.startsWith('island'))
    await page.setContent(`<body style="margin:0;padding:16px;font:14px system-ui;background:${scheme === 'dark' ? '#111' : '#fff'};color:${scheme === 'dark' ? '#eee' : '#111'}">
      <h3 style="margin:0 0 8px">${label} — ${scheme}: dock + quick chat (idle, working), "+" picker seat rows, island (all 6 shapes)</h3>
      <div style="display:flex;gap:12px">${big.map((x) => `<figure style="margin:0">${img(x.f, 520)}<figcaption>${x.name}</figcaption></figure>`).join('')}</div>
      <div style="display:grid;grid-template-columns:repeat(3,380px);gap:8px 16px;margin-top:12px">${isl.map((x) => `<figure style="margin:0">${img(x.f, 380)}<figcaption>${x.name}</figcaption></figure>`).join('')}</div></body>`)
    const h = await page.evaluate(() => document.body.scrollHeight)
    await page.setViewportSize({ width: 1640, height: h })
    await page.screenshot({ path: path.join(out, `pr1-${label}-${scheme}.png`), fullPage: true })
    await page.close()
  }
  await browser.close()
})().catch((e) => { console.error(e); process.exit(1) })
