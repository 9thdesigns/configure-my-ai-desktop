// The jelly badge in the dock (Playwright Chromium, paused fake clock: timers
// run only on runFor; Web Animations are inspected as created): an 18px pill
// with a 3px ring in the dock's fill, a gradient per kind, 12px/700 tabular
// digits capped at "99+", inside its seat; in at scale .7 → 1 (200ms); a +1
// rolls the old digit out and the new one in, follows the width and
// squashes; bursts collapse into one move; out squashes and shrinks to .2
// (240ms) then hides; reduced motion changes in place; the working dots hop
// (28×14, three 6px dots, 960ms, 130ms apart) and pause when the page is
// hidden. Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { DOCK_WIDTH } = require('../src/widget-window')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = {})
  const on = (name) => (fn) => { cma[name] = fn }
  const nop = () => {}
  window.cmaWidget = {
    ready: nop, drag: nop, open: nop, collapse: nop, contextMenu: nop, picker: nop, workspaceMenu: nop, pin: nop, openInApp: nop,
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onChatCss: on('chatCss'),
    reportHitRects () {}, sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const bot = (i, extra = {}) => ({ id: i ? `bot-${i}` : 'manager', name: `B${i}`, avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i, ...extra })

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', colorScheme = 'light' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: DOCK_WIDTH, height: 600 }, reducedMotion, colorScheme })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  const t0 = Date.now()
  await page.clock.install({ time: t0 })
  await page.clock.pauseAt(t0 + 1000)
  try {
    await page.goto(WIDGET_URL)
    await fn(page)
  } finally {
    await context.close()
  }
})

const dock = (page, bots) => page.evaluate((bots) => {
  window.__cma.state({ bots, candidates: [], focused_bot_id: null, workspace: null })
  window.__cma.layout({ expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true })
}, bots)

const jelly = (page, i = 1) => page.evaluate((i) => {
  document.getAnimations().forEach((a) => { if (a.effect.getComputedTiming().endTime !== Infinity) a.finish() })
  const seat = document.querySelectorAll('.dock-bot')[i]
  const j = seat.querySelector('.jelly')
  const pill = j.querySelector('.jelly-pill')
  const glyph = j.querySelector('.jelly-glyph:not(.is-leaving)')
  const s = getComputedStyle(pill)
  const g = getComputedStyle(glyph)
  const r = pill.getBoundingClientRect()
  const sr = seat.getBoundingClientRect()
  return {
    kind: j.dataset.kind, empty: j.hasAttribute('data-empty'), dot: j.hasAttribute('data-dot'), glyph: glyph.textContent,
    h: r.height, w: r.width, bg: s.backgroundImage, ring: s.boxShadow, origin: s.transformOrigin,
    font: [g.fontSize, g.fontWeight, g.fontVariantNumeric, g.color],
    inside: r.left >= sr.left && r.right + 3 <= sr.right + 0.01 && r.bottom + 3 <= sr.bottom + 0.01,
  }
}, i)

const anims = (page, sel) => page.evaluate((sel) => document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.matches(sel)).map((a) => {
  const t = a.effect.getTiming()
  return { duration: t.duration, easing: t.easing, frames: a.effect.getKeyframes().map((k) => ({ transform: k.transform, opacity: k.opacity, width: k.width })) }
}), sel)

