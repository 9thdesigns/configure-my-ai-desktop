// A seat's recents card in a real browser (Playwright Chromium) on a paused
// fake clock (time moves only on runFor), with a stub where the preload
// bridge would be: a click asks main for the card from that seat, a
// double-click or Option-click goes straight to the chat; the card is laid
// out to spec (288 wide, 20px corners, 52px rows, the height main sized the
// window for); it buds out of the seat on SOFT behind a frame's wait, with
// the bridge fading in and the rows staggered 30ms apart; it closes back
// into the seat on CLOSE; reduced motion is a short fade and nothing moves;
// the keyboard walks the rows and opens one; and it opens toward the screen
// interior from either edge. Skipped where Playwright (or its Chromium) is
// not installed.

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
    ...Object.fromEntries(['ready', 'drag', 'open', 'recents', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp'].map((n) => [n, call(n)])),
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onChatCss: on('chatCss'), onThreads: on('threads'),
    reportHitRects () {}, sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

const bots = (n) => Array.from({ length: n }, (_, i) => ({ id: i ? `bot-${i}` : 'manager', name: i ? `Bot ${i}` : 'Manager', avatar_color: '#6e56cf', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: i === 1 ? 'Working…' : 'Idle', paused: false, isManager: !i }))
const NOW = Date.parse('2026-11-28T15:00:00Z')
const THREADS = [
  { id: 't1', title: 'Quarterly plan', preview: 'Here is the draft you asked for', updated_at: new Date(NOW - 5 * 60_000).toISOString(), unread: true },
  { id: 't2', title: 'Inbox triage', preview: 'Three need a reply today', updated_at: new Date(NOW - 3 * 3_600_000).toISOString(), unread: false },
  { id: 't3', title: 'Hiring loop', preview: 'Scheduled the panel', updated_at: new Date(NOW - 26 * 3_600_000).toISOString(), unread: false },
]
const workArea = { x: 0, y: 25, width: 1440, height: 875 }
const COLLAPSED = { expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true }

// The layout main would send for bot-1's card from a seat at seatY.
function recentsLayout ({ side = 'right', seatY = 120, rows = THREADS.length } = {}) {
  const l = W.recentsLayoutFor({ workArea, dockHeight: 380, offsetY: 200, side, seatY, rows })
  return { layout: { expanded: true, mode: 'recents', botId: 'bot-1', dockTop: l.dockTop, popoverTop: 0, popoverHeight: 0, cardTop: l.cardTop, cardHeight: l.cardHeight, seatY: l.seatY, side, draggable: true, opening: true }, bounds: l.bounds }
}

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', side = 'right' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const { layout, bounds } = recentsLayout({ side })
  const context = await browser.newContext({ viewport: { width: bounds.width, height: bounds.height }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  await page.clock.install({ time: NOW - 1000 })
  await page.clock.pauseAt(NOW)
  try {
    await page.goto(WIDGET_URL)
    await page.evaluate(({ list, collapsed, side }) => {
      window.__cma.state({ bots: list, candidates: [], focused_bot_id: null, workspace: null })
      window.__cma.layout({ ...collapsed, side })
    }, { list: bots(4), collapsed: COLLAPSED, side })
    await page.clock.runFor(50)
    await fn(page, { layout, bounds, side })
  } finally {
    await context.close()
  }
})

const openCard = async (page, layout, threads = THREADS) => {
  await page.evaluate(({ layout, threads }) => {
    window.__cma.threads({ bot_id: 'bot-1', threads })
    window.__cma.layout(layout)
  }, { layout, threads })
}

// Web Animations run on the document timeline, not the fake clock: seek
// them (or run them to their end) by hand.
const seek = (page, ms) => page.evaluate((ms) => {
  for (const a of document.getAnimations()) if (a.effect.target.closest && a.effect.target.closest('#recents')) { a.pause(); a.currentTime = ms }
}, ms)
const settle = async (page) => {
  await page.clock.runFor(300) // past the arming frame's 250ms cap
  await page.evaluate(() => { for (const a of document.getAnimations()) if (a.effect.target.closest && a.effect.target.closest('#recents')) a.finish() })
  await page.clock.runFor(20)
}

const cardState = (page) => page.evaluate(() => {
  const card = document.querySelector('.recents-card')
  const cs = getComputedStyle(card)
  return { clip: cs.clipPath, transform: cs.transform, visibility: getComputedStyle(document.querySelector('#recents')).visibility, bridge: Number(getComputedStyle(document.querySelector('.recents-bridge')).opacity) }
})

pageTest('a click asks for the card from that seat (its centre, down the dock window); a double-click or Option-click opens the chat', async (page) => {
  const seat = page.locator('.dock-bot[data-bot-id="bot-1"]')
  const box = await seat.boundingBox()
  await seat.click()
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'recents' || c[0] === 'open')), [['recents', 'bot-1', Math.round(box.y + box.height / 2)]])
  await page.evaluate(() => { window.__cma.calls.length = 0 })
  await seat.dblclick()
  assert.deepEqual((await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'recents' || c[0] === 'open'))).map((c) => c[0]), ['recents', 'open'], 'the second click of the double-click opens the chat')
  await page.evaluate(() => { window.__cma.calls.length = 0 })
  await seat.click({ modifiers: ['Alt'] })
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'recents' || c[0] === 'open')), [['open', 'bot-1']])
})

