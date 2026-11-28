// The accessibility, reduced-motion / reduced-transparency and ambient-pause
// pass over the dock and the island: the ambient state from main
// (src/ambient.js: the screen locked, asleep, reduced transparency), how
// the pages apply it (src/ambient-view.js), every stylesheet that animates
// honouring reduced motion, the solid fallbacks, the names a screen reader
// hears, and the question reachable from the composer by keyboard.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { pathToFileURL } = require('node:url')
const { createAmbient, validAmbient } = require('../src/ambient')
const AV = require('../src/ambient-view')

const src = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')

test('ambient: paused while the screen is locked or the Mac asleep; reduced transparency and motion read from the system', () => {
  const pm = new EventEmitter()
  const theme = Object.assign(new EventEmitter(), { prefersReducedTransparency: false })
  let reduced = false
  const seen = []
  const a = createAmbient({ powerMonitor: pm, nativeTheme: theme, systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: reduced }) }, onChange: (s) => seen.push(s) })
  assert.deepEqual(a.state(), { paused: false, transparency: 'normal', motion: 'normal' })
  pm.emit('lock-screen')
  pm.emit('suspend')
  pm.emit('unlock-screen')
  assert.equal(a.state().paused, true, 'still asleep')
  pm.emit('resume')
  assert.equal(a.state().paused, false)
  theme.prefersReducedTransparency = true
  theme.emit('updated')
  reduced = true
  theme.emit('updated')
  assert.deepEqual(seen.map((s) => [s.paused, s.transparency, s.motion]), [[true, 'normal', 'normal'], [false, 'normal', 'normal'], [false, 'reduce', 'normal'], [false, 'reduce', 'reduce']], 'told on changes only')
  a.destroy()
  pm.emit('lock-screen')
  assert.equal(seen.length, 4, 'listeners removed')
  assert.deepEqual(createAmbient().state(), { paused: false, transparency: 'normal', motion: 'normal' }, 'no Electron: calm defaults')
  assert.deepEqual(validAmbient({ paused: 1, transparency: 'reduce', motion: 'x', evil: true }), { paused: false, transparency: 'reduce', motion: 'normal' })
  assert.equal(validAmbient('nope'), null)
})

test('the page\'s attributes: paused when main says so or the window is hidden; reduce from main or the media query', () => {
  assert.deepEqual(AV.attributes({}), { ambient: null, transparency: null })
  assert.deepEqual(AV.attributes({ hidden: true }), { ambient: 'paused', transparency: null })
  assert.deepEqual(AV.attributes({ main: { paused: true } }), { ambient: 'paused', transparency: null })
  assert.deepEqual(AV.attributes({ main: { transparency: 'reduce' } }), { ambient: null, transparency: 'reduce' })
  assert.deepEqual(AV.attributes({ mediaTransparency: true }), { ambient: null, transparency: 'reduce' })
})

test('every stylesheet that animates honours reduced motion; the dock and island pause and go solid', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '../src')).filter((x) => x.endsWith('.css'))) {
    const css = src(f)
    if (/animation:|transition:/.test(css)) assert.match(css, /prefers-reduced-motion: reduce/, `${f} animates without a reduced-motion rule`)
  }
  for (const f of ['widget.css', 'island.css']) {
    const css = src(f)
    assert.match(css, /:root\[data-ambient="paused"\] \*,[\s\S]*animation-play-state: paused !important/, `${f}: ambient pause`)
    assert.match(css, /:root\[data-transparency="reduce"\]/, `${f}: solid fallbacks`)
  }
  for (const [html, view] of [['widget.html', 'widget-view.js'], ['island.html', 'island-view.js']]) {
    const page = src(html)
    assert.ok(page.indexOf('<script src="ambient-view.js">') > 0 && page.indexOf('<script src="ambient-view.js">') < page.indexOf(`<script src="${view}">`), `${html} loads ambient-view.js before ${view}`)
    assert.match(src(view), /window\.Ambient\.attach\(document, api\.onAmbient\)/)
  }
})

// --- Controllers ---------------------------------------------------------------------

const I = require('../src/island-window')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }

function fakeElectron () {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (o) {
      super()
      this.bounds = { x: 0, y: 0, width: o.width, height: o.height }
      this.visible = false
      this.sent = []
      this.webContents = Object.assign(new EventEmitter(), { send: (c, p) => this.sent.push([c, p]), setWindowOpenHandler () {}, getURL: () => I.HTML_URL })
      windows.push(this)
    }

    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    loadFile () { setImmediate(() => this.emit('ready-to-show')) }
    isDestroyed () { return false }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    hide () { this.visible = false }
    setBounds (b) { this.bounds = b }
    getBounds () { return { ...this.bounds } }
    setIgnoreMouseEvents () {}
    setFocusable () {}
    focus () {}
    blur () {}
    destroy () { this.emit('closed') }
  }
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getCursorScreenPoint: () => ({ x: -1, y: -1 }) })
  const session = { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }
  return { BrowserWindow, screen, session, windows }
}

