// The island page's actions menu, chips and recording pill, in Playwright on
// a paused fake clock: the "+" opens a role=menu that grows out of it (160ms,
// 0.96 → 1, fading in, from its corner); 32px rows, radius 12, 6px padding,
// 16px icons, the row's key on the right; arrows, → into Screenshot's
// submenu, ← and Esc back, Enter and the letters pick, a click away closes;
// the chips' buttons; the recording pill's timer and its click; reduced
// motion. Skipped where Playwright (or its Chromium) is not installed.

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
    ...Object.fromEntries(['ready', 'drag', 'hover', 'activate', 'compose', 'collapse', 'openInApp', 'openApp', 'move', 'reportHitRects', 'reportHeight', 'stopRecording', 'attachment'].map((n) => [n, call(n)])),
    onView: on('view'),
    onLayout: on('layout'),
    onAvatarCss: on('css'),
    onChatCss: on('chatCss'),
    onComposer: on('composer'),
    send: async (text) => { cma.calls.push(['send', text]); return true },
    action: async (id) => { cma.calls.push(['action', id]); return true },
    answer: async () => false,
    decide: async () => false,
  }
}

const BOT = { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle' }
const VIEW = { idle: true, mode: 'idle', bot: BOT, chip: { kind: 'idle', label: 'All quiet' }, badge: 0, detail: '', pending: null }
const PILL = { centre: 260, width: 212, height: 32, edge: 'top', wrap: false, notchWidth: 0, screenX: 900 }
const CLOSED = { expanded: false, focused: false, composing: false, draggable: true, dragging: false, snapped: false, pill: PILL }
const OPEN = { ...CLOSED, expanded: true, focused: true, composing: true }
const NONE = { screenshot: null, file: null, saved: null, notice: null }
const COMPOSER = { manager: BOT, lines: [{ id: '1', body: 'Morning.' }], sent: null, awaiting: false, reply: null, error: null, attachments: NONE, screenshots: true, revealLabel: 'Show in Finder' }

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference', open = true } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 520, height: 520 }, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  try {
    await page.goto(ISLAND_URL)
    await page.evaluate(({ view, layout }) => { window.__cma.view(view); window.__cma.layout(layout) }, { view: VIEW, layout: CLOSED })
    await page.clock.runFor(600)
    if (open) {
      await page.evaluate(({ layout, composer }) => { window.__cma.composer(composer); window.__cma.layout(layout) }, { layout: OPEN, composer: COMPOSER })
      await page.clock.runFor(1500)
    }
    await fn(page)
  } finally {
    await context.close()
  }
})

const calls = (page, name) => page.evaluate((name) => window.__cma.calls.filter((c) => c[0] === name), name)
const box = (page, sel) => page.locator(sel).first().boundingBox()
const cs = (page, sel, prop) => page.locator(sel).first().evaluate((el, prop) => getComputedStyle(el)[prop], prop)
const focused = (page) => page.evaluate(() => document.activeElement?.dataset.action || document.activeElement?.dataset.role || null)

pageTest('the "+" opens a menu that grows out of it: 160ms, 0.96 → 1 and fading in, from its corner', async (page) => {
  await page.click('[data-role="compose-actions"]')
  const menu = page.locator('#island-menu')
  assert.equal(await menu.getAttribute('role'), 'menu')
  assert.equal(await page.locator('[data-role="compose-actions"]').getAttribute('aria-expanded'), 'true')
  assert.equal(await menu.evaluate((n) => n.style.transformOrigin), 'left top')
  assert.equal(await menu.evaluate((n) => n.style.transform), 'scale(0.96)')
  await page.clock.runFor(80)
  const mid = await menu.evaluate((n) => [Number(n.style.opacity), n.style.transform])
  assert.ok(mid[0] > 0.3 && mid[0] < 1, `fading in (${mid[0]})`)
  assert.match(mid[1], /^scale\(0\.9[6-9]\d*\)$/)
  await page.clock.runFor(100)
  assert.deepEqual(await menu.evaluate((n) => [n.style.opacity, n.style.transform]), ['', ''], 'done by 160ms')
  // Below the "+", from its left edge.
  const plus = await box(page, '[data-role="compose-actions"]')
  const m = await box(page, '#island-menu')
  assert.ok(Math.abs(m.x - plus.x) < 2 && m.y >= plus.y + plus.height)
})

