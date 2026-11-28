// The island's states and when its card previews: the mode for every chip,
// a message or question previewing after 300ms of hover and leaving 100ms
// after the pointer does, other states never previewing, and the widget's
// "response arrived" event turning the pill into "New message" until the
// user opens it. The controller runs against a fake Electron, timers on
// node's mock clock.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fixture = require('./fixtures/widget.json')
const { ADA, LIN, OPS } = require('./ids')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const I = require('../src/island-window')

const idleManager = { ...fixture.manager, mood: 'idle', state: { ...fixture.manager.state, waiting: null, detail: '' } }
const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }

function fakeElectron () {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (options) {
      super()
      this.options = options
      this.visible = false
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
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
    isDestroyed () { return false }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    hide () { this.visible = false }
    setBounds (b) { this.bounds = b }
    getBounds () { return { ...this.bounds } }
    setIgnoreMouseEvents () {}
    setFocusable () {}
    focus () {}
    destroy () { this.emit('closed') }
  }
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getCursorScreenPoint: () => ({ x: -1, y: -1 }),
  })
  const session = { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }
  return { BrowserWindow, screen, session, windows }
}

function fakeIpc () {
  const handlers = {}
  return {
    on: (ch, fn) => { handlers[ch] = fn },
    handle: (ch, fn) => { handlers[ch] = fn },
    emit (ch, win, payload) { return handlers[ch]({ sender: win.webContents, senderFrame: { url: I.HTML_URL } }, payload) },
  }
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

// setImmediate stays real (the window's ready-to-show); setTimeout is mocked.
async function start (t, state) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  const electron = fakeElectron()
  const store = fakeStore(state)
  const opened = []
  const island = I.createIslandController({ store, prefs: createPrefs({ platform: 'darwin' }), feed: { isSignedIn: () => true }, getMainWindow: () => null, openBot: (id) => opened.push(id), platform: 'darwin', electron })
  const ipc = fakeIpc()
  island.registerIpc(ipc)
  island.sync()
  await new Promise((resolve) => setImmediate(resolve))
  const win = electron.windows.at(-1)
  ipc.emit('cma-island:ready', win)
  const last = (ch) => win.sent.filter(([c]) => c === ch).at(-1)?.[1]
  return { island, ipc, win, store, opened, view: () => last('cma-island:view'), layout: () => last('cma-island:layout') }
}

test('every chip has a mode; the six states are the island\'s whole vocabulary', () => {
  assert.deepEqual(I.MODES, ['idle', 'working', 'message', 'question', 'approval', 'recording'])
  const cases = { idle: 'idle', offline: 'idle', working: 'working', responded: 'message', failed: 'message', question: 'question', waiting: 'question', approval: 'approval', screen: 'recording' }
  for (const [kind, mode] of Object.entries(cases)) assert.equal(I.islandMode({ kind }), mode, kind)
  assert.equal(I.islandMode(null), 'idle')
  const state = widgetStateFrom(fixture)
  assert.equal(I.islandView({ ...state, focused_bot_id: OPS }).mode, 'question')
  assert.equal(I.islandView({ ...state, focused_bot_id: LIN }).mode, 'approval')
  assert.equal(I.islandView({ ...state, focused_bot_id: ADA }).mode, 'working')
  assert.equal(I.islandView(widgetStateFrom({ ...fixture, manager: idleManager, seats: [] })).mode, 'idle')
  assert.equal(I.withScreenIndicator(I.islandView(state), true).mode, 'recording')
  assert.ok(Number.isInteger(I.islandView(state).badge))
})

test('only a message or a question previews on hover', () => {
  assert.equal(I.previews({ idle: false, mode: 'message' }), true)
  assert.equal(I.previews({ idle: false, mode: 'question' }), true)
  for (const mode of ['idle', 'working', 'approval', 'recording']) assert.equal(I.previews({ idle: false, mode }), false, mode)
  assert.equal(I.previews({ idle: true, mode: 'message' }), false)
  assert.deepEqual([I.HOVER_PREVIEW_MS, I.HOVER_LEAVE_MS], [300, 100])
})