pageTest('the look: an 18px pill with a 3px ring in the dock fill, a gradient per kind, 12px/700 tabular white digits, inside its seat', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 3 }), bot(2, { waiting: 'question', needs_count: 1 }), bot(3, { mood: 'failed' }), bot(4, { mood: 'responded', needs_count: 250 }), bot(5, { mood: 'responded' })])
  const unread = await jelly(page, 1)
  assert.deepEqual([unread.kind, unread.glyph, unread.h], ['unread', '3', 18])
  assert.match(unread.bg, /linear-gradient\(rgb\(109, 94, 252\), rgb\(75, 63, 214\)\)/)
  assert.equal(unread.ring, 'rgb(248, 247, 245) 0px 0px 0px 3px', 'a 3px ring in the dock fill: it reads as cut out')
  assert.deepEqual(unread.font, ['12px', '700', 'tabular-nums', 'rgb(255, 255, 255)'])
  assert.equal(unread.origin, '9px 18px', 'origin bottom centre')
  assert.ok(unread.inside, 'the pill and its ring stay inside the seat')
  const waiting = await jelly(page, 2)
  assert.deepEqual([waiting.kind, waiting.glyph], ['waiting', '?'])
  assert.match(waiting.bg, /rgb\(255, 154, 31\), rgb\(208, 112, 12\)/)
  const failed = await jelly(page, 3)
  assert.deepEqual([failed.kind, failed.glyph], ['failed', '!'])
  assert.match(failed.bg, /rgb\(240, 74, 90\), rgb\(181, 23, 42\)/)
  const many = await jelly(page, 4)
  assert.equal(many.glyph, '99+')
  assert.ok(many.w > 18 && many.inside, 'wider, and still inside')
  const dot = await jelly(page, 5)
  assert.deepEqual([dot.dot, dot.h], [true, 10], 'something new, no count: a dot')
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dock-bot')[0].querySelector('.jelly').hasAttribute('data-empty')), true, 'nothing to show: hidden')
})

pageTest('dark: the ring is the dark dock fill', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 2 })])
  assert.equal((await jelly(page, 1)).ring, 'rgb(18, 17, 16) 0px 0px 0px 3px')
}, { colorScheme: 'dark' })

pageTest('in: scale .7 → 1 over 200ms (.2, 0, 0, 1)', async (page) => {
  await dock(page, [bot(0), bot(1)])
  await page.clock.runFor(50)
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 1 })])
  const a = await anims(page, '.jelly-pill')
  assert.equal(a.length, 1)
  assert.equal(a[0].duration, 200)
  assert.equal(a[0].easing, 'cubic-bezier(0.2, 0, 0, 1)')
  assert.deepEqual(a[0].frames.map((f) => f.transform), ['scale(0.7)', 'scale(1)'])
})

pageTest('+1: the old digit rolls up and out, the new one rolls in from below, the width follows, and it squashes', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 9 })])
  await page.clock.runFor(1000)
  await page.evaluate(() => document.getAnimations().forEach((a) => a.finish()))
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 10 })])
  const out = await anims(page, '.jelly-glyph.is-leaving')
  assert.equal(out.length, 1)
  assert.deepEqual([out[0].duration, out[0].easing], [200, 'ease-in'])
  assert.deepEqual(out[0].frames.map((f) => f.transform), ['translateY(0px)', 'translateY(-65%)'])
  const incoming = await anims(page, '.jelly-glyph:not(.is-leaving)')
  assert.deepEqual([incoming[0].duration, incoming[0].easing], [280, 'cubic-bezier(0.22, 1, 0.36, 1)'])
  assert.deepEqual(incoming[0].frames.map((f) => f.transform), ['translateY(65%)', 'translateY(0px)'])
  const pill = await anims(page, '.jelly-pill')
  const width = pill.find((p) => p.frames[0].width)
  assert.ok(width && width.duration === 280, 'the width follows (9 → 10 is wider)')
  assert.ok(parseFloat(width.frames[1].width) > parseFloat(width.frames[0].width))
  const squash = pill.find((p) => p.frames.length === 4)
  assert.deepEqual(squash.frames.map((f) => f.transform), ['scale(1, 1)', 'scale(1.12, 0.88)', 'scale(0.97, 1.04)', 'scale(1, 1)'])
  assert.equal(squash.duration, 360)
  assert.equal((await jelly(page, 1)).glyph, '10')
})

