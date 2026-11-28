// A response arriving, in the dock page (Playwright Chromium, paused fake
// clock: timers and frames run only on runFor; Web Animations are read as
// created), with a stub where the preload bridge would be: the seat nudges
// 1 → 1.10 → 1; a pill drips out beside the dock (560ms, overshooting, from
// scale .6 / transparent / 32px toward the edge) with the bot's face, an
// icon and its label (at most 240px, ellipsised); three show, then "N
// more"; each lives 8s, held while the pointer is on the dock or the shelf
// and given 600ms more when it leaves, then leaves (300ms, 24px toward the
// edge); a click opens that chat; the page asks main for room while the
// shelf is out; reduced motion fades. In an open chat a new bubble rises
// 8px unblurring (340ms) and a working bot shows typing dots. Skipped where
// Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { SHELF_STAGE_WIDTH, EXPANDED_WIDTH } = require('../src/widget-window')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp', 'shelf'].map((n) => [n, call(n)])),
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onChatCss: on('chatCss'), onArrival: on('arrival'),
    reportHitRects () {}, sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const NAMES = ['Max', 'Ada', 'Lin', 'Ivo', 'Rae', 'Oz']
const bot = (i, extra = {}) => ({ id: i ? `bot-${i}` : 'manager', name: NAMES[i], avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i, ...extra })
const BOTS = NAMES.map((_, i) => bot(i))
const LAYOUT = { expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true }

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', width = SHELF_STAGE_WIDTH } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width, height: 640 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  const t0 = Date.now()
  await page.clock.install({ time: t0 })
  await page.clock.pauseAt(t0 + 1000)
  try {
    await page.goto(WIDGET_URL)
    await page.evaluate(({ bots, layout }) => { window.__cma.state({ bots, candidates: [], focused_bot_id: null, workspace: null }); window.__cma.layout(layout) }, { bots: BOTS, layout: LAYOUT })
    await page.clock.runFor(50)
    await fn(page)
  } finally {
    await context.close()
  }
})

const arrive = async (page, i, extra = {}) => {
  await page.evaluate((a) => window.__cma.arrival(a), { bot_id: `bot-${i}`, name: NAMES[i], label: `Answer from ${NAMES[i]}`, kind: 'message', shelf: true, ...extra })
  await page.clock.runFor(40) // the frame the page waits for the wider window
}
const pills = (page) => page.$$eval('.shelf-pill:not(.shelf-more)', (n) => n.map((b) => b.querySelector('.shelf-label').textContent))
const more = (page) => page.evaluate(() => document.querySelector('.shelf-more')?.textContent || null)
const calls = (page, name) => page.evaluate((name) => window.__cma.calls.filter((c) => c[0] === name), name)
const anims = (page, sel) => page.evaluate((sel) => document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.matches(sel)).map((a) => ({ duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing, frames: a.effect.getKeyframes().map((k) => ({ transform: k.transform, opacity: k.opacity })) })), sel)

pageTest('the seat nudges 1 → 1.10 → 1 (a sampled snappy spring)', async (page) => {
  await arrive(page, 1)
  const a = await anims(page, '.dock-bot[data-bot-id="bot-1"]')
  assert.equal(a.length, 1)
  const scales = a[0].frames.map((f) => Number(f.transform.match(/scale\(([\d.]+)\)/)[1]))
  assert.equal(scales[0], 1)
  assert.ok(Math.abs(Math.max(...scales) - 1.1) < 0.001, `peaks at 1.10 (${Math.max(...scales)})`)
  assert.equal(scales.at(-1), 1)
  assert.equal(a[0].easing, 'linear')
})

