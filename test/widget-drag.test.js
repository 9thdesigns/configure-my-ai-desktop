// The dock and island controllers driven end to end against a fake Electron:
// a drag over IPC moves the window, the drop snaps and is remembered per
// display, a restart puts it back, display changes keep it on screen, and
// only the right page in the right window can drag at all.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const W = require('../src/widget-window')
const I = require('../src/island-window')

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
const external = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }

function fakeElectron (displays) {
  const screenListeners = {}
  const windows = []
  class BrowserWindow {
    constructor (opts) {
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }
      this.listeners = {}
      this.destroyed = false
      this.visible = false
      this.ignoreMoves = false // a compositor that ignores client positioning
      this.sent = []
      const self = this
      this.webContents = {
        send: (channel, payload) => self.sent.push([channel, payload]),
        on () {},
        setWindowOpenHandler () {},
        getURL: () => self.url,
      }
      windows.push(this)
    }

    on (e, f) { (this.listeners[e] ||= []).push(f) }
    once (e, f) { this.on(e, f) }
    emit (e) { for (const f of this.listeners[e] || []) f() }
    loadFile (file) { this.url = require('node:url').pathToFileURL(file).href; setImmediate(() => this.emit('ready-to-show')) }
    setBounds (b) { if (!this.ignoreMoves) this.bounds = { ...this.bounds, ...b } }
    getBounds () { return { ...this.bounds } }
    isDestroyed () { return this.destroyed }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    hide () { this.visible = false }
    destroy () { this.destroyed = true; this.emit('closed') }
    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    setIgnoreMouseEvents () {}
    setFocusable () {}
    focus () {}
  }
  const screen = {
    displays,
    getAllDisplays: () => screen.displays,
    getPrimaryDisplay: () => screen.displays[0],
    getDisplayMatching: () => screen.displays[0],
    getCursorScreenPoint: () => ({ x: -1, y: -1 }),
    on (e, f) { (screenListeners[e] ||= []).push(f) },
    removeListener () {},
    emit (e) { for (const f of screenListeners[e] || []) f() },
  }
  const session = { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }
  return { BrowserWindow, screen, session, windows }
}

