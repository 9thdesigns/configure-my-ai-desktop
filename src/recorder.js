'use strict'

// Record screen and Voice note (the island's actions menu): a hidden page in
// its own session records with MediaRecorder — the display under the pointer
// (getDisplayMedia, answered by main's display-media handler only while a
// screen recording is armed) or the microphone (getUserMedia, allowed for
// that page only while a voice note is armed) — and streams the chunks to
// main, which writes them to the user's Movies folder:
//
//   ~/Movies/Configure My AI/Screen recording 2026-11-28 at 09.41.07.webm
//   ~/Movies/Configure My AI/Voice note 2026-11-28 at 09.41.07.webm
//
// (app.getPath('videos') off macOS: ~/Videos, the Videos library.) Nothing
// is uploaded: the web app takes screenshots only, so a recording stays on
// this computer and the island offers "Show in Finder".
//
// The rules are pure (test/recorder.test.js): names, chunk checks, the
// caps and the timer's text; createRecorder is the Electron half.

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const KINDS = Object.freeze(['screen', 'voice'])
const FOLDER = 'Configure My AI'
const LIMITS = Object.freeze({
  maxMs: 30 * 60 * 1000, // a recording stops itself after 30 minutes
  maxChunkBytes: 16 * 1024 * 1024,
  maxBytes: 2 * 1024 * 1024 * 1024,
  timesliceMs: 1000,
})
const LABEL = Object.freeze({ screen: 'Screen recording', voice: 'Voice note' })

const pad = (n) => String(n).padStart(2, '0')