pageTest('a pill drips out beside the dock: face, icon, label; 560ms overshooting from scale .6, transparent, 32px toward the edge', async (page) => {
  await arrive(page, 1, { label: 'The weekly report is ready, with the charts and the long appendix everyone asked for' })
  assert.deepEqual(await calls(page, 'shelf'), [['shelf', true]], 'asked main for room first')
  const a = (await anims(page, '.shelf-pill'))[0]
  const p = await page.evaluate(() => {
    document.getAnimations().forEach((x) => { if (x.effect.getComputedTiming().endTime !== Infinity) x.finish() })
    const b = document.querySelector('.shelf-pill')
    const label = b.querySelector('.shelf-label')
    const dock = document.querySelector('.dock').getBoundingClientRect()
    const r = b.getBoundingClientRect()
    return { face: b.querySelector('.avatar').getBoundingClientRect().width, icon: Boolean(b.querySelector('.shelf-icon svg path')), labelW: label.getBoundingClientRect().width, cut: label.scrollWidth > label.clientWidth, gap: Math.round(dock.left - r.right), aria: b.getAttribute('aria-label') }
  })
  assert.equal(p.face, 28)
  assert.ok(p.icon)
  assert.ok(p.labelW <= 240 && p.cut, 'at most 240px, ellipsised')
  assert.ok(p.gap >= 18 && p.gap <= 20, `18px from the dock (${p.gap})`)
  assert.match(p.aria, /^Ada: The weekly report.*Open the chat\.$/)
  assert.equal(a.duration, 560)
  assert.equal(a.easing, 'cubic-bezier(0.34, 1.56, 0.64, 1)')
  assert.deepEqual(a.frames, [{ transform: 'translateX(32px) scale(0.6)', opacity: '0' }, { transform: 'none', opacity: '1' }])
})

pageTest('three show, then "N more"; the same bot again updates its pill', async (page) => {
  for (const i of [1, 2, 3, 4, 5]) await arrive(page, i)
  assert.deepEqual(await pills(page), ['Answer from Ada', 'Answer from Lin', 'Answer from Ivo'])
  assert.equal(await more(page), '2 more')
  await arrive(page, 2, { label: 'Lin again' })
  assert.deepEqual(await pills(page), ['Answer from Ada', 'Lin again', 'Answer from Ivo'])
  assert.equal(await more(page), '2 more')
})

pageTest('each lives 8s, then leaves (300ms, fading 24px toward the edge) and the next in line comes in', async (page) => {
  for (const i of [1, 2, 3, 4]) await arrive(page, i)
  await page.clock.runFor(7800)
  assert.equal((await pills(page)).length, 3, 'still there just before 8s')
  await page.clock.runFor(300)
  const leaving = await anims(page, '.shelf-pill')
  assert.ok(leaving.some((x) => x.duration === 300 && x.frames.at(-1).transform === 'translateX(24px)' && x.frames.at(-1).opacity === '0'))
  await page.waitForFunction(() => document.querySelectorAll('.shelf-pill:not(.shelf-more)').length === 1, null, { timeout: 3000 })
  assert.deepEqual(await pills(page), ['Answer from Rae'], 'Rae came in as the first three left')
  assert.equal(await more(page), null)
})

pageTest('hovering the shelf (or the dock) holds the pills; leaving gives them 600ms more', async (page) => {
  await arrive(page, 1)
  await page.clock.runFor(2000)
  const box = await page.locator('.shelf-pill').boundingBox()
  await page.mouse.move(box.x + 20, box.y + 20)
  await page.clock.runFor(20000)
  assert.equal((await pills(page)).length, 1, 'held while hovered')
  await page.mouse.move(5, 600) // off the shelf and the dock
  await page.clock.runFor(6000 + 600 - 100)
  assert.equal((await pills(page)).length, 1, 'the rest of its 8s, plus 600ms')
  await page.clock.runFor(200)
  await page.waitForFunction(() => !document.querySelector('.shelf-pill'), null, { timeout: 3000 })
  assert.deepEqual((await calls(page, 'shelf')).map((c) => c[1]), [true, false], 'room given back when the shelf empties')
})

