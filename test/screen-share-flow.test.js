// Share screen end to end, in main: the widget controller (fake Electron,
// fake IPC), the real feed and screen-share broker, and a stub server that
// enforces the confirmed contract for
//   POST /desktop/widget/bots/:id/messages { body, attachments: [screenshot] }
// — magic bytes checked, 413 { error: 'attachment_too_large' } over its
// limit, 422 { error: 'attachment_invalid' } on a bad image, 200 with the
// conversation (messages carry attachments) otherwise.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const fixture = require('./fixtures/widget.json')
const { createPrefs } = require('../src/prefs')
const { createWidgetStore, createWidgetFeed, WIDGET_JSON_PATH } = require('../src/widget-feed')
const { createScreenShare, createIndicator } = require('../src/screen-share')
const W = require('../src/widget-window')

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const display = { id: 1, size: { width: 1440, height: 900 }, scaleFactor: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } }

function fakeElectron () {
  const windows = []
  class BrowserWindow {
    constructor (opts) {
      this.bounds = { x: 0, y: 0, width: opts.width, height: opts.height }
      this.listeners = {}
      this.destroyed = false
      this.visible = false
      this.sent = []
      const self = this
      this.webContents = { send: (channel, payload) => self.sent.push([channel, payload]), on () {}, setWindowOpenHandler () {}, getURL: () => self.url }
      windows.push(this)
    }

    on (e, f) { (this.listeners[e] ||= []).push(f) }
    once (e, f) { this.on(e, f) }
    emit (e) { for (const f of this.listeners[e] || []) f() }
    loadFile (file) { this.url = pathToFileURL(file).href; setImmediate(() => this.emit('ready-to-show')) }
    setBounds (b) { this.bounds = { ...this.bounds, ...b } }
    getBounds () { return { ...this.bounds } }
    isDestroyed () { return this.destroyed }
    isVisible () { return this.visible }
    showInactive () { this.visible = true }
    destroy () { this.destroyed = true; this.emit('closed') }
    setAlwaysOnTop () {}
    setVisibleOnAllWorkspaces () {}
    setIgnoreMouseEvents () {}
    setFocusable () {}
    focus () {}
  }
  const screen = {
    getAllDisplays: () => [display],
    getPrimaryDisplay: () => display,
    getDisplayMatching: () => display,
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

// The server side of the contract, as the web worker builds it.
function stubServer ({ chatAttachments = ['screenshot'], maxBytes = 5 * 1024 * 1024 } = {}) {
  const posts = []
  let seq = 0
  const messages = [{ id: 'm0', role: 'assistant', body: 'Hi Dave.', created_at: '2026-11-28T09:00:00Z' }]
  const conversation = () => ({ bot_id: 'manager', status: 'idle', messages: messages.slice(-20), pending: null })
  async function request ({ method, path: p, body }) {
    if (method === 'GET' && p === WIDGET_JSON_PATH) return { status: 200, json: { ...fixture, chat_attachments: chatAttachments } }
    if (method === 'GET' && p.startsWith('/desktop/widget/bots/manager/messages')) return { status: 200, json: conversation() }
    if (method === 'PATCH') return { status: 200, json: { ...fixture, chat_attachments: chatAttachments } }
    if (method === 'POST' && p === '/desktop/widget/bots/manager/messages') {
      posts.push(body)
      const atts = body.attachments || []
      if (atts.length > 1) return { status: 422, json: { error: 'attachment_invalid' } }
      const stored = []
      for (const a of atts) {
        if (a.kind !== 'screenshot' || !['image/png', 'image/jpeg'].includes(a.mime) || typeof a.data_base64 !== 'string') return { status: 422, json: { error: 'attachment_invalid' } }
        const data = Buffer.from(a.data_base64, 'base64')
        if (data.length > maxBytes) return { status: 413, json: { error: 'attachment_too_large' } }
        const magic = a.mime === 'image/png' ? PNG_MAGIC : JPEG_MAGIC
        if (!data.subarray(0, magic.length).equals(magic)) return { status: 422, json: { error: 'attachment_invalid' } }
        stored.push({ kind: 'screenshot', mime: a.mime, width: a.width, height: a.height, url: `https://configuremyai.com/rails/active_storage/shot-${++seq}.png` })
      }
      if (!body.body && !stored.length) return { status: 422, json: { error: 'blank' } }
      messages.push({ id: `u${++seq}`, role: 'user', body: body.body, created_at: '2026-11-28T09:01:00Z', attachments: stored })
      return { status: 201, json: conversation() }
    }
    return { status: 404 }
  }
  return { request, posts }
}

// A capture whose PNG bytes we choose (a real PNG header, or junk).
function capturing (bytes) {
  return async () => ({
    isEmpty: () => false,
    getSize: () => ({ width: 1440, height: 900 }),
    resize () { return this },
    toPNG: () => bytes,
    toJPEG: () => Buffer.concat([JPEG_MAGIC, Buffer.alloc(10)]),
  })
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

async function start ({ server = stubServer(), shareScreen = true, capture = capturing(Buffer.concat([PNG_MAGIC, Buffer.alloc(64, 7)])) } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-share-'))
  const prefs = createPrefs({ file: path.join(dir, 'prefs.json'), platform: 'linux' })
  prefs.set({ shareScreen })
  const store = createWidgetStore()
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  const indicator = []
  const screenShare = createScreenShare({ isEnabled: () => prefs.get().shareScreen === true, platform: 'linux', env: {}, capture, indicator: createIndicator({ minMs: 0, onChange: (on) => indicator.push(on) }) })
  const electron = fakeElectron()
  const ipc = fakeIpc()
  const widget = W.createWidgetController({ store, prefs, feed, getMainWindow: () => null, openBot () {}, electron, platform: 'linux', env: {}, screenShare })
  widget.registerIpc(ipc)
  widget.sync()
  await tick()
  const win = electron.windows.at(-1)
  ipc.emit('cma-widget:open', win, 'manager')
  await tick()
  return { prefs, store, feed, screenShare, widget, ipc, win, server, indicator }
}

test('200: Share screen, then send — the screenshot goes with the message, then is dropped', async (t) => {
  const s = await start()
  t.after(() => s.widget.destroy())
  const shot = await s.ipc.emit('cma-widget:share-screen', s.win, { bot_id: 'manager', reason: 'button' })
  assert.equal(shot.status, 'ok')
  assert.deepEqual(s.indicator, [true, false])
  assert.ok(s.screenShare.has('manager'))

  const view = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: "what's this error?" })
  const post = s.server.posts.at(-1)
  assert.equal(post.body, "what's this error?")
  assert.equal(post.attachments.length, 1)
  assert.equal(post.attachments[0].kind, 'screenshot')
  assert.equal(post.attachments[0].mime, 'image/png')
  assert.ok(Buffer.from(post.attachments[0].data_base64, 'base64').subarray(0, 8).equals(PNG_MAGIC))
  assert.equal(view.failed, undefined)
  const sent = view.messages.at(-1)
  assert.equal(sent.screenshot, true)
  assert.deepEqual(sent.attachments.map((a) => [a.kind, a.url]), [['screenshot', 'https://configuremyai.com/rails/active_storage/shot-1.png']])
  assert.ok(!s.screenShare.has('manager'), 'dropped once the server has it')

  // The next message goes without one.
  await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'thanks' })
  assert.equal(s.server.posts.at(-1).attachments, undefined)
})

