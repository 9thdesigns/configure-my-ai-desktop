// The island's Manager composer, pure parts (src/island-composer.js) and
// the controller end to end against a fake Electron: the shortcut list and
// its tray submenu, the lines shown, how a reply is recognised, and the
// flow — a click (or the global shortcut) opens it focused, Enter sends to
// the Manager over the widget route, the reply is polled for and lands in
// place (or as "New message" once closed), closing gives the keyboard back
// and trims the window only after the page has closed the shell.

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const { trayMenuTemplate } = require('../src/tray')
const C = require('../src/island-composer')
const I = require('../src/island-window')

const msg = (id, role, body) => ({ id, role, body, created_at: null })
const CONVO = { bot_id: 'manager', messages: [msg('1', 'assistant', 'Morning. Three things today.'), msg('2', 'user', 'Go on'), msg('3', 'assistant', 'First, the launch plan\nis ready.'), msg('4', 'assistant', 'Second, Ada needs a review.')], pending: null }

test('the shortcut is one of a fixed list, labelled in each platform\'s words', () => {
  assert.deepEqual(C.SHORTCUTS.map((s) => s.id), ['ctrl-alt-space', 'ctrl-alt-m', 'cmd-shift-space', 'off'])
  assert.equal(C.DEFAULT_SHORTCUT, 'ctrl-alt-space')
  assert.equal(C.shortcutFor('ctrl-alt-space').accelerator, 'Control+Alt+Space')
  assert.equal(C.shortcutFor('off').accelerator, null)
  assert.equal(C.shortcutFor('Command+Q').id, 'ctrl-alt-space', 'unknown: the default, never the string')
  assert.equal(C.shortcutLabel('ctrl-alt-space', 'darwin'), '⌃⌥Space')
  assert.equal(C.shortcutLabel('ctrl-alt-space', 'win32'), 'Ctrl+Alt+Space')
  const picked = []
  const items = C.shortcutMenuItems('ctrl-alt-m', { platform: 'darwin' }, (id) => picked.push(id))
  assert.deepEqual(items.map((i) => [i.type, i.checked]), [['radio', false], ['radio', true], ['radio', false], ['radio', false]])
  items[3].click()
  assert.deepEqual(picked, ['off'])
  assert.match(C.shortcutMenuItems('ctrl-alt-space', { platform: 'darwin', unavailable: true })[0].label, /in use by another app/)
})

test('the tray has an Island Shortcut submenu, greyed out while the island is hidden', () => {
  const calls = []
  const template = trayMenuTemplate(null, { prefs: { showIsland: true, islandShortcut: 'ctrl-alt-space' }, platform: 'darwin' }, { setIslandShortcut: (id) => calls.push(id) })
  const item = template.find((i) => i.id === 'island-shortcut')
  assert.equal(item.enabled, true)
  item.submenu.find((i) => i.id === 'island-shortcut-cmd-shift-space').click()
  assert.deepEqual(calls, ['cmd-shift-space'])
  assert.equal(trayMenuTemplate(null, { prefs: { showIsland: false }, platform: 'darwin' }, {}).find((i) => i.id === 'island-shortcut').enabled, false)
})

test('the open island shows the Manager\'s last two lines, one line each', () => {
  assert.deepEqual(C.managerLines(CONVO), [{ id: '3', body: 'First, the launch plan is ready.' }, { id: '4', body: 'Second, Ada needs a review.' }])
  assert.deepEqual(C.managerLines(null), [])
  assert.equal(C.managerLines({ messages: [msg('9', 'assistant', 'x'.repeat(5000))] })[0].body.length, 600)
})

test('the reply is the first Manager message after what was sent', () => {
  const sentConvo = { messages: [...CONVO.messages, msg('5', 'user', 'Show me the plan')] }
  const sent = C.sentIn(sentConvo, ' Show me  the plan ')
  assert.deepEqual(sent, { id: '5', body: 'Show me the plan' })
  assert.equal(C.replyTo(sent, sentConvo), null, 'not yet')
  const replied = { messages: [...sentConvo.messages, msg('6', 'assistant', 'Here it is: …')] }
  assert.deepEqual(C.replyTo(sent, replied), { id: '6', body: 'Here it is: …' })
  // The sent message's id unknown: matched by its text.
  assert.deepEqual(C.replyTo({ id: null, body: 'Show me the plan' }, replied), { id: '6', body: 'Here it is: …' })
  assert.equal(C.replyTo(null, replied), null)
})

test('the composer view: lines before sending; the sent text, then the reply or the dots', () => {
  const before = C.composerView({ manager: null, conversation: CONVO })
  assert.equal(before.manager.name, 'Manager')
  assert.equal(before.lines.length, 2)
  assert.equal(before.sent, null)
  const waiting = C.composerView({ conversation: CONVO, sent: { id: 'x', body: 'Hi' }, awaiting: true })
  assert.deepEqual([waiting.sent, waiting.awaiting, waiting.reply], [{ body: 'Hi' }, true, null])
  assert.equal(C.composerView({ conversation: CONVO, error: 'evil' }).error, null)
  assert.equal(C.composerView({ conversation: CONVO, error: 'timeout' }).error, 'timeout')
})

