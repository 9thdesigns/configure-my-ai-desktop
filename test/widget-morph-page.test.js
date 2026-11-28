// A row of the recents card opened, in a real browser (Playwright Chromium)
// on a paused fake clock, with a stub where the preload bridge would be: the
// card grows into the 380×560 chat on OPEN (height first, then width) after
// a frame's wait, under the card as it fades; the row's title flies to the
// header; the chat's content fades in at 85% from .97; the header gets a back
// chevron. Esc (or the chevron) steps back: the chat shrinks into the card on
// CLOSE and the card comes back with its row focused; Esc again closes. The
// chat closes into the seat on CLOSE. Reduced motion is a fade. It sits in
// the card's place on either edge. Web Animations run on the document
// timeline, not the fake clock, so they are seeked or finished by hand.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const W = require('../src/widget-window')
const RC = require('../src/recents-card')
const Motion = require('../src/motion')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'openThread', 'back', 'recents', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp'].map((n) => [n, call(n)])),
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onChatCss: on('chatCss'), onThreads: on('threads'),
    reportHitRects () {}, sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const bots = (n) => Array.from({ length: n }, (_, i) => ({ id: i ? `bot-${i}` : 'manager', name: i ? `Bot ${i}` : 'Manager', avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i }))
const NOW = Date.parse('2026-11-28T15:00:00Z')
const THREADS = [
  { id: 't1', title: 'Quarterly plan', preview: 'Here is the draft', updated_at: new Date(NOW - 5 * 60_000).toISOString(), unread: true },
  { id: 't2', title: 'Inbox triage', preview: 'Three need a reply', updated_at: new Date(NOW - 3 * 3_600_000).toISOString(), unread: false },
]
const workArea = { x: 0, y: 25, width: 1440, height: 875 }

// Everything in the chat's (wider) window, as main sends it there.
function layouts (side = 'right') {
  const t = W.threadLayoutFor({ workArea, dockHeight: 380, offsetY: 150, side, seatY: 120, rows: THREADS.length })
  const base = { expanded: true, botId: 'bot-1', dockTop: t.dockTop, cardTop: t.cardTop, cardHeight: t.cardHeight, seatY: t.seatY, side, draggable: true }
  return {
    bounds: t.bounds,
    t,
    recents: { ...base, mode: 'recents', popoverTop: 0, popoverHeight: 0, opening: true },
    thread: { ...base, mode: 'thread', popoverTop: t.popoverTop, popoverHeight: t.popoverHeight, opening: true, threadId: 't1', threadTitle: 'Quarterly plan' },
    back: { ...base, mode: 'recents', popoverTop: t.popoverTop, popoverHeight: t.popoverHeight, back: true },
    closing: { ...base, expanded: false, botId: null, mode: 'chat', popoverTop: t.popoverTop, popoverHeight: t.popoverHeight, closing: true, closingMode: 'thread' },
  }
}

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const inMorph = (a) => a.effect && a.effect.target && (a.effect.target.closest?.('#popover, #recents') || a.effect.target.classList?.contains('morph-title'))
const settle = async (page) => {
  await page.clock.runFor(300)
  await page.evaluate(() => { for (const a of document.getAnimations()) a.finish() })
  await page.clock.runFor(20)
}

