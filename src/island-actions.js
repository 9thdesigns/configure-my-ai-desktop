'use strict'

// The island composer's actions menu (its "+"): what is in it, and what the
// composer shows about each outcome. Pure (test/island-actions.test.js); the
// controller in island-window.js runs them.
//
//   Screenshot ▸ Whole screen / This window / Select area
//                     — screen-share.js: the "Let Manager see your screen"
//                       switch, the macOS Screen Recording permission (and
//                       its one-time explainer), the "Viewing your screen"
//                       indicator; held for the Manager and sent with the
//                       next message as attachments[{ kind: 'screenshot' }],
//                       only while widget.json lists chat_attachments
//                       'screenshot'. Nothing is captured silently.
//   Record screen     — recorder.js; saved to ~/Movies/Configure My AI and
//                       kept there (the web app takes no video yet).
//   Share what's on screen with Manager
//                     — a Whole screen screenshot, sent at once.
//   Attach file       — the user picks a file; it stays on this computer.
//                       The message names it, and the Manager can ask to read
//                       it with the file tools (local-files.js), which the
//                       local tools' approval card decides.
//   Voice note        — recorder.js (the microphone); kept, like recordings.
//   Open Manager in app

const os = require('node:os')
const path = require('node:path')

// The menu, in order. key: the letter that picks it while the menu is open
// (shown on the right of the row).
const MENU = Object.freeze([
  Object.freeze({ id: 'screenshot', label: 'Screenshot', key: 'S', icon: 'camera', submenu: Object.freeze([
    Object.freeze({ id: 'screenshot-display', label: 'Whole screen', key: 'W', icon: 'display' }),
    Object.freeze({ id: 'screenshot-window', label: 'This window', key: 'T', icon: 'window' }),
    Object.freeze({ id: 'screenshot-area', label: 'Select area', key: 'A', icon: 'crop' }),
  ]) }),
  Object.freeze({ id: 'record', label: 'Record screen', key: 'R', icon: 'record' }),
  Object.freeze({ id: 'share', label: 'Share what’s on screen with Manager', key: 'H', icon: 'share' }),
  Object.freeze({ id: 'attach', label: 'Attach file', key: 'F', icon: 'clip' }),
  Object.freeze({ id: 'voice', label: 'Voice note', key: 'V', icon: 'mic' }),
  Object.freeze({ id: 'open-app', label: 'Open Manager in app', key: 'O', icon: 'open' }),
])

const ACTION_IDS = Object.freeze(MENU.flatMap((item) => (item.submenu ? item.submenu.map((s) => s.id) : [item.id])))
const validAction = (id) => (ACTION_IDS.includes(id) ? id : null)
const SCREENSHOT_SOURCE = Object.freeze({ 'screenshot-display': 'display', 'screenshot-window': 'window', 'screenshot-area': 'area', share: 'display' })

// ~/Documents/report.pdf for a path under the home folder.
function shownPath (file, home = os.homedir()) {
  const p = String(file || '')
  if (home && (p === home || p.startsWith(home + path.sep))) return `~${p.slice(home.length)}`
  return p
}

// The line a message gains when a file is attached: the file's place, so
// the Manager can ask to read it (and the user, on the approval card, says
// whether it may).
const fileLine = (file) => `Attached file: ${shownPath(file)}`

function withFile (body, file) {
  const text = typeof body === 'string' ? body.trim() : ''
  if (!file) return text
  return text ? `${text}\n\n${fileLine(file)}` : fileLine(file)
}

const NOTICES = Object.freeze({
  no_screenshots: 'Screenshots can’t be sent to the Manager yet.',
  recording_permission: 'Configure My AI needs Screen Recording permission to record. Turn it on in System Settings → Privacy & Security → Screen Recording.',
  voice_permission: 'Configure My AI needs microphone access for a voice note. Turn it on in System Settings → Privacy & Security → Microphone.',
  recording_failed: 'The recording didn’t start. Try again.',
  recording_busy: 'Already recording.',
  file_unreadable: 'That file can’t be attached.',
})

// What the composer shows under the Manager's lines: the screenshot waiting
// to go, the attached file, a recording just saved, and one notice.
//   screenshot — { preview (data:image/jpeg), width, height, source } | null
//   file       — { path, size } | null           (the path stays in main;
//                                                the page gets its name and
//                                                shown place)
//   saved      — { kind, name, durationMs } | null
//   notice     — { message, settings?, turnOn? } | null
//   localTools — can the Manager ask to read files at all?
function attachmentsView ({ screenshot = null, file = null, saved = null, notice = null, localTools = true } = {}) {
  const preview = screenshot && typeof screenshot.preview === 'string' && /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(screenshot.preview) ? screenshot.preview : null
  return {
    screenshot: screenshot ? { preview, width: Math.trunc(screenshot.width) || 0, height: Math.trunc(screenshot.height) || 0, source: screenshot.source === 'window' ? 'window' : 'display' } : null,
    file: file ? { name: path.basename(String(file.path)), shown: shownPath(file.path), readable: Boolean(localTools) } : null,
    saved: saved ? { kind: saved.kind === 'voice' ? 'voice' : 'screen', name: String(saved.name || ''), durationMs: Math.max(0, Math.trunc(saved.durationMs) || 0) } : null,
    notice: notice && typeof notice.message === 'string' ? { message: notice.message.slice(0, 400), settings: Boolean(notice.settings), turnOn: Boolean(notice.turnOn) } : null,
  }
}

// A screen-share refusal (screen-share.js) as a notice.
function noticeFromRefusal (result) {
  if (!result || result.status !== 'refused') return null
  return { message: result.message, settings: Boolean(result.settingsUrl), turnOn: result.code === 'disabled' }
}

module.exports = { MENU, ACTION_IDS, validAction, SCREENSHOT_SOURCE, shownPath, fileLine, withFile, NOTICES, attachmentsView, noticeFromRefusal }
