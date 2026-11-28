const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const S = require('../src/screen-share')
const { composeFrom, ATTACHMENT_TIMEOUT_MS } = require('../src/widget-chat')
const { withScreenIndicator, SCREEN_CHIP } = require('../src/island-window')
const { widgetView } = require('../src/widget-window')
const { widgetStateFrom } = require('../src/widget-state')
const fixture = require('./fixtures/widget.json')

const read = (f) => fs.readFileSync(path.join(__dirname, '../src', f), 'utf8')

// A NativeImage stand-in: a size, and PNG/JPEG buffers of chosen lengths.
function fakeImage ({ width = 1440, height = 900, png = 1000, jpeg = 500, empty = false } = {}) {
  return {
    isEmpty: () => empty,
    getSize: () => ({ width, height }),
    resize ({ width: w }) { return fakeImage({ width: w, height: Math.round(height * (w / width)), png, jpeg }) },
    toPNG: () => Buffer.alloc(png, 1),
    toJPEG: () => Buffer.alloc(jpeg, 2),
  }
}

// A broker with everything recorded, and an indicator whose state the
// capture can observe.
function broker (overrides = {}) {
  const calls = { capture: 0, status: 0, explain: 0, indicator: [] }
  const indicator = S.createIndicator({ onChange: (on) => calls.indicator.push(on), minMs: 0 })
  let onDuringCapture = null
  const share = S.createScreenShare({
    isEnabled: () => true,
    platform: 'darwin',
    env: {},
    getMediaAccessStatus: () => { calls.status++; return 'granted' },
    explain: async () => { calls.explain++; return true },
    capture: async () => { calls.capture++; onDuringCapture = indicator.on; return fakeImage() },
    indicator,
    ...overrides,
  })
  return { share, calls, indicator, duringCapture: () => onDuringCapture }
}

// --- The permission state machine -----------------------------------------

test('macOS permission states map to granted / denied / restricted / not-determined', () => {
  const at = (status) => S.permissionState({ platform: 'darwin', getMediaAccessStatus: (t) => { assert.equal(t, 'screen'); return status } })
  assert.equal(at('granted'), 'granted')
  assert.equal(at('denied'), 'denied')
  assert.equal(at('restricted'), 'restricted')
  assert.equal(at('not-determined'), 'not-determined')
  assert.equal(at('unknown'), 'not-determined', 'an older macOS: the capture asks')
  assert.equal(S.permissionState({ platform: 'darwin', getMediaAccessStatus: () => { throw new Error('x') } }), 'not-determined')
})

test('Windows and Linux have no up-front permission', () => {
  for (const platform of ['win32', 'linux']) {
    assert.equal(S.permissionState({ platform, getMediaAccessStatus: () => 'denied' }), 'granted')
  }
})

test('what each permission state leads to', () => {
  assert.equal(S.permissionAction('granted'), 'capture')
  assert.equal(S.permissionAction('not-determined'), 'explain')
  assert.equal(S.permissionAction('denied'), 'refuse')
  assert.equal(S.permissionAction('restricted'), 'refuse')
  assert.equal(S.permissionAction('anything else'), 'refuse')
})

test('granted: captures, holds the image for that bot, and gives back a preview only', async () => {
  const { share, calls } = broker()
  const r = await share.request({ reason: 'button', botId: 'manager' })
  assert.equal(r.status, 'ok')
  assert.equal(calls.capture, 1)
  assert.equal(calls.explain, 0)
  assert.match(r.preview, /^data:image\/jpeg;base64,/)
  assert.equal(r.data, undefined, 'the full image never leaves main')
  assert.equal(r.data_base64, undefined)
  assert.ok(share.has('manager'))
  assert.ok(!share.has('other-bot'))
})