const pageTest = (name, fn, { reducedMotion = 'no-preference', side = 'right' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const L = layouts(side)
  const context = await browser.newContext({ viewport: { width: L.bounds.width, height: L.bounds.height }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  await page.clock.install({ time: NOW - 1000 })
  await page.clock.pauseAt(NOW)
  try {
    await page.goto(WIDGET_URL)
    await page.evaluate(({ list, L }) => {
      window.__cma.state({ bots: list, candidates: [], focused_bot_id: null, workspace: null })
      window.__cma.threads({ bot_id: 'bot-1', threads: L.threads })
      window.__cma.layout(L.recents)
    }, { list: bots(3), L: { ...L, threads: THREADS } })
    await settle(page)
    await fn(page, L)
  } finally {
    await context.close()
  }
})

const openRow = async (page, L) => {
  await page.evaluate((l) => window.__cma.layout(l), L.thread)
}

pageTest('the card grows into the chat: held a frame, then from the card\'s rectangle on OPEN, height first, then width, under the fading card', async (page, L) => {
  await openRow(page, L)
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#popover')).visibility), 'hidden', 'held back while the window widens')
  assert.equal(await page.evaluate(() => document.querySelector('#recents').hidden), false, 'the card is still there')
  await page.clock.runFor(40)
  const m = await page.evaluate(() => {
    const pop = document.querySelector('#popover')
    const frame = pop.getAnimations().find((a) => a.effect.getKeyframes()[0].clipPath)
    const card = document.querySelector('#recents').getAnimations()[0]
    const content = [...pop.children].filter((n) => !n.hidden).map((n) => n.getAnimations()[0]).filter(Boolean)
    return {
      visibility: getComputedStyle(pop).visibility,
      cls: pop.className,
      box: (({ width, height }) => [width, height])(pop.getBoundingClientRect()),
      kf: frame.effect.getKeyframes().map((k) => k.clipPath),
      duration: frame.effect.getTiming().duration,
      card: card && [card.effect.getKeyframes().at(-1).opacity, card.effect.getTiming().duration],
      content: content.map((a) => [a.effect.getTiming().delay, a.effect.getKeyframes()[0].transform, Number(a.effect.getKeyframes()[0].opacity)]),
    }
  })
  assert.equal(m.visibility, 'visible')
  assert.match(m.cls, /is-thread/)
  assert.match(m.cls, /is-morphing/)
  assert.deepEqual(m.box, [380, 560], 'the chat is 380×560')
  const expected = RC.morphFrames({ width: 380, height: 560, cardTop: L.thread.cardTop - L.thread.popoverTop, cardHeight: L.thread.cardHeight, cardWidth: 288 })
  assert.equal(m.duration, expected.duration, 'OPEN, with the width lagging')
  assert.equal(m.kf[0], expected.keyframes[0].clipPath, 'starts as the card')
  assert.match(m.kf.at(-1), /^inset\(0px( 0px 0px 0px)? round 20px\)$/)
  assert.deepEqual(m.card, ['0', 150], 'the card fades on top')
  assert.ok(m.content.length >= 3)
  assert.ok(m.content.every(([delay, from, op]) => delay === expected.contentDelay && from === 'scale(0.97)' && op === 0), 'content at 85%, from .97')
  assert.equal(expected.contentDelay, Math.round(expected.duration * 0.85))
})

pageTest('the row\'s title flies to the header, and the header gets the title, the bot and a back chevron', async (page, L) => {
  const fromRect = await page.evaluate(() => { const r = document.querySelector('.recents-row[data-thread-id="t1"] .recents-title').getBoundingClientRect(); return { left: r.left, top: r.top } })
  await openRow(page, L)
  await page.clock.runFor(40)
  const f = await page.evaluate(() => {
    const clone = document.querySelector('.morph-title')
    const to = document.querySelector('[data-role="head-name"]').getBoundingClientRect()
    const a = clone.getAnimations().find((x) => x.effect.getKeyframes().at(-1).transform !== undefined && x.effect.getKeyframes().at(-1).transform !== 'none')
    return { text: clone.textContent, left: parseFloat(clone.style.left), top: parseFloat(clone.style.top), to: { left: to.left, top: to.top }, last: a.effect.getKeyframes().at(-1).transform }
  })
  assert.equal(f.text, 'Quarterly plan')
  assert.deepEqual([f.left, f.top], [fromRect.left, fromRect.top], 'from the row')
  const [, dx, dy] = f.last.match(/translate\(([-\d.]+)px, ([-\d.]+)px\)/).map(Number)
  assert.ok(Math.abs(f.left + dx - f.to.left) < 0.5 && Math.abs(f.top + dy - f.to.top) < 0.5, 'to the header')
  await settle(page)
  const after = await page.evaluate(() => ({
    clone: Boolean(document.querySelector('.morph-title')),
    name: document.querySelector('[data-role="head-name"]').textContent,
    state: document.querySelector('[data-role="head-state"]').textContent,
    back: !document.querySelector('[data-action="back"]').hidden,
    card: document.querySelector('#recents').hidden,
    clip: getComputedStyle(document.querySelector('#popover')).clipPath,
    morphing: document.querySelector('#popover').classList.contains('is-morphing'),
    focus: document.activeElement.dataset.role,
  }))
  assert.deepEqual(after, { clone: false, name: 'Quarterly plan', state: 'Bot 1 · Idle', back: true, card: true, clip: 'none', morphing: false, focus: 'compose' })
})

pageTest('Esc steps back: the chat shrinks into the card on CLOSE (width first), the card comes back with its row focused; Esc again closes', async (page, L) => {
  await openRow(page, L)
  await settle(page)
  await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'back' || c[0] === 'collapse')), [['back']])
  await page.evaluate((l) => window.__cma.layout(l), L.back)
  const m = await page.evaluate(() => {
    const pop = document.querySelector('#popover')
    const frame = pop.getAnimations().find((a) => a.effect.getKeyframes()[0].clipPath)
    return { hidden: pop.hidden, duration: frame.effect.getTiming().duration, last: frame.effect.getKeyframes().at(-1).clipPath, card: document.querySelector('#recents').hidden }
  })
  const expected = RC.morphFrames({ width: 380, height: 560, cardTop: L.back.cardTop - L.back.popoverTop, cardHeight: L.back.cardHeight, cardWidth: 288, back: true })
  assert.equal(m.hidden, false)
  assert.equal(m.duration, expected.duration, 'CLOSE')
  assert.equal(m.last, expected.keyframes.at(-1).clipPath, 'lands on the card')
  assert.equal(m.card, false)
  await settle(page)
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#popover').hidden, document.querySelector('#recents').hidden, document.activeElement.dataset.threadId]), [true, false, 't1'])
  await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'back' || c[0] === 'collapse')), [['back'], ['collapse']])
})

