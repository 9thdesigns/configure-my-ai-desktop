// The recents card in the dock controller, against a fake Electron: a seat
// click fetches the bot's recent chats and opens the card (the window
// widening only to hold it, the list sent before the layout); a bot with no
// chats, an older server (404) or no answer goes straight to the quick chat,
// as before; again on the seat closes it back into the seat in the still-
// wide window; a double-click turns it into the chat; answers that arrive
// after the user moved on are dropped; a cable broadcast refreshes it; and
// the new channel takes only well-formed requests from the widget page.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom, dockBots } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const W = require('../src/widget-window')

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }

function fakeElectron () {
  const windows = []
  class BrowserWindow {
    constructor (opts) {
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }
      this.listeners = {}
      this.destroyed = false
      this.visible = false
      this.focusable = false
      this.sent = []
      const self = this
      this.webContents = { send: (channel, payload) => self.sent.push([channel, payload]), on () {}, setWindowOpenHandler () {}, getURL: () => self.url }
      windows.push(this)
    }

    on (e, f) { (this.listeners[e] ||= []).push(f) }
    once (e, f) { this.on(e, f) }
    emit (e) { for (const f of this.listeners[e] || []) f() }
    loadFile (file) { this.url = require('node:url').pathToFileURL(file).href; setImmediate(() => this.emit('ready-to-show')) }
    setBounds (b) { this.bounds = { ...this.bounds, ...b } }
    getBounds () { return { ...this.bounds } }
    isDestroyed () { return this.destroyed }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    destroy () { this.destroyed = true; this.emit('closed') }
    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    setIgnoreMouseEvents () {}
    setFocusable (on) { this.focusable = on }
    focus () {}
    blur () {}
  }
  const screen = {
    getAllDisplays: () => [laptop],
    getPrimaryDisplay: () => laptop,
    getDisplayMatching: () => laptop,
    getCursorScreenPoint: () => ({ x: -1, y: -1 }),
    on () {},
    removeListener () {},
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
    emit (ch, win, payload, { url = win.url, sender = win.webContents } = {}) {
      return handlers[ch]({ sender, senderFrame: { url } }, payload)
    },
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))
const state = widgetStateFrom(fixture)
const [MANAGER, ADA] = dockBots(state).map((b) => b.id)
const THREADS = [
  { id: 't1', title: 'Plan', preview: 'Draft ready', updated_at: '2026-11-28T10:00:00.000Z', unread: true },
  { id: 't2', title: 'Inbox', preview: 'Three to answer', updated_at: '2026-11-28T09:00:00.000Z', unread: false },
]

// A deferred answer per threads request, so a test can resolve it when it likes.
function fakeFeed () {
  const pending = []
  return {
    pending,
    calls: [],
    isSignedIn: () => true,
    conversation: async () => null,
    setFocus: async () => {},
    threads (botId) {
      this.calls.push(botId)
      return new Promise((resolve) => pending.push({ botId, resolve }))
    },
  }
}

async function start ({ feed = fakeFeed() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-recents-'))
  const prefs = createPrefs({ file: path.join(dir, 'prefs.json'), platform: 'darwin' })
  const listeners = new Set()
  const store = { value: state, get () { return this.value }, onChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn) }, emit () { for (const fn of listeners) fn() } }
  const opened = []
  const electron = fakeElectron()
  const ipc = fakeIpc()
  const widget = W.createWidgetController({ store, prefs, feed, getMainWindow: () => null, openBot: (id) => opened.push(id), electron, platform: 'darwin', env: {} })
  widget.registerIpc(ipc)
  widget.sync()
  await tick()
  const win = electron.windows.at(-1)
  ipc.emit('cma-widget:hit-rects', win, { rects: [], dockHeight: 300 })
  return { widget, ipc, win, feed, store, opened, electron }
}

const sentOn = (win, ch) => win.sent.filter(([c]) => c === ch).map(([, p]) => p)
const lastLayout = (win) => sentOn(win, 'cma-widget:layout').at(-1)
const answer = async (feed, result) => { feed.pending.shift().resolve(result); await tick() }

test('a seat click: the list first, then the window widens just enough for the card beside the dock, focused', async () => {
  const { ipc, win, feed } = await start()
  const before = win.getBounds()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  assert.deepEqual(feed.calls, [ADA])
  assert.deepEqual(win.getBounds(), before, 'nothing moves until the list is in')
  await answer(feed, { status: 'ok', threads: THREADS })
  const order = win.sent.map(([c]) => c).filter((c) => c === 'cma-widget:threads' || c === 'cma-widget:layout').slice(-2)
  assert.deepEqual(order, ['cma-widget:threads', 'cma-widget:layout'], 'the rows are there when the card opens')
  assert.deepEqual(sentOn(win, 'cma-widget:threads').at(-1), { bot_id: ADA, threads: THREADS })
  const layout = lastLayout(win)
  const bounds = win.getBounds()
  assert.equal(layout.mode, 'recents')
  assert.equal(layout.botId, ADA)
  assert.equal(layout.opening, true)
  assert.equal(bounds.width, W.RECENTS_WINDOW_WIDTH)
  assert.equal(bounds.x + bounds.width, before.x + before.width, 'grows inward from the right edge')
  assert.equal(layout.cardHeight, W.recentsCardHeight(2))
  assert.equal(bounds.y + layout.seatY, before.y + 120, 'the seat stays where it was on screen')
  assert.equal(bounds.y + layout.dockTop, before.y, 'the dock never moves')
  assert.equal(layout.seatY - layout.cardTop, 38, 'the header level with the seat')
  assert.equal(win.focusable, true)
})