pageTest('the card: 288 wide, 20px corners, 8px padding; a 44px header with the bot\'s name (14/600) and status (13, muted); 52px rows; 32px controls; the height main sized it for', async (page, { layout }) => {
  await openCard(page, layout)
  await page.clock.runFor(40)
  await settle(page)
  const m = await page.evaluate(() => {
    const card = document.querySelector('.recents-card')
    const cs = getComputedStyle(card)
    const name = document.querySelector('[data-role="recents-name"]')
    const status = document.querySelector('[data-role="recents-status"]')
    const rows = [...document.querySelectorAll('.recents-row')]
    const r0 = rows[0]
    const q = (sel) => getComputedStyle(r0.querySelector(sel))
    return {
      width: card.getBoundingClientRect().width,
      height: card.getBoundingClientRect().height,
      radius: cs.borderTopLeftRadius,
      padding: cs.paddingTop,
      head: document.querySelector('.recents-head').getBoundingClientRect().height,
      name: [name.textContent, getComputedStyle(name).fontSize, getComputedStyle(name).fontWeight],
      status: [status.textContent, getComputedStyle(status).fontSize],
      rows: rows.map((r) => r.getBoundingClientRect().height),
      title: [q('.recents-title').fontSize, q('.recents-title').fontWeight],
      preview: [q('.recents-preview').fontSize, q('.recents-preview').whiteSpace],
      time: [r0.querySelector('.recents-time').textContent, q('.recents-time').fontSize, q('.recents-time').fontVariantNumeric],
      dot: [q('.recents-dot').width, q('.recents-dot').opacity, getComputedStyle(rows[1].querySelector('.recents-dot')).opacity],
      buttons: [...document.querySelectorAll('.recents-btn')].map((b) => [b.textContent, b.getBoundingClientRect().height]),
      times: rows.map((r) => r.querySelector('.recents-time').textContent),
      role: [document.querySelector('#recents').getAttribute('role'), document.querySelector('.recents-list').getAttribute('role'), r0.getAttribute('role')],
      labelled: document.querySelector('#recents').getAttribute('aria-labelledby'),
    }
  })
  assert.equal(m.width, 288)
  assert.equal(m.height, W.recentsCardHeight(3))
  assert.equal(m.height, layout.cardHeight)
  assert.equal(m.radius, '20px')
  assert.equal(m.padding, '8px')
  assert.equal(m.head, 44)
  assert.deepEqual(m.name, ['Bot 1', '14px', '600'])
  assert.deepEqual(m.status, ['Working…', '13px'])
  assert.deepEqual(m.rows, [52, 52, 52])
  assert.deepEqual(m.title, ['14px', '600'], 'unread: the title is bolder')
  assert.deepEqual(m.preview, ['13px', 'nowrap'])
  assert.deepEqual(m.time, ['5m', '12px', 'tabular-nums'])
  assert.deepEqual(m.dot, ['8px', '1', '0'])
  assert.deepEqual(m.buttons, [['New chat', 32], ['Open in app', 32]])
  assert.deepEqual(m.times, ['5m', '3h', 'Yesterday'])
  assert.deepEqual(m.role, ['dialog', 'listbox', 'option'])
  assert.equal(m.labelled, 'recents-name')
})