function fakeIpc () {
  const handlers = {}
  return {
    handlers,
    on: (ch, fn) => { handlers[ch] = fn },
    handle: (ch, fn) => { handlers[ch] = fn },
    // An event from a window's page (the right one unless told otherwise).
    emit (ch, win, payload, { url = win.url, sender = win.webContents } = {}) {
      return handlers[ch]({ sender, senderFrame: { url } }, payload)
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const state = widgetStateFrom(fixture)
const store = { get: () => state, onChange: () => () => {} }
const feed = { isSignedIn: () => true, conversation: async () => null, setFocus: async () => {} }

function tempPrefs () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-drag-'))
  return { dir, file: path.join(dir, 'prefs.json') }
}

async function startWidget ({ file, electron, env = {} }) {
  const prefs = createPrefs({ file, platform: 'darwin' })
  const ipc = fakeIpc()
  const widget = W.createWidgetController({ store, prefs, feed, getMainWindow: () => null, openBot () {}, electron, platform: 'darwin', env })
  widget.registerIpc(ipc)
  widget.sync()
  await tick()
  const win = electron.windows.at(-1)
  ipc.emit('cma-widget:hit-rects', win, { rects: [], dockHeight: 300 })
  return { widget, prefs, ipc, win }
}

async function startIsland ({ file, electron, env = {} }) {
  const prefs = createPrefs({ file, platform: 'darwin' })
  const ipc = fakeIpc()
  const island = I.createIslandController({ store, prefs, feed, getMainWindow: () => null, openBot () {}, electron, platform: 'darwin', env })
  island.registerIpc(ipc)
  island.sync()
  await tick()
  return { island, prefs, ipc, win: electron.windows.at(-1) }
}

const drag = (ipc, ch, win, from, to, steps = 4) => {
  ipc.emit(ch, win, { phase: 'start', screenX: from.x, screenY: from.y })
  for (let i = 1; i <= steps; i++) {
    ipc.emit(ch, win, { phase: 'move', screenX: from.x + ((to.x - from.x) * i) / steps, screenY: from.y + ((to.y - from.y) * i) / steps })
  }
  ipc.emit(ch, win, { phase: 'end', screenX: to.x, screenY: to.y })
}

const lastLayout = (win, ch) => win.sent.filter(([c]) => c === ch).at(-1)[1]

test('the dock: dragged left, it snaps to the left edge, and comes back there after a restart', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop])
  const { widget, prefs, ipc, win } = await startWidget({ file, electron })
  const start = win.getBounds()
  assert.equal(start.x, 1512 - W.EDGE_MARGIN - W.DOCK_WIDTH, 'right edge by default')

  // Mid-drag the window follows the pointer, anywhere.
  ipc.emit('cma-widget:drag', win, { phase: 'start', screenX: start.x + 30, screenY: start.y + 40 })
  ipc.emit('cma-widget:drag', win, { phase: 'move', screenX: 700, screenY: 300 })
  assert.deepEqual([win.getBounds().x, win.getBounds().y], [670, 260])
  ipc.emit('cma-widget:drag', win, { phase: 'move', screenX: 200, screenY: 400 })
  ipc.emit('cma-widget:drag', win, { phase: 'end', screenX: 200, screenY: 400 })

  const b = win.getBounds()
  assert.equal(b.x, W.EDGE_MARGIN, 'snapped to the left edge')
  assert.equal(b.y, 360)
  assert.equal(lastLayout(win, 'cma-widget:layout').side, 'left')
  assert.deepEqual(prefs.get().widgetPositions, [{ id: 1, bounds: laptop.bounds, pos: { side: 'left', offsetY: 323 } }])
  widget.destroy()

  // A restart: the same place.
  const again = await startWidget({ file, electron })
  assert.deepEqual([again.win.getBounds().x, again.win.getBounds().y], [W.EDGE_MARGIN, 360])
  again.widget.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the dock: remembered per display; the display unplugged, it falls back to the default', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop, external])
  const { widget, prefs, ipc, win } = await startWidget({ file, electron })
  // Onto the external display (to its left, negative x), dropped near its right edge.
  drag(ipc, 'cma-widget:drag', win, { x: win.getBounds().x + 30, y: 400 }, { x: -100, y: 500 })
  assert.equal(win.getBounds().x, -W.EDGE_MARGIN - W.DOCK_WIDTH, 'right edge of the external display')
  assert.deepEqual(prefs.get().widgetPositions.map((e) => e.id), [2])

  // Unplugged: back on the laptop, at the default (right edge, centred).
  electron.screen.displays = [laptop]
  electron.screen.emit('display-removed')
  const fallback = win.getBounds()
  assert.equal(fallback.x, 1512 - W.EDGE_MARGIN - W.DOCK_WIDTH)
  assert.equal(fallback.y, 37 + Math.round((945 - 300) / 2))

  // Plugged back in: the newest remembered display that is connected wins.
  electron.screen.displays = [laptop, external]
  widget.destroy()
  const again = await startWidget({ file, electron })
  assert.equal(again.win.getBounds().x, -W.EDGE_MARGIN - W.DOCK_WIDTH)
  again.widget.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the dock: a smaller work area (resolution or taskbar change) keeps it on screen', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop])
  const { widget, ipc, win } = await startWidget({ file, electron })
  drag(ipc, 'cma-widget:drag', win, { x: win.getBounds().x + 30, y: 400 }, { x: 1450, y: 2000 })
  assert.equal(win.getBounds().y + win.getBounds().height, 37 + 945, 'dropped below the bottom: at the bottom')
  electron.screen.displays = [{ ...laptop, workArea: { x: 0, y: 37, width: 1280, height: 600 } }]
  electron.screen.emit('display-metrics-changed')
  const b = win.getBounds()
  assert.equal(b.x, 1280 - W.EDGE_MARGIN - W.DOCK_WIDTH)
  assert.ok(b.y >= 37 && b.y + b.height <= 637, `inside the new work area (${b.y})`)
  widget.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the dock: only the widget page in the widget window can drag it, with a valid message', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop])
  const { widget, prefs, ipc, win } = await startWidget({ file, electron })
  const before = win.getBounds()
  const other = { url: 'https://evil.example/', webContents: {} }
  // Another window's page; the right window but another URL; junk payloads.
  drag(ipc, 'cma-widget:drag', other, { x: 1400, y: 400 }, { x: 100, y: 400 })
  drag(ipc, 'cma-widget:drag', win, { x: 1400, y: 400 }, { x: 100, y: 400 }, 4)
  assert.notDeepEqual(win.getBounds(), before, 'sanity: the real page can')
  const moved = win.getBounds()
  for (const send of [
    () => ipc.emit('cma-widget:drag', win, { phase: 'start', screenX: 100, screenY: 400 }, { url: 'file:///elsewhere.html' }),
    () => ipc.emit('cma-widget:drag', win, { phase: 'start', screenX: 100, screenY: 400 }, { sender: other.webContents }),
    () => ipc.emit('cma-widget:drag', win, { phase: 'start', screenX: 'x', screenY: 400 }),
    () => ipc.emit('cma-widget:drag', win, { phase: 'teleport', screenX: 1, screenY: 1 }),
    () => ipc.emit('cma-widget:drag', win, null),
  ]) {
    send()
    ipc.emit('cma-widget:drag', win, { phase: 'move', screenX: 900, screenY: 100 }, { url: 'file:///elsewhere.html' })
    assert.deepEqual(win.getBounds(), moved)
  }
  // A move or end with no start does nothing either.
  ipc.emit('cma-widget:drag', win, { phase: 'move', screenX: 900, screenY: 100 })
  ipc.emit('cma-widget:drag', win, { phase: 'end', screenX: 900, screenY: 100 })
  assert.deepEqual(win.getBounds(), moved)
  assert.equal(prefs.get().widgetPositions.length, 1)
  widget.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the dock on Wayland, or where moves do not land, degrades to not dragging', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop])
  // A native Wayland session on Linux (Hyprland, GNOME, KDE …).
  const prefs = createPrefs({ file, platform: 'linux' })
  const ipc = fakeIpc()
  const w = W.createWidgetController({ store, prefs, feed, getMainWindow: () => null, openBot () {}, electron, platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1' } })
  w.registerIpc(ipc)
  w.sync()
  await tick()
  const win = electron.windows.at(-1)
  const before = win.getBounds()
  drag(ipc, 'cma-widget:drag', win, { x: before.x + 20, y: 300 }, { x: 200, y: 300 })
  assert.deepEqual(win.getBounds(), before, 'Wayland: no drag')
  assert.equal(lastLayout(win, 'cma-widget:layout').draggable, false, 'the page is told, so it shows no grab cursor')
  assert.deepEqual(prefs.get().widgetPositions, [])
  w.destroy()

  // X11 / macOS / Windows, but a window manager that ignores the moves.
  const x = await startWidget({ file, electron })
  x.win.ignoreMoves = true
  drag(x.ipc, 'cma-widget:drag', x.win, { x: 1450, y: 300 }, { x: 200, y: 300 }, 6)
  assert.equal(lastLayout(x.win, 'cma-widget:layout').draggable, false, 'gave up after moves that did not land')
  assert.deepEqual(x.prefs.get().widgetPositions, [], 'nothing saved')
  x.widget.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

// --- The island -----------------------------------------------------------------

test('the island: dropped near top-centre it snaps home; further away it stays; restarts keep it', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop])
  const { island, prefs, ipc, win } = await startIsland({ file, electron })
  const home = I.islandBounds(laptop.workArea, I.COMPACT_HEIGHT)
  assert.deepEqual(win.getBounds(), home)
  const grab = { x: home.x + 100, y: home.y + 28 }

  // 30px right, 25px down: within 48px of home — snaps back.
  drag(ipc, 'cma-island:drag', win, grab, { x: grab.x + 30, y: grab.y + 25 })
  assert.deepEqual(win.getBounds(), home)
  assert.deepEqual(prefs.get().islandPositions[0].pos, { snap: 'top-center' })

  // Down to the bottom-left: stays there.
  drag(ipc, 'cma-island:drag', win, grab, { x: 300, y: 700 })
  const dropped = win.getBounds()
  assert.deepEqual([dropped.x, dropped.y], [300 - 100, 700 - 28], 'where it was let go (grabbed 100px in, 28px down)')
  assert.deepEqual(prefs.get().islandPositions[0].pos, { dx: dropped.x, dy: dropped.y - 37 })
  island.destroy()

  const again = await startIsland({ file, electron })
  assert.deepEqual(again.win.getBounds(), dropped)
  again.island.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the island: kept on screen when the work area shrinks; back to top-centre when its display goes', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop, external])
  const { island, ipc, win } = await startIsland({ file, electron })
  const home = I.islandBounds(laptop.workArea, I.COMPACT_HEIGHT)
  // Onto the external display, low and to the left.
  drag(ipc, 'cma-island:drag', win, { x: home.x + 100, y: home.y + 28 }, { x: -1800, y: 950 })
  const there = win.getBounds()
  assert.ok(there.x < 0, 'on the external display')
  // Its resolution drops: still inside the (smaller) work area.
  electron.screen.displays = [laptop, { ...external, bounds: { x: -1280, y: 0, width: 1280, height: 720 }, workArea: { x: -1280, y: 0, width: 1280, height: 690 } }]
  electron.screen.emit('display-metrics-changed')
  const b = win.getBounds()
  assert.ok(b.x >= -1280 - I.SHADOW && b.x + b.width <= I.SHADOW, `x inside (${b.x})`)
  assert.ok(b.y + b.height <= 690 + I.SHADOW, `y inside (${b.y})`)
  // Unplugged: top-centre of the laptop.
  electron.screen.displays = [laptop]
  electron.screen.emit('display-removed')
  assert.deepEqual(win.getBounds(), home)
  island.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the island: only its own page can drag it, and a drag never opens the card on hover', async () => {
  const { dir, file } = tempPrefs()
  const electron = fakeElectron([laptop])
  const { island, prefs, ipc, win } = await startIsland({ file, electron })
  const home = win.getBounds()
  drag(ipc, 'cma-island:drag', win, { x: home.x + 50, y: home.y + 20 }, { x: 300, y: 600 }, 3)
  const moved = win.getBounds()
  assert.notDeepEqual(moved, home)
  ipc.emit('cma-island:drag', win, { phase: 'start', screenX: 300, screenY: 600 }, { url: 'https://configuremyai.com/' })
  ipc.emit('cma-island:drag', win, { phase: 'move', screenX: 900, screenY: 100 }, { url: 'https://configuremyai.com/' })
  ipc.emit('cma-island:drag', win, { phase: 'end', screenX: 900, screenY: 100 }, { sender: {} })
  ipc.emit('cma-island:drag', win, { phase: 'start', screenX: Infinity, screenY: 0 })
  assert.deepEqual(win.getBounds(), moved)
  assert.equal(prefs.get().islandPositions.length, 1)

  // Mid-drag, hover events are ignored (the card would grow the window).
  ipc.emit('cma-island:drag', win, { phase: 'start', screenX: moved.x + 50, screenY: moved.y + 20 })
  const layouts = win.sent.filter(([c]) => c === 'cma-island:layout').length
  ipc.emit('cma-island:hover', win, true)
  assert.equal(win.sent.filter(([c]) => c === 'cma-island:layout').length, layouts)
  ipc.emit('cma-island:drag', win, { phase: 'end', screenX: moved.x + 50, screenY: moved.y + 20 })
  island.destroy()
  fs.rmSync(dir, { recursive: true, force: true })
})