// --- The controller -------------------------------------------------------------

const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }

function fakeElectron ({ taken = [] } = {}) {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (options) {
      super()
      this.visible = false
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
      this.sent = []
      this.focusable = false
      this.focused = false
      this.blurs = 0
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
    setFocusable (on) { this.focusable = on }
    focus () { this.focused = true }
    blur () { this.focused = false; this.blurs++ }
    destroy () { this.emit('closed') }
  }
  const screen = Object.assign(new EventEmitter(), {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getCursorScreenPoint: () => ({ x: -1, y: -1 }),
  })
  const shortcuts = new Map()
  const globalShortcut = {
    register (acc, fn) { if (taken.includes(acc)) return false; shortcuts.set(acc, fn); return true },
    unregister (acc) { shortcuts.delete(acc) },
  }
  const session = { fromPartition: () => ({ setPermissionRequestHandler () {}, setPermissionCheckHandler () {} }) }
  return { BrowserWindow, screen, session, globalShortcut, shortcuts, windows }
}

function fakeIpc () {
  const handlers = {}
  return {
    on: (ch, fn) => { handlers[ch] = fn },
    handle: (ch, fn) => { handlers[ch] = fn },
    emit (ch, win, payload, { url = I.HTML_URL } = {}) { return handlers[ch]({ sender: win.webContents, senderFrame: { url } }, payload) },
  }
}

// The Manager, as the server would answer: a send appends the user's message;
// replyAfter polls later, the Manager's reply is there.
function fakeFeed ({ replyAfter = 2, failSend = false } = {}) {
  let messages = [...CONVO.messages]
  let polls = 0
  let pending = null
  const feed = {
    sends: [],
    isSignedIn: () => true,
    async conversation (id) {
      assert.equal(id, 'manager')
      if (pending && ++polls >= replyAfter) {
        messages = [...messages, msg(`r${messages.length}`, 'assistant', `Reply to: ${pending}`)]
        pending = null
      }
      return { bot_id: 'manager', messages, pending: null }
    },
    async sendMessage (input) {
      feed.sends.push(input)
      if (failSend) return null
      messages = [...messages, msg(`u${messages.length}`, 'user', input.body)]
      pending = input.body
      polls = 0
      return { bot_id: 'manager', messages, pending: null }
    },
  }
  return feed
}

const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve)) }

async function start (t, { feed = fakeFeed(), electron = fakeElectron(), prefs = createPrefs({ platform: 'darwin' }), state = widgetStateFrom(fixture), platform = 'darwin' } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  const store = { get: () => state, onChange: () => () => {} }
  const island = I.createIslandController({ store, prefs, feed, getMainWindow: () => null, openBot () {}, platform, electron })
  const ipc = fakeIpc()
  island.registerIpc(ipc)
  island.sync()
  await flush()
  const win = electron.windows.at(-1)
  ipc.emit('cma-island:ready', win)
  const last = (ch) => win.sent.filter(([c]) => c === ch).at(-1)?.[1]
  return { island, ipc, win, feed, electron, prefs, layout: () => last('cma-island:layout'), composer: () => last('cma-island:composer') }
}

test('a click opens the composer, focused, with the Manager\'s last two lines', async (t) => {
  const { ipc, win, layout, composer } = await start(t)
  ipc.emit('cma-island:compose', win)
  await flush()
  assert.deepEqual([layout().expanded, layout().composing, layout().focused], [true, true, true])
  assert.equal(win.focusable, true)
  assert.equal(win.focused, true)
  assert.deepEqual(composer().lines.map((l) => l.id), ['3', '4'])
  assert.equal(composer().manager.id, 'manager')
})

test('Enter sends to the Manager over the widget route; the reply is polled for and lands in place', async (t) => {
  const { ipc, win, feed, composer } = await start(t, { feed: fakeFeed({ replyAfter: 2 }) })
  ipc.emit('cma-island:compose', win)
  await flush()
  assert.equal(await ipc.emit('cma-island:send', win, 'Show me the plan'), true)
  assert.deepEqual(feed.sends, [{ bot_id: 'manager', body: 'Show me the plan' }])
  assert.deepEqual([composer().sent.body, composer().awaiting, composer().reply], ['Show me the plan', true, null])
  assert.equal(await ipc.emit('cma-island:send', win, 'again'), false, 'one at a time')
  t.mock.timers.tick(C.REPLY_POLL_MS)
  await flush()
  assert.equal(composer().awaiting, true)
  t.mock.timers.tick(C.REPLY_POLL_MS)
  await flush()
  assert.equal(composer().awaiting, false)
  assert.equal(composer().reply.body, 'Reply to: Show me the plan')
})