test('the island is told the ambient state, again after a reload; "Answer" from the composer opens the card focused', async () => {
  const OPS = fixture.seats.find((s) => s.name === 'Ops').bot_id
  const electron = fakeElectron()
  const store = { get: () => widgetStateFrom({ ...fixture, focused_bot_id: OPS }), onChange: () => () => {} }
  const island = I.createIslandController({ store, prefs: createPrefs({ platform: 'darwin' }), feed: { isSignedIn: () => true }, getMainWindow: () => null, openBot () {}, platform: 'darwin', electron })
  const handlers = {}
  island.registerIpc({ on: (c, f) => { handlers[c] = f }, handle: (c, f) => { handlers[c] = f } })
  island.sync()
  await new Promise((resolve) => setImmediate(resolve))
  const win = electron.windows.at(-1)
  const ev = { sender: win.webContents, senderFrame: { url: I.HTML_URL } }
  const last = (ch) => win.sent.filter(([c]) => c === ch).at(-1)?.[1]
  island.setAmbient({ paused: true, transparency: 'reduce', motion: 'normal', evil: 1 })
  assert.deepEqual(last('cma-island:ambient'), { paused: true, transparency: 'reduce', motion: 'normal' })
  win.sent.length = 0
  handlers['cma-island:ready'](ev)
  assert.deepEqual(last('cma-island:ambient'), { paused: true, transparency: 'reduce', motion: 'normal' }, 'a reloaded page is told again')
  handlers['cma-island:compose'](ev)
  const waiting = last('cma-island:composer').waiting
  assert.equal(waiting.kind, 'question')
  assert.equal(waiting.bot, 'Ops')
  handlers['cma-island:activate'](ev)
  assert.deepEqual([last('cma-island:layout').expanded, last('cma-island:layout').composing, last('cma-island:layout').focused], [true, false, true], 'the card, focused')
  island.destroy()
})

// --- Pages ---------------------------------------------------------------------------

let pw = null
try { pw = require('playwright') } catch {}
let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const ISLAND_URL = pathToFileURL(path.join(__dirname, '../src/island.html')).href
function islandBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaIsland = {
    ...Object.fromEntries(['ready', 'drag', 'hover', 'activate', 'compose', 'collapse', 'openInApp', 'openApp', 'move', 'reportHitRects', 'reportHeight', 'stopRecording', 'attachment', 'haptic'].map((n) => [n, call(n)])),
    onView: on('view'), onLayout: on('layout'), onAvatarCss: on('css'), onChatCss: on('chatCss'), onComposer: on('composer'), onAmbient: on('ambient'),
    send: async () => true, action: async () => true, answer: async () => false, decide: async () => false,
  }
}

const pageTest = (name, fn) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 520, height: 400 } })
  const page = await context.newPage()
  await page.addInitScript(islandBridge)
  await page.clock.install({ time: 0 })
  await page.clock.pauseAt(1000)
  try {
    await page.goto(ISLAND_URL)
    await fn(page)
  } finally {
    await context.close()
  }
})

const BOT = { id: 'ops', name: 'Ops', avatar_color: '#30a46c', avatar_shape: 'circle' }
const PILL = { centre: 260, width: 212, height: 32, edge: 'top', wrap: false, notchWidth: 0, screenX: 900 }
const CLOSED = { expanded: false, focused: false, composing: false, draggable: true, pill: PILL }

pageTest('island: locked or asleep, the recording dot holds still; reduced transparency makes its tint solid', async (page) => {
  await page.evaluate(({ bot, layout }) => {
    window.__cma.view({ idle: false, mode: 'recording', bot, chip: { kind: 'recording', label: 'Recording' }, badge: 0, detail: '', pending: null, recording: { kind: 'screen', elapsedMs: 0 } })
    window.__cma.layout(layout)
  }, { bot: BOT, layout: CLOSED })
  const play = () => page.locator('[data-role="chip"]').evaluate((n) => n.getAnimations({ subtree: true, pseudoElements: true }).map((a) => a.playState).join(',') || getComputedStyle(n, '::before').animationPlayState)
  assert.match(await play(), /running/)
  await page.evaluate(() => window.__cma.ambient({ paused: true, transparency: 'normal', motion: 'normal' }))
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ambient), 'paused')
  assert.equal(await page.locator('[data-role="chip"]').evaluate((n) => getComputedStyle(n, '::before').animationPlayState), 'paused')
  await page.evaluate(() => window.__cma.ambient({ paused: false, transparency: 'reduce', motion: 'normal' }))
  assert.equal(await page.evaluate(() => document.documentElement.dataset.ambient), undefined, 'unlocked: running again')
  assert.equal(await page.locator('[data-role="chip"]').evaluate((n) => getComputedStyle(n).backgroundColor), 'rgb(50, 16, 15)', 'solid, not a see-through tint')
})