test('200: a screenshot alone (no text) is a bubble too', async (t) => {
  const s = await start()
  t.after(() => s.widget.destroy())
  await s.ipc.emit('cma-widget:share-screen', s.win, { bot_id: 'manager', reason: 'button' })
  const view = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: '' })
  assert.equal(s.server.posts.at(-1).body, '')
  assert.equal(view.messages.at(-1).body, 'Shared my screen')
})

test('a message asking about the screen takes one first, with the indicator — only while the switch is on', async (t) => {
  const s = await start()
  t.after(() => s.widget.destroy())
  const view = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'do X on my screen' })
  assert.equal(s.server.posts.at(-1).attachments.length, 1)
  assert.deepEqual(s.indicator, [true, false])
  assert.equal(view.screen.status, 'ok')

  const off = await start({ shareScreen: false })
  t.after(() => off.widget.destroy())
  await off.ipc.emit('cma-widget:send', off.win, { bot_id: 'manager', body: "what's this error?" })
  assert.equal(off.server.posts.at(-1).attachments, undefined, 'switch off: no capture')
  assert.deepEqual(off.indicator, [])
})

test('413: the server says too large — not sent, the screenshot dropped, the composer told why', async (t) => {
  const s = await start({ server: stubServer({ maxBytes: 32 }) })
  t.after(() => s.widget.destroy())
  await s.ipc.emit('cma-widget:share-screen', s.win, { bot_id: 'manager', reason: 'button' })
  const before = s.server.posts.length
  const view = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'look' })
  assert.equal(s.server.posts.length, before + 1, 'not retried')
  assert.equal(view.failed, true)
  assert.equal(view.screen.status, 'refused')
  assert.match(view.screen.message, /too large/)
  assert.ok(!s.screenShare.has('manager'))
  // The retry goes as plain text.
  const retry = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'look' })
  assert.equal(s.server.posts.at(-1).attachments, undefined)
  assert.equal(retry.messages.at(-1).body, 'look')
})

