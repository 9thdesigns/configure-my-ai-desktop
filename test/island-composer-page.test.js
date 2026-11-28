// The island page's Manager composer, in Playwright on a paused fake clock
// (every frame is the test's to run): a click asks main to open it; open,
// the shell springs to 440 wide with 24px corners and 18px shoulders, and its
// rows come in 90ms later, 40ms apart, blur clearing; the composer is a 36px
// pill with 14px text, the mic at the trailing edge until there is text and
// then a 28px send; Enter sends; the reply comes in as if typed; Esc takes
// the content out over 280ms before asking main to close, then the shell
// closes. Reduced motion: opacity fades. Skipped where Playwright (or its
// Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const ISLAND_URL = pathToFileURL(path.join(__dirname, '../src/island.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [], sendResult: true })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaIsland = {
    ...Object.fromEntries(['ready', 'drag', 'hover', 'activate', 'compose', 'collapse', 'openInApp', 'openApp', 'move', 'reportHitRects', 'reportHeight'].map((n) => [n, call(n)])),
    onView: on('view'),
    onLayout: on('layout'),
    onAvatarCss: on('css'),
    onChatCss: on('chatCss'),
    onComposer: on('composer'),
    send: async (text) => { cma.calls.push(['send', text]); return cma.sendResult },
    answer: async () => false,
    decide: async () => false,
  }
}