test('denied or restricted: refused with the System Settings link, nothing captured', async () => {
  for (const status of ['denied', 'restricted']) {
    const { share, calls } = broker({ getMediaAccessStatus: () => status })
    const r = await share.request({ reason: 'button', botId: 'manager' })
    assert.equal(r.status, 'refused')
    assert.equal(r.code, 'permission_denied')
    assert.equal(r.settingsUrl, 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
    assert.equal(calls.capture, 0)
    assert.equal(calls.explain, 0)
  }
})

test('not-determined: the explainer first; "Not Now" captures nothing', async () => {
  const { share, calls } = broker({ getMediaAccessStatus: () => 'not-determined', explain: async () => false })
  const r = await share.request({ reason: 'button', botId: 'manager' })
  assert.equal(r.code, 'explainer_declined')
  assert.equal(calls.capture, 0)
})

test('not-determined: Continue raises the system prompt via the capture; a grant goes through', async () => {
  const statuses = ['not-determined', 'granted']
  const { share, calls } = broker({ getMediaAccessStatus: () => statuses.shift() })
  const r = await share.request({ reason: 'button', botId: 'manager' })
  assert.equal(r.status, 'ok')
  assert.equal(calls.capture, 1)
})

test('not-determined: a denial at the system prompt is reported, and nothing is held', async () => {
  const statuses = ['not-determined', 'denied']
  const { share } = broker({ getMediaAccessStatus: () => statuses.shift() })
  const r = await share.request({ reason: 'button', botId: 'manager' })
  assert.equal(r.code, 'permission_denied')
  assert.ok(r.settingsUrl)
  assert.ok(!share.has('manager'))
})

test('the explainer is one line and says where the screenshot goes', () => {
  assert.equal(S.EXPLAINER.message.split('\n').length, 1)
  assert.match(S.EXPLAINER.detail, /only captures your screen when you ask/)
  assert.match(S.EXPLAINER.detail, /nothing is saved on this computer/)
})

// --- No capture without an explicit request; the switch -------------------

test('no capture without an explicit user request', async () => {
  for (const reason of [undefined, '', 'bot', 'timer', 'background', 'tool_call', 'BUTTON']) {
    const { share, calls } = broker()
    const r = await share.request({ reason, botId: 'manager' })
    assert.equal(r.code, 'not_requested', String(reason))
    assert.equal(calls.capture, 0)
    assert.equal(calls.status, 0, 'the OS is not even asked')
  }
  const { share, calls } = broker()
  assert.equal((await share.request({ reason: 'button' })).code, 'not_requested', 'no bot: no chat turn to attach to')
  assert.equal((await share.request()).code, 'not_requested')
  assert.equal(calls.capture, 0)
})

test('the switch off: capture refused before anything else', async () => {
  const { share, calls } = broker({ isEnabled: () => false })
  for (const reason of S.EXPLICIT_REASONS) {
    const r = await share.request({ reason, botId: 'manager' })
    assert.equal(r.code, 'disabled')
    assert.match(r.message, /Let Manager see your screen/)
  }
  assert.equal(calls.capture, 0)
  assert.equal(calls.status, 0)
  assert.equal(calls.explain, 0)
})

test('one capture at a time', async () => {
  let release
  const { share, calls } = broker({ capture: () => new Promise((resolve) => { release = () => resolve(fakeImage()) }) })
  const first = share.request({ reason: 'button', botId: 'manager' })
  await new Promise((r) => setImmediate(r))
  assert.equal(share.busy, true)
  assert.equal((await share.request({ reason: 'button', botId: 'manager' })).code, 'busy')
  release()
  assert.equal((await first).status, 'ok')
  assert.equal(share.busy, false)
  assert.equal(calls.indicator.join(), 'true,false')
})

test('nothing in the app captures on a timer or from a bot: the widget and island IPC are the only callers', () => {
  const sources = fs.readdirSync(path.join(__dirname, '../src')).filter((f) => f.endsWith('.js'))
  const callers = sources.filter((f) => /screenShare\.request\(|\.request\(\{ reason:/.test(read(f)))
  assert.deepEqual(callers, ['island-window.js', 'widget-window.js'])
  // The island's actions menu: the user's click only, never on a timer.
  const iw = read('island-window.js')
  assert.doesNotMatch(iw, /setInterval\([^)]*screen/i)
  for (const m of iw.matchAll(/screenShare\.request\(\{ reason: ([^,]+),/g)) assert.equal(m[1], "'button'")
  const ww = read('widget-window.js')
  assert.doesNotMatch(ww, /setInterval\([^)]*screenShare/)
  // Every request names an explicit reason: the button, or a message asking.
  for (const m of ww.matchAll(/screenShare\.request\(\{ reason: ([^,]+),/g)) {
    assert.match(m[1], /^(input\.reason|'message')$/)
  }
})

// --- The indicator ---------------------------------------------------------

test('the indicator is up for the whole capture and comes down after', async () => {
  const { share, calls, duringCapture } = broker()
  await share.request({ reason: 'button', botId: 'manager' })
  assert.equal(duringCapture(), true)
  assert.deepEqual(calls.indicator, [true, false])
})

test('the indicator comes down even when the capture throws', async () => {
  const { share, calls } = broker({ capture: async () => { throw new Error('boom') }, platform: 'win32' })
  const r = await share.request({ reason: 'button', botId: 'manager' })
  assert.equal(r.code, 'capture_failed')
  assert.deepEqual(calls.indicator, [true, false])
})

test('the indicator is not shown when nothing is captured (refused early)', async () => {
  const { share, calls } = broker({ isEnabled: () => false })
  await share.request({ reason: 'button', botId: 'manager' })
  assert.deepEqual(calls.indicator, [])
})

test('the indicator stays up for its minimum time, and overlapping shows keep it up', () => {
  let t = 0
  const timers = []
  const seen = []
  const ind = S.createIndicator({
    onChange: (on) => seen.push(on),
    minMs: 1500,
    now: () => t,
    setTimer: (fn, ms) => { const timer = { fn, at: t + ms, cleared: false }; timers.push(timer); return timer },
    clearTimer: (timer) => { timer.cleared = true },
  })
  const run = () => { for (const x of timers) if (!x.cleared && x.at <= t) { x.cleared = true; x.fn() } }
  ind.show()
  t = 200
  ind.hide()
  assert.equal(ind.on, true, 'a fast capture is still seen')
  t = 1000; run()
  assert.equal(ind.on, true)
  t = 1500; run()
  assert.equal(ind.on, false)
  assert.deepEqual(seen, [true, false])

  ind.show(); ind.show()
  t = 5000
  ind.hide()
  assert.equal(ind.on, true, 'one capture still running')
  ind.hide()
  assert.equal(ind.on, false, 'past the minimum: down at once')
  ind.hide()
  assert.equal(ind.on, false, 'an extra hide is harmless')
})

test('the island says "Viewing your screen" while capturing, over whatever it showed', () => {
  const view = { idle: false, bot: { id: 'x', name: 'Ada' }, chip: { kind: 'question', label: 'Questions' }, pending: { id: 'p' } }
  assert.equal(withScreenIndicator(view, false), view)
  const on = withScreenIndicator(view, true)
  assert.deepEqual(on.chip, { kind: 'screen', label: 'Viewing your screen' })
  assert.equal(on.capturing, true)
  assert.deepEqual(on.pending, view.pending, 'a pending card is kept')
  assert.equal(withScreenIndicator(null, true), null, 'island off: nothing to show it on')
  assert.equal(SCREEN_CHIP.label, 'Viewing your screen')
  assert.match(read('island.css'), /\.island\[data-chip="screen"\]/)
})

// --- Failures per platform -------------------------------------------------

test('an empty capture: Wayland gets the portal message, macOS the settings link, others a retry', async () => {
  const empty = async () => fakeImage({ empty: true })
  let r = await broker({ platform: 'linux', env: { XDG_SESSION_TYPE: 'wayland' }, capture: empty }).share.request({ reason: 'button', botId: 'm' })
  assert.equal(r.code, 'wayland_unavailable')
  assert.match(r.message, /xdg-desktop-portal/)
  r = await broker({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-1' }, capture: async () => null }).share.request({ reason: 'button', botId: 'm' })
  assert.equal(r.code, 'wayland_unavailable')
  r = await broker({ platform: 'linux', env: { XDG_SESSION_TYPE: 'x11' }, capture: empty }).share.request({ reason: 'button', botId: 'm' })
  assert.equal(r.code, 'capture_failed')
  r = await broker({ platform: 'darwin', capture: empty }).share.request({ reason: 'button', botId: 'm' })
  assert.equal(r.code, 'permission_denied')
  r = await broker({ platform: 'win32', capture: empty }).share.request({ reason: 'button', botId: 'm' })
  assert.equal(r.code, 'capture_failed')
})

test('an image over the cap even as JPEG is refused', async () => {
  const big = async () => fakeImage({ png: S.LIMITS.maxBytes + 1, jpeg: S.LIMITS.maxBytes + 1 })
  const { share } = broker({ capture: big })
  assert.equal((await share.request({ reason: 'button', botId: 'm' })).code, 'too_large')
  assert.ok(!share.has('m'))
})

// --- Encoding and the attachment payload ------------------------------------

test('encodeImage: shrinks to 1920 wide, PNG unless over the cap, then JPEG', () => {
  const small = S.encodeImage(fakeImage({ width: 1440, height: 900 }))
  assert.deepEqual([small.mime, small.width, small.height], ['image/png', 1440, 900])
  const wide = S.encodeImage(fakeImage({ width: 3840, height: 2160 }))
  assert.deepEqual([wide.width, wide.height], [1920, 1080])
  const heavy = S.encodeImage(fakeImage({ png: S.LIMITS.maxBytes + 1, jpeg: 1000 }))
  assert.equal(heavy.mime, 'image/jpeg')
  assert.equal(heavy.tooLarge, false)
  assert.equal(S.encodeImage(null), null)
  assert.equal(S.encodeImage(fakeImage({ empty: true })), null)
  assert.equal(S.encodeImage(fakeImage({ png: 0 })), null)
})

test('the attachment payload: kind, mime, base64, size, source, time — nothing else', () => {
  const held = { mime: 'image/png', data: Buffer.from('PNGDATA'), width: 1440.6, height: 900, source: 'display', capturedAt: Date.parse('2026-11-28T12:00:00Z') }
  const a = S.attachmentPayload(held)
  assert.deepEqual(a, {
    kind: 'screenshot',
    mime: 'image/png',
    data_base64: Buffer.from('PNGDATA').toString('base64'),
    width: 1440,
    height: 900,
    source: 'display',
    captured_at: '2026-11-28T12:00:00.000Z',
  })
  assert.equal(S.attachmentPayload({ ...held, source: 'evil' }).source, 'display')
  assert.equal(S.attachmentPayload({ ...held, mime: 'image/svg+xml' }), null)
  assert.equal(S.attachmentPayload({ ...held, data: 'not a buffer' }), null)
  assert.equal(S.attachmentPayload({ ...held, data: Buffer.alloc(0) }), null)
  assert.equal(S.attachmentPayload({ ...held, data: Buffer.alloc(S.LIMITS.maxBytes + 1) }), null)
  assert.equal(S.attachmentPayload(null), null)
})

test('the chat turn: the attachment rides along; text may be empty only with one', () => {
  const attachment = { kind: 'screenshot', mime: 'image/png', data_base64: 'AAAA', width: 1, height: 1, source: 'display', captured_at: '2026-11-28T12:00:00.000Z' }
  const withShot = composeFrom({ bot_id: 'manager', body: "what's this error?" }, { attachment })
  assert.deepEqual(withShot.body, { body: "what's this error?", attachments: [attachment] })
  assert.equal(withShot.path, '/desktop/widget/bots/manager/messages')
  assert.equal(withShot.timeoutMs, ATTACHMENT_TIMEOUT_MS)
  assert.deepEqual(composeFrom({ bot_id: 'manager', body: '' }, { attachment }).body, { body: '', attachments: [attachment] })
  assert.equal(composeFrom({ bot_id: 'manager', body: '' }), null, 'no text and no screenshot: nothing to send')
  const plain = composeFrom({ bot_id: 'manager', body: 'hi' })
  assert.deepEqual(plain.body, { body: 'hi' })
  assert.equal(plain.timeoutMs, undefined)
  // The renderer cannot smuggle an attachment in: only main's option counts.
  assert.deepEqual(composeFrom({ bot_id: 'manager', body: 'hi', attachments: [attachment] }).body, { body: 'hi' })
})

// --- Holding the screenshot ----------------------------------------------

test('a held screenshot: peeked for the send, discarded after; dropped after five minutes', async () => {
  let t = 1_000_000
  const { share } = broker({ now: () => t })
  await share.request({ reason: 'button', botId: 'manager' })
  assert.ok(share.peek('manager'))
  assert.ok(share.has('manager'), 'peek leaves it for a retry')
  assert.equal(share.take('manager').mime, 'image/png')
  assert.equal(share.take('manager'), null)
  await share.request({ reason: 'button', botId: 'manager' })
  share.discard('manager')
  assert.equal(share.peek('manager'), null)
  await share.request({ reason: 'button', botId: 'manager' })
  t += S.LIMITS.heldMs + 1
  assert.equal(share.peek('manager'), null)
  await share.request({ reason: 'button', botId: 'a' })
  await share.request({ reason: 'button', botId: 'b' })
  share.discard()
  assert.ok(!share.has('a') && !share.has('b'), 'discard() drops them all')
})

// --- Messages that ask about the screen -----------------------------------

test('only a message that names the screen counts as asking for it', () => {
  for (const text of ["what's this error?", 'What is this dialog', 'can you look at my screen', 'do X on my screen', 'take a screenshot', 'share my screen', 'what am I looking at on screen']) {
    assert.ok(S.asksAboutScreen(text), text)
  }
  for (const text of ['hi', 'fix the error in the build', 'what is the plan', 'screen the candidates', '', null, 42]) {
    assert.ok(!S.asksAboutScreen(text), String(text))
  }
})

// --- The switch, in the menus and the widget -------------------------------

test('"Let Manager See Your Screen" menu item follows and sets the pref', () => {
  let current = { shareScreen: false }
  const listeners = []
  const prefs = { get: () => current, set: (p) => { current = { ...current, ...p }; listeners.forEach((fn) => fn(current)) }, onChange: (fn) => listeners.push(fn) }
  const item = S.shareScreenMenuItem(prefs)
  assert.deepEqual([item.id, item.label, item.type, item.checked], ['share-screen', 'Let Manager See Your Screen', 'checkbox', false])
  item.click({ checked: true })
  assert.equal(current.shareScreen, true)
  const menuItem = { checked: false }
  S.syncShareScreenMenuItem({ getMenuItemById: (id) => (id === 'share-screen' ? menuItem : null) }, prefs)
  assert.equal(menuItem.checked, true)
  prefs.set({ shareScreen: false })
  assert.equal(menuItem.checked, false)
})

test('the widget offers Share screen only when the server takes screenshots', () => {
  const without = widgetStateFrom(fixture)
  assert.deepEqual(without.chat_attachments, [])
  assert.deepEqual(widgetView(without, { shareScreen: true }).screen_share, { available: false, enabled: true })
  const withIt = widgetStateFrom({ ...fixture, chat_attachments: ['screenshot', 'video', 7] })
  assert.deepEqual(withIt.chat_attachments, ['screenshot'], 'only kinds we know')
  assert.deepEqual(widgetView(withIt).screen_share, { available: true, enabled: false })
})

// --- IPC origin gating ------------------------------------------------------

test('the widget\'s screen IPC is gated to the widget page and the open chat', () => {
  const ww = read('widget-window.js')
  const handler = ww.slice(ww.indexOf("ipcMain.handle('cma-widget:share-screen'"), ww.indexOf("ipcMain.on('cma-widget:discard-screen'"))
  assert.match(handler, /if \(!fromWidget\(event\) \|\| !screenShare/)
  assert.match(handler, /botId !== openBotId/, 'only for the chat that is open')
  assert.match(handler, /EXPLICIT_REASONS\.includes\(input\.reason\)/)
  assert.match(handler, /if \(!screenAvailable\(\)\) return null/)
  const send = ww.slice(ww.indexOf("ipcMain.handle('cma-widget:send'"))
  assert.match(send.slice(0, 120), /if \(!fromWidget\(event\)\) return null/)
  for (const channel of ['discard-screen', 'screen-settings', 'set-share-screen']) {
    const at = ww.indexOf(`ipcMain.on('cma-widget:${channel}'`)
    assert.ok(at > 0, channel)
    assert.match(ww.slice(at, at + 200), /fromWidget\(event\)/, channel)
  }
  // The settings pane is a fixed URL opened by main; the renderer sends none.
  assert.match(read('widget-preload.js'), /openScreenSettings: \(\) => ipcRenderer\.send\('cma-widget:screen-settings'\)/)
  assert.match(read('screen-share-main.js'), /shell\.openExternal\(SCREEN_SETTINGS_URL\)/)
})

test('the Local Computer Access switch is gated to its own window', () => {
  const lt = read('local-tools-main.js')
  const at = lt.indexOf("ipcMain.handle('lt:set-share-screen'")
  assert.ok(at > 0)
  assert.match(lt.slice(at, at + 160), /if \(!fromWindow\(event, settingsWindow\) \|\| !prefs\) return false/)
  assert.match(lt.slice(at, at + 200), /shareScreen: on === true/)
})

test('the Settings window explains what is captured, when, and where it goes', () => {
  const html = read('local-tools-settings.html')
  assert.match(html, /id="share-screen"/)
  assert.match(html, /Let Manager see your screen/)
  assert.match(html, /What’s captured:/)
  assert.match(html, /When:/)
  assert.match(html, /Where it goes:/)
  assert.match(html, /never saved on this computer/)
})

test('the new modules are in the check script', () => {
  const pkg = require('../package.json')
  assert.match(pkg.scripts.check, /node --check src\/screen-share\.js/)
  assert.match(pkg.scripts.check, /node --check src\/screen-share-main\.js/)
})

// --- What comes back: messages with attachments ------------------------------

test('a message\'s screenshot is kept with its size, and a url only on our origin', () => {
  const { conversationFrom, attachmentError, SCREENSHOT_ONLY_BODY } = require('../src/widget-chat')
  const conv = conversationFrom({
    bot_id: 'manager',
    messages: [
      { id: 'u1', role: 'user', body: 'look', attachments: [{ kind: 'screenshot', mime: 'image/png', width: 1440, height: 900, url: 'https://configuremyai.com/rails/active_storage/a.png' }] },
      { id: 'u2', role: 'user', body: '', attachments: [{ kind: 'screenshot', mime: 'image/jpeg', width: 10, height: 10, url: 'https://evil.example/a.png' }] },
      { id: 'u3', role: 'user', body: '', attachments: [{ kind: 'video' }] },
      { id: 'a1', role: 'assistant', body: 'I see a dialog.' },
    ],
  }, 'manager')
  assert.deepEqual(conv.messages.map((m) => m.id), ['u1', 'u2', 'a1'], 'an empty message with no screenshot is dropped')
  assert.deepEqual(conv.messages[0].attachments, [{ kind: 'screenshot', mime: 'image/png', width: 1440, height: 900, url: 'https://configuremyai.com/rails/active_storage/a.png' }])
  assert.equal(conv.messages[0].screenshot, true)
  assert.equal(conv.messages[1].attachments[0].url, null, 'off-origin url dropped')
  assert.equal(conv.messages[1].body, SCREENSHOT_ONLY_BODY)
  assert.equal(conv.messages[2].screenshot, undefined)
  assert.match(read('widget-view.js'), new RegExp(`SCREENSHOT_ONLY_BODY = '${SCREENSHOT_ONLY_BODY}'`), 'the bubble text matches main\'s')

  assert.equal(attachmentError({ status: 413, json: null }), 'attachment_too_large')
  assert.equal(attachmentError({ status: 413, json: { error: 'attachment_too_large' } }), 'attachment_too_large')
  assert.equal(attachmentError({ status: 422, json: { error: 'attachment_invalid' } }), 'attachment_invalid')
  assert.equal(attachmentError({ status: 422, json: { error: 'invalid_authenticity_token' } }), null, 'a stale token is not an attachment error')
  assert.equal(attachmentError(null), null)
})

test('the thread marks a bubble that carried a screenshot', () => {
  const ChatFormat = require('../src/chat-format')
  const items = ChatFormat.threadItems([{ id: 'u1', role: 'user', body: 'look', screenshot: true, created_at: null }, { id: 'a1', role: 'assistant', body: 'ok', created_at: null }], { outbox: [{ key: 'out:1', body: 'Shared my screen', screenshot: true, failed: false }] })
  const byKey = Object.fromEntries(items.map((i) => [i.key, i]))
  assert.equal(byKey.u1.screenshot, true)
  assert.equal(byKey.a1.screenshot, undefined)
  assert.equal(byKey['out:1'].screenshot, true)
  assert.match(read('widget.css'), /\.message\.has-screenshot::before/)
})