test('422: the server cannot read the image — not resent with a fresh token, dropped, explained', async (t) => {
  const s = await start({ capture: capturing(Buffer.from('this is not a png at all')) })
  t.after(() => s.widget.destroy())
  await s.ipc.emit('cma-widget:share-screen', s.win, { bot_id: 'manager', reason: 'button' })
  const before = s.server.posts.length
  const view = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'look' })
  assert.equal(s.server.posts.length, before + 1, 'an attachment refusal is not the stale-token 422: no second upload')
  assert.equal(view.failed, true)
  assert.match(view.screen.message, /couldn’t read/)
  assert.ok(!s.screenShare.has('manager'))
})

test('a plain send that fails keeps nothing extra; a failed send keeps the screenshot for the retry', async (t) => {
  const server = stubServer()
  let down = true
  const flaky = { ...server, request: async (req) => (down && req.method === 'POST' ? { status: 0 } : server.request(req)) }
  const s = await start({ server: flaky })
  t.after(() => s.widget.destroy())
  await s.ipc.emit('cma-widget:share-screen', s.win, { bot_id: 'manager', reason: 'button' })
  assert.equal(await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'look' }), null)
  assert.ok(s.screenShare.has('manager'), 'kept for the retry')
  down = false
  const view = await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'look' })
  assert.equal(view.messages.at(-1).screenshot, true)
})

test('IPC gating: only the widget page, only the open chat, only an explicit reason, only when offered', async (t) => {
  const s = await start()
  t.after(() => s.widget.destroy())
  const share = (payload, opts) => s.ipc.emit('cma-widget:share-screen', s.win, payload, opts)
  assert.equal(await share({ bot_id: 'manager', reason: 'button' }, { url: 'https://configuremyai.com/home' }), null, 'another page')
  assert.equal(await share({ bot_id: 'manager', reason: 'button' }, { sender: {} }), null, 'another window')
  assert.equal(await share({ bot_id: fixture.seats[1].bot_id, reason: 'button' }), null, 'not the open chat')
  assert.equal(await share({ bot_id: 'manager', reason: 'tool_call' }), null, 'not a user action')
  assert.equal(await share({ bot_id: 'manager' }), null)
  assert.equal(await share(null), null)
  assert.ok(!s.screenShare.has('manager'))
  assert.deepEqual(s.indicator, [], 'nothing was captured')
  assert.equal(await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: 'x' }, { url: 'file:///elsewhere.html' }), null)

  // The switch, set from the composer, only from the widget page.
  s.ipc.emit('cma-widget:set-share-screen', s.win, false, { url: 'https://configuremyai.com/' })
  assert.equal(s.prefs.get().shareScreen, true)
  s.ipc.emit('cma-widget:set-share-screen', s.win, false)
  assert.equal(s.prefs.get().shareScreen, false)
  const off = await share({ bot_id: 'manager', reason: 'button' })
  assert.equal(off.code, 'disabled', 'switch off: refused')

  // Collapsing the chat drops a held screenshot.
  s.ipc.emit('cma-widget:set-share-screen', s.win, true)
  await share({ bot_id: 'manager', reason: 'button' })
  assert.ok(s.screenShare.has('manager'))
  s.ipc.emit('cma-widget:collapse', s.win)
  assert.ok(!s.screenShare.has('manager'))
})

test('a server without chat_attachments: no Share screen, and nothing is attached', async (t) => {
  const s = await start({ server: stubServer({ chatAttachments: null }) })
  t.after(() => s.widget.destroy())
  assert.equal(await s.ipc.emit('cma-widget:share-screen', s.win, { bot_id: 'manager', reason: 'button' }), null)
  await s.ipc.emit('cma-widget:send', s.win, { bot_id: 'manager', body: "what's this error?" })
  assert.equal(s.server.posts.at(-1).attachments, undefined)
  const state = s.win.sent.filter(([c]) => c === 'cma-widget:state').at(-1)[1]
  assert.equal(state.screen_share.available, false)
})
