// The island page's states and its mode swap, in Playwright on a paused
// fake clock (every frame is the test's to run): hovering widens the pill
// 32px and lifts the avatar (1.2x, 10px out, 4px away from the edge) on a
// bouncy spring; a change of state fades the old content out over 160ms
// (0.985, 4px blur) and springs the new one in from 0.965 with the blur
// clearing; reduced motion just swaps; the recording dot; the jelly badge
// hook. Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const ISLAND_URL = pathToFileURL(path.join(__dirname, '../src/island.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaIsland = {
    ...Object.fromEntries(['ready', 'drag', 'hover', 'activate', 'collapse', 'openInApp', 'openApp', 'move', 'reportHitRects', 'reportHeight'].map((n) => [n, call(n)])),
    onView: on('view'),
    onLayout: on('layout'),
    onAvatarCss: on('css'),
    answer: async () => false,
    decide: async () => false,
  }
}

const BOT = { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle' }
const VIEWS = {
  idle: { idle: true, mode: 'idle', bot: BOT, chip: { kind: 'idle', label: 'All quiet' }, badge: 0, detail: '', pending: null },
  working: { idle: false, mode: 'working', bot: BOT, chip: { kind: 'working', label: 'Working…' }, badge: 0, detail: '', pending: null },
  message: { idle: false, mode: 'message', bot: BOT, chip: { kind: 'responded', label: 'New message' }, badge: 2, detail: 'Done — the report is ready.', pending: null },
  recording: { idle: false, mode: 'recording', bot: BOT, chip: { kind: 'screen', label: 'Viewing your screen' }, badge: 0, detail: '', pending: null, capturing: true },
}
const LAYOUT = { expanded: false, focused: false, draggable: true, dragging: false, snapped: false, pill: { centre: 200, width: 212, height: 32, edge: 'top', wrap: false, notchWidth: 0, screenX: 900 } }

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', init = null } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 400, height: 60 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  if (init) await page.addInitScript(init)
  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  try {
    await page.goto(ISLAND_URL)
    await page.evaluate(({ view, layout }) => { window.__cma.view(view); window.__cma.layout(layout) }, { view: VIEWS.idle, layout: LAYOUT })
    await page.clock.runFor(600)
    await fn(page)
  } finally {
    await context.close()
  }
})

const show = (page, view) => page.evaluate((v) => window.__cma.view(v), view)
const box = (page, sel) => page.locator(sel).boundingBox()
const style = (page, sel, prop) => page.locator(sel).first().evaluate((el, prop) => el.style[prop] || getComputedStyle(el)[prop], prop)
const ghost = (page) => page.evaluate(() => {
  const g = document.querySelector('.bar-ghost')
  return g ? { opacity: Number(g.style.opacity || 1), transform: g.style.transform, filter: g.style.filter } : null
})

pageTest('hover: the pill widens 32px and the avatar lifts — 1.2x, 10px out, 4px down — then settles back', async (page) => {
  const before = await box(page, '.avatar-wrap')
  assert.equal(Math.round((await box(page, '#island')).width), 212)
  await page.hover('[data-role="bar"]')
  await page.clock.runFor(1500)
  assert.equal(Math.round((await box(page, '#island')).width), 244)
  assert.equal(await style(page, '.avatar-wrap', 'transform'), 'translate(-10px, 4px) scale(1.2)')
  const after = await box(page, '.avatar-wrap')
  assert.ok(after.width > before.width * 1.15, 'bigger')
  await page.mouse.move(5, 55)
  await page.mouse.move(399, 59)
  await page.clock.runFor(1500)
  assert.equal(Math.round((await box(page, '#island')).width), 212)
  assert.equal(await page.locator('.avatar-wrap').evaluate((el) => el.style.transform), '', 'no transform at rest')
})

pageTest('hover on the bottom edge lifts the avatar up, away from the edge', async (page) => {
  await page.evaluate((layout) => window.__cma.layout({ ...layout, pill: { ...layout.pill, edge: 'bottom' } }), LAYOUT)
  await page.hover('[data-role="bar"]')
  await page.clock.runFor(1500)
  assert.equal(await style(page, '.avatar-wrap', 'transform'), 'translate(-10px, -4px) scale(1.2)')
})

