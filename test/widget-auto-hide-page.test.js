// "Hide when not in use", in the dock page (Playwright Chromium, paused fake
// clock: timers and frames run only on runFor), with a stub where the
// preload bridge would be. Pref on: after 900ms unused the dock tucks 90px
// into its edge on the tuck spring (overshooting a little, 260 / 22), and
// only a 3px strip flush to the edge takes the mouse; hovering the strip,
// a panel opening or finished-work pills bring it straight back; a new
// question while tucked washes amber up the strip; the left edge mirrors
// it; reduced motion jumps and drops the wash. Pref off: it never tucks.
// Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { SHELF_STAGE_WIDTH } = require('../src/widget-window')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [], rects: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp', 'shelf', 'openThread', 'haptic', 'recents'].map((n) => [n, call(n)])),
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onChatCss: on('chatCss'), onArrival: on('arrival'), onThreads: on('threads'),
    reportHitRects (rects) { cma.rects.push(rects) },
    sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const NAMES = ['Max', 'Ada', 'Lin']
const bot = (i, extra = {}) => ({ id: i ? `bot-${i}` : 'manager', name: NAMES[i], avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i, ...extra })
const BOTS = NAMES.map((_, i) => bot(i))
const LAYOUT = { expanded: false, mode: 'chat', botId: null, dockTop: 40, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true }
const W = SHELF_STAGE_WIDTH

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', autoHide = true, side = 'right' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: W, height: 640 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  const t0 = Date.now()
  await page.clock.install({ time: t0 })
  await page.clock.pauseAt(t0 + 1000)
  try {
    await page.goto(WIDGET_URL)
    await page.evaluate(({ bots, layout, autoHide }) => {
      window.__cma.layout(layout)
      window.__cma.state({ bots, candidates: [], focused_bot_id: null, workspace: null, auto_hide: autoHide })
    }, { bots: BOTS, layout: { ...LAYOUT, side }, autoHide })
    await page.clock.runFor(50)
    await fn(page)
  } finally {
    await context.close()
  }
})

const translateX = (page) => page.evaluate(() => {
  const v = document.getElementById('dock').style.translate
  return v ? parseFloat(v) : 0
})
const stripShown = (page) => page.evaluate(() => !document.getElementById('dock-strip').hidden)
const lastRects = (page) => page.evaluate(() => window.__cma.rects.at(-1))
const setState = (page, bots, extra = {}) => page.evaluate(({ bots, extra }) => window.__cma.state({ bots, candidates: [], focused_bot_id: null, workspace: null, auto_hide: true, ...extra }), { bots, extra })

pageTest('pref on: 900ms unused, then it tucks 90px on the spring (a small overshoot) and only the 3px strip takes the mouse', async (page) => {
  await page.clock.runFor(800)
  assert.equal(await stripShown(page), false, 'not yet')
  await page.clock.runFor(150)
  assert.equal(await stripShown(page), true)
  let max = 0
  for (let i = 0; i < 90; i++) { await page.clock.runFor(16); max = Math.max(max, await translateX(page)) }
  assert.equal(await translateX(page), 90, 'at rest, 90px toward the right edge')
  assert.ok(max > 92 && max < 97, `260 / 22 overshoots ~5%: ${max}`)
  const rects = await lastRects(page)
  assert.equal(rects.length, 1)
  assert.equal(rects[0].width, 3)
  assert.equal(rects[0].x + rects[0].width, W, 'flush to the edge')
  const dock = await page.evaluate(() => { const d = document.getElementById('dock'); return { top: d.offsetTop, height: d.offsetHeight } })
  assert.deepEqual({ top: rects[0].y, height: rects[0].height }, dock, 'as tall as the dock, where it was')
})

