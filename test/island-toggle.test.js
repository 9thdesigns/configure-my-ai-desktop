// The island's on/off switch end to end, without Electron: the tray and app
// menu checkboxes → the pref → the island window shown or hidden, the reverse
// sync back into the menu, persistence across launches, the idle pill, and
// where the pill lands on a notched MacBook and on a secondary display.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const { trayMenuTemplate } = require('../src/tray')
const I = require('../src/island-window')

const idleManager = { ...fixture.manager, mood: 'idle', state: { ...fixture.manager.state, waiting: null, detail: '' } }
const quietState = widgetStateFrom({ ...fixture, manager: idleManager, seats: [] })
const busyState = widgetStateFrom(fixture)

// A MacBook Pro 14": the menu bar (with the notch in it) is 37pt tall.
const NOTCH = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
// A 1080p monitor to the left, a little higher, with a 48px taskbar at the top.
const LEFT = { id: 2, bounds: { x: -1920, y: -200, width: 1920, height: 1080 }, workArea: { x: -1920, y: -152, width: 1920, height: 1032 } }

function fakeElectron ({ displays = [NOTCH], primary = NOTCH } = {}) {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (options) {
      super()
      this.options = options
      this.visible = false
      this.destroyed = false
      this.bounds = null
      this.sent = []
      this.webContents = Object.assign(new EventEmitter(), {
        send: (channel, payload) => this.sent.push([channel, payload]),
        setWindowOpenHandler () {},
        getURL: () => I.HTML_URL,
      })
      windows.push(this)
    }

    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    loadFile () { setImmediate(() => this.emit('ready-to-show')) }
    isDestroyed () { return this.destroyed }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    hide () { this.visible = false }
    setBounds (b) { this.bounds = b }
    getBounds () { return { ...(this.bounds || { x: 0, y: 0, width: this.options.width, height: this.options.height }) } }
    setIgnoreMouseEvents () {}
    setFocusable () {}
    focus () {}
    destroy () { this.destroyed = true; this.emit('closed') }
  }
  const screen = Object.assign(new EventEmitter(), {
    displays,
    primary,
    getAllDisplays () { return this.displays },
    getPrimaryDisplay () { return this.primary },
    getCursorScreenPoint () { return { x: -1, y: -1 } },
  })
  const session = { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }
  return { BrowserWindow, screen, session, windows }
}