pageTest('the mode swap: out over 160ms (0.985, 4px blur), then the new content springs in from 0.965', async (page) => {
  await show(page, VIEWS.working)
  // Frame 0: the old content is a ghost over the bar; the new one is waiting, small and blurred.
  let g = await ghost(page)
  assert.ok(g, 'the old content is still there, on its way out')
  assert.equal(await page.locator('.bar-ghost .chip').textContent(), 'All quiet')
  assert.equal(await page.locator('[data-role="chip"]').textContent(), 'Working…')
  assert.equal(await style(page, '[data-role="content"]', 'opacity'), '0')
  await page.clock.runFor(80)
  g = await ghost(page)
  assert.ok(g.opacity > 0.3 && g.opacity < 0.7, `half out (${g.opacity})`)
  assert.match(g.filter, /^blur\((1|2)\.\d+px\)$/)
  assert.match(g.transform, /^scale\(0\.99\d+\)$/)
  await page.clock.runFor(100)
  assert.equal(await ghost(page), null, 'gone after 160ms')
  const entering = await page.locator('[data-role="content"]').evaluate((el) => ({ t: el.style.transform, f: el.style.filter }))
  assert.match(entering.t, /^scale\(0\.9[67]\d*\)$/, `entering from ~0.965 (${entering.t})`)
  assert.match(entering.f, /^blur\(/)
  await page.clock.runFor(1200)
  const rest = await page.locator('[data-role="content"]').evaluate((el) => [el.style.opacity, el.style.transform, el.style.filter])
  assert.deepEqual(rest, ['', '', ''], 'at rest: no opacity, transform or blur left behind')
  assert.equal(await page.locator('#island').getAttribute('data-mode'), 'working')
})

pageTest('a swap mid-swap starts again cleanly; the same state again does not swap', async (page) => {
  await show(page, VIEWS.working)
  await page.clock.runFor(60)
  await show(page, VIEWS.message)
  assert.equal(await page.locator('.bar-ghost').count(), 1, 'one ghost, not two')
  await page.clock.runFor(1500)
  await show(page, VIEWS.message)
  assert.equal(await ghost(page), null)
})

pageTest('reduced motion: the content just changes — no ghost, no blur, no scale', async (page) => {
  await show(page, VIEWS.working)
  assert.equal(await ghost(page), null)
  assert.deepEqual(await page.locator('[data-role="content"]').evaluate((el) => [el.style.opacity, el.style.transform, el.style.filter]), ['', '', ''])
  await page.hover('[data-role="bar"]')
  assert.equal(await style(page, '.avatar-wrap', 'transform'), 'translate(-10px, 4px) scale(1.2)', 'the lift jumps')
}, { reducedMotion: 'reduce' })

pageTest('recording: a red 8px dot, pulsing once every 1.2s', async (page) => {
  await show(page, VIEWS.recording)
  const dot = await page.locator('[data-role="chip"]').evaluate((el) => {
    const s = getComputedStyle(el, '::before')
    return { w: s.width, h: s.height, bg: s.backgroundColor, dur: s.animationDuration, dir: s.animationDirection }
  })
  assert.deepEqual([dot.w, dot.h], ['8px', '8px'])
  assert.equal(dot.bg, 'rgb(255, 90, 95)')
  assert.deepEqual([dot.dur, dot.dir], ['0.6s', 'alternate'], 'there and back: 1.2s')
  assert.equal(await page.locator('#island').getAttribute('data-mode'), 'recording')
})

pageTest('the jelly badge (jelly-badge.js) paints the island\'s count on the avatar, and nothing when there is nothing to count', async (page) => {
  await show(page, VIEWS.message)
  assert.equal(await page.locator('[data-role="badge"]').isHidden(), false)
  const jelly = await page.evaluate(() => {
    const j = document.querySelector('[data-role="badge"] .jelly')
    return { kind: j.dataset.kind, glyph: j.querySelector('.jelly-glyph').textContent, ring: getComputedStyle(j).getPropertyValue('--jelly-ring').trim() }
  })
  assert.deepEqual([jelly.kind, jelly.glyph], ['unread', '2'], 'a message: the indigo count')
  assert.match(jelly.ring, /#000|#0a0a0a|var\(--pill/, 'the ring is the island\'s fill')
  await show(page, VIEWS.idle)
  assert.equal(await page.locator('[data-role="badge"]').isHidden(), true, 'nothing to count')
})
