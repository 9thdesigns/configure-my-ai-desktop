// The island's actions menu: its items (and the page's copy of them), the
// attachments the composer shows, the screen-share broker's new sources
// (a window, a dragged-out area), the Select-area maths, the recorder's
// rules — and the controller end to end against a fake Electron: every
// action from the user's click only, screenshots through the broker and
// sent with the next message, the attached file's line, recordings kept on
// this computer, the island staying open while a dialog has the focus.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { createPrefs } = require('../src/prefs')
const A = require('../src/island-actions')
const S = require('../src/screen-share')
const R = require('../src/recorder')
const { toImageRect, dragRect } = require('../src/area-select')
const I = require('../src/island-window')

test('the menu: Screenshot (three ways), Record, Share, Attach, Voice note, Open in app', () => {
  assert.deepEqual(A.MENU.map((m) => m.label), ['Screenshot', 'Record screen', 'Share what’s on screen with Manager', 'Attach file', 'Voice note', 'Open Manager in app'])
  assert.deepEqual(A.MENU[0].submenu.map((m) => m.label), ['Whole screen', 'This window', 'Select area'])
  assert.deepEqual(A.ACTION_IDS, ['screenshot-display', 'screenshot-window', 'screenshot-area', 'record', 'share', 'attach', 'voice', 'open-app'])
  for (const level of [A.MENU, A.MENU[0].submenu]) {
    const keys = level.map((m) => m.key)
    assert.equal(new Set(keys).size, keys.length, 'one key per row')
  }
  assert.equal(A.validAction('record'), 'record')
  assert.equal(A.validAction('screenshot'), null, 'the parent row is not an action')
  assert.equal(A.validAction('rm -rf'), null)
})

test('the page\'s menu is the same as island-actions.js MENU', () => {
  const page = fs.readFileSync(path.join(__dirname, '../src/island-view.js'), 'utf8')
  const block = page.slice(page.indexOf('const MENU = ['), page.indexOf('const MENU_MS'))
  const ids = [...block.matchAll(/id: '([a-z-]+)'/g)].map((m) => m[1])
  const want = A.MENU.flatMap((m) => [m.id, ...(m.submenu || []).map((s) => s.id)])
  assert.deepEqual(ids, want)
  const labels = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1])
  assert.deepEqual(labels, A.MENU.flatMap((m) => [m.label, ...(m.submenu || []).map((s) => s.label)]))
})

test('an attached file: shown under ~, and a message gains its place, not its contents', () => {
  const home = os.homedir()
  assert.equal(A.shownPath(path.join(home, 'Documents', 'r.pdf'), home), path.join('~', 'Documents', 'r.pdf').replace(/^~/, '~'))
  assert.equal(A.shownPath('/etc/hosts', home), '/etc/hosts')
  assert.equal(A.withFile('Have a look', path.join(home, 'a.txt')), `Have a look\n\nAttached file: ~${path.sep}a.txt`)
  assert.equal(A.withFile('', path.join(home, 'a.txt')), `Attached file: ~${path.sep}a.txt`)
  assert.equal(A.withFile('  hi  ', null), 'hi')
})

test('what the composer is told: only safe previews, a name for the file, never its path alone', () => {
  const v = A.attachmentsView({ screenshot: { preview: 'data:image/jpeg;base64,AAAA', width: 10.7, height: 5, source: 'window' }, file: { path: '/Users/x/report.pdf' }, saved: { kind: 'voice', name: 'Voice note.webm', durationMs: 4200, path: '/secret' }, notice: { message: 'Hi', settings: 1 }, localTools: false })
  assert.deepEqual(v.screenshot, { preview: 'data:image/jpeg;base64,AAAA', width: 10, height: 5, source: 'window' })
  assert.deepEqual(v.file, { name: 'report.pdf', shown: '/Users/x/report.pdf', readable: false })
  assert.deepEqual(v.saved, { kind: 'voice', name: 'Voice note.webm', durationMs: 4200 })
  assert.equal('path' in v.saved, false)
  assert.deepEqual(v.notice, { message: 'Hi', settings: true, turnOn: false })
  assert.equal(A.attachmentsView({ screenshot: { preview: 'javascript:alert(1)' } }).screenshot.preview, null)
  assert.deepEqual(A.noticeFromRefusal({ status: 'refused', code: 'disabled', message: 'm' }), { message: 'm', settings: false, turnOn: true })
  assert.equal(A.noticeFromRefusal({ status: 'ok' }), null)
})