function fakeStore (initial) {
  let state = initial
  const listeners = new Set()
  return {
    get: () => state,
    set (next) { state = next; for (const fn of listeners) fn(state) },
    onChange (fn) { listeners.add(fn); return () => listeners.delete(fn) },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const tmpPrefsFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-island-')), 'prefs.json')

function setup ({ state = quietState, file, showIsland, electronOptions, mainBounds } = {}) {
  const electron = fakeElectron(electronOptions)
  const prefs = createPrefs({ file, platform: 'darwin' })
  if (showIsland !== undefined) prefs.set({ showIsland })
  const store = fakeStore(state)
  const main = mainBounds ? { isDestroyed: () => false, isMinimized: () => false, getBounds: () => mainBounds } : null
  const island = I.createIslandController({ store, prefs, feed: { isSignedIn: () => true }, getMainWindow: () => main, openBot () {}, platform: 'darwin', electron })
  island.sync()
  return { electron, prefs, store, island, win: () => electron.windows.at(-1) }
}

test('pref on with a quiet team: the island window is created and shown (the idle pill)', async () => {
  const { island, win } = setup()
  assert.ok(win(), 'a window exists even though no bot needs the user')
  await tick()
  assert.equal(island.isVisible(), true)
  const view = win().sent.filter(([c]) => c === 'cma-island:view').at(-1)?.[1]
  assert.ok(!view || view.idle === true, 'whatever was sent is the idle view')
  island.destroy()
})

test('the dock being off on the server no longer hides the island', async () => {
  const { island } = setup({ state: { ...quietState, enabled: false } })
  await tick()
  assert.equal(island.isVisible(), true)
  island.destroy()
})

test('tray checkbox → pref → window hidden, and back on → shown again', async () => {
  const { prefs, island } = setup()
  await tick()
  assert.equal(island.isVisible(), true)

  const actions = { setShowIsland: (on) => prefs.set({ showIsland: Boolean(on) }) }
  const item = (p) => trayMenuTemplate(busyState, { prefs: p, platform: 'darwin' }, actions).find((x) => x.id === 'show-island')

  // Electron flips the checkbox before calling click.
  item(prefs.get()).click({ checked: false })
  assert.equal(prefs.get().showIsland, false)
  assert.equal(island.isVisible(), false)

  item(prefs.get()).click({ checked: true })
  assert.equal(prefs.get().showIsland, true)
  assert.equal(island.isVisible(), true)
  island.destroy()
})

test('app menu checkbox → pref → window, and the reverse sync from the tray', async () => {
  const { prefs, island } = setup()
  await tick()
  const menuItem = I.islandMenuItem(prefs)
  assert.equal(menuItem.id, 'show-island')
  assert.equal(menuItem.type, 'checkbox')
  assert.equal(menuItem.checked, true)

  // A built menu, as far as syncIslandMenuItem needs.
  const built = { id: 'show-island', checked: true }
  const menu = { getMenuItemById: (id) => (id === built.id ? built : null) }
  const off = I.syncIslandMenuItem(menu, prefs)

  built.checked = false
  menuItem.click(built)
  assert.equal(prefs.get().showIsland, false)
  assert.equal(island.isVisible(), false)

  // The tray turns it back on: the menu's tick follows.
  prefs.set({ showIsland: true })
  assert.equal(built.checked, true)
  assert.equal(island.isVisible(), true)

  off()
  prefs.set({ showIsland: false })
  assert.equal(built.checked, true, 'unsubscribed')
  island.destroy()
})

test('off at launch: no window until the pref is turned on', async () => {
  const { prefs, island, win } = setup({ showIsland: false })
  assert.equal(win(), undefined)
  prefs.set({ showIsland: true })
  await tick()
  assert.equal(island.isVisible(), true)
  island.destroy()
})

test('the setting survives a restart', async () => {
  const file = tmpPrefsFile()
  const first = setup({ file })
  first.prefs.set({ showIsland: false })
  first.island.destroy()

  const second = setup({ file })
  assert.equal(second.prefs.get().showIsland, false)
  assert.equal(second.win(), undefined, 'still off after relaunch')
  second.prefs.set({ showIsland: true })
  second.island.destroy()

  assert.equal(createPrefs({ file, platform: 'darwin' }).get().showIsland, true)
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

test('a question arriving swaps the idle pill for the bot; it going away brings the idle pill back', async () => {
  const { store, island, win } = setup()
  await tick()
  store.set(busyState)
  const views = () => win().sent.filter(([c]) => c === 'cma-island:view').map(([, v]) => v)
  assert.equal(views().at(-1).idle, false)
  assert.equal(views().at(-1).chip.kind, 'question')
  store.set(quietState)
  assert.equal(views().at(-1).idle, true)
  assert.equal(island.isVisible(), true)
  island.destroy()
})

test('the idle pill renders the manager\'s mark and status; the page knows the idle chip', () => {
  const view = I.islandIdleView(quietState)
  assert.deepEqual(view.bot, { id: 'manager', name: fixture.manager.name, avatar_url: fixture.manager.avatar_url ?? null, avatar_color: fixture.manager.avatar_color ?? null, avatar_shape: fixture.manager.avatar_shape ?? null })
  assert.equal(view.chip.label, 'All quiet')
  const paused = widgetStateFrom({ ...fixture, manager: { ...idleManager, state: { ...idleManager.state, status: 'paused' } }, seats: [] })
  assert.equal(I.islandIdleView(paused).chip.label, 'Paused')

  const css = fs.readFileSync(path.join(__dirname, '../src/island.css'), 'utf8')
  assert.match(css, /\.island\[data-chip="idle"\] \.chip/)
  assert.match(css, /\.island\.is-idle/)
  const page = fs.readFileSync(path.join(__dirname, '../src/island-view.js'), 'utf8')
  assert.match(page, /classList\.toggle\('is-idle', next\.idle === true\)/)
  // A click on the bar opens the Manager composer, idle or not (PR 11).
  assert.match(page, /api\.compose\(\)/)
})

// Where the page is told the pill is, in screen x, and the edge it is on.
const lastPill = (win) => win.sent.filter(([c]) => c === 'cma-island:layout').at(-1)[1].pill

test('notched MacBook: at top centre the pill wraps the notch, at the very top', async () => {
  const { island, win } = setup()
  await tick()
  const pill = lastPill(win())
  assert.equal(pill.screenX, 756, 'centred on the notch')
  assert.equal(pill.wrap, true)
  assert.equal(pill.height, 37, 'as tall as the notch (the menu bar)')
  assert.equal(win().bounds.y, 0)
  island.destroy()
})

test('secondary display: the pill follows the main window there, flush under its top taskbar', async () => {
  const d = I.islandDisplay({ displays: [NOTCH, LEFT], primary: NOTCH, mainBounds: { x: -1500, y: 0, width: 1200, height: 800 } })
  assert.equal(d.id, 2)
  const { island, win } = setup({ electronOptions: { displays: [NOTCH, LEFT], primary: NOTCH }, mainBounds: { x: -1500, y: 0, width: 1200, height: 800 } })
  await tick()
  const pill = lastPill(win())
  assert.equal(pill.screenX, -1920 + 960)
  assert.equal(pill.wrap, false, 'no notch on a monitor')
  assert.equal(win().bounds.y, -152, 'under the top taskbar')
  island.destroy()
})

test('display removed, main window gone or off every display: back to the primary', () => {
  assert.equal(I.islandDisplay({ displays: [NOTCH], primary: NOTCH, mainBounds: { x: -1500, y: 0, width: 1200, height: 800 } }).id, 1)
  assert.equal(I.islandDisplay({ displays: [NOTCH, LEFT], primary: NOTCH, mainBounds: null }).id, 1)
  assert.equal(I.islandDisplay({ displays: [LEFT], primary: undefined }).id, 2)
})

test('a narrow or portrait work area keeps the pill on screen', async () => {
  const narrow = { id: 5, bounds: { x: 100, y: 0, width: 560, height: 800 }, workArea: { x: 100, y: 0, width: 560, height: 800 } }
  const { island, win } = setup({ electronOptions: { displays: [narrow], primary: narrow } })
  await tick()
  const b = win().bounds
  assert.ok(b.x >= 100 && b.x + b.width <= 660, `window on the display (${b.x}, ${b.width})`)
  const pill = lastPill(win())
  assert.ok(pill.screenX - pill.width / 2 >= 100 && pill.screenX + pill.width / 2 <= 660)
  island.destroy()
})

test('display changes re-place the window on the display the main window is now on', async () => {
  const { electron, island, win } = setup({ electronOptions: { displays: [NOTCH, LEFT], primary: NOTCH }, mainBounds: { x: -1500, y: 0, width: 1200, height: 800 } })
  await tick()
  assert.equal(lastPill(win()).screenX, -960, 'on the left monitor with the app')
  // Unplug the left monitor.
  electron.screen.displays = [NOTCH]
  electron.screen.emit('display-removed')
  assert.equal(lastPill(win()).screenX, 756, 'back on the MacBook')
  // Resolution change on the MacBook (More Space): a bigger display.
  electron.screen.displays = [{ ...NOTCH, bounds: { x: 0, y: 0, width: 1800, height: 1169 }, workArea: { x: 0, y: 37, width: 1800, height: 1132 } }]
  electron.screen.primary = electron.screen.displays[0]
  electron.screen.emit('display-metrics-changed')
  assert.equal(lastPill(win()).screenX, 900)
  island.destroy()
})
