// The island page in a real browser (Playwright Chromium), with a stub where
// the preload bridge would be: the pill drawn where main says, square on
// the edge it hangs from and round away from it, its concave shoulders, the
// ears round a notch, the grabber on hover (and while dragging), the hit
// rects it reports, the magnet's settle, Alt + arrows, and reduced motion.
// Animations run on Playwright's fake clock. Skipped where Playwright (or
// its Chromium) is not installed.

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

const VIEW = { idle: false, bot: { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle' }, chip: { kind: 'working', label: 'Working…' }, detail: '', pending: null }
const pill = (over = {}) => ({ centre: 200, width: 212, height: 32, edge: 'top', wrap: false, notchWidth: 0, screenX: 900, ...over })

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 400, height: 60 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  // Time stands still unless the test moves it: every spring frame is the
  // test's to run (page.clock fakes requestAnimationFrame too).
  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  try {
    await page.goto(ISLAND_URL)
    await page.evaluate((view) => window.__cma.view(view), VIEW)
    await fn(page)
  } finally {
    await context.close()
  }
})

const layout = (page, over = {}) => page.evaluate((l) => window.__cma.layout(l), { expanded: false, focused: false, draggable: true, dragging: false, snapped: false, pill: pill(), ...over })
const box = (page, sel) => page.locator(sel).boundingBox()
const style = (page, sel, prop) => page.locator(sel).evaluate((el, prop) => getComputedStyle(el)[prop], prop)
const settle = async (page, ms = 600) => { await page.clock.runFor(ms) }

pageTest('top edge: flush to the top, centred where main says, square on top and round below, shoulders up there', async (page) => {
  await layout(page)
  await settle(page)
  const b = await box(page, '#island')
  assert.equal(b.y, 0)
  assert.equal(Math.round(b.x + b.width / 2), 200)
  assert.equal(Math.round(b.width), 212)
  assert.equal(Math.round(b.height), 32)
  assert.equal(await style(page, '.island-clip', 'borderRadius'), '0px 0px 16px 16px')
  const left = await box(page, '.shoulder-start')
  assert.deepEqual([Math.round(left.x + left.width), left.y, left.width], [Math.round(b.x), 0, 6], 'the left shoulder flares from the top edge')
  assert.match(await style(page, '.shoulder-start', 'backgroundImage'), /radial-gradient\(circle at 0(px|%) 100%/)
})

pageTest('bottom edge: flush to the bottom, round on top, shoulders at the bottom', async (page) => {
  await layout(page, { pill: pill({ edge: 'bottom' }) })
  await settle(page)
  const b = await box(page, '#island')
  assert.equal(Math.round(b.y + b.height), 60)
  assert.equal(await style(page, '.island-clip', 'borderRadius'), '16px 16px 0px 0px')
  const s = await box(page, '.shoulder-end')
  assert.equal(Math.round(s.y + s.height), 60)
})

pageTest('round the notch: as tall as the notch, the avatar and the state in the ears, the name kept for the label', async (page) => {
  await layout(page, { pill: pill({ wrap: true, width: 268, height: 37, notchWidth: 185 }) })
  await settle(page)
  const b = await box(page, '#island')
  assert.deepEqual([Math.round(b.width), Math.round(b.height)], [268, 37])
  assert.equal(await page.locator('.island-name').isVisible(), false)
  const avatar = await box(page, '.avatar')
  const chip = await box(page, '.chip')
  const notchLeft = b.x + (b.width - 185) / 2
  assert.ok(avatar.x + avatar.width <= notchLeft, 'the avatar is left of the notch')
  assert.ok(chip.x >= notchLeft + 185, 'the state is right of it')
  assert.deepEqual([chip.width, chip.height], [8, 8], 'as an 8px dot')
  assert.equal(await page.locator('[data-role="bar"]').getAttribute('aria-label'), 'Max: Working…')
  assert.equal(await style(page, '.island-clip', 'borderRadius'), '0px 0px 14px 14px')
})

pageTest('hover: the grabber fades in 6px from the far side as the pill grows 8px; dragging widens it to 36', async (page) => {
  await layout(page)
  await settle(page)
  assert.equal(await style(page, '.grabber', 'opacity'), '0')
  await page.hover('[data-role="bar"]')
  await settle(page, 120)
  assert.ok(Number(await style(page, '.grabber', 'opacity')) >= 0.8, 'mostly in after 120ms')
  await settle(page, 600)
  assert.equal(await style(page, '.grabber', 'opacity'), '1')
  const b = await box(page, '#island')
  assert.equal(Math.round(b.height), 40, '32 + 8')
  const g = await box(page, '.grabber')
  assert.deepEqual([g.width, g.height], [28, 4])
  assert.equal(Math.round(b.y + b.height - (g.y + g.height)), 6)
  assert.equal(Math.round(g.x + g.width / 2), 200)
  assert.deepEqual((await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'hover'))).at(-1), ['hover', true])
  // A real press-and-move (drag-gesture.js: 4px after 90ms) starts a drag.
  const bar = await box(page, '[data-role="bar"]')
  await page.mouse.move(bar.x + 30, bar.y + 10)
  await page.mouse.down()
  await page.clock.runFor(120)
  await page.mouse.move(bar.x + 60, bar.y + 10)
  await settle(page, 1500)
  assert.equal(await page.evaluate(() => document.documentElement.hasAttribute('data-dragging')), true)
  assert.equal(Math.round((await box(page, '.grabber')).width), 36)
  await page.mouse.up()
})

