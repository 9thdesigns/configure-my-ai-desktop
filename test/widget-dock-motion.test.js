// The dock's drag feel and its moves, in a real browser (Playwright
// Chromium) on a paused fake clock (time moves only on runFor), with a stub
// where the preload bridge would be: a fast drag stretches the outline
// toward the drag (never more than 12px, the faces unscaled) with the seats
// lagging behind; a stopped pointer lets it relax; letting go wobbles it
// back through rest; reduced motion: no stretch at all. Moving across: it
// tucks into the edge and buds in on the other one. Opening: the panel is
// held back a frame while the window widens; closing: it animates out, then
// hides. Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { DOCK_WIDTH, EXPANDED_WIDTH } = require('../src/widget-window')

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
    reportHitRects () {}, sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const bots = (n) => Array.from({ length: n }, (_, i) => ({ id: i ? `bot-${i}` : 'manager', name: `B${i}`, avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i }))
const LAYOUT = { expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true }

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', width = DOCK_WIDTH } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width, height: 720 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  // Paused: timers and animation frames run only on runFor.
  const t0 = Date.now()
  await page.clock.install({ time: t0 })
  await page.clock.pauseAt(t0 + 1000)
  try {
    await page.goto(WIDGET_URL)
    await page.evaluate(({ list, layout }) => {
      window.__cma.state({ bots: list, candidates: [], focused_bot_id: null, workspace: null })
      window.__cma.layout(layout)
    }, { list: bots(4), layout: LAYOUT })
    await page.clock.runFor(50)
    await fn(page)
  } finally {
    await context.close()
  }
})

const feel = (page) => page.evaluate(() => {
  const dock = document.querySelector('.dock')
  const body = document.querySelector('.dock-body')
  const avatar = document.querySelector('.dock-bot .avatar').getBoundingClientRect()
  return {
    scale: Number(dock.style.getPropertyValue('--stretch-scale') || 1),
    origin: dock.style.getPropertyValue('--stretch-origin') || '0%',
    seats: Number((body.style.transform.match(/translateY\(([-\d.]+)px\)/) || [0, 0])[1]),
    h: dock.offsetHeight,
    face: [avatar.width, avatar.height],
  }
})

// A press on the grip, then quick moves `step` px every 16ms of fake time.
async function fastDrag (page, { steps = 10, step = 14 } = {}) {
  const g = await page.locator('.dock-grip').boundingBox()
  const x = g.x + g.width / 2
  let y = g.y + g.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  const seen = []
  for (let i = 0; i < steps; i++) {
    await page.clock.runFor(16)
    y += step
    await page.mouse.move(x, y)
    seen.push(await feel(page))
  }
  return { x, y, seen }
}

pageTest('a fast drag stretches the outline toward the drag (≤12px, faces unscaled) and the seats lag behind; a stopped pointer relaxes it', async (page) => {
  const { seen } = await fastDrag(page)
  const peak = seen.reduce((a, b) => (b.scale > a.scale ? b : a))
  assert.ok(peak.scale > 1.01, `stretched (${peak.scale})`)
  assert.ok((peak.scale - 1) * peak.h <= 12 + 1e-6, `at most 12px (${((peak.scale - 1) * peak.h).toFixed(2)})`)
  assert.equal(peak.origin, '0%', 'dragged down: grows downward from the top')
  assert.ok(peak.seats < 0, 'the seats lag behind (up)')
  assert.ok(Math.abs(peak.seats + (peak.scale - 1) * peak.h * 0.3) < 0.05, 'by 0.3 of the stretch')
  assert.deepEqual(peak.face, [28, 28], 'faces never scale')
  // The pointer stops: the stretch relaxes back to rest.
  await page.clock.runFor(600)
  const rest = await feel(page)
  assert.ok(Math.abs(rest.scale - 1) < 0.002, `relaxed (${rest.scale})`)
  await page.mouse.up()
})

