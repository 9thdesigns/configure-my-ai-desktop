// Trackpad haptics (src/haptics.js): the throttle, the one-tick-per-element
// hover rule, the switch, reduced motion, the no-op off macOS, the helper's
// life (spawned once, restarted when it exits, killed on quit), and that
// only a fixed command and fixed words ever reach it. Then the island and
// the dock calling it for the right moments.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const H = require('../src/haptics')
const { trayMenuTemplate } = require('../src/tray')
const { createPrefs } = require('../src/prefs')

function fakeSpawn () {
  const children = []
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter()
    child.cmd = cmd
    child.args = args
    child.opts = opts
    child.lines = []
    child.killed = false
    child.stdin = Object.assign(new EventEmitter(), {
      write: (s) => { child.lines.push(s); return true },
      end: () => { child.ended = true },
    })
    child.kill = () => { child.killed = true; child.emit('exit', null, 'SIGTERM') }
    children.push(child)
    return child
  }
  return { spawn, children }
}

function make (over = {}) {
  let t = 1000
  const s = fakeSpawn()
  const state = { enabled: true, reduced: false }
  const h = H.createHaptics({ platform: 'darwin', spawn: s.spawn, now: () => t, enabled: () => state.enabled, reducedMotion: () => state.reduced, ...over })
  return { h, ...s, state, tick: (ms) => { t += ms }, lines: () => s.children.flatMap((c) => c.lines) }
}

test('the moments and their patterns: hover is alignment; click, expand, drop and flip generic; the magnet a level change', () => {
  assert.deepEqual(H.EVENTS, { hover: 'alignment', click: 'generic', expand: 'generic', drop: 'generic', flip: 'generic', snap: 'level' })
  const m = make()
  assert.equal(m.h.play('click'), 'generic')
  m.tick(400)
  assert.equal(m.h.play('snap'), 'level')
  m.tick(400)
  assert.equal(m.h.play('hover', 'island'), 'alignment')
  assert.deepEqual(m.lines(), ['generic\n', 'level\n', 'alignment\n'])
  assert.equal(m.h.play('rm -rf'), null, 'unknown moments are ignored')
})

test('at most one tick every 300ms, whatever asks', () => {
  const m = make()
  assert.equal(m.h.play('click'), 'generic')
  m.tick(299)
  assert.equal(m.h.play('click'), null)
  assert.equal(m.h.play('snap'), null)
  m.tick(1)
  assert.equal(m.h.play('click'), 'generic')
  assert.equal(m.lines().length, 2)
})

test('hover never buzzes: once per element, then not again until it has been left for 500ms', () => {
  const m = make()
  assert.equal(m.h.play('hover', 'seat:1'), 'alignment')
  m.tick(1000)
  assert.equal(m.h.play('hover', 'seat:1'), null, 'still inside')
  m.h.leave('seat:1')
  m.tick(499)
  assert.equal(m.h.play('hover', 'seat:1'), null, 'back too soon')
  m.h.leave('seat:1')
  m.tick(500)
  assert.equal(m.h.play('hover', 'seat:1'), 'alignment', 'off it for 500ms: ticks again')
  m.tick(400)
  assert.equal(m.h.play('hover', 'seat:2'), 'alignment', 'another element is its own')
  assert.equal(m.h.play('hover', '<script>'), null, 'junk element names are ignored')
  assert.equal(m.h.play('hover'), null)
})

test('the switch, and reduced motion, turn it off', () => {
  const m = make()
  m.state.enabled = false
  assert.equal(m.h.play('click'), null)
  m.state.enabled = true
  m.state.reduced = true
  assert.equal(m.h.play('click'), null)
  assert.equal(m.children.length, 0, 'not even spawned')
  m.state.reduced = false
  assert.equal(m.h.play('click'), 'generic')
})

test('off macOS it is a no-op (nothing spawned)', () => {
  for (const platform of ['win32', 'linux']) {
    const m = make({ platform })
    assert.equal(m.h.play('click'), null)
    assert.equal(m.children.length, 0)
  }
  assert.equal(H.createHaptics({ platform: 'darwin' }).play('click'), null, 'no spawn: nothing')
})

