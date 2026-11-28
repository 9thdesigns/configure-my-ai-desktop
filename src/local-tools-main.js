// Electron side of local computer access: the approval card, the Local
// Computer Access window (grants + audit), screen capture, the macOS
// screen-recording helper, and starting the poller. The decisions themselves
// live in the pure modules (local-tools*.js); this file only wires them to
// windows and the OS.
//
// The approval card is its own small always-on-top window, placed where the
// island sits. It is deliberately not an island card: see ensureApprovalWindow.

const { app, BrowserWindow, dialog, ipcMain, screen, session, shell, systemPreferences } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { GrantStore, AuditLog, ApprovalBroker } = require('./local-tools-approval')
const { createPoller } = require('./local-tools-client')
const { SCREEN_SETTINGS_URL } = require('./screen-share')
const { captureDisplay } = require('./screen-share-main')

let approvalWindow = null
let settingsWindow = null
const pending = new Map() // card id → resolve
let settingsFile
let grants
let audit
let poller
let prefs = null // the shell's prefs (src/prefs.js), for "Let Manager see your screen"

function readSettings () {
  try { return { enabled: true, screenHelperShown: false, ...JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } } catch {
    return { enabled: true, screenHelperShown: false }
  }
}

function writeSettings (patch) {
  const next = { ...readSettings(), ...patch }
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true })
  fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

function smallWindow (opts) {
  return new BrowserWindow({
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'local-tools-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    ...opts,
  })
}

// Nothing in these windows may navigate anywhere or open anything.
function lockDown (win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (e) => e.preventDefault())
}

function ensureApprovalWindow () {
  if (approvalWindow && !approvalWindow.isDestroyed()) return approvalWindow
  // Top-centre, where the island sits, so a request appears where the user
  // already looks for "a bot needs you". It stays its own window rather than
  // an island card: the island is fed by the server's widget state and
  // answers to the server, while this decision must stay on this machine.
  const area = screen.getPrimaryDisplay().workArea
  const width = 460
  approvalWindow = smallWindow({
    width,
    height: 340,
    x: Math.round(area.x + (area.width - width) / 2),
    y: area.y + 64,
    alwaysOnTop: true,
    title: 'Allow this action?',
  })
  approvalWindow.setAlwaysOnTop(true, 'floating')
  lockDown(approvalWindow)
  approvalWindow.loadFile(path.join(__dirname, 'local-tools-card.html'))
  // Closing the card is a Deny.
  approvalWindow.on('closed', () => {
    approvalWindow = null
    for (const resolve of pending.values()) resolve('deny')
    pending.clear()
  })
  return approvalWindow
}

// prompt(card, { signal }) for the broker.
function promptInWindow (card, { signal }) {
  return new Promise((resolve) => {
    const win = ensureApprovalWindow()
    pending.set(card.id, resolve)
    const send = () => {
      if (win.isDestroyed()) return
      win.webContents.send('lt:card', card)
      win.show()
      win.focus()
    }
    if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send)
    else send()
    signal.addEventListener('abort', () => {
      pending.delete(card.id)
      if (!win.isDestroyed()) win.hide()
    })
  })
}

function openSettingsWindow () {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus()
    return
  }
  settingsWindow = smallWindow({ width: 640, height: 560, resizable: true, title: 'Local Computer Access' })
  lockDown(settingsWindow)
  settingsWindow.loadFile(path.join(__dirname, 'local-tools-settings.html'))
  settingsWindow.once('ready-to-show', () => settingsWindow.show())
  settingsWindow.on('closed', () => { settingsWindow = null })
}

const fromWindow = (event, win) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents)

function registerIpc () {
  ipcMain.on('lt:decide', (event, id, answer) => {
    if (!fromWindow(event, approvalWindow)) return
    const resolve = pending.get(String(id))
    if (!resolve) return
    pending.delete(String(id))
    resolve(['once', 'always', 'deny'].includes(answer) ? answer : 'deny')
    if (pending.size === 0 && approvalWindow) approvalWindow.hide()
  })
  ipcMain.handle('lt:settings', (event) => {
    if (!fromWindow(event, settingsWindow)) return null
    return {
      enabled: readSettings().enabled,
      shareScreen: Boolean(prefs?.get().shareScreen),
      platform: process.platform,
      grants: grants.list(),
      audit: audit.list({ limit: 200 }),
    }
  })
  ipcMain.handle('lt:revoke', (event, id) => {
    if (!fromWindow(event, settingsWindow)) return false
    return grants.revoke(String(id))
  })
  ipcMain.handle('lt:set-share-screen', (event, on) => {
    if (!fromWindow(event, settingsWindow) || !prefs) return false
    prefs.set({ shareScreen: on === true })
    return true
  })
  ipcMain.handle('lt:set-enabled', (event, on) => {
    if (!fromWindow(event, settingsWindow)) return false
    setEnabled(Boolean(on))
    return true
  })
}

// macOS: screen capture needs the Screen Recording permission, which only the
// user can grant in System Settings. Shown once; after that a denied capture
// just reports the error back to the bot.
async function screenPermissionHelper () {
  if (process.platform !== 'darwin') return
  const status = systemPreferences.getMediaAccessStatus('screen')
  if (status === 'granted') return
  if (readSettings().screenHelperShown) return
  writeSettings({ screenHelperShown: true })
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: ['Open System Settings', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    message: 'Allow Configure My AI to see your screen',
    detail: 'A bot asked for a screenshot. macOS needs you to turn on Screen Recording for Configure My AI in System Settings → Privacy & Security, then quit and reopen the app.',
  })
  if (response === 0) shell.openExternal(SCREEN_SETTINGS_URL)
}

async function captureScreen ({ maxWidth }) {
  await screenPermissionHelper()
  return captureDisplay({ maxWidth })
}

function isEnabled () {
  return readSettings().enabled !== false
}

function setEnabled (on) {
  writeSettings({ enabled: on })
}

function initLocalTools (options = {}) {
  prefs = options.prefs || null
  const dir = app.getPath('userData')
  settingsFile = path.join(dir, 'local-tools-settings.json')
  grants = new GrantStore(path.join(dir, 'local-tools-grants.json'))
  audit = new AuditLog(path.join(dir, 'local-tools-audit.jsonl'))
  registerIpc()
  const broker = new ApprovalBroker({ grants, prompt: promptInWindow })
  poller = createPoller({
    fetch: (url, init) => session.defaultSession.fetch(url, init),
    broker,
    audit,
    runDeps: { capture: captureScreen },
    isEnabled,
    log: (msg) => console.warn(`[local-tools] ${msg}`),
  })
  poller.start()
  return { isEnabled, setEnabled, openSettings: openSettingsWindow }
}

module.exports = { initLocalTools, SCREEN_SETTINGS_URL }