pageTest('island: its name says the state and the badge; the composer offers the waiting question by keyboard', async (page) => {
  await page.evaluate(({ bot, layout }) => {
    window.__cma.view({ idle: false, mode: 'question', bot, chip: { kind: 'question', label: 'Questions' }, badge: 2, detail: '', pending: null })
    window.__cma.layout(layout)
  }, { bot: BOT, layout: CLOSED })
  assert.equal(await page.locator('[data-role="bar"]').getAttribute('aria-label'), 'Ops: Questions, 2 need you')
  assert.equal(await page.locator('[data-role="badge"]').getAttribute('aria-hidden'), 'true')
  await page.evaluate(({ layout }) => {
    window.__cma.composer({ manager: { id: 'manager', name: 'Max' }, lines: [], sent: null, awaiting: false, reply: null, error: null, attachments: {}, waiting: { bot: 'Ops', kind: 'question', prompt: 'Which region?' } })
    window.__cma.layout({ ...layout, expanded: true, focused: true, composing: true })
  }, { layout: CLOSED })
  await page.clock.runFor(1500)
  const row = page.locator('[data-role="waiting"]')
  assert.match(await row.innerText(), /Ops asks: Which region\?/)
  await page.focus('[data-role="waiting"] button')
  await page.keyboard.press('Enter')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'activate')), [['activate']])
})

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href
function widgetBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'recents', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp', 'haptic'].map((n) => [n, call(n)])),
    onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), onAmbient: on('ambient'),
    reportHitRects () {}, sendMessage: async () => null, answer: async () => null, decide: async () => null,
  }
}

test('dock: a seat says its state and its count; locked, the rim\'s pulse holds still; the grip is hidden from screen readers', { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 520, height: 560 } })
  const page = await context.newPage()
  await page.addInitScript(widgetBridge)
  try {
    await page.goto(WIDGET_URL)
    await page.evaluate(() => {
      const bots = [
        { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle', mood: 'working', waiting: null, needs_count: 0, label: 'Working…', paused: false, isManager: true },
        { id: 'bot-1', name: 'Ops', avatar_color: '#30a46c', avatar_shape: 'circle', mood: 'waiting', waiting: 'question', needs_count: 2, label: 'Questions', paused: false, isManager: false },
      ]
      window.__cma.state({ bots, candidates: [], focused_bot_id: null, dock_full: false, max_pinned: 12, workspace: null })
      window.__cma.layout({ expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true })
    })
    const labels = await page.locator('.dock-bot').evaluateAll((ns) => ns.map((n) => n.getAttribute('aria-label')))
    assert.deepEqual(labels, ['Max, Working…', 'Ops, Questions, 2 need you'])
    assert.equal(await page.locator('.dock-grip').getAttribute('aria-hidden'), 'true')
    const rimState = () => page.locator('.dock-rim').evaluate((n) => getComputedStyle(n).animationPlayState)
    const rimAnimated = await page.locator('.dock-rim').evaluate((n) => getComputedStyle(n).animationName)
    if (rimAnimated !== 'none') assert.equal(await rimState(), 'running')
    await page.evaluate(() => window.__cma.ambient({ paused: true, transparency: 'reduce', motion: 'normal' }))
    assert.equal(await page.evaluate(() => document.documentElement.dataset.ambient), 'paused')
    assert.equal(await page.evaluate(() => document.documentElement.dataset.transparency), 'reduce')
    assert.equal(await rimState(), 'paused')
    // Focus rings: 2px, 2px out, from the keyboard.
    await page.keyboard.press('Tab')
    const ring = await page.evaluate(() => { const n = document.activeElement; const s = getComputedStyle(n); return [n.className, s.outlineWidth, s.outlineOffset] })
    if (/dock-bot|dock-add/.test(ring[0])) assert.deepEqual(ring.slice(1), ['2px', '2px'])
  } finally {
    await context.close()
  }
})