pageTest('hovering the strip slides it back out; leaving tucks it again after 900ms', async (page) => {
  await page.clock.runFor(2500)
  const r = (await lastRects(page))[0]
  await page.mouse.move(r.x + 1, r.y + r.height / 2)
  await page.clock.runFor(1500)
  assert.equal(await translateX(page), 0, 'out')
  assert.equal(await stripShown(page), false)
  assert.ok((await lastRects(page)).some((x) => x.width > 3), 'the dock takes the mouse again')
  await page.mouse.move(5, 600)
  await page.clock.runFor(850)
  assert.equal(await stripShown(page), false, 'still out')
  await page.clock.runFor(100)
  assert.equal(await stripShown(page), true, 'tucked again')
})

pageTest('a panel opening, or finished-work pills, bring it out at once and keep it out', async (page) => {
  await page.clock.runFor(2500)
  await page.evaluate((layout) => window.__cma.layout({ ...layout, expanded: true, mode: 'chat', botId: 'bot-1', popoverTop: 40, popoverHeight: 400 }), LAYOUT)
  await page.clock.runFor(1500)
  assert.equal(await translateX(page), 0)
  assert.equal(await stripShown(page), false)
  await page.evaluate((layout) => window.__cma.layout(layout), LAYOUT)
  await page.clock.runFor(2500)
  assert.equal(await stripShown(page), true, 'closed: tucks again')
  await page.evaluate(() => window.__cma.arrival({ bot_id: 'bot-1', name: 'Ada', label: 'Done', kind: 'message', shelf: true }))
  await page.clock.runFor(1500)
  assert.equal(await translateX(page), 0, 'a pill is out: in use')
})

pageTest('a new question while tucked: an amber wash runs up the strip, which stays amber while anyone waits', async (page) => {
  await page.clock.runFor(2500)
  await setState(page, [BOTS[0], bot(1, { mood: 'waiting', waiting: 'question' }), BOTS[2]])
  const wash = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.matches('.dock-strip-wash')).map((a) => ({ duration: a.effect.getTiming().duration, frames: a.effect.getKeyframes().map((k) => k.transform) })))
  assert.equal(wash.length, 1)
  assert.equal(wash[0].duration, 900)
  assert.deepEqual([wash[0].frames[0], wash[0].frames.at(-1)], ['translateY(100%)', 'translateY(-100%)'], 'bottom to top')
  assert.equal(await page.evaluate(() => document.getElementById('dock-strip').hasAttribute('data-waiting')), true)
  assert.equal(await stripShown(page), true, 'it stays tucked')
  await setState(page, [BOTS[0], bot(1, { mood: 'waiting', waiting: 'question' }), bot(2, { waiting: 'approval', paused: true })])
  const count = await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.matches('.dock-strip-wash')).length)
  assert.equal(count, 1, 'the same question again, or a paused bot: no new wash')
  await setState(page, BOTS)
  assert.equal(await page.evaluate(() => document.getElementById('dock-strip').hasAttribute('data-waiting')), false)
})

pageTest('the left edge: it tucks the other way and the strip sits at x = 0', async (page) => {
  await page.clock.runFor(2500)
  assert.equal(await translateX(page), -90)
  const r = (await lastRects(page))[0]
  assert.deepEqual([r.x, r.width], [0, 3])
}, { side: 'left' })

pageTest('reduced motion: it jumps (no spring), and a question just turns the strip amber', async (page) => {
  await page.clock.runFor(950)
  assert.equal(await translateX(page), 90, 'at once')
  await setState(page, [BOTS[0], bot(1, { mood: 'waiting', waiting: 'question' })])
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.effect?.target?.matches('.dock-strip-wash')).length), 0)
  assert.equal(await page.evaluate(() => document.getElementById('dock-strip').hasAttribute('data-waiting')), true)
}, { reducedMotion: 'reduce' })

pageTest('pref off: it never tucks', async (page) => {
  await page.clock.runFor(5000)
  assert.equal(await translateX(page), 0)
  assert.equal(await stripShown(page), false)
}, { autoHide: false })