pageTest('it buds out of the seat: held a frame while the window widens, then a seat circle on the seat grows into the card on SOFT, the bridge fades in, the rows enter 30ms apart from 10px toward the edge', async (page, { layout }) => {
  await openCard(page, layout)
  assert.equal((await cardState(page)).visibility, 'hidden', 'held back this frame')
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('#recents *')].filter((n) => getComputedStyle(n).visibility === 'visible' && getComputedStyle(n).opacity !== '0' && n.getBoundingClientRect().width > 0).length), 0, 'nothing inside shows through while held back')
  await page.clock.runFor(40)
  const start = await cardState(page)
  assert.equal(start.visibility, 'visible')
  const seat = layout.seatY - layout.cardTop
  // The first frame: a 40px circle at the card's dock-side edge, shifted
  // onto the seat (58px: 20 + the 10px gap + 8px padding + 20).
  const first = await page.evaluate(() => {
    const a = document.getAnimations().find((x) => x.effect.target === document.querySelector('.recents-card'))
    return { kf: a.effect.getKeyframes(), timing: a.effect.getComputedTiming() }
  })
  const k0 = first.kf[0]
  assert.equal(k0.transform, 'translateX(58px)')
  assert.equal(k0.clipPath, `inset(${seat - 20}px 0px ${layout.cardHeight - seat - 20}px 248px round 20px)`)
  assert.match(first.kf.at(-1).clipPath, /^inset\(0px( 0px 0px 0px)? round 20px\)$/)
  assert.equal(first.kf.at(-1).transform, 'none')
  assert.equal(first.timing.duration, Motion.sample('soft', { from: 0, to: 1 }).duration, 'the SOFT spring')
  // Overshoot: a SOFT spring passes its target, so the shift goes past 0.
  assert.ok(first.kf.some((k) => /translateX\(-/.test(k.transform)), 'a soft overshoot')
  const rows = await page.evaluate(() => [...document.querySelectorAll('.recents-row')].map((r) => {
    const a = r.getAnimations().find((x) => !(x instanceof CSSTransition))
    return { delay: a.effect.getTiming().delay, duration: a.effect.getTiming().duration, easing: a.effect.getTiming().easing, from: a.effect.getKeyframes()[0] }
  }))
  assert.deepEqual(rows.map((r) => r.delay), [60, 90, 120])
  assert.ok(rows.every((r) => r.duration === 280 && r.easing === 'cubic-bezier(0.22, 1, 0.36, 1)'))
  assert.deepEqual([Number(rows[0].from.opacity), rows[0].from.transform, rows[0].from.filter], [0, 'translateX(10px)', 'blur(2px)'])
  // Mid-bud the bridge is coming in; at rest the card is whole and the
  // animations are gone.
  await seek(page, 120)
  const mid = await cardState(page)
  assert.ok(mid.bridge > 0 && mid.bridge <= 1, `bridge fading in (${mid.bridge})`)
  await settle(page)
  const rest = await cardState(page)
  assert.equal(rest.clip, 'inset(0px round 20px)')
  assert.equal(rest.transform, 'none')
  assert.equal(rest.bridge, 1)
  assert.equal(await page.evaluate(() => document.getAnimations().filter((a) => a.effect.target.closest && a.effect.target.closest('#recents')).length), 0)
  // The first row has the focus (keyboard users land in the list).
  assert.equal(await page.evaluate(() => document.activeElement.dataset.threadId), 't1')
})

pageTest('the bridge: a plain SVG path level with the seat, spanning the gap to the dock, in the dock\'s fill', async (page, { layout }) => {
  await openCard(page, layout)
  await page.clock.runFor(40)
  await settle(page)
  const b = await page.evaluate(() => {
    const svg = document.querySelector('.recents-bridge')
    const r = svg.getBoundingClientRect()
    const card = document.querySelector('.recents-card').getBoundingClientRect()
    const dock = document.querySelector('.dock-body').getBoundingClientRect()
    return { d: svg.querySelector('path').getAttribute('d'), top: r.top, height: r.height, left: r.left, right: r.right, cardRight: card.right, dockLeft: dock.left, fill: getComputedStyle(svg.querySelector('path')).fill, dockFill: getComputedStyle(document.querySelector('.dock-fill')).fill, filter: getComputedStyle(svg).filter }
  })
  assert.equal(b.d, RC.bridgePath(10))
  assert.equal(b.top + b.height / 2, layout.seatY, 'level with the seat')
  assert.ok(b.left <= b.cardRight && b.right >= b.dockLeft, 'spans the gap, a pixel under each side')
  assert.equal(b.fill, b.dockFill)
  assert.equal(b.filter, 'none', 'no goo blur')
})

