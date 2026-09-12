// Configure My AI for desktop (macOS + Windows) — the Electron main process.
//
// A deliberately thin shell: every screen is https://configuremyai.com
// rendered in the bundled Chromium — the same model as the Claude, Slack and
// Grok Bot desktop apps. Product logic stays in the Rails app; the only jobs
// here are windowing, the menu bar, keeping foreign links out of the app
// window, surviving offline, and auto-update. The code is shared across
// platforms; the few OS differences (window chrome, quit-on-close) are
// branched inline.
//
// The Rails app decides its layout by user agent (app/helpers/mobile_helper.rb
// in the main repo): only a UA carrying "Turbo Native" gets the phone chrome.
// This shell never sends that marker, so it renders the full desktop UI —
// which on a laptop or desktop is the point.

const { app, BrowserWindow, ipcMain, session, shell } = require('electron')
const path = require('node:path')
const { installMenu } = require('./menu')
const windowState = require('./window-state')
const updater = require('./updater')

const APP_HOST = 'configuremyai.com'
const APP_URL = `https://${APP_HOST}`

// Height of the strip at the top of the window that the user drags it by, and
// of the Windows caption-button overlay drawn into it. The page reserves this
// much room at its top (body.desktop-app in the Rails app) and the preload
// marks it draggable, so the two have to agree; this is the one place it is
// written down.
const TITLEBAR_HEIGHT = 40

// The app opens on the walkthrough landing (/welcome), not the marketing
// home. Signed out, /welcome renders the desktop-only wizard — what Configure
// My AI does, plus Log in / Create account — with no marketing chrome (see
// the server's desktop_app? branch); already signed in, the server bounces
// /welcome straight into the app. Sign-in itself is email/password only in
// the app (no OAuth buttons, which a desktop webview can't complete), and
// marketing pages are never linked from these screens, so the app never
// surfaces them.
const START_URL = `${APP_URL}/welcome`

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

// The windows drawn without a native title bar — the app's own, but not the
// OAuth popups, which keep a standard frame. Only these need the page to
// donate a draggable strip, and the preload asks before installing one.
const chromelessWindows = new WeakSet()

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

// A few AUTH_HOSTS are also ordinary destinations, not just OAuth waypoints —
// GitHub most of all: the app surfaces repo, PR and release links, and those
// need the user's BROWSER session (where they are signed in to GitHub), not
// this app's empty cookie jar, which 404s on anything private. So for these
// hosts only the real sign-in / OAuth endpoints stay in the app (to complete a
// provider-connect round trip); every other path is content and opens
// externally.
const AUTH_PATH_ONLY_HOSTS = new Set(['github.com'])

// GitHub's auth surface: the OAuth authorize / access-token endpoints (which
// live under /login/oauth) and the sign-in gate they bounce through.
// Everything else on github.com is content.
function isGithubAuthPath (pathname) {
  return /^\/(login|session)(\/|$)/.test(pathname)
}

function isAuthUrl (value) {
  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:') return false
  if (!AUTH_HOSTS.has(url.hostname)) return false
  if (AUTH_PATH_ONLY_HOSTS.has(url.hostname)) return isGithubAuthPath(url.pathname)
  return true
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

// Chromeless window chrome, per OS — a window with no title-bar strip but with
// working, native window controls, the way the Grok, Claude and Slack apps
// look. The mechanism differs by platform:
//   macOS   — 'hiddenInset' hides the strip and keeps the traffic lights
//             (close/minimise/zoom), nudged in from the corner.
//   Windows — 'hidden' plus a Window Controls Overlay, which paints the
//             minimise/maximise/close buttons over the top-right of the page so
//             the web content still reaches the top edge. Colours track the
//             window background so the caption area blends in.
// Either way the window is not frameless, so the top strip stays draggable.
// Linux and anything else keep the standard frame.
function titleBarOptions () {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  }
  if (process.platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#ffffff', symbolColor: '#231d1b', height: TITLEBAR_HEIGHT },
    }
  }
  return {}
}

function createMainWindow () {
  const state = windowState.load()

  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    ...titleBarOptions(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  if (state.isMaximized) mainWindow.maximize()
  if (Object.keys(titleBarOptions()).length > 0) chromelessWindows.add(mainWindow)
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

// What the preload needs to know before the page paints: whether this window
// has a title bar of its own, and how tall the strip is if it does not. Sent
// synchronously because the answer decides what goes into the document, and
// asking after the first paint means a window that is briefly unmovable.
function registerIpc () {
  ipcMain.on('cfa:window-info', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    event.returnValue = {
      chromeless: Boolean(win && chromelessWindows.has(win)),
      titleBarHeight: TITLEBAR_HEIGHT,
      platform: process.platform,
      version: app.getVersion(),
    }
  })
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
  registerIpc()
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