// --- screen-share.js: the new sources ---------------------------------------

function fakeImage (width = 1920, height = 1080) {
  const img = {
    getSize: () => ({ width, height }),
    isEmpty: () => false,
    resize: ({ width: w }) => fakeImage(w, Math.round(height * (w / width))),
    crop: (r) => fakeImage(r.width, r.height),
    toPNG: () => Buffer.alloc(100),
    toJPEG: () => Buffer.alloc(50),
  }
  return img
}

function broker (over = {}) {
  const calls = { capture: [], indicator: [] }
  const share = S.createScreenShare({
    isEnabled: () => true,
    platform: 'win32',
    capture: async (opts) => { calls.capture.push(opts); return fakeImage() },
    indicator: { show: () => calls.indicator.push(true), hide: () => calls.indicator.push(false) },
    ...over,
  })
  return { share, calls }
}

test('screen share: a window, or an area the user drags out (the indicator up all the while)', async () => {
  const w = broker()
  const win = await w.share.request({ reason: 'button', botId: 'manager', source: 'window' })
  assert.equal(win.status, 'ok')
  assert.equal(w.calls.capture[0].source, 'window')
  assert.equal(w.share.peek('manager').source, 'window')

  let indicatorDuringSelect = null
  const a = broker({ select: async (image) => { indicatorDuringSelect = true; assert.equal(image.getSize().width, 1920); return { x: 100, y: 50, width: 400, height: 300 } } })
  const area = await a.share.request({ reason: 'button', botId: 'manager', source: 'area' })
  assert.equal(area.status, 'ok')
  assert.deepEqual([area.width, area.height], [400, 300], 'cropped')
  assert.equal(a.calls.capture[0].source, 'display')
  assert.equal(indicatorDuringSelect, true)
  assert.deepEqual(a.calls.indicator, [true, false])
  assert.equal(a.share.peek('manager').source, 'display', 'an area is sent as part of the display')

  const c = broker({ select: async () => null })
  const cancelled = await c.share.request({ reason: 'button', botId: 'manager', source: 'area' })
  assert.deepEqual([cancelled.status, cancelled.code], ['refused', 'selection_cancelled'])
  assert.equal(c.share.has('manager'), false, 'nothing held')

  assert.equal((await broker().share.request({ reason: 'button', botId: 'manager', source: 'everything' })).code, 'not_requested')
  assert.equal((await broker().share.request({ reason: 'timer', botId: 'manager', source: 'window' })).code, 'not_requested')
  assert.equal((await broker({ isEnabled: () => false }).share.request({ reason: 'button', botId: 'manager', source: 'area' })).code, 'disabled')
})

test('cropRect: whole pixels inside the image, at least 8px; junk is null', () => {
  const img = fakeImage(100, 80)
  assert.deepEqual(S.cropRect({ x: 10.4, y: 5.6, width: 50.2, height: 30 }, img), { x: 10, y: 6, width: 50, height: 30 })
  assert.deepEqual(S.cropRect({ x: 90, y: 70, width: 50, height: 50 }, img), { x: 90, y: 70, width: 10, height: 10 }, 'clipped to the image')
  for (const bad of [null, {}, { x: 0, y: 0, width: 4, height: 40 }, { x: 'a', y: 0, width: 10, height: 10 }]) assert.equal(S.cropRect(bad, img), null)
})

test('Select area: the overlay\'s rectangle in the capture\'s pixels', () => {
  assert.deepEqual(dragRect({ x: 50, y: 40 }, { x: 10, y: 100 }), { x: 10, y: 40, width: 40, height: 60 })
  assert.deepEqual(toImageRect({ x: 10, y: 20, width: 100, height: 50 }, { width: 1512, height: 982 }, { width: 3024, height: 1964 }), { x: 20, y: 40, width: 200, height: 100 })
  assert.equal(toImageRect({ x: 'x' }, { width: 1, height: 1 }, { width: 1, height: 1 }), null)
})

// --- recorder.js ---------------------------------------------------------------