pageTest('the bar reports where it takes the mouse, a few px round the pill', async (page) => {
  await layout(page)
  await settle(page)
  const rects = (await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'reportHitRects'))).at(-1)[1]
  assert.equal(rects.length, 1)
  const b = await box(page, '#island')
  assert.ok(rects[0].x <= b.x - 6 && rects[0].x + rects[0].width >= b.x + b.width + 6, 'covers the shoulders')
})

pageTest('the magnet: the pill is drawn where the pointer had it and springs home', async (page) => {
  await layout(page, { dragging: true, pill: pill({ screenX: 880 }) })
  await settle(page)
  // Caught: main moved the window 20px; the pill starts 20px off and settles.
  await layout(page, { dragging: true, snapped: true, pill: pill({ screenX: 900 }) })
  const start = await box(page, '#island')
  assert.equal(Math.round(start.x + start.width / 2), 180, 'where it was')
  await settle(page, 800)
  const end = await box(page, '#island')
  assert.equal(Math.round(end.x + end.width / 2), 200, 'home')
})

pageTest('Alt + arrows on the focused bar ask main to move it', async (page) => {
  await layout(page)
  await page.focus('[data-role="bar"]')
  await page.keyboard.press('Alt+ArrowLeft')
  await page.keyboard.press('Alt+ArrowDown')
  await page.keyboard.press('ArrowLeft')
  await settle(page, 800)
  const moves = await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'move').map((c) => c[1]))
  assert.deepEqual(moves, [{ step: -1 }, { edge: 'bottom' }])
  assert.equal(await style(page, '.grabber', 'opacity'), '1', 'focus shows the grabber, no hover needed')
  assert.equal(await style(page, '[data-role="bar"]', 'outlineWidth'), '2px')
})

pageTest('reduced motion: the magnet jumps, nothing springs', async (page) => {
  await layout(page, { dragging: true, pill: pill({ screenX: 880 }) })
  await layout(page, { dragging: true, snapped: true, pill: pill({ screenX: 900 }) })
  const b = await box(page, '#island')
  assert.equal(Math.round(b.x + b.width / 2), 200, 'already home')
  assert.equal(await style(page, '#island', 'transitionDuration'), '0s')
}, { reducedMotion: 'reduce' })

pageTest('the island is a polite live region; the page cannot drag when main says so', async (page) => {
  assert.equal(await page.locator('#island').getAttribute('aria-live'), 'polite')
  await layout(page, { draggable: false })
  await page.hover('[data-role="bar"]')
  await settle(page, 300)
  assert.equal(await style(page, '.grabber', 'display'), 'none')
})