test('a question previews after 300ms of hover, and goes 100ms after the pointer leaves', async (t) => {
  const { ipc, win, layout } = await start(t, widgetStateFrom({ ...fixture, focused_bot_id: OPS }))
  ipc.emit('cma-island:hover', win, true)
  t.mock.timers.tick(299)
  assert.equal(layout().expanded, false, 'not yet')
  t.mock.timers.tick(1)
  assert.equal(layout().expanded, true, 'previewing')
  assert.equal(layout().focused, false, 'without taking focus')
  ipc.emit('cma-island:hover', win, false)
  t.mock.timers.tick(99)
  assert.equal(layout().expanded, true)
  t.mock.timers.tick(1)
  assert.equal(layout().expanded, false, 'gone 100ms after leaving')
  // In and out before 300ms: no preview at all.
  ipc.emit('cma-island:hover', win, true)
  t.mock.timers.tick(200)
  ipc.emit('cma-island:hover', win, false)
  t.mock.timers.tick(500)
  assert.equal(layout().expanded, false)
  // Clicked into: leaving does not close it.
  ipc.emit('cma-island:activate', win)
  ipc.emit('cma-island:hover', win, false)
  t.mock.timers.tick(500)
  assert.equal(layout().expanded, true)
})

test('an approval or a working bot only lifts on hover; a click still opens the card', async (t) => {
  const { ipc, win, layout } = await start(t, widgetStateFrom({ ...fixture, focused_bot_id: LIN }))
  ipc.emit('cma-island:hover', win, true)
  t.mock.timers.tick(1000)
  assert.equal(layout().expanded, false)
  ipc.emit('cma-island:activate', win)
  assert.equal(layout().expanded, true)
})

test('a drag cancels a pending preview', async (t) => {
  const { ipc, win, layout } = await start(t, widgetStateFrom({ ...fixture, focused_bot_id: OPS }))
  ipc.emit('cma-island:hover', win, true)
  t.mock.timers.tick(150)
  ipc.emit('cma-island:drag', win, { phase: 'start', screenX: 756, screenY: 50 })
  t.mock.timers.tick(500)
  assert.equal(layout().expanded, false)
  ipc.emit('cma-island:drag', win, { phase: 'end', screenX: 756, screenY: 50 })
})

test('"response arrived": New message for that bot, until it is opened', async (t) => {
  const quiet = widgetStateFrom({ ...fixture, manager: idleManager })
  const ada = quiet.seats.find((s) => s.bot_id === ADA)
  const calm = { ...quiet, seats: quiet.seats.map((s) => ({ ...s, mood: 'idle', state: { ...s.state, waiting: null } })) }
  const { island, ipc, win, view, opened } = await start(t, calm)
  assert.equal(view().mode, 'idle')
  island.responseArrived({ bot_id: 'nope' })
  island.responseArrived({ bot_id: '../x' })
  assert.equal(view().mode, 'idle', 'unknown or junk ids are ignored')
  island.responseArrived({ bot_id: ADA })
  assert.equal(view().mode, 'message')
  assert.deepEqual(view().chip, { kind: 'responded', label: 'New message' })
  assert.equal(view().bot.id, ADA)
  assert.equal(view().bot.name, ada.name)
  // A message previews on hover.
  ipc.emit('cma-island:hover', win, true)
  t.mock.timers.tick(300)
  ipc.emit('cma-island:open-in-app', win, ADA)
  assert.deepEqual(opened, [ADA])
  assert.equal(view().mode, 'idle', 'opened: back to quiet')
})

test('"response arrived" never hides a question, an approval or the screen being viewed', async (t) => {
  const { island, view } = await start(t, widgetStateFrom({ ...fixture, focused_bot_id: OPS }))
  island.responseArrived({ bot_id: ADA })
  assert.equal(view().mode, 'question')
  island.setCapturing(true)
  assert.equal(view().mode, 'recording')
})

test('"response arrived" lets go when the bot starts on something new', async (t) => {
  const calm = widgetStateFrom({ ...fixture, manager: idleManager, seats: fixture.seats.map((s) => ({ ...s, mood: 'idle', state: { ...s.state, waiting: null } })) })
  const { island, store, view } = await start(t, calm)
  island.responseArrived({ bot_id: 'manager' })
  assert.equal(view().mode, 'message')
  store.set({ ...calm, manager: { ...calm.manager, mood: 'working' } })
  assert.notEqual(view().chip.label, 'New message')
})
