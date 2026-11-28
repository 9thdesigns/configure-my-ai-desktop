// "A response arrived" (src/arrivals.js) and its wiring in the dock's
// controller (src/widget-window.js, against a fake Electron): a dock bot
// whose mood turns to responded, or whose answer changes while responded,
// has arrived — never on the first state, never a paused or newly pinned
// bot. The controller tells the island (onResponseArrived) and the page
// (cma-widget:arrival, with the "Show finished work" pref), and widens the
// collapsed window while the page's shelf is out (cma-widget:shelf, gated
// to the widget page).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const { detectArrivals } = require('../src/arrivals')
const W = require('../src/widget-window')

const ADA = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d'
const LIN = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

// The fixture with some seats changed: { [bot_id]: { mood, state, … } }.
function stateWith (changes = {}) {
  const f = structuredClone(fixture)
  for (const seat of f.seats) if (changes[seat.bot_id]) Object.assign(seat, changes[seat.bot_id], { state: { ...seat.state, ...(changes[seat.bot_id].state || {}) } })
  if (changes.manager) Object.assign(f.manager, changes.manager, { state: { ...f.manager.state, ...(changes.manager.state || {}) } })
  return widgetStateFrom(f)
}
const responded = (detail, messageId) => ({ mood: 'responded', state: { waiting: null, detail, message_id: messageId } })

test('a bot that turns to responded has arrived, with its answer as the label', () => {
  const before = stateWith()
  const after = stateWith({ [ADA]: responded('The weekly report is ready.', '11111111-1111-4111-8111-111111111111') })
  assert.deepEqual(detectArrivals(before, after), [{ bot_id: ADA, name: 'Ada', label: 'The weekly report is ready.', kind: 'message', conversation_id: null }])
})

test('a second answer (a new message while responded) arrives again; the same state does not', () => {
  const one = stateWith({ [ADA]: responded('First.', '11111111-1111-4111-8111-111111111111') })
  const same = stateWith({ [ADA]: responded('First.', '11111111-1111-4111-8111-111111111111') })
  const two = stateWith({ [ADA]: responded('Second.', '22222222-2222-4222-8222-222222222222') })
  assert.deepEqual(detectArrivals(one, same), [])
  assert.equal(detectArrivals(same, two)[0].label, 'Second.')
})

test('nothing on the first state, for a paused bot, or for a bot newly pinned', () => {
  const after = stateWith({ [ADA]: responded('Done.', '11111111-1111-4111-8111-111111111111') })
  assert.deepEqual(detectArrivals(null, after), [])
  assert.deepEqual(detectArrivals(stateWith(), stateWith({ [ADA]: { mood: 'responded', state: { detail: 'Done.', status: 'paused' } } })), [])
  const unpinned = structuredClone(fixture)
  unpinned.seats = unpinned.seats.map((s) => (s.bot_id === ADA ? { ...s, pinned: false } : s))
  assert.deepEqual(detectArrivals(widgetStateFrom(unpinned), after), [], 'not in the dock before')
})

test('an arrival names the conversation it came in: a bot\'s session_id, the manager\'s thread_id', () => {
  const before = stateWith()
  const lin = detectArrivals(before, stateWith({ [LIN]: responded('Shipped.', '33333333-3333-4333-8333-333333333333') }))[0]
  assert.equal(lin.conversation_id, 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f')
  const manager = detectArrivals(before, stateWith({ manager: responded('Done.', '44444444-4444-4444-8444-444444444444') }))[0]
  assert.equal(manager.bot_id, 'manager')
  assert.equal(manager.conversation_id, '1e2f3a4b-5c6d-4e7f-9a8b-9c0d1e2f3a4b')
})

test('a finished file reads as a file; no detail reads "New message"', () => {
  const before = stateWith()
  assert.equal(detectArrivals(before, stateWith({ [LIN]: responded('Saved Q3-summary.pdf to Reports') }))[0].kind, 'file')
  assert.deepEqual(detectArrivals(before, stateWith({ [LIN]: responded('') }))[0].label, 'New message')
})

// --- The controller -------------------------------------------------------

function fakeElectron () {
  const windows = []
  class BrowserWindow {
    constructor (opts) {
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }
      this.listeners = {}
      this.sent = []
      this.destroyed = false
      const self = this
      this.webContents = { send: (c, p) => self.sent.push([c, p]), on () {}, setWindowOpenHandler () {}, getURL: () => self.url }
      windows.push(this)
    }

    on (e, f) { (this.listeners[e] ||= []).push(f) }
    once (e, f) { this.on(e, f) }
    emit (e) { for (const f of this.listeners[e] || []) f() }
    loadFile (file) { this.url = require('node:url').pathToFileURL(file).href; setImmediate(() => this.emit('ready-to-show')) }
    setBounds (b) { this.bounds = { ...this.bounds, ...b } }
    getBounds () { return { ...this.bounds } }
    isDestroyed () { return this.destroyed }
    isVisible () { return true }
    showInactive () {}
    destroy () { this.destroyed = true; this.emit('closed') }
    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    setIgnoreMouseEvents () {}
    setFocusable () {}
    focus () {}
  }
  const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
  const screen = { getAllDisplays: () => [display], getPrimaryDisplay: () => display, getDisplayMatching: () => display, getCursorScreenPoint: () => ({ x: -1, y: -1 }), on () {}, removeListener () {} }
  return { BrowserWindow, screen, session: { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }, windows }
}