pageTest('letting go mid-stretch wobbles it back through rest, then it settles exactly', async (page) => {
  await fastDrag(page)
  await page.mouse.up()
  const after = []
  for (let i = 0; i < 60; i++) {
    await page.clock.runFor(16)
    after.push(await feel(page))
  }
  // An overshoot past rest: the stretch changes sign (the origin flips).
  assert.ok(after.some((f) => f.origin === '100%' && f.scale > 1.0005), 'overshoots the other way (wobble)')
  const last = after.at(-1)
  assert.equal(last.scale, 1)
  assert.equal(last.seats, 0)
})

pageTest('reduced motion: no stretch, no lag, no wobble', async (page) => {
  const { seen } = await fastDrag(page)
  assert.ok(seen.every((f) => f.scale === 1 && f.seats === 0))
  await page.mouse.up()
  await page.clock.runFor(300)
  assert.equal((await feel(page)).scale, 1)
}, { reducedMotion: 'reduce' })

pageTest('moving across: it tucks into the edge (160ms), then buds in on the other edge', async (page) => {
  await page.evaluate((l) => window.__cma.layout({ ...l, tuck: true }), LAYOUT)
  const tuck = await page.evaluate(() => document.getAnimations().filter((a) => a.effect.target === document.querySelector('.dock')).map((a) => ({ d: a.effect.getTiming().duration, to: a.effect.getKeyframes().at(-1).transform })))
  assert.deepEqual(tuck, [{ d: 160, to: 'translateX(72px)' }], 'into the right edge')
  await page.evaluate((l) => window.__cma.layout({ ...l, side: 'left', budIn: true }), LAYOUT)
  const bud = await page.evaluate(() => document.getAnimations().filter((a) => a.effect.target === document.querySelector('.dock')).map((a) => ({ from: a.effect.getKeyframes()[0].transform, to: a.effect.getKeyframes().at(-1).transform, easing: a.effect.getTiming().easing })))
  assert.equal(bud.length, 1, 'the tuck is replaced by the bud-in')
  assert.equal(bud[0].from, 'translateX(-72px)', 'from inside the left edge')
  assert.equal(bud[0].to, 'none')
  assert.equal(bud[0].easing, 'linear', 'a sampled spring (soft)')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.side), 'left')
})

pageTest('reduced motion: moving across just moves (no tuck, no bud-in animation)', async (page) => {
  await page.evaluate((l) => window.__cma.layout({ ...l, tuck: true }), LAYOUT)
  await page.evaluate((l) => window.__cma.layout({ ...l, side: 'left', budIn: true }), LAYOUT)
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.effect.target === document.querySelector('.dock')).length), 0)
  assert.equal(await page.evaluate(() => document.querySelector('.dock').style.transform), 'none')
}, { reducedMotion: 'reduce' })

pageTest('opening: the panel waits a frame while the window widens, then animates in; closing: it animates out in the wide window, then hides', async (page) => {
  const open = { expanded: true, mode: 'chat', botId: 'bot-1', dockTop: 0, popoverTop: 0, popoverHeight: 520, side: 'right', draggable: true }
  await page.evaluate((l) => window.__cma.layout({ ...l, opening: true }), open)
  assert.equal(await page.evaluate(() => document.querySelector('#popover').hasAttribute('data-arming')), true, 'held back this frame')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#popover')).visibility), 'hidden')
  await page.clock.runFor(40)
  assert.equal(await page.evaluate(() => document.querySelector('#popover').hasAttribute('data-arming')), false, 'then it plays')
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#popover')).animationName), 'popover-in')
  // Closing: still shown while it animates out, then hidden.
  await page.evaluate((l) => window.__cma.layout({ ...l, expanded: false, botId: null, closing: true }), open)
  assert.equal(await page.evaluate(() => document.querySelector('#popover').hidden), false)
  assert.ok(await page.evaluate(() => document.getAnimations().some((a) => a.effect.target === document.querySelector('#popover') && a.effect.getKeyframes().at(-1).opacity === '0')))
  await page.waitForFunction(() => document.querySelector('#popover').hidden, null, { timeout: 3000 })
}, { width: EXPANDED_WIDTH })