pageTest('in and out of the shelf a few times: the grace does not pile up, and the oldest still leaves first', async (page) => {
  await arrive(page, 1)
  await page.clock.runFor(1500)
  await arrive(page, 2)
  await page.clock.runFor(1000)
  const box = await page.locator('.shelf-pill').first().boundingBox()
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(box.x + 20, box.y + 20)
    await page.clock.runFor(100)
    await page.mouse.move(5, 600)
    await page.clock.runFor(100) // back within the 600ms: still held
  }
  await page.clock.runFor(600) // now the clocks run again
  // Ada had 8000 − 2540 left, Lin 8000 − 1000: Ada goes first.
  await page.clock.runFor(8000 - 2540 - 100)
  assert.deepEqual(await pills(page), ['Answer from Ada', 'Answer from Lin'])
  await page.clock.runFor(200)
  await page.waitForFunction(() => document.querySelectorAll('.shelf-pill:not(.shelf-more)').length === 1, null, { timeout: 3000 })
  assert.deepEqual(await pills(page), ['Answer from Lin'])
})

pageTest('a click on a pill opens that chat', async (page) => {
  await arrive(page, 3)
  await page.click('.shelf-pill')
  assert.deepEqual(await calls(page, 'open'), [['open', 'bot-3']])
})

pageTest('"Show finished work" off: the seat still nudges, no pill', async (page) => {
  await arrive(page, 1, { shelf: false })
  assert.equal((await anims(page, '.dock-bot[data-bot-id="bot-1"]')).length, 1)
  assert.equal(await page.locator('.shelf-pill').count(), 0)
  assert.deepEqual(await calls(page, 'shelf'), [])
})

pageTest('reduced motion: no nudge; the pill fades in and out', async (page) => {
  await arrive(page, 1)
  assert.equal((await anims(page, '.dock-bot')).length, 0)
  const a = (await anims(page, '.shelf-pill'))[0]
  assert.deepEqual(a.frames, [{ transform: undefined, opacity: '0' }, { transform: undefined, opacity: '1' }])
  assert.equal(a.duration, 150)
}, { reducedMotion: 'reduce' })

pageTest('in an open chat: a new bubble rises 8px, unblurring, over 340ms; a working bot shows typing dots (6px, 1s, 150ms apart)', async (page) => {
  await page.evaluate((l) => window.__cma.layout({ ...l, expanded: true, botId: 'bot-1', popoverHeight: 520 }), LAYOUT)
  await page.evaluate(() => window.__cma.conversation({ bot_id: 'bot-1', history: true, pending: null, messages: [{ id: 'a', role: 'assistant', body: 'Hello', created_at: new Date().toISOString() }] }))
  const s = await page.evaluate(() => { const m = getComputedStyle(document.querySelector('.message')); return { name: m.animationName, dur: m.animationDuration } })
  assert.deepEqual(s, { name: 'message-in', dur: '0.34s' })
  const kf = await page.evaluate(() => document.getAnimations().find((a) => a.animationName === 'message-in').effect.getKeyframes()[0])
  assert.equal(kf.transform, 'translateY(8px)')
  assert.equal(kf.filter, 'blur(4px)')
  assert.equal(kf.opacity, '0')
  await page.evaluate((bots) => window.__cma.state({ bots: bots.map((b) => (b.id === 'bot-1' ? { ...b, mood: 'working' } : b)), candidates: [], focused_bot_id: null, workspace: null }), BOTS)
  const dots = await page.evaluate(() => [...document.querySelectorAll('.typing i')].map((i) => { const c = getComputedStyle(i); return [i.offsetWidth, c.animationDuration, c.animationDelay] }))
  assert.deepEqual(dots, [[6, '1s', '0s'], [6, '1s', '0.15s'], [6, '1s', '0.3s']])
  assert.equal(await page.evaluate(() => document.querySelector('[data-role="messages"]').lastElementChild.className), 'typing', 'last in the thread')
  await page.evaluate((bots) => window.__cma.state({ bots, candidates: [], focused_bot_id: null, workspace: null }), BOTS)
  assert.equal(await page.locator('.typing').count(), 0, 'gone when it stops working')
}, { width: EXPANDED_WIDTH })