pageTest('bursts: five changes within 400ms are one move now and one to the latest value when the burst ends', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 1 })])
  await page.clock.runFor(1000)
  await page.evaluate(() => {
    window.__rolls = 0
    const proto = Element.prototype.animate
    Element.prototype.animate = function (frames, opts) {
      if (this.classList.contains('is-leaving')) window.__rolls++
      return proto.call(this, frames, opts)
    }
  })
  for (const n of [2, 3, 4, 5, 6]) {
    await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: n })])
    await page.clock.runFor(50)
  }
  assert.equal(await page.evaluate(() => window.__rolls), 1, 'one roll at the start of the burst')
  assert.equal((await jelly(page, 1)).glyph, '2', 'the rest wait')
  await page.clock.runFor(400)
  assert.equal(await page.evaluate(() => window.__rolls), 2, 'one more when the burst ends')
  assert.equal((await jelly(page, 1)).glyph, '6', 'straight to the latest')
})

pageTest('out: a small squash, then scale .2 and fade over 240ms (.5, 0, .75, 0); hidden after', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 2 })])
  await page.clock.runFor(1000)
  await dock(page, [bot(0), bot(1)])
  const a = await anims(page, '.jelly-pill')
  const out = a.find((x) => x.duration === 240)
  assert.ok(out)
  assert.equal(out.easing, 'cubic-bezier(0.5, 0, 0.75, 0)')
  assert.deepEqual(out.frames.map((f) => f.transform), ['scale(1, 1)', 'scale(1.08, 0.92)', 'scale(0.2)'])
  assert.equal(out.frames.at(-1).opacity, '0')
  await page.waitForFunction(() => document.querySelectorAll('.dock-bot')[1].querySelector('.jelly').hasAttribute('data-empty'), null, { timeout: 3000 })
})

pageTest('reduced motion: no animation at all; the glyph changes in place', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 2 })])
  await dock(page, [bot(0), bot(1, { mood: 'responded', needs_count: 3 })])
  await dock(page, [bot(0), bot(1, { waiting: 'question', needs_count: 1 })])
  assert.deepEqual(await anims(page, '.jelly, .jelly *'), [])
  assert.deepEqual([(await jelly(page, 1)).kind, (await jelly(page, 1)).glyph], ['waiting', '?'])
  await dock(page, [bot(0), bot(1)])
  assert.equal(await page.evaluate(() => document.querySelectorAll('.dock-bot')[1].querySelector('.jelly').hasAttribute('data-empty')), true, 'gone at once')
}, { reducedMotion: 'reduce' })

pageTest('working: a 28×14 pill under the face, three 6px dots hopping 960ms, 130ms apart; paused while the page is hidden', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'working' })])
  const d = await page.evaluate(() => {
    const seat = document.querySelectorAll('.dock-bot')[1]
    const pill = seat.querySelector('.jelly-dots')
    const face = seat.querySelector('.avatar').getBoundingClientRect()
    const r = pill.getBoundingClientRect()
    const dots = [...pill.querySelectorAll('.jelly-dot')].map((x) => { const s = getComputedStyle(x); const b = x.getBoundingClientRect(); return { w: b.width, h: b.height, name: s.animationName, dur: s.animationDuration, delay: s.animationDelay, state: s.animationPlayState } })
    return { w: r.width, h: r.height, centred: Math.abs((r.left + r.right) / 2 - (face.left + face.right) / 2) < 0.5, under: r.bottom > face.bottom, pillHidden: getComputedStyle(seat.querySelector('.jelly-pill')).display, dots }
  })
  assert.deepEqual([d.w, d.h], [28, 14])
  assert.ok(d.centred && d.under, 'centred under the face')
  assert.equal(d.pillHidden, 'none', 'no count badge while working')
  assert.deepEqual(d.dots.map((x) => [x.w, x.h, x.name, x.dur, x.delay, x.state]), [[6, 6, 'jelly-hop', '0.96s', '0s', 'running'], [6, 6, 'jelly-hop', '0.96s', '0.13s', 'running'], [6, 6, 'jelly-hop', '0.96s', '0.26s', 'running']])
  await page.evaluate(() => document.documentElement.setAttribute('data-cfa-paused', ''))
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.jelly-dot')).animationPlayState), 'paused')
})

pageTest('reduced motion: the working dots stand still', async (page) => {
  await dock(page, [bot(0), bot(1, { mood: 'working' })])
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.jelly-dot')).animationName), 'none')
}, { reducedMotion: 'reduce' })