async function start ({ showFinishedWork = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-arrival-'))
  const prefs = createPrefs({ file: path.join(dir, 'prefs.json'), platform: 'darwin' })
  prefs.set({ showFinishedWork })
  let current = stateWith()
  const listeners = []
  const store = { get: () => current, onChange: (fn) => { listeners.push(fn); return () => {} } }
  const setState = (s) => { current = s; listeners.forEach((fn) => fn(s)) }
  const arrived = []
  const asked = []
  const electron = fakeElectron()
  const handlers = {}
  const ipc = { on: (c, f) => { handlers[c] = f }, handle: (c, f) => { handlers[c] = f } }
  const widget = W.createWidgetController({ store, prefs, feed: { conversation: async (id, conversationId) => { asked.push([id, conversationId || null]); return null }, setFocus: async () => {} }, getMainWindow: () => null, openBot () {}, electron, platform: 'darwin', env: {}, onResponseArrived: (a) => arrived.push(a) })
  widget.registerIpc(ipc)
  widget.sync()
  await new Promise((resolve) => setImmediate(resolve))
  const win = electron.windows.at(-1)
  const emit = (ch, payload, url = win.url) => handlers[ch]({ sender: win.webContents, senderFrame: { url } }, payload)
  emit('cma-widget:hit-rects', { rects: [], dockHeight: 300 })
  return { widget, win, setState, arrived, asked, emit, dir }
}

test('the controller: an arrival goes to the island hook and to the page (with the pref); the first state sends none', async () => {
  const t = await start()
  assert.deepEqual(t.arrived, [], 'nothing at launch')
  t.setState(stateWith({ [ADA]: responded('Report ready.', '11111111-1111-4111-8111-111111111111') }))
  assert.deepEqual(t.arrived, [{ bot_id: ADA }])
  const sent = t.win.sent.filter(([c]) => c === 'cma-widget:arrival').map(([, p]) => p)
  assert.deepEqual(sent, [{ bot_id: ADA, name: 'Ada', label: 'Report ready.', kind: 'message', conversation_id: null, shelf: true }])
  t.widget.destroy()
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('the controller: "Show finished work" off — the page still hears (the seat nudges) but with shelf: false', async () => {
  const t = await start({ showFinishedWork: false })
  t.setState(stateWith({ [ADA]: responded('Done.', '11111111-1111-4111-8111-111111111111') }))
  assert.equal(t.win.sent.filter(([c]) => c === 'cma-widget:arrival').at(-1)[1].shelf, false)
  t.widget.destroy()
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('the controller: the shelf widens the collapsed window inward and trims it back; only the widget page may ask', async () => {
  const t = await start()
  const narrow = t.win.getBounds()
  assert.equal(narrow.width, W.DOCK_WIDTH)
  t.emit('cma-widget:shelf', true)
  const wide = t.win.getBounds()
  assert.equal(wide.width, W.SHELF_STAGE_WIDTH)
  assert.equal(wide.x + wide.width, narrow.x + narrow.width, 'grown inward: the dock stays on the edge')
  t.emit('cma-widget:shelf', false)
  assert.deepEqual(t.win.getBounds(), narrow)
  t.emit('cma-widget:shelf', true, 'file:///elsewhere.html')
  assert.deepEqual(t.win.getBounds(), narrow, 'another page: ignored')
  t.emit('cma-widget:shelf', 'yes')
  assert.deepEqual(t.win.getBounds(), narrow, 'not a boolean: ignored')
  t.widget.destroy()
  fs.rmSync(t.dir, { recursive: true, force: true })
})

test('the controller: a pill opens the chat pinned to the conversation the answer came in — only that one, only for a dock bot', async () => {
  const t = await start()
  const LIN_SESSION = 'c3d4e5f6-a7b8-4c9d-8e0f-2a3b4c5d6e7f'
  t.emit('cma-widget:open-thread', { bot_id: LIN, thread_id: LIN_SESSION })
  assert.deepEqual(t.asked, [], 'no arrival yet: ignored')
  t.setState(stateWith({ [LIN]: responded('Shipped.', '33333333-3333-4333-8333-333333333333') }))
  t.emit('cma-widget:open-thread', { bot_id: LIN, thread_id: '99999999-9999-4999-8999-999999999999' })
  t.emit('cma-widget:open-thread', { bot_id: LIN, thread_id: LIN_SESSION }, 'file:///elsewhere.html')
  assert.deepEqual(t.asked, [], 'another conversation, or another page: ignored')
  t.emit('cma-widget:open-thread', { bot_id: LIN, thread_id: LIN_SESSION })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(t.asked.at(-1), [LIN, LIN_SESSION], 'the quick chat, pinned to that conversation')
  t.widget.destroy()
  fs.rmSync(t.dir, { recursive: true, force: true })
})