test('junk and a closed composer send nothing', async (t) => {
  const { ipc, win, feed } = await start(t)
  assert.equal(await ipc.emit('cma-island:send', win, 'not open'), false)
  ipc.emit('cma-island:compose', win)
  assert.equal(await ipc.emit('cma-island:send', win, '   '), false)
  assert.equal(await ipc.emit('cma-island:send', win, { body: 'x' }), false)
  assert.equal(await ipc.emit('cma-island:send', win, 'hi', { url: 'https://configuremyai.com/' }), false, 'not the island page')
  assert.deepEqual(feed.sends, [])
})

test('a send that fails says so; a reply that never comes stops polling and says so', async (t) => {
  const failing = await start(t, { feed: fakeFeed({ failSend: true }) })
  failing.ipc.emit('cma-island:compose', failing.win)
  assert.equal(await failing.ipc.emit('cma-island:send', failing.win, 'Hello'), false)
  assert.equal(failing.composer().error, 'send')
  failing.island.destroy()
  t.mock.timers.reset()

  const slow = await start(t, { feed: fakeFeed({ replyAfter: Infinity }) })
  slow.ipc.emit('cma-island:compose', slow.win)
  await slow.ipc.emit('cma-island:send', slow.win, 'Hello')
  for (let i = 0; i <= C.REPLY_TIMEOUT_MS / C.REPLY_POLL_MS + 1; i++) {
    t.mock.timers.tick(C.REPLY_POLL_MS)
    await flush()
  }
  assert.equal(slow.composer().awaiting, false)
  assert.equal(slow.composer().error, 'timeout')
})

test('closing gives the keyboard back and trims the window only after the shell has closed', async (t) => {
  const { ipc, win, layout } = await start(t)
  ipc.emit('cma-island:compose', win)
  ipc.emit('cma-island:height', win, 260)
  const open = win.getBounds()
  ipc.emit('cma-island:collapse', win)
  assert.deepEqual([layout().expanded, layout().composing, layout().focused], [false, false, false])
  assert.equal(win.blurs, 1, 'blurred: the previous app is key again')
  assert.equal(win.focusable, false)
  assert.equal(win.getBounds().height, open.height, 'still open-sized while the page closes')
  t.mock.timers.tick(I.CLOSE_TRIM_MS)
  assert.ok(win.getBounds().height < open.height, 'then trimmed')
})

test('on Linux and Windows closing does not blur (that would lower the island under other windows)', async (t) => {
  const { ipc, win } = await start(t, { platform: 'linux' })
  ipc.emit('cma-island:compose', win)
  ipc.emit('cma-island:collapse', win)
  assert.equal(win.blurs, 0)
  assert.equal(win.focusable, false)
})

test('a reply landing after the island closed shows as "New message"', async (t) => {
  // A quiet team (a question would outrank it).
  const calm = widgetStateFrom({ ...fixture, manager: { ...fixture.manager, mood: 'idle', state: { ...fixture.manager.state, waiting: null } }, seats: [] })
  const { ipc, win } = await start(t, { feed: fakeFeed({ replyAfter: 1 }), state: calm })
  ipc.emit('cma-island:compose', win)
  await ipc.emit('cma-island:send', win, 'Ping')
  ipc.emit('cma-island:collapse', win)
  t.mock.timers.tick(C.REPLY_POLL_MS)
  await flush()
  const view = win.sent.filter(([c]) => c === 'cma-island:view').at(-1)[1]
  assert.deepEqual([view.mode, view.chip.label, view.bot.id], ['message', 'New message', 'manager'])
})

test('the global shortcut toggles the composer; the pref changes it; another app\'s combination is reported', async (t) => {
  const electron = fakeElectron({ taken: ['Control+Alt+M'] })
  const { island, prefs, layout } = await start(t, { electron })
  assert.deepEqual([...electron.shortcuts.keys()], ['Control+Alt+Space'])
  electron.shortcuts.get('Control+Alt+Space')()
  assert.equal(layout().composing, true)
  electron.shortcuts.get('Control+Alt+Space')()
  assert.equal(layout().composing, false, 'again: closed')
  prefs.set({ islandShortcut: 'cmd-shift-space' })
  assert.deepEqual([...electron.shortcuts.keys()], ['CommandOrControl+Shift+Space'])
  prefs.set({ islandShortcut: 'ctrl-alt-m' })
  assert.deepEqual([...electron.shortcuts.keys()], [])
  assert.equal(island.shortcutUnavailable(), true)
  prefs.set({ islandShortcut: 'off' })
  assert.equal(island.shortcutUnavailable(), false)
  prefs.set({ islandShortcut: 'ctrl-alt-space' })
  prefs.set({ showIsland: false })
  assert.deepEqual([...electron.shortcuts.keys()], [], 'island hidden: no shortcut')
  prefs.set({ showIsland: true })
  assert.deepEqual([...electron.shortcuts.keys()], ['Control+Alt+Space'])
  island.destroy()
  assert.deepEqual([...electron.shortcuts.keys()], [], 'gone on quit')
})
