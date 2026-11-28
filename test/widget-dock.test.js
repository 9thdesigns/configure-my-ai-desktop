// The dock that grows out of the edge, in a real browser (Playwright
// Chromium) with a stub where the preload bridge would be: flush to the
// edge, one filled shape in the theme's frame colour with no border and an
// outward shadow, 40px seats around a --dock-face face (28 by default, 32
// when the token says so), 10px apart in 8px of padding, seven seats then
// a scrolling column with a fade, the manager first, the rim light's moods,
// and the grab handle at rest, hovered and dragging. Skipped where
// Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { DOCK_WIDTH, DOCK_BODY_WIDTH } = require('../src/widget-window')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp'].map((n) => [n, call(n)])),
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onChatCss: on('chatCss'),
    reportHitRects: (rects, height) => { cma.hit = { rects, height } },
    sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const NAMES = ['Max', 'Ada', 'Lin', 'Ivo', 'Rae', 'Oz', 'Kit', 'Noa', 'Pia', 'Sol']
const bots = (n, moods = {}) => Array.from({ length: n }, (_, i) => ({ id: i ? `bot-${i}` : 'manager', name: NAMES[i], avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i, ...(moods[i] || {}) }))

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { colorScheme = 'light', width = DOCK_WIDTH } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width, height: 720 }, colorScheme })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  try {
    await fn(page)
  } finally {
    await context.close()
  }
})

async function showDock (page, list, { side = 'right', face } = {}) {
  await page.goto(WIDGET_URL)
  if (face) await page.evaluate((f) => document.documentElement.style.setProperty('--dock-face', `${f}px`), face)
  await page.evaluate(({ list, side }) => {
    window.__cma.state({ bots: list, candidates: [], focused_bot_id: null, dock_full: false, max_pinned: 12, workspace: null })
    window.__cma.layout({ expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side, draggable: true })
  }, { list, side })
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
}

const rect = (page, sel, i = 0) => page.locator(sel).nth(i).evaluate((n) => { const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom } })
const css = (page, sel, props) => page.locator(sel).first().evaluate((n, props) => { const s = getComputedStyle(n); return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])) }, props)

pageTest('flush to the edge: a 56px body against the window\'s right edge, the window holding it and its shadow', async (page) => {
  await showDock(page, bots(4))
  const dock = await rect(page, '.dock')
  assert.equal(dock.w, DOCK_BODY_WIDTH)
  assert.equal(dock.right, DOCK_WIDTH, 'touches the screen edge (the window is flush to it)')
  const hit = await page.evaluate(() => window.__cma.hit)
  assert.equal(hit.height, Math.ceil(dock.h + 24 + 40), 'asks for room for its shadow above and below')
  assert.equal(dock.y, 24)
})

pageTest('one filled shape with concave fillets, in the frame colour, no border, an outward shadow', async (page) => {
  await showDock(page, bots(4))
  const s = await page.evaluate(() => {
    const dock = document.querySelector('.dock')
    const svg = dock.querySelector('.dock-shape')
    const fill = svg.querySelector('.dock-fill')
    return { d: fill.getAttribute('d'), vb: svg.getAttribute('viewBox'), fill: getComputedStyle(fill).fill, border: getComputedStyle(dock).borderTopWidth, bg: getComputedStyle(dock).backgroundColor, filter: getComputedStyle(svg).filter, w: dock.offsetWidth, h: dock.offsetHeight }
  })
  assert.equal(s.vb, `0 0 ${s.w} ${s.h}`)
  assert.match(s.d, /^M 56 0 A 14 14 0 0 1 42 14 /, 'starts on the edge with a 14px concave fillet')
  assert.match(s.d, /A 14 14 0 0 1 56 \d+(\.\d+)? Z$/, 'ends with a fillet back into the edge')
  assert.equal(s.fill, 'rgb(248, 247, 245)', 'light frame colour #f8f7f5')
  assert.equal(s.border, '0px')
  assert.equal(s.bg, 'rgba(0, 0, 0, 0)', 'the shape is the only fill')
  assert.match(s.filter, /drop-shadow\(rgba\(0, 0, 0, 0\.18\) 0px 8px 24px\)/)
})

pageTest('dark: the frame colour is #121110', async (page) => {
  await showDock(page, bots(3))
  assert.equal((await css(page, '.dock-fill', ['fill'])).fill, 'rgb(18, 17, 16)')
}, { colorScheme: 'dark' })

for (const face of [28, 32]) {
  pageTest(`seats: 40px around a ${face}px face, 10px apart, in 8px of padding; the manager first`, async (page) => {
    await showDock(page, bots(4), face === 28 ? {} : { face })
    const ids = await page.$$eval('.dock-bot', (n) => n.map((b) => b.dataset.botId))
    assert.equal(ids[0], 'manager')
    const a = await rect(page, '.dock-bot', 0)
    const b = await rect(page, '.dock-bot', 1)
    const dock = await rect(page, '.dock')
    assert.deepEqual([a.w, a.h], [40, 40])
    assert.equal(b.y - a.bottom, 10, 'gap 10')
    assert.equal(a.x - dock.x, 8, 'pad 8')
    assert.equal(dock.right - a.right, 8)
    const avatar = await rect(page, '.dock-bot .avatar', 0)
    assert.deepEqual([avatar.w, avatar.h], [face, face])
    assert.equal(avatar.x - a.x, (40 - face) / 2, 'centred in its seat')
  })
}