pageTest('the back chevron asks main to step back', async (page, L) => {
  await openRow(page, L)
  await settle(page)
  await page.click('[data-action="back"]')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'back')), [['back']])
})

pageTest('closing the chat: into the seat on CLOSE, then hidden', async (page, L) => {
  await openRow(page, L)
  await settle(page)
  await page.evaluate((l) => window.__cma.layout(l), L.closing)
  const m = await page.evaluate(() => {
    const a = document.querySelector('#popover').getAnimations()[0]
    return { duration: a.effect.getTiming().duration, last: a.effect.getKeyframes().at(-1) }
  })
  assert.equal(m.duration, Motion.sample('close', { from: 1, to: 0 }).duration)
  assert.equal(m.last.transform, 'translateX(58px)', 'onto the seat')
  assert.match(m.last.clipPath, /^inset\([\d.]+px 0px [\d.]+px 340px round 20px\)$/, 'a seat circle at the chat\'s dock-side edge')
  await settle(page)
  assert.equal(await page.evaluate(() => document.querySelector('#popover').hidden), true)
})

pageTest('reduced motion: the chat fades in (≤150ms), nothing moves, no title flight', async (page, L) => {
  await openRow(page, L)
  await page.clock.runFor(40)
  const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.effect.target.closest && a.effect.target.closest('#popover, #recents')).map((a) => ({ d: a.effect.getTiming().duration, keys: a.effect.getKeyframes().flatMap((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x))) })))
  assert.ok(anims.length > 0)
  assert.ok(anims.every((a) => a.d <= 150 && a.keys.every((k) => k === 'opacity')), JSON.stringify(anims))
  assert.equal(await page.evaluate(() => Boolean(document.querySelector('.morph-title'))), false)
  await settle(page)
  assert.deepEqual(await page.evaluate(() => [document.querySelector('#popover').hidden, document.querySelector('#recents').hidden]), [false, true])
}, { reducedMotion: 'reduce' })

for (const side of ['right', 'left']) {
  pageTest(`on the ${side} edge the chat sits in the card's place: 10px from the dock, toward the screen interior`, async (page, L) => {
    await openRow(page, L)
    await settle(page)
    const r = await page.evaluate(() => {
      const pop = document.querySelector('#popover').getBoundingClientRect()
      const dock = document.querySelector('.dock-body').getBoundingClientRect()
      return { pop: [pop.left, pop.right, pop.top], dock: [dock.left, dock.right] }
    })
    if (side === 'right') assert.equal(r.pop[1], r.dock[0] - 10)
    else assert.equal(r.pop[0], r.dock[1] + 10)
    assert.equal(r.pop[2], L.thread.popoverTop)
  }, { side })
}