pageTest('the menu\'s look: radius 12, 6px padding, 32px rows, 16px icons, the row\'s key on the right', async (page) => {
  await page.click('[data-role="compose-actions"]')
  await page.clock.runFor(200)
  assert.equal(await cs(page, '#island-menu', 'borderTopLeftRadius'), '12px')
  assert.equal(await cs(page, '#island-menu', 'paddingTop'), '6px')
  const rows = page.locator('#island-menu .menu-item')
  assert.deepEqual(await rows.evaluateAll((ns) => ns.map((n) => n.textContent)), ['ScreenshotS›'.replace('S›', '›'), 'Record screenR', 'Share what’s on screen with ManagerH', 'Attach fileF', 'Voice noteV', 'Open Manager in appO'])
  assert.equal(Math.round((await box(page, '#island-menu .menu-item')).height), 32)
  const icon = await box(page, '#island-menu .menu-icon')
  assert.deepEqual([icon.width, icon.height], [16, 16])
  assert.equal(await rows.first().getAttribute('role'), 'menuitem')
  assert.equal(await rows.first().getAttribute('aria-haspopup'), 'menu')
})

pageTest('keys: arrows move, → opens Screenshot, Enter picks; ← and Esc go back; a letter picks', async (page) => {
  await page.focus('[data-role="compose-actions"]')
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(page), 'screenshot')
  await page.keyboard.press('ArrowDown')
  assert.equal(await focused(page), 'record')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('ArrowRight')
  assert.equal(await focused(page), 'screenshot-display')
  assert.equal(await page.locator('#island-menu .menu-item').first().getAttribute('aria-expanded'), 'true')
  await page.keyboard.press('ArrowLeft')
  assert.equal(await focused(page), 'screenshot', 'back to the parent row')
  assert.equal(await page.locator('.menu.is-sub').count(), 0)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  assert.deepEqual(await calls(page, 'action'), [['action', 'screenshot-window']])
  assert.equal(await page.locator('#island-menu').isHidden(), true)
  // Letters.
  await page.focus('[data-role="compose-actions"]')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('v')
  assert.deepEqual((await calls(page, 'action')).at(-1), ['action', 'voice'])
  // Esc closes and gives the "+" its focus back (and does not close the island).
  await page.focus('[data-role="compose-actions"]')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Escape')
  assert.equal(await page.locator('#island-menu').isHidden(), true)
  assert.equal(await focused(page), 'compose-actions')
  assert.deepEqual(await calls(page, 'collapse'), [])
})

pageTest('a click picks; a click away closes; the open menu is part of the hit area', async (page) => {
  await page.click('[data-role="compose-actions"]')
  await page.clock.runFor(200)
  const rects = (await calls(page, 'reportHitRects')).at(-1)[1]
  assert.equal(rects.length, 2, 'the island and its menu')
  await page.click('#island-menu [data-action="screenshot"]')
  await page.clock.runFor(200)
  await page.click('.menu.is-sub [data-action="screenshot-area"]')
  assert.deepEqual(await calls(page, 'action'), [['action', 'screenshot-area']])
  await page.click('[data-role="compose-actions"]')
  await page.mouse.click(500, 500)
  assert.equal(await page.locator('#island-menu').isHidden(), true)
})