const VIEW = { idle: true, mode: 'idle', bot: { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle' }, chip: { kind: 'idle', label: 'All quiet' }, badge: 0, detail: '', pending: null }
const PILL = { centre: 260, width: 212, height: 32, edge: 'top', wrap: false, notchWidth: 0, screenX: 900 }
const CLOSED = { expanded: false, focused: false, composing: false, draggable: true, dragging: false, snapped: false, pill: PILL }
const OPEN = { ...CLOSED, expanded: true, focused: true, composing: true }
const COMPOSER = { manager: { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle' }, lines: [{ id: '3', body: 'The launch plan is ready.' }, { id: '4', body: 'Ada needs a review.' }], sent: null, awaiting: false, reply: null, error: null }

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 520, height: 320 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  try {
    await page.goto(ISLAND_URL)
    await page.evaluate(({ view, layout }) => { window.__cma.view(view); window.__cma.layout(layout) }, { view: VIEW, layout: CLOSED })
    await page.clock.runFor(600)
    await fn(page)
  } finally {
    await context.close()
  }
})

const calls = (page, name) => page.evaluate((name) => window.__cma.calls.filter((c) => c[0] === name), name)
const box = (page, sel) => page.locator(sel).first().boundingBox()
const cs = (page, sel, prop) => page.locator(sel).first().evaluate((el, prop) => getComputedStyle(el)[prop], prop)
const open = async (page, composer = COMPOSER) => {
  await page.evaluate(({ layout, composer }) => { window.__cma.composer(composer); window.__cma.layout(layout) }, { layout: OPEN, composer })
}
const rowOpacity = (page) => page.evaluate(() => [...document.querySelector('[data-role="compose"]').children].filter((n) => n.getClientRects().length > 0).map((n) => Number(n.style.opacity === '' ? 1 : n.style.opacity)))

pageTest('a click on the bar asks main for the composer', async (page) => {
  await page.click('[data-role="bar"]')
  assert.deepEqual(await calls(page, 'compose'), [['compose']])
})

pageTest('open: 440 wide, 24px corners, 18px shoulders and the open shadow; rows 90ms later, 40ms apart', async (page) => {
  await open(page)
  // Before 90ms no row has started.
  await page.clock.runFor(80)
  assert.deepEqual(await rowOpacity(page), [0, 0, 0])
  // Row one at 90ms, row two at 130ms, row three at 170ms.
  await page.clock.runFor(30)
  let o = await rowOpacity(page)
  assert.ok(o[0] > 0 && o[1] === 0 && o[2] === 0, `only the first row has begun (${o})`)
  await page.clock.runFor(40)
  o = await rowOpacity(page)
  assert.ok(o[1] > 0 && o[2] === 0, `then the second (${o})`)
  const blurring = await page.locator('[data-role="compose"] > :first-child').evaluate((n) => n.style.filter)
  assert.match(blurring, /^blur\(/, 'blur clearing as it comes in')
  await page.clock.runFor(1500)
  assert.deepEqual(await rowOpacity(page), [1, 1, 1])
  const b = await box(page, '#island')
  assert.equal(Math.round(b.width), 440)
  assert.equal(await cs(page, '.island-clip', 'borderBottomLeftRadius'), '24px')
  assert.equal((await box(page, '.shoulder-start')).width, 18)
  assert.match(await cs(page, '#island', 'filter'), /drop-shadow\(rgba\(0, 0, 0, 0\.55\) 0px 0px 12px\)/)
  assert.equal(await page.evaluate(() => document.activeElement?.dataset.role), 'input', 'focus in the composer')
})

pageTest('the composer: a 36px pill, 14px text; the mic at the trailing edge, a 28px send once there is text', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  assert.equal(Math.round((await box(page, '.composer-pill')).height), 36)
  assert.equal(await cs(page, '[data-role="input"]', 'fontSize'), '14px')
  assert.equal(await page.locator('[data-role="mic"]').isVisible(), true)
  assert.equal(await page.locator('[data-role="send"]').isVisible(), false)
  const actions = await box(page, '[data-role="compose-actions"]')
  const pill = await box(page, '.composer-pill')
  assert.ok(actions.x - pill.x < 10, 'actions at the leading edge')
  assert.equal(await page.locator('[data-role="compose-actions"]').getAttribute('aria-haspopup'), 'menu')
  await page.fill('[data-role="input"]', 'Show me the plan')
  assert.equal(await page.locator('[data-role="mic"]').isVisible(), false)
  const send = await box(page, '[data-role="send"]')
  assert.deepEqual([send.width, send.height], [28, 28])
  assert.ok(pill.x + pill.width - (send.x + send.width) < 10, 'send at the trailing edge')
  assert.equal(await page.locator('.compose-line').count(), 2, "the Manager's last two lines")
})

pageTest('Enter sends; the dots while the reply comes; the reply comes in as if typed', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.fill('[data-role="input"]', 'Show me the plan')
  await page.press('[data-role="input"]', 'Enter')
  assert.deepEqual(await calls(page, 'send'), [['send', 'Show me the plan']])
  assert.equal(await page.inputValue('[data-role="input"]'), '', 'cleared once main took it')
  await page.evaluate((c) => window.__cma.composer({ ...c, sent: { body: 'Show me the plan' }, awaiting: true }), COMPOSER)
  assert.equal(await page.locator('.compose-typing').count(), 1)
  assert.equal(await page.locator('.compose-line.is-sent').textContent(), 'Show me the plan')
  const reply = 'Here is the plan: ship Tuesday, announce Wednesday, review Friday.'
  await page.evaluate(({ c, reply }) => window.__cma.composer({ ...c, sent: { body: 'Show me the plan' }, awaiting: false, reply: { id: 'r1', body: reply } }), { c: COMPOSER, reply })
  await page.clock.runFor(200)
  const part = await page.locator('.compose-line.is-reply').textContent()
  assert.ok(part.length > 0 && part.length < reply.length, `part of it so far (${part.length})`)
  assert.ok(reply.startsWith(part))
  await page.clock.runFor(2000)
  assert.equal(await page.locator('.compose-line.is-reply').textContent(), reply)
  // The same reply again does not start over.
  await page.evaluate(({ c, reply }) => window.__cma.composer({ ...c, sent: { body: 'Show me the plan' }, reply: { id: 'r1', body: reply } }), { c: COMPOSER, reply })
  assert.equal(await page.locator('.compose-line.is-reply').textContent(), reply)
})

pageTest('a send main refused keeps the text and says so', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.evaluate(() => { window.__cma.sendResult = false })
  await page.fill('[data-role="input"]', 'Hello')
  await page.press('[data-role="input"]', 'Enter')
  assert.equal(await page.inputValue('[data-role="input"]'), 'Hello')
  await page.evaluate((c) => window.__cma.composer({ ...c, error: 'send' }), COMPOSER)
  assert.match(await page.locator('.compose-line.is-error').textContent(), /Couldn’t send that/)
})