// "Screen recording 2026-11-28 at 09.41.07.webm" (local time, no colons:
// they are not allowed in macOS Finder names or on Windows).
function fileName (kind, date = new Date()) {
  const d = date
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`
  return `${LABEL[kind] || LABEL.screen} ${stamp}.webm`
}

// A name that doesn't clash with a file already there: "… (2).webm".
function freePath (dir, name, exists = fs.existsSync) {
  let candidate = path.join(dir, name)
  const ext = path.extname(name)
  const base = name.slice(0, -ext.length)
  for (let i = 2; exists(candidate) && i < 1000; i++) candidate = path.join(dir, `${base} (${i})${ext}`)
  return candidate
}

// mm:ss (h:mm:ss past an hour), for the island's timer.
function clock (ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

// A chunk from the recorder page: bytes, not too many. → Buffer | null.
function validChunk (input) {
  if (!input) return null
  let buf = null
  if (Buffer.isBuffer(input)) buf = input
  else if (input instanceof Uint8Array) buf = Buffer.from(input.buffer, input.byteOffset, input.byteLength)
  else if (input instanceof ArrayBuffer) buf = Buffer.from(input)
  if (!buf || buf.length === 0 || buf.length > LIMITS.maxChunkBytes) return null
  return buf
}

// May we record? macOS gates the screen behind Screen Recording (the same
// permission, and the same first-time explainer, as a screenshot:
// screen-share.js) and a voice note behind the microphone. Elsewhere, yes.
const RECORDING_EXPLAINER = Object.freeze({
  message: 'Record your screen?',
  detail: 'macOS will ask for Screen Recording permission. The recording is saved on this computer, in Movies → Configure My AI; nothing is uploaded.',
})
async function recordingPermission (kind, { platform = process.platform, electron = require('electron') } = {}) {
  if (platform !== 'darwin') return true
  const { systemPreferences, dialog } = electron
  if (kind === 'voice') {
    if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true
    return Boolean(await systemPreferences.askForMediaAccess('microphone').catch(() => false))
  }
  const { permissionState, permissionAction } = require('./screen-share')
  const action = permissionAction(permissionState({ platform, getMediaAccessStatus: (t) => systemPreferences.getMediaAccessStatus(t) }))
  if (action === 'capture') return true
  if (action === 'refuse') return false
  const { response } = await dialog.showMessageBox({ type: 'info', buttons: ['Continue', 'Not Now'], defaultId: 0, cancelId: 1, ...RECORDING_EXPLAINER })
  return response === 0
}

const HTML_PATH = path.join(__dirname, 'recorder.html')
const HTML_URL = pathToFileURL(HTML_PATH).href
const PARTITION = 'cma-recorder'

// One recording at a time.
//   folder()         — where recordings go (app.getPath('videos')/FOLDER)
//   permission(kind) — resolves true when the OS lets us (screen: the
//                      screen-share consent flow; voice: the microphone)
//   onChange(state)  — { recording: { kind, startedAt } | null }
//   onSaved(saved)   — { kind, path, name, durationMs }
//   onError(code, kind) — 'permission' | 'failed' | 'busy'
function createRecorder ({ folder, permission = async () => false, onChange = () => {}, onSaved = () => {}, onError = () => {}, now = Date.now, electron = require('electron') }) {
  const { BrowserWindow, session, desktopCapturer, screen, ipcMain } = electron
  let win = null
  let rec = null // { kind, startedAt, file, stream, bytes, timer, armed }

  const recSession = session.fromPartition(PARTITION)
  const fromRecorder = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents && ((event.senderFrame && event.senderFrame.url) || event.sender.getURL()) === HTML_URL)
  const fromRecorderContents = (contents) => Boolean(win && !win.isDestroyed() && contents === win.webContents)

  // Only the recorder page, only while armed, only what was armed: the
  // microphone for a voice note; the screen (display-capture, then main's
  // display-media handler picks it) for a screen recording.
  const allowed = (permission, details) => {
    if (!rec) return false
    const types = details?.mediaTypes
    // getDisplayMedia asks for 'media' with no audio (mediaTypes empty, or
    // the check's mediaType 'video'); main's display-media handler then
    // decides which screen.
    if (rec.kind === 'screen') {
      if (permission === 'display-capture') return true
      if (permission !== 'media') return false
      if (Array.isArray(types) && types.length) return types.includes('video') && !types.includes('audio')
      return !details?.mediaType || details.mediaType === 'video'
    }
    if (permission !== 'media') return false
    if (Array.isArray(types) && types.length) return types.includes('audio') && !types.includes('video')
    const type = details?.mediaType
    return type === 'audio' || !type || type === 'unknown'
  }
  recSession.setPermissionCheckHandler((contents, permission, _origin, details) => Boolean(contents && fromRecorderContents(contents) && allowed(permission, details)))
  recSession.setPermissionRequestHandler((contents, permission, callback, details) => callback(Boolean(fromRecorderContents(contents) && allowed(permission, details))))
  if (typeof recSession.setDisplayMediaRequestHandler === 'function') {
    recSession.setDisplayMediaRequestHandler(async (request, callback) => {
      // Only the recorder page's own frame, only while a screen recording is armed.
      if (!rec || rec.kind !== 'screen' || !win || win.isDestroyed() || request?.frame?.url !== HTML_URL) return callback({})
      try {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        const sources = await desktopCapturer.getSources({ types: ['screen'] })
        const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
        callback(source ? { video: source } : {})
      } catch {
        callback({})
      }
    })
  }

  function ensureWindow () {
    if (win && !win.isDestroyed()) return Promise.resolve(win)
    win = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      skipTaskbar: true,
      webPreferences: { preload: path.join(__dirname, 'recorder-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: PARTITION, backgroundThrottling: false, spellcheck: false },
    })
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('closed', () => { win = null; if (rec) fail('failed') })
    return win.loadFile(HTML_PATH).then(() => win)
  }

  const state = () => ({ recording: rec ? { kind: rec.kind, startedAt: rec.startedAt } : null })

  function cleanup () {
    if (!rec) return
    clearTimeout(rec.timer)
    rec = null
    onChange(state())
  }

  function fail (code) {
    if (!rec) return onError(code, null)
    const r = rec
    cleanup()
    try { r.stream?.destroy() } catch {}
    try { if (r.bytes === 0) fs.rmSync(r.file, { force: true }) } catch {}
    onError(code, r.kind)
  }

  async function start (kind) {
    if (!KINDS.includes(kind)) return false
    if (rec) { onError('busy', kind); return false }
    const ok = await Promise.resolve().then(() => permission(kind)).catch(() => false)
    if (!ok) { onError('permission', kind); return false }
    const dir = folder()
    try { fs.mkdirSync(dir, { recursive: true }) } catch { onError('failed', kind); return false }
    const file = freePath(dir, fileName(kind, new Date(now())))
    rec = { kind, startedAt: now(), file, stream: fs.createWriteStream(file), bytes: 0, timer: null }
    rec.stream.on('error', () => fail('failed'))
    rec.timer = setTimeout(stop, LIMITS.maxMs)
    onChange(state())
    try {
      const w = await ensureWindow()
      w.webContents.send('cma-recorder:start', { kind, timesliceMs: LIMITS.timesliceMs })
    } catch {
      fail('failed')
      return false
    }
    return true
  }

  function stop () {
    if (!rec || rec.stopping) return false
    rec.stopping = true
    if (win && !win.isDestroyed()) win.webContents.send('cma-recorder:stop')
    else fail('failed')
    return true
  }

  function registerIpc () {
    ipcMain.on('cma-recorder:chunk', (event, data) => {
      if (!fromRecorder(event) || !rec) return
      const buf = validChunk(data)
      if (!buf) return
      if (rec.bytes + buf.length > LIMITS.maxBytes) return stop()
      rec.bytes += buf.length
      rec.stream.write(buf)
    })
    ipcMain.on('cma-recorder:done', (event) => {
      if (!fromRecorder(event) || !rec) return
      const r = rec
      const durationMs = now() - r.startedAt
      cleanup()
      r.stream.end(() => {
        if (r.bytes === 0) {
          try { fs.rmSync(r.file, { force: true }) } catch {}
          return onError('failed', r.kind)
        }
        onSaved({ kind: r.kind, path: r.file, name: path.basename(r.file), durationMs })
      })
    })
    ipcMain.on('cma-recorder:error', (event, code) => {
      if (!fromRecorder(event)) return
      fail(code === 'permission' ? 'permission' : 'failed')
    })
  }

  return {
    start,
    stop,
    registerIpc,
    state,
    get recording () { return Boolean(rec) },
    destroy () {
      if (rec) stop()
      if (win && !win.isDestroyed()) win.destroy()
    },
  }
}

module.exports = { KINDS, FOLDER, LIMITS, LABEL, HTML_URL, PARTITION, RECORDING_EXPLAINER, fileName, freePath, clock, validChunk, recordingPermission, createRecorder }