pageTest('the chips: the screenshot (with its preview), the file, a saved recording, a notice — and their buttons', async (page) => {
  const attachments = {
    screenshot: { preview: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', width: 1920, height: 1080, source: 'display' },
    file: { name: 'plan.pdf', shown: '~/Documents/plan.pdf', readable: true },
    saved: { kind: 'screen', name: 'Screen recording.webm', durationMs: 42_000 },
    notice: { message: 'Turn on “Let Manager see your screen” to share your screen.', settings: false, turnOn: true },
  }
  await page.evaluate((c) => window.__cma.composer(c), { ...COMPOSER, attachments })
  const text = await page.locator('[data-role="attach"]').innerText()
  assert.match(text, /Screenshot/)
  assert.match(text, /plan\.pdf/)
  assert.match(text, /Screen recording saved · 00:42/)
  assert.match(text, /Kept on this computer/)
  assert.match(text, /The Manager asks before opening it/)
  assert.equal(await page.locator('[data-role="attach"] img').count(), 1)
  await page.click('.notice .btn')
  await page.locator('[data-role="attach"] .btn-link').first().click()
  await page.locator('[data-role="attach"] .chip-x').first().click()
  assert.deepEqual(await calls(page, 'attachment'), [['attachment', 'turn-on', 'notice'], ['attachment', 'reveal', 'file'], ['attachment', 'remove', 'screenshot']])
  // A screenshot alone can be sent: the send button shows with no text.
  assert.equal(await page.locator('[data-role="send"]').isVisible(), true)
  for (const b of await page.locator('[data-role="attach"] button').all()) assert.ok((await b.boundingBox()).height >= 28, 'hit targets ≥ 28px')
})

pageTest('recording: the pill shows the label and a running timer; its click stops instead of opening', async (page) => {
  await page.evaluate((v) => window.__cma.view({ ...v, mode: 'recording', idle: false, chip: { kind: 'recording', label: 'Recording' }, recording: { kind: 'screen', elapsedMs: 65_000 } }), VIEW)
  assert.equal(await page.locator('[data-role="chip"] .chip-timer').textContent(), '01:05')
  await page.clock.runFor(2000)
  assert.equal(await page.locator('[data-role="chip"] .chip-timer').textContent(), '01:07', 'counting on the clock')
  const dot = await page.locator('[data-role="chip"]').evaluate((n) => { const s = getComputedStyle(n, '::before'); return [s.width, s.animationDuration, s.animationDirection] })
  assert.deepEqual(dot, ['8px', '0.6s', 'alternate'], 'the 8px red dot, once every 1.2s')
  await page.click('[data-role="bar"]')
  assert.deepEqual(await calls(page, 'stopRecording'), [['stopRecording']])
  assert.deepEqual(await calls(page, 'compose'), [])
}, { open: false })

pageTest('recording round the notch: the dot in the left ear, the timer in the right', async (page) => {
  await page.evaluate(({ layout }) => window.__cma.layout({ ...layout, pill: { ...layout.pill, wrap: true, width: 268, notchWidth: 185 } }), { layout: CLOSED })
  await page.evaluate((v) => window.__cma.view({ ...v, mode: 'recording', idle: false, chip: { kind: 'recording', label: 'Recording' }, recording: { kind: 'screen', elapsedMs: 3000 } }), VIEW)
  await page.clock.runFor(600)
  const island = await box(page, '#island')
  const notchLeft = island.x + (island.width - 185) / 2
  const dot = await box(page, '.rec-dot')
  const timer = await box(page, '.chip-timer')
  assert.ok(dot.x + dot.width <= notchLeft, 'dot left of the notch')
  assert.ok(timer.x >= notchLeft + 185, 'timer right of it')
  assert.equal(await page.locator('.avatar-wrap').isHidden(), true)
}, { open: false })

pageTest('reduced motion: the menu just fades in', async (page) => {
  await page.click('[data-role="compose-actions"]')
  assert.equal(await page.locator('#island-menu').evaluate((n) => n.style.transform), '')
  await page.clock.runFor(200)
  assert.equal(await page.locator('#island-menu').evaluate((n) => n.style.opacity), '')
}, { reducedMotion: 'reduce' })