pageTest('seven seats show, then the column scrolls with a fade at the end that has more', async (page) => {
  await showDock(page, bots(10))
  const col = await rect(page, '.dock-bots')
  assert.equal(col.h, 7 * 40 + 6 * 10)
  assert.equal(await page.$eval('.dock-bots', (n) => n.dataset.more), 'below')
  assert.match((await css(page, '.dock-bots', ['mask-image']))['mask-image'], /linear-gradient/)
  await page.$eval('.dock-bots', (n) => { n.scrollTop = 40 })
  await page.waitForFunction(() => document.querySelector('.dock-bots').dataset.more === 'both')
  await page.$eval('.dock-bots', (n) => { n.scrollTop = n.scrollHeight })
  await page.waitForFunction(() => document.querySelector('.dock-bots').dataset.more === 'above')
  // Seven or fewer: no scrolling, no fade.
  await showDock(page, bots(7))
  assert.equal(await page.$eval('.dock-bots', (n) => n.dataset.more || ''), '')
  assert.equal((await css(page, '.dock-bots', ['mask-image']))['mask-image'], 'none')
})

pageTest('the rim light: brand indigo and quiet; brighter while a bot works; amber while one waits', async (page) => {
  await showDock(page, bots(3))
  const rim = () => page.evaluate(() => { const r = document.querySelector('.dock-rim'); const s = getComputedStyle(r); return { activity: document.querySelector('.dock').dataset.activity, fill: s.fill, opacity: Number(s.opacity), x: Number(r.getAttribute('x')), w: Number(r.getAttribute('width')), anim: s.animationName } })
  let r = await rim()
  assert.equal(r.activity, 'idle')
  assert.equal(r.fill, 'rgb(109, 94, 252)')
  assert.equal(r.x + r.w, 56, 'along the edge seam')
  assert.equal(r.w, 2)
  const quiet = r.opacity
  await page.evaluate((list) => window.__cma.state({ bots: list, candidates: [], focused_bot_id: null, workspace: null }), bots(3, { 2: { mood: 'working' } }))
  await page.waitForTimeout(260)
  r = await rim()
  assert.equal(r.activity, 'working')
  assert.equal(r.anim, 'rim-breathe')
  assert.ok(r.opacity > quiet, 'brighter while working')
  await page.evaluate((list) => window.__cma.state({ bots: list, candidates: [], focused_bot_id: null, workspace: null }), bots(3, { 1: { mood: 'waiting', waiting: 'question', needs_count: 1 }, 2: { mood: 'working' } }))
  await page.waitForTimeout(260)
  r = await rim()
  assert.equal(r.activity, 'waiting')
  assert.equal(r.fill, 'rgb(255, 154, 31)', 'amber')
})

pageTest('the grab handle: a 24×4 bar 8px below the last seat in a 28×20 hit area; 70% and 28 wide on hover; 32 wide while dragging', async (page) => {
  await showDock(page, bots(3))
  const grip = await rect(page, '.dock-grip')
  const bar = await rect(page, '.dock-grip-bar')
  const add = await rect(page, '.dock-add')
  assert.deepEqual([grip.w, grip.h], [28, 20])
  assert.deepEqual([bar.w, bar.h], [24, 4])
  assert.equal(grip.y - add.bottom, 8, '8px below the last seat')
  assert.equal((await css(page, '.dock-grip', ['cursor'])).cursor, 'grab')
  assert.equal(Number((await css(page, '.dock-grip-bar', ['opacity'])).opacity), 0.4)
  await page.hover('.dock-grip')
  await page.waitForTimeout(260)
  assert.equal((await rect(page, '.dock-grip-bar')).w, 28)
  assert.equal(Number((await css(page, '.dock-grip-bar', ['opacity'])).opacity), 0.7)
  // A real press-and-move on the grip: a drag, not a click.
  const at = { x: grip.x + grip.w / 2, y: grip.y + grip.h / 2 }
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  for (let i = 1; i <= 8; i++) { await page.waitForTimeout(25); await page.mouse.move(at.x, at.y - i * 4) }
  await page.waitForTimeout(260)
  assert.ok(await page.evaluate(() => document.documentElement.hasAttribute('data-dragging')))
  assert.equal((await rect(page, '.dock-grip-bar')).w, 32)
  assert.equal((await css(page, 'html', ['cursor'])).cursor, 'grabbing')
  await page.mouse.up()
  assert.ok((await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'drag').map((c) => c[1]))).includes('end'))
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'picker')), [], 'the drop did not click "+"')
})

pageTest('the left edge: the dock hugs the left and its shape is mirrored', async (page) => {
  await showDock(page, bots(3), { side: 'left' })
  assert.equal((await rect(page, '.dock')).x, 0)
  assert.match((await css(page, '.dock-shape', ['transform'])).transform, /matrix\(-1, 0, 0, 1/)
})