test('recordings: a dated name without colons, never over an existing file; mm:ss; chunks checked', () => {
  const d = new Date(2026, 10, 28, 9, 41, 7)
  assert.equal(R.fileName('screen', d), 'Screen recording 2026-11-28 at 09.41.07.webm')
  assert.equal(R.fileName('voice', d), 'Voice note 2026-11-28 at 09.41.07.webm')
  const taken = new Set(['/m/a.webm', '/m/a (2).webm'])
  assert.equal(R.freePath('/m', 'a.webm', (p) => taken.has(p)), path.join('/m', 'a (3).webm'))
  assert.deepEqual([R.clock(0), R.clock(65_400), R.clock(3_725_000)], ['00:00', '01:05', '1:02:05'])
  assert.equal(R.validChunk(new Uint8Array([1, 2, 3])).length, 3)
  assert.equal(R.validChunk('nope'), null)
  assert.equal(R.validChunk(new Uint8Array(0)), null)
  assert.equal(R.validChunk(Buffer.alloc(R.LIMITS.maxChunkBytes + 1)), null)
  assert.equal(R.LIMITS.maxMs, 30 * 60 * 1000)
})

test('the recorder page and the overlay are offline local pages; the recorder only records when armed', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')
  for (const html of ['recorder.html', 'area-select.html']) assert.match(read(html), /default-src 'none'.*connect-src 'none'/)
  const rec = read('recorder.js')
  assert.match(rec, /Boolean\(contents && fromRecorderContents\(contents\) && allowed\(permission, details\)\)/)
  assert.match(rec, /if \(!rec\) return false/)
  assert.match(rec, /request\?\.frame\?\.url !== HTML_URL\) return callback\(\{\}\)/)
  for (const f of ['recorder-view.js', 'area-select-view.js']) assert.doesNotMatch(read(f), /innerHTML|fetch\(|XMLHttpRequest|eval\(/)
})

// --- The controller ---------------------------------------------------------------

const display = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }

function fakeElectron () {
  const windows = []
  class BrowserWindow extends EventEmitter {
    constructor (options) {
      super()
      this.visible = false
      this.bounds = { x: 0, y: 0, width: options.width, height: options.height }
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

function fakeIpc () {
  const handlers = {}
  return {
    on: (ch, fn) => { handlers[ch] = fn },
    handle: (ch, fn) => { handlers[ch] = fn },
    emit (ch, win, payload, { url = I.HTML_URL } = {}) { return handlers[ch]({ sender: win.webContents, senderFrame: { url } }, payload) },
  }
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)) }
const msg = (id, role, body) => ({ id, role, body, created_at: null })

async function start ({ attachments = ['screenshot'], screenResult = null, pickFile = async () => null, attachmentError = null, localTools = () => true } = {}) {
  const calm = widgetStateFrom({ ...fixture, chat_attachments: attachments, manager: { ...fixture.manager, mood: 'idle', state: { ...fixture.manager.state, waiting: null } }, seats: [] })
  const store = { get: () => calm, onChange: () => () => {} }
  const requests = []
  let held = null
  const screenShare = {
    async request (input) {
      requests.push(input)
      const r = screenResult || { status: 'ok', botId: 'manager', width: 1920, height: 1080, preview: 'data:image/jpeg;base64,AAAA' }
      if (r.status === 'ok') held = { mime: 'image/png', data: Buffer.from('png'), width: 1920, height: 1080, source: input.source === 'window' ? 'window' : 'display', capturedAt: Date.now() }
      return r
    },
    peek: () => held,
    has: () => Boolean(held),
    discard: () => { held = null; return true },
  }
  const sends = []
  const feed = {
    isSignedIn: () => true,
    conversation: async () => ({ bot_id: 'manager', messages: [msg('1', 'assistant', 'Hi')], pending: null }),
    async sendMessage (input, options) {
      sends.push([input, options])
      if (attachmentError) return { attachment_error: attachmentError }
      return { bot_id: 'manager', messages: [msg('1', 'assistant', 'Hi'), msg('2', 'user', input.body || 'Shared my screen')], pending: null }
    },
  }
  const rec = { starts: [], stops: 0, start: async (kind) => { rec.starts.push(kind); return true }, stop: () => { rec.stops++ } }
  const shown = []
  const opened = []
  const electron = fakeElectron()
  const prefs = createPrefs({ platform: 'darwin' })
  const island = I.createIslandController({
    store, prefs, feed, getMainWindow: () => null, openBot: (id) => opened.push(id), platform: 'darwin', electron,
    screenShare, recorder: rec, pickFile, statFile: () => ({ isFile: true, size: 10 }), showInFolder: (p) => shown.push(p), localTools,
  })
  const ipc = fakeIpc()
  island.registerIpc(ipc)
  island.sync()
  await flush()
  const win = electron.windows.at(-1)
  ipc.emit('cma-island:ready', win)
  ipc.emit('cma-island:compose', win)
  await flush()
  const last = (ch) => win.sent.filter(([c]) => c === ch).at(-1)?.[1]
  return { island, ipc, win, requests, sends, rec, shown, opened, prefs, held: () => held, composer: () => last('cma-island:composer'), layout: () => last('cma-island:layout'), view: () => last('cma-island:view') }
}

test('Screenshot ▸ This window: through the broker, for the Manager, from the click; then sent with the next message', async () => {
  const t = await start()
  assert.equal(await t.ipc.emit('cma-island:action', t.win, 'screenshot-window'), true)
  assert.deepEqual(t.requests, [{ reason: 'button', botId: 'manager', source: 'window' }])
  assert.deepEqual(t.composer().attachments.screenshot, { preview: 'data:image/jpeg;base64,AAAA', width: 1920, height: 1080, source: 'window' })
  assert.equal(t.composer().screenshots, true)
  assert.equal(await t.ipc.emit('cma-island:send', t.win, 'What is this?'), true)
  const [input, options] = t.sends[0]
  assert.deepEqual(input, { bot_id: 'manager', body: 'What is this?' })
  assert.equal(options.attachment.kind, 'screenshot')
  assert.equal(options.attachment.source, 'window')
  assert.equal(t.held(), null, 'dropped once the server has it')
  assert.equal(t.composer().attachments.screenshot, null)
})

test('no screenshots on this server: nothing is captured, the composer says why', async () => {
  const t = await start({ attachments: [] })
  await t.ipc.emit('cma-island:action', t.win, 'screenshot-display')
  assert.deepEqual(t.requests, [])
  assert.match(t.composer().attachments.notice.message, /can’t be sent/)
})

test('a refusal from the broker (the switch off) is a notice with Turn on; Turn on flips the same switch', async () => {
  const t = await start({ screenResult: { status: 'refused', code: 'disabled', message: S.MESSAGES.disabled } })
  await t.ipc.emit('cma-island:action', t.win, 'screenshot-area')
  assert.deepEqual(t.composer().attachments.notice, { message: S.MESSAGES.disabled, settings: false, turnOn: true })
  t.ipc.emit('cma-island:attachment', t.win, { op: 'turn-on', what: 'notice' })
  assert.equal(t.prefs.get().shareScreen, true)
  assert.equal(t.composer().attachments.notice, null)
})

test('Share what\'s on screen: a whole-screen capture, sent at once', async () => {
  const t = await start()
  await t.ipc.emit('cma-island:action', t.win, 'share')
  assert.equal(t.requests[0].source, 'display')
  assert.equal(t.sends.length, 1)
  assert.equal(t.sends[0][0].body, '')
  assert.equal(t.sends[0][1].attachment.kind, 'screenshot')
})

test('the server refusing the screenshot: dropped, the text kept, the reason shown', async () => {
  const t = await start({ attachmentError: 'attachment_too_large' })
  await t.ipc.emit('cma-island:action', t.win, 'screenshot-display')
  assert.equal(await t.ipc.emit('cma-island:send', t.win, 'Look'), false)
  assert.equal(t.held(), null)
  assert.equal(t.composer().attachments.notice.message, S.MESSAGES.attachment_too_large)
})

test('Attach file: the user\'s pick stays here; the message names its place; Show in Finder; remove', async () => {
  const file = path.join(os.homedir(), 'Documents', 'plan.pdf')
  const t = await start({ pickFile: async () => file })
  await t.ipc.emit('cma-island:action', t.win, 'attach')
  assert.deepEqual(t.composer().attachments.file, { name: 'plan.pdf', shown: A.shownPath(file), readable: true })
  assert.equal(JSON.stringify(t.composer()).includes(os.homedir()), false, 'the page never gets the full path')
  t.ipc.emit('cma-island:attachment', t.win, { op: 'reveal', what: 'file' })
  assert.deepEqual(t.shown, [file])
  await t.ipc.emit('cma-island:send', t.win, 'Summarise this')
  assert.equal(t.sends[0][0].body, `Summarise this\n\nAttached file: ${A.shownPath(file)}`)
  assert.equal(t.sends[0][1], undefined, 'no upload')
  assert.equal(t.composer().attachments.file, null)
})

test('Attach file without local tools: the chip says the Manager can\'t open it', async () => {
  const t = await start({ pickFile: async () => '/tmp/x.txt', localTools: () => false })
  await t.ipc.emit('cma-island:action', t.win, 'attach')
  assert.equal(t.composer().attachments.file.readable, false)
})

test('Record screen: starts the recorder and collapses to the pill; the pill shows the timer; its click stops', async () => {
  const t = await start()
  await t.ipc.emit('cma-island:action', t.win, 'record')
  assert.deepEqual(t.rec.starts, ['screen'])
  assert.equal(t.layout().composing, false)
  t.island.setRecording({ recording: { kind: 'screen', startedAt: Date.now() - 65_000 } })
  const v = t.view()
  assert.equal(v.mode, 'recording')
  assert.deepEqual(v.chip, { kind: 'recording', label: 'Recording' })
  assert.ok(v.recording.elapsedMs >= 65_000)
  t.ipc.emit('cma-island:stop-recording', t.win)
  assert.equal(t.rec.stops, 1)
  t.island.setRecording({ recording: null })
  assert.notEqual(t.view().mode, 'recording')
})

test('a saved recording opens the composer with Show in Finder; it is never sent', async () => {
  const t = await start()
  t.ipc.emit('cma-island:collapse', t.win)
  t.island.recordingSaved({ kind: 'voice', path: '/Users/x/Movies/Configure My AI/Voice note.webm', name: 'Voice note.webm', durationMs: 4000 })
  assert.equal(t.layout().composing, true)
  assert.deepEqual(t.composer().attachments.saved, { kind: 'voice', name: 'Voice note.webm', durationMs: 4000 })
  t.ipc.emit('cma-island:attachment', t.win, { op: 'reveal', what: 'saved' })
  assert.deepEqual(t.shown, ['/Users/x/Movies/Configure My AI/Voice note.webm'])
  await t.ipc.emit('cma-island:send', t.win, 'hi')
  assert.equal(t.sends[0][1], undefined)
})

test('a recording the OS refused: the notice (with the settings button on macOS)', async () => {
  const t = await start()
  t.island.recordingError('permission', 'screen')
  assert.deepEqual([t.composer().attachments.notice.message, t.composer().attachments.notice.settings], [A.NOTICES.recording_permission, true])
  t.island.recordingError('permission', 'voice')
  assert.equal(t.composer().attachments.notice.message, A.NOTICES.voice_permission)
})

test('while a dialog has the focus the island stays open', async () => {
  let release
  const t = await start({ pickFile: () => new Promise((resolve) => { release = resolve }) })
  const pending = t.ipc.emit('cma-island:action', t.win, 'attach')
  t.win.emit('blur')
  assert.equal(t.layout().composing, true, 'not closed by the dialog taking focus')
  release(null)
  await pending
  t.win.emit('blur')
  assert.equal(t.layout().composing, false, 'a blur afterwards closes it as before')
})

test('Open Manager in app; junk actions and other pages are refused', async () => {
  const t = await start()
  assert.equal(await t.ipc.emit('cma-island:action', t.win, 'rm -rf /'), false)
  assert.equal(await t.ipc.emit('cma-island:action', t.win, { id: 'record' }), false)
  assert.equal(await t.ipc.emit('cma-island:action', t.win, 'record', { url: 'https://configuremyai.com/' }), false)
  t.ipc.emit('cma-island:attachment', t.win, { op: 'reveal', what: '/etc/passwd' })
  assert.deepEqual([t.rec.starts, t.shown], [[], []])
  await t.ipc.emit('cma-island:action', t.win, 'open-app')
  assert.deepEqual(t.opened, ['manager'])
  assert.equal(t.layout().composing, false)
  assert.equal(await t.ipc.emit('cma-island:action', t.win, 'record'), false, 'only while the composer is open')
})