test('the helper: a fixed osascript command, spawned once; only fixed words written', () => {
  const m = make()
  for (let i = 0; i < 5; i++) { m.h.play('click'); m.tick(400) }
  assert.equal(m.children.length, 1, 'one long-lived child')
  const c = m.children[0]
  assert.equal(c.cmd, '/usr/bin/osascript')
  assert.deepEqual(c.args, H.HELPER_ARGS)
  assert.deepEqual(c.args.slice(0, 3), ['-l', 'JavaScript', '-e'])
  assert.deepEqual(c.opts.stdio, ['pipe', 'ignore', 'ignore'])
  for (const line of c.lines) assert.ok(Object.keys(H.PATTERNS).includes(line.trim()), line)
  // The script is plain JavaScript (JXA) and names the AppKit performer.
  assert.doesNotThrow(() => new Function(H.HELPER_SCRIPT)) // eslint-disable-line no-new-func
  assert.match(H.HELPER_SCRIPT, /NSHapticFeedbackManager\.defaultPerformer/)
  assert.match(H.HELPER_SCRIPT, /performFeedbackPatternPerformanceTime\(PATTERNS\[word\], 1\)/)
  assert.match(H.HELPER_SCRIPT, /hasOwnProperty\.call\(PATTERNS, word\)/, 'the helper itself ignores any other word')
})

test('the helper is restarted when it exits (at most 3 times a minute) and killed on quit', () => {
  const m = make()
  m.h.play('click')
  m.children[0].emit('exit', 1)
  assert.equal(m.h.running, false)
  m.tick(400)
  m.h.play('click')
  assert.equal(m.children.length, 2, 'restarted on the next tick')
  m.children[1].emit('exit', 1)
  m.tick(400)
  m.h.play('click')
  m.children[2].emit('exit', 1)
  m.tick(400)
  assert.equal(m.h.play('click'), null, 'a fourth start within a minute: given up')
  assert.equal(m.children.length, 3)
  m.tick(60_000)
  assert.equal(m.h.play('click'), 'generic', 'a minute later, tried again')
  m.h.shutdown()
  assert.equal(m.children.at(-1).killed, true)
  assert.equal(m.children.at(-1).ended, true)
  m.tick(400)
  assert.equal(m.h.play('click'), null, 'nothing after quit')
  assert.equal(m.children.length, 4)
})

test('the pref, on by default; the tray and the app menu switch it (macOS only)', () => {
  const prefs = createPrefs({ platform: 'darwin' })
  assert.equal(prefs.get().hapticsEnabled, true)
  const item = H.hapticsMenuItem(prefs)
  assert.deepEqual([item.label, item.type, item.checked], ['Haptic Feedback', 'checkbox', true])
  item.click({ checked: false })
  assert.equal(prefs.get().hapticsEnabled, false)
  const calls = []
  const mac = trayMenuTemplate(null, { prefs: { hapticsEnabled: true }, platform: 'darwin' }, { setHaptics: (on) => calls.push(on) })
  const tray = mac.find((i) => i.id === 'haptics')
  assert.equal(tray.checked, true)
  tray.click({ checked: false })
  assert.deepEqual(calls, [false])
  assert.equal(trayMenuTemplate(null, { prefs: {}, platform: 'win32' }, {}).find((i) => i.id === 'haptics'), undefined)
})

// --- The island and the dock -------------------------------------------------------

const I = require('../src/island-window')
const W = require('../src/widget-window')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }

function fakeElectron () {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (o) {
      super()
      this.bounds = { x: 0, y: 0, width: o.width || 100, height: o.height || 100 }
      this.visible = false
      this.sent = []
      this.webContents = Object.assign(new EventEmitter(), { send: (c, p) => this.sent.push([c, p]), setWindowOpenHandler () {}, getURL: () => this.url })
      windows.push(this)
    }

    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    loadFile (f) { this.url = require('node:url').pathToFileURL(f).href; setImmediate(() => this.emit('ready-to-show')) }
    isDestroyed () { return false }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    show () { this.visible = true }
    hide () { this.visible = false }
    setBounds (b) { this.bounds = { ...this.bounds, ...b } }
    getBounds () { return { ...this.bounds } }
    setIgnoreMouseEvents () {}
    setFocusable () {}
    setContentProtection () {}
    focus () {}
    blur () {}
    destroy () { this.emit('closed') }
  }
  const screen = Object.assign(new EventEmitter(), { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display, getDisplayNearestPoint: () => display, getCursorScreenPoint: () => ({ x: -1, y: -1 }) })
  const session = { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }
  return { BrowserWindow, screen, session, windows }
}

function fakeIpc () {
  const handlers = {}
  return {
    on: (ch, fn) => { handlers[ch] = fn },
    handle: (ch, fn) => { handlers[ch] = fn },
    emit (ch, win, payload, { url = win.url } = {}) { return handlers[ch]({ sender: win.webContents, senderFrame: { url } }, payload) },
  }
}

const recorder = () => {
  const calls = []
  return { calls, play: (e, el) => { calls.push(el ? [e, el] : [e]); return 'x' }, leave: (el) => calls.push(['leave', el]) }
}
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve)) }