pageTest('Esc: the content out over 280ms, then main is asked to close; then the shell closes', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.keyboard.press('Escape')
  await page.clock.runFor(70)
  // Main re-sends the open layout meanwhile (a height report): Esc still wins.
  await page.evaluate((layout) => window.__cma.layout(layout), OPEN)
  await page.clock.runFor(70)
  const mid = await rowOpacity(page)
  assert.ok(mid.every((o) => o > 0.3 && o < 0.7), `half out (${mid})`)
  assert.deepEqual(await calls(page, 'collapse'), [], 'not yet')
  await page.clock.runFor(160)
  assert.deepEqual(await calls(page, 'collapse'), [['collapse']], 'after 280ms')
  await page.evaluate((layout) => window.__cma.layout(layout), CLOSED)
  await page.clock.runFor(100)
  const closing = await box(page, '#island')
  assert.ok(closing.width < 440 && closing.width > 212, `the shell closing (${closing.width})`)
  await page.clock.runFor(1500)
  assert.equal(Math.round((await box(page, '#island')).width), 212)
  assert.equal(await page.locator('[data-role="compose"]').isHidden(), true)
  assert.equal(Math.round((await box(page, '#island')).height), 32)
  assert.equal(await cs(page, '.island-clip', 'borderBottomLeftRadius'), '16px')
})

pageTest('closed from main (a click away): the content goes first, then the shell', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.evaluate((layout) => window.__cma.layout(layout), CLOSED)
  await page.clock.runFor(140)
  assert.equal(Math.round((await box(page, '#island')).width), 440, 'still open while the content leaves')
  await page.clock.runFor(1500)
  assert.equal(Math.round((await box(page, '#island')).width), 212)
})

pageTest('the mic and Open in app carry on in the app', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.click('[data-role="mic"]')
  await page.click('[data-role="compose-open"]')
  assert.deepEqual(await calls(page, 'openInApp'), [['openInApp', 'manager'], ['openInApp', 'manager']])
})

pageTest('the web chat tokens: the sheet\'s dark block restyles the composer', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.evaluate(() => window.__cma.chatCss({ css: ':root { --composer-bg: #ffffff; } :root[data-theme="dark"] { --composer-bg: rgb(1, 2, 3); }' }))
  assert.equal(await cs(page, '.composer-pill', 'backgroundColor'), 'rgb(1, 2, 3)', 'the dark block wins: the island is always dark')
})

pageTest('reduced motion: opening and closing are 150ms opacity fades', async (page) => {
  await open(page)
  assert.equal(Math.round((await box(page, '#island')).width), 440, 'no width spring')
  assert.equal(await page.locator('[data-role="compose"]').evaluate((n) => n.style.opacity), '0')
  await page.clock.runFor(80)
  const mid = Number(await page.locator('[data-role="compose"]').evaluate((n) => n.style.opacity))
  assert.ok(mid > 0.3 && mid < 0.7, `fading in (${mid})`)
  await page.clock.runFor(100)
  assert.equal(await page.locator('[data-role="compose"]').evaluate((n) => n.style.opacity), '')
  assert.deepEqual(await page.locator('[data-role="compose"] > :first-child').evaluate((n) => [n.style.filter, n.style.transform]), ['', ''])
  await page.keyboard.press('Escape')
  await page.clock.runFor(100)
  assert.deepEqual(await calls(page, 'collapse'), [], 'fading out')
  await page.clock.runFor(100)
  assert.deepEqual(await calls(page, 'collapse'), [['collapse']], 'after a 150ms fade (to the next frame)')
}, { reducedMotion: 'reduce' })

pageTest('closed and opened again before the content has gone: it comes back, visible', async (page) => {
  await open(page)
  await page.clock.runFor(1500)
  await page.evaluate((layout) => window.__cma.layout(layout), CLOSED)
  await page.clock.runFor(100)
  await open(page)
  await page.clock.runFor(2000)
  assert.deepEqual(await rowOpacity(page), [1, 1, 1])
  assert.equal(Math.round((await box(page, '#island')).width), 440)
})