test('a bot with no chats, an older server (404) or no answer: the seat opens the quick chat, as before; after a 404 it stops asking', async () => {
  for (const [result, label] of [[{ status: 'ok', threads: [] }, 'no chats'], [null, 'no answer']]) {
    const { ipc, win, feed } = await start()
    ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
    await answer(feed, result)
    const layout = lastLayout(win)
    assert.equal(layout.mode, 'chat', label)
    assert.equal(layout.botId, ADA, label)
    assert.equal(win.getBounds().width, W.EXPANDED_WIDTH, label)
  }
  const { ipc, win, feed } = await start()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  await answer(feed, { status: 'unsupported' })
  assert.equal(lastLayout(win).mode, 'chat')
  ipc.emit('cma-widget:collapse', win)
  ipc.emit('cma-widget:recents', win, { bot_id: MANAGER, seat_y: 60 })
  assert.deepEqual(feed.calls, [ADA], 'no second request to a missing route')
  assert.equal(lastLayout(win).mode, 'chat')
  assert.equal(lastLayout(win).botId, MANAGER)
})

test('again on the open seat: the card closes back into it in the still-wide window, which is trimmed after', async () => {
  const { ipc, win, feed } = await start()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  await answer(feed, { status: 'ok', threads: THREADS })
  const open = lastLayout(win)
  const wide = win.getBounds()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  const closing = lastLayout(win)
  assert.equal(closing.closing, true)
  assert.equal(closing.closingMode, 'recents')
  assert.equal(closing.expanded, false)
  assert.deepEqual([closing.cardTop, closing.cardHeight, closing.seatY], [open.cardTop, open.cardHeight, open.seatY], 'where the card is now')
  assert.deepEqual(win.getBounds(), wide, 'not trimmed yet')
  assert.equal(feed.calls.length, 1)
})

test('reopened, the card shows the last list at once and refreshes it behind; a changed row count re-places the window', async () => {
  const { ipc, win, feed } = await start()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  await answer(feed, { status: 'ok', threads: THREADS })
  ipc.emit('cma-widget:collapse', win)
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  assert.equal(lastLayout(win).mode, 'recents', 'open from the cache, no wait')
  assert.equal(feed.calls.length, 2, 'and a fresh request behind it')
  const more = [...THREADS, { id: 't3', title: 'Hiring', preview: '', updated_at: null, unread: false }]
  await answer(feed, { status: 'ok', threads: more })
  assert.deepEqual(sentOn(win, 'cma-widget:threads').at(-1).threads, more)
  assert.equal(lastLayout(win).cardHeight, W.recentsCardHeight(3))
})

test('a cable broadcast (the store changes) refreshes the open card; an unchanged list sends nothing', async () => {
  const { ipc, win, feed, store } = await start()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  await answer(feed, { status: 'ok', threads: THREADS })
  const sent = sentOn(win, 'cma-widget:threads').length
  store.emit()
  assert.equal(feed.calls.length, 2)
  store.emit()
  assert.equal(feed.calls.length, 2, 'one request at a time')
  await answer(feed, { status: 'ok', threads: THREADS })
  assert.equal(sentOn(win, 'cma-widget:threads').length, sent, 'unchanged: nothing resent')
  store.emit()
  await answer(feed, { status: 'ok', threads: [{ ...THREADS[0], unread: false }, THREADS[1]] })
  assert.equal(sentOn(win, 'cma-widget:threads').at(-1).threads[0].unread, false)
})

test('a double-click turns the card into the chat; an answer that comes after the user moved on is dropped', async () => {
  const { ipc, win, feed } = await start()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  await answer(feed, { status: 'ok', threads: THREADS })
  ipc.emit('cma-widget:open', win, ADA)
  assert.equal(lastLayout(win).mode, 'chat')
  assert.equal(lastLayout(win).botId, ADA)
  assert.equal(win.getBounds().width, W.EXPANDED_WIDTH)

  const late = await start()
  late.ipc.emit('cma-widget:recents', late.win, { bot_id: ADA, seat_y: 120 })
  late.ipc.emit('cma-widget:open', late.win, ADA) // the double-click's second click, before the list
  await answer(late.feed, { status: 'ok', threads: THREADS })
  assert.equal(lastLayout(late.win).mode, 'chat', 'the late list does not reopen the card')

  const gone = await start()
  gone.ipc.emit('cma-widget:recents', gone.win, { bot_id: ADA, seat_y: 120 })
  gone.ipc.emit('cma-widget:collapse', gone.win)
  await answer(gone.feed, { status: 'ok', threads: THREADS })
  assert.equal(sentOn(gone.win, 'cma-widget:layout').filter((l) => l.expanded).length, 0, 'closed before it opened: stays closed')
})

test('"Open in app" from the card opens the bot in the main window', async () => {
  const { ipc, win, feed, opened } = await start()
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 120 })
  await answer(feed, { status: 'ok', threads: THREADS })
  ipc.emit('cma-widget:open-in-app', win, ADA)
  assert.deepEqual(opened, [ADA])
  assert.equal(lastLayout(win).closing, true)
})

test('the recents channel takes only the widget page, a docked bot and a seat inside the dock', async () => {
  const { ipc, win, feed } = await start()
  const bad = [
    null, 'x', { bot_id: '../x', seat_y: 10 }, { bot_id: ADA }, { bot_id: ADA, seat_y: 'NaN' }, { bot_id: ADA, seat_y: -1 },
    { bot_id: ADA, seat_y: 301 }, { bot_id: 'not-docked', seat_y: 10 },
  ]
  for (const input of bad) ipc.emit('cma-widget:recents', win, input)
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 10 }, { url: 'https://evil.example/' })
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 10 }, { sender: {} })
  assert.deepEqual(feed.calls, [])
  ipc.emit('cma-widget:recents', win, { bot_id: ADA, seat_y: 300 })
  assert.deepEqual(feed.calls, [ADA])
})
