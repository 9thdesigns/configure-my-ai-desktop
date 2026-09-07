// Configure My AI for macOS — the Electron main process.
//
// A deliberately thin shell: every screen is https://configuremyai.com
// rendered in the bundled Chromium — the same model as the Claude, Slack and
// Grok Bot desktop apps. Product logic stays in the Rails app; the only jobs
// here are windowing, the menu bar, keeping foreign links out of the app
// window, surviving offline, and auto-update.
//
// The Rails app decides its layout by user agent (app/helpers/mobile_helper.rb
// in the main repo): only a UA carrying "Turbo Native" gets the phone chrome.
// This shell never sends that marker, so it renders the full desktop UI —
// which on a Mac is the point.

const { app, BrowserWindow, session, shell } = require('electron')
const path = require('node:path')
const { installMenu } = require('./menu')
const windowState = require('./window-state')
const updater = require('./updater')

const APP_HOST = 'configuremyai.com'
const APP_URL = `https://${APP_HOST}`

// The app opens to the sign-in screen, not the marketing home. Signed out,
// that renders the desktop-only email/password landing (no marketing chrome,
// no OAuth buttons — see the server's desktop_app? branch); an already
// signed-in WebView is bounced straight into the app by Devise. Marketing
// pages are never linked from these screens, so the app never surfaces them.
const START_URL = `${APP_URL}/login`

// Hosts that must complete INSIDE the app window: every OAuth provider the
// Rails app offers (see the omniauth-* gems in its Gemfile). Their round trip
// ends back on APP_HOST, so sending them to the system browser would strand
// the session in the wrong cookie jar. Everything else off-host opens in the
// user's default browser.
const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'github.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'linkedin.com',
  'www.linkedin.com',
  'twitter.com',
  'x.com',
  'api.twitter.com',
  'api.x.com',
  'slack.com',
])

let mainWindow = null

function parseUrl (value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isAppUrl (value) {
  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:') return false
  return url.hostname === APP_HOST || url.hostname.endsWith(`.${APP_HOST}`)
}

function isAuthUrl (value) {
  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:') return false
  return AUTH_HOSTS.has(url.hostname)
}

// Anything not ours and not an auth hop leaves the app. Only web URLs are
// handed to the OS — shell.openExternal with an arbitrary scheme is how a
// page launches things it shouldn't.
function openExternally (value) {
  const url = parseUrl(value)
  if (!url) return
  if (url.protocol === 'https:' || url.protocol === 'http:') {
    shell.openExternal(url.toString())
  }
}

// Identify this window to the server as the desktop app. The Rails app keys
// its desktop-only signed-out experience — no marketing chrome, and
// email/password sign-in only (no OAuth buttons, which a desktop webview
// can't complete) — on this exact token (MobileHelper::DESKTOP_MARKER). It is
// appended, leaving the genuine Chrome user agent intact; because the server
// strips the OAuth buttons for this UA, Google's embedded-webview block is
// never reached.
function tagUserAgent () {
  app.userAgentFallback = `${app.userAgentFallback} ConfigureMyAI-Desktop/${app.getVersion()}`
}

function applyNavigationPolicy (contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) return { action: 'allow' }
    if (isAuthUrl(url)) {
      // OAuth popups get a plain, menu-less window sized like the ones the
      // providers design for.
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 600,
          height: 720,
          autoHideMenuBar: true,
        },
      }
    }
    openExternally(url)
    return { action: 'deny' }
  })

  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url) || isAuthUrl(url)) return
    event.preventDefault()
    openExternally(url)
  })
}

function showOfflinePage (win) {
  win.loadFile(path.join(__dirname, 'offline.html'))
}

function createMainWindow () {
  const state = windowState.load()

  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  if (state.isMaximized) mainWindow.maximize()
  windowState.track(mainWindow)
  applyNavigationPolicy(mainWindow.webContents)

  // -3 is ERR_ABORTED — fired by ordinary in-page cancellations, not by being
  // offline. Everything else on the main frame gets the retry page.
  mainWindow.webContents.on('did-fail-load', (_event, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) showOfflinePage(mainWindow)
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => { mainWindow = null })

  mainWindow.loadURL(START_URL)
  return mainWindow
}

// The renderer is a website; it should hold website permissions. Notifications
// and fullscreen are part of the product (web push, video), the rest is not —
// and nothing off-host gets anything at all.
function restrictPermissions () {
  const allowed = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write'])
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    callback(isAppUrl(contents.getURL()) && allowed.has(permission))
  })
}

app.setName('Configure My AI')
tagUserAgent()

app.whenReady().then(() => {
  restrictPermissions()
  installMenu({
    appUrl: APP_URL,
    startUrl: START_URL,
    getWindow: () => mainWindow,
    onCheckForUpdates: () => updater.checkForUpdates({ getWindow: () => mainWindow }),
  })
  createMainWindow()
  // Background update checks; the "Update Ready" modal appears once a newer
  // signed build has downloaded. See src/updater.js.
  updater.initAutoUpdates({ getWindow: () => mainWindow })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

// macOS convention: closing the window leaves the app in the Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