pageTest('closing: back into the seat on CLOSE in the still-wide window, then hidden', async (page, { layout }) => {
  await openCard(page, layout)
  await page.clock.runFor(40)
  await settle(page)
  await page.evaluate((l) => window.__cma.layout({ ...l, expanded: false, botId: null, mode: 'chat', closing: true, closingMode: 'recents', opening: undefined }), layout)
  const anim = await page.evaluate(() => {
    const a = document.getAnimations().find((x) => x.effect.target === document.querySelector('.recents-card'))
    return { duration: a.effect.getTiming().duration, last: a.effect.getKeyframes().at(-1) }
  })
  assert.equal(anim.duration, Motion.sample('close', { from: 1, to: 0 }).duration, 'the CLOSE spring')
  assert.equal(anim.last.transform, 'translateX(58px)', 'ends on the seat')
  assert.equal(await page.evaluate(() => document.querySelector('#recents').hidden), false)
  await settle(page)
  assert.equal(await page.evaluate(() => document.querySelector('#recents').hidden), true)
})

pageTest('reduced motion: a short fade (≤150ms), nothing moves or blurs', async (page, { layout }) => {
  await openCard(page, layout)
  await page.clock.runFor(40)
  const anims = await page.evaluate(() => document.getAnimations().filter((a) => a.effect.target.closest && a.effect.target.closest('#recents')).map((a) => ({ d: a.effect.getTiming().duration, keys: a.effect.getKeyframes().map((k) => Object.keys(k).filter((x) => !['offset', 'easing', 'composite', 'computedOffset'].includes(x))).flat() })))
  assert.ok(anims.length > 0)
  assert.ok(anims.every((a) => a.d <= 150), JSON.stringify(anims))
  assert.ok(anims.every((a) => a.keys.every((k) => k === 'opacity')), 'opacity only')
  await page.evaluate((l) => window.__cma.layout({ ...l, expanded: false, botId: null, mode: 'chat', closing: true, closingMode: 'recents', opening: undefined }), layout)
  await settle(page)
  assert.equal(await page.evaluate(() => document.querySelector('#recents').hidden), true)
}, { reducedMotion: 'reduce' })

pageTest('keyboard: arrows move between rows, Enter opens one; the controls open a new chat or the app; Esc asks main to close', async (page, { layout }) => {
  await openCard(page, layout)
  await page.clock.runFor(40)
  await settle(page)
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.threadId), 't2')
  assert.equal(await page.evaluate(() => document.querySelector('.recents-list').getAttribute('aria-activedescendant')), 'recents-row-1')
  await page.keyboard.press('End')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.threadId), 't3')
  await page.keyboard.press('ArrowDown')
  assert.equal(await page.evaluate(() => document.activeElement.dataset.threadId), 't3', 'stays on the last')
  await page.keyboard.press('Home')
  await page.keyboard.press('Enter')
  await page.click('[data-action="new-chat"]')
  await page.click('[data-action="recents-open-in-app"]')
  await page.keyboard.press('Escape')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => ['open', 'openInApp', 'collapse'].includes(c[0]))), [['open', 'bot-1'], ['open', 'bot-1'], ['openInApp', 'bot-1'], ['collapse']])
})

for (const side of ['right', 'left']) {
  pageTest(`on the ${side} edge, the card opens toward the screen interior, beside the dock`, async (page, { layout, bounds }) => {
    await openCard(page, layout)
    await settle(page)
    const r = await page.evaluate(() => {
      const card = document.querySelector('.recents-card').getBoundingClientRect()
      const dock = document.querySelector('.dock-body').getBoundingClientRect()
      return { card: [card.left, card.right], dock: [dock.left, dock.right] }
    })
    if (side === 'right') {
      assert.equal(r.dock[1], bounds.width, 'the dock on the right edge')
      assert.equal(r.card[1], r.dock[0] - 10, 'the card 10px inward of it')
      assert.equal(r.card[0], 24, 'with room for its shadow')
    } else {
      assert.equal(r.dock[0], 0)
      assert.equal(r.card[0], r.dock[1] + 10)
      assert.equal(r.card[1], bounds.width - 24)
    }
    const k0 = await page.evaluate(() => document.querySelector('.recents-card').getAnimations().length)
    assert.equal(k0, 0)
  }, { side })
}

pageTest('on the left edge the bud starts on the seat to the left', async (page, { layout }) => {
  await openCard(page, layout)
  await page.clock.runFor(40)
  const k0 = await page.evaluate(() => document.querySelector('.recents-card').getAnimations()[0].effect.getKeyframes()[0])
  assert.equal(k0.transform, 'translateX(-58px)')
  assert.match(k0.clipPath, /^inset\([\d.]+px 248px [\d.]+px 0px round 20px\)$/)
}, { side: 'left' })