test('the island: hover on the island and the grabber, the composer opening, the magnet, a flip, a drop on centre', async () => {
  const haptics = recorder()
  const electron = fakeElectron()
  const store = { get: () => widgetStateFrom(fixture), onChange: () => () => {} }
  const island = I.createIslandController({ store, prefs: createPrefs({ platform: 'darwin' }), feed: { isSignedIn: () => true }, getMainWindow: () => null, openBot () {}, platform: 'darwin', electron, haptics })
  const ipc = fakeIpc()
  island.registerIpc(ipc)
  island.sync()
  await flush()
  const win = electron.windows.at(-1)
  ipc.emit('cma-island:ready', win)
  ipc.emit('cma-island:hover', win, true)
  ipc.emit('cma-island:hover', win, false)
  ipc.emit('cma-island:haptic', win, { kind: 'hover', element: 'grabber' })
  ipc.emit('cma-island:haptic', win, { kind: 'leave', element: 'grabber' })
  ipc.emit('cma-island:haptic', win, { kind: 'hover', element: 'seat:evil' })
  ipc.emit('cma-island:haptic', win, { kind: 'hover', element: 'grabber' }, { url: 'https://configuremyai.com/' })
  assert.deepEqual(haptics.calls, [['hover', 'island'], ['leave', 'island'], ['hover', 'grabber'], ['leave', 'grabber']])
  haptics.calls.length = 0
  ipc.emit('cma-island:compose', win)
  assert.deepEqual(haptics.calls, [['expand']])
  ipc.emit('cma-island:collapse', win)
  haptics.calls.length = 0
  // A drag: off centre, onto the magnet, down to the other edge, back up and
  // dropped on centre.
  ipc.emit('cma-island:drag', win, { phase: 'start', screenX: 756, screenY: 50 })
  ipc.emit('cma-island:drag', win, { phase: 'move', screenX: 600, screenY: 50 })
  ipc.emit('cma-island:drag', win, { phase: 'move', screenX: 760, screenY: 50 })
  ipc.emit('cma-island:drag', win, { phase: 'move', screenX: 400, screenY: 800 })
  ipc.emit('cma-island:drag', win, { phase: 'move', screenX: 760, screenY: 50 })
  ipc.emit('cma-island:drag', win, { phase: 'end', screenX: 760, screenY: 50 })
  assert.deepEqual(haptics.calls, [['snap'], ['flip'], ['snap'], ['drop']])
  island.destroy()
})

test('the dock: hover on a seat (by bot id only), a click, and its drop', async () => {
  const haptics = recorder()
  const electron = fakeElectron()
  const state = widgetStateFrom(fixture)
  const store = { get: () => state, onChange: () => () => {} }
  const feed = { isSignedIn: () => true, conversation: async () => null, setFocus: async () => {} }
  const widget = W.createWidgetController({ store, prefs: createPrefs({ platform: 'darwin' }), feed, getMainWindow: () => null, openBot () {}, electron, platform: 'darwin', haptics })
  const ipc = fakeIpc()
  widget.registerIpc(ipc)
  widget.sync()
  await flush()
  const win = electron.windows.find((w) => String(w.url).endsWith('widget.html'))
  ipc.emit('cma-widget:haptic', win, { kind: 'hover', bot_id: 'manager' })
  ipc.emit('cma-widget:haptic', win, { kind: 'leave', bot_id: 'manager' })
  ipc.emit('cma-widget:haptic', win, { kind: 'hover', bot_id: '../../etc' })
  ipc.emit('cma-widget:haptic', win, { kind: 'hover', bot_id: 'manager' }, { url: 'https://configuremyai.com/' })
  assert.deepEqual(haptics.calls, [['hover', 'seat:manager'], ['leave', 'seat:manager']])
  haptics.calls.length = 0
  ipc.emit('cma-widget:open', win, 'manager')
  assert.deepEqual(haptics.calls, [['click']])
  ipc.emit('cma-widget:collapse', win)
  haptics.calls.length = 0
  // Dragged and let go on its own edge: the drop tick.
  const b = win.getBounds()
  ipc.emit('cma-widget:drag', win, { phase: 'start', screenX: b.x + 20, screenY: b.y + 40 })
  ipc.emit('cma-widget:drag', win, { phase: 'move', screenX: b.x + 20, screenY: b.y + 140 })
  ipc.emit('cma-widget:drag', win, { phase: 'end', screenX: b.x + 20, screenY: b.y + 140 })
  assert.deepEqual(haptics.calls, [['drop']])
  widget.destroy()
})
