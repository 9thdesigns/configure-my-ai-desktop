// Configure My AI for desktop (macOS, Windows + Linux/Omarchy) — the Electron
// main process.
//
// A deliberately thin shell: every screen is https://configuremyai.com
// rendered in the bundled Chromium — the same model as the Claude, Slack and
// Grok Bot desktop apps. Product logic stays in the Rails app; the only jobs
// here are windowing, the menu bar, keeping foreign links out of the app
// window, surviving offline, and auto-update. The code is shared across
// platforms; the few OS differences (window chrome, quit-on-close, Wayland)
// are branched inline.
//
// The Rails app decides its layout by user agent (app/helpers/mobile_helper.rb
// in the main repo): only a UA carrying "Turbo Native" gets the phone chrome.
// This shell never sends that marker, so it renders the full desktop UI —
// which on a laptop or desktop is the point.

const { app, BrowserWindow, ipcMain, nativeTheme, session, shell, systemPreferences } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const { installMenu } = require('./menu')
const windowState = require('./window-state')
const updater = require('./updater')

const { APP_HOST, APP_URL, START_URL, parseUrl, isAppUrl, isAuthUrl } = require('./url-policy')
const { webRefreshClearOptions, senderAllowed } = require('./web-refresh')
const { defaultColors, colorsFromPage, overlayOptions } = require('./window-chrome')
const { applyBadge } = require('./badge')

// Height of the strip at the top of the window that the user drags it by, and
// of the Windows caption-button overlay drawn into it. The page reserves this
// much room at its top (body.is-desktop-app in the Rails app) and the preload
// marks it draggable, so the two have to agree; this is the one place it is
// written down.
const TITLEBAR_HEIGHT = 40

let mainWindow = null

// The windows drawn without a native title bar — the app's own, but not the
// OAuth popups, which keep a standard frame. Only these need the page to
// donate a draggable strip, and the preload asks before installing one.
const chromelessWindows = new WeakSet()

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

// Tiling Wayland/X11 window managers — Hyprland (what Omarchy runs), Sway, i3,
// niri, river. They tile, move and close windows from the keyboard and draw no
// title bars of their own, so a caption strip with minimise/maximise buttons is
// dead weight there (minimise has no meaning in Hyprland at all). Detected from
// the environment the compositor exports to every client it starts; the desktop
// name is the fallback for sessions started some other way.
const TILING_DESKTOPS = /\b(hyprland|sway|i3|niri|river|bspwm|qtile|awesome|dwm|xmonad)\b/i

function isTilingWindowManager () {
  if (process.platform !== 'linux') return false
  const env = process.env
  if (env.HYPRLAND_INSTANCE_SIGNATURE || env.SWAYSOCK || env.I3SOCK || env.NIRI_SOCKET) return true
  return TILING_DESKTOPS.test(`${env.XDG_CURRENT_DESKTOP || ''} ${env.XDG_SESSION_DESKTOP || ''} ${env.DESKTOP_SESSION || ''}`)
}

// Where the OS draws the window buttons over the page, which the site needs to
// know to keep its top bar clear of them (html[data-desktop-captions] in the
// Rails app's desktop.css):
//   'left'  — macOS traffic lights
//   'right' — Windows / Linux Window Controls Overlay
//   'none'  — a tiling WM (Omarchy): no buttons at all
function captionSide () {
  if (process.platform === 'darwin') return 'left'
  if (isTilingWindowManager()) return 'none'
  return 'right'
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
//   Linux   — floating desktops (GNOME, KDE, …) get the same overlay as
//             Windows. Tiling WMs such as Hyprland (Omarchy) get a frameless
//             window: the compositor owns placement and has no buttons to show,
//             and a client-drawn title bar in a tile looks like a bug.
// On every OS but the tiling case the window is not frameless, so the top
// strip stays draggable; in the tiling case the strip still drags a floating
// window, and a tiled one is moved from the keyboard as usual.
function titleBarOptions () {
  if (process.platform === 'darwin') {
    return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
  }
  if (isTilingWindowManager()) {
    return { frame: false }
  }
  return {
    titleBarStyle: 'hidden',
    // The overlay colour is the band the OS paints behind its own buttons, so
    // it has to match what the page shows in that band. It starts on the OS
    // theme's default (window-chrome.js) and the page corrects it as soon as
    // it has painted (cmaiDesktop.setChromeColors → cfa:chrome-colors below):
    // the right sidebar's tone when it is open, the page's when it is folded,
    // on whichever theme the page is on.
    titleBarOverlay: overlayOptions(defaultColors(nativeTheme.shouldUseDarkColors), TITLEBAR_HEIGHT),
  }
}

// Does this window have a Window Controls Overlay to recolour? macOS draws
// traffic lights on the page and a tiling WM draws nothing.
function hasTitleBarOverlay () {
  return process.platform !== 'darwin' && !isTilingWindowManager()
}

// Paint the window's own chrome: its background (seen while a page loads or
// a resize catches up) and, where there is one, the caption-button band.
function applyChromeColors (win, colors) {
  if (!win || win.isDestroyed()) return
  win.setBackgroundColor(colors.background)
  if (hasTitleBarOverlay() && typeof win.setTitleBarOverlay === 'function') {
    try {
      win.setTitleBarOverlay(overlayOptions(colors, TITLEBAR_HEIGHT))
    } catch {
      // A window created without an overlay (older OS builds) has nothing to
      // recolour; the page's own strip still matches.
    }
  }
}

// Until the page has said, the chrome follows the OS theme; once it has, the
// page's answer stands (it knows its own theme, which may not be the OS's).
const pageColored = new WeakSet()

function createMainWindow () {
  const state = windowState.load()

  // Unpackaged runs (npm start) have no bundle icon, so Windows and Linux
  // would otherwise show Electron's default. The packaged app already carries
  // the platform icon; this path is not inside the asar, so it is skipped.
  // macOS ignores BrowserWindow.icon and uses the .icns from the .app.
  const iconPath = path.join(__dirname, '..', 'build', 'icon.png')

  mainWindow = new BrowserWindow({
    ...state.bounds,
    minWidth: 960,
    minHeight: 600,
    show: false,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    // The page's colour, not white: a dark window flashed white on every load.
    backgroundColor: defaultColors(nativeTheme.shouldUseDarkColors).background,
    // Linux keeps the menu for its accelerators (Back/Forward, zoom, reload)
    // but not as a GTK bar across a chromeless window; Alt shows it.
    autoHideMenuBar: process.platform === 'linux',
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
  chromelessWindows.add(mainWindow)

  // Full screen hides the macOS traffic lights, so the site's top bar can take
  // back the room it keeps for them at the left of the title strip (the Rails
  // app reads html[data-desktop-fullscreen], which the preload stamps). The
  // window-info reply carries the state at each page load; these carry every
  // change after it. Sent as the new state rather than read back, because
  // isFullScreen() can still report the old one while the animation runs.
  const sendFullscreen = (on) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('cfa:fullscreen', on)
  }
  mainWindow.on('enter-full-screen', () => sendFullscreen(true))
  mainWindow.on('leave-full-screen', () => sendFullscreen(false))
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
      captions: captionSide(),
      // Whether this window is full screen as the page loads; changes after
      // that arrive as cfa:fullscreen (createMainWindow).
      fullscreen: Boolean(win && win.isFullScreen()),
      platform: process.platform,
      version: app.getVersion(),
      appHost: APP_HOST,
    }
  })

  // The account menu's updater (the site's desktop_update Stimulus
  // controller, through window.cmaiDesktop in src/preload.js). Answered only
  // for frames on our own origin: the app window can legitimately sit on an
  // OAuth provider's page mid-round-trip, and a provider's page has no
  // business reading this app's update state, let alone restarting it.
  const fromAppFrame = (event) => {
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL()
    return senderAllowed(url)
  }

  // The page's colours for the window's own chrome (the site's
  // desktop_chrome_controller, through cmaiDesktop.setChromeColors). Same
  // origin gate as the rest; the colours are validated in window-chrome.js
  // before they reach the OS.
  ipcMain.handle('cfa:chrome-colors', (event, input) => {
    if (!fromAppFrame(event)) return false
    const colors = colorsFromPage(input)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!colors || !win) return false
    pageColored.add(win)
    applyChromeColors(win, colors)
    return true
  })

  // The unread badge (cmaiDesktop.setBadge). Same origin gate; the count is
  // clamped in badge.js before it reaches the OS.
  ipcMain.on('cfa:set-badge', (event, n) => {
    if (!fromAppFrame(event)) return
    applyBadge(app, n)
  })

  // The OS theme changed: windows the page has not coloured yet follow it.
  nativeTheme.on('updated', () => {
    const colors = defaultColors(nativeTheme.shouldUseDarkColors)
    for (const win of BrowserWindow.getAllWindows()) {
      if (chromelessWindows.has(win) && !pageColored.has(win)) applyChromeColors(win, colors)
    }
  })

  ipcMain.handle('cfa:update-status', (event) => {
    if (!fromAppFrame(event)) return null
    return updater.getStatus()
  })

  ipcMain.handle('cfa:update-check', (event) => {
    if (!fromAppFrame(event)) return null
    updater.checkQuietly({ getWindow: () => mainWindow })
    return updater.getStatus()
  })

  ipcMain.handle('cfa:update-install', (event) => {
    if (!fromAppFrame(event)) return false
    return updater.installNow()
  })

  // The WEB-deploy refresh (cmaiDesktop.reloadForWebUpdate, asked for by the
  // Rails app's lib/app_version.js when GET /version says a new release is
  // live). Distinct from the SHELL updater above: nothing here downloads or
  // installs a binary — it clears what can serve the old release (the HTTP
  // cache; service workers and CacheStorage, per web-refresh.js, which is
  // the one place the "never localStorage / IndexedDB / cookies" rule is
  // written down) and reloads the CURRENT url of the asking frame, not a
  // bounce to the start page. The default persistent session stays exactly
  // that: composer drafts and the remember-me cookie survive.
  ipcMain.handle('cfa:web-refresh', async (event) => {
    if (!fromAppFrame(event)) return false
    try {
      await session.defaultSession.clearCache()
      await session.defaultSession.clearStorageData(webRefreshClearOptions())
    } catch {
      // A cache that would not clear still gets the hard reload below —
      // reloadIgnoringCache revalidates the document either way.
    }
    event.sender.reloadIgnoringCache()
    return true
  })

  // The page's last resort, behind its "Restart required" card: a refresh
  // that came back still on the old release. Same defer-a-tick pattern as
  // updater.installNow — let the invoke's turn finish before teardown.
  ipcMain.handle('cfa:relaunch', (event) => {
    if (!fromAppFrame(event)) return false
    setImmediate(() => {
      app.relaunch()
      app.quit()
    })
    return true
  })
}

// The renderer is a website; it should hold website permissions. Notifications,
// fullscreen and the clipboard are part of the product (web push, video, copy).
// The microphone is too: the composer dictates into the same field as on the
// web. Camera, geolocation and the rest are not, and nothing off-host gets
// anything at all.
//
// Chromium asks twice — a synchronous check, then a request. Both have to
// agree. Granting the request and refusing the check is how getUserMedia
// fails with NotAllowedError before the OS prompt ever appears. On macOS the
// request also has to pass TCC (systemPreferences.askForMediaAccess); the
// Chromium grant is not enough on its own.
function restrictPermissions () {
  const allowed = new Set(['notifications', 'fullscreen', 'clipboard-sanitized-write', 'media'])

  session.defaultSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
    if (!fromApp(contents, requestingOrigin)) return false
    if (permission === 'media') return mediaIsAudio(details)
    return allowed.has(permission)
  })

  session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (!fromApp(contents) || !allowed.has(permission)) {
      callback(false)
      return
    }
    if (permission !== 'media') {
      callback(true)
      return
    }
    if (!mediaIsAudio(details)) {
      callback(false)
      return
    }
    grantMicrophone(callback)
  })
}

function fromApp (contents, origin) {
  if (origin && isAppUrl(origin)) return true
  const url = contents?.getURL?.()
  return Boolean(url && isAppUrl(url))
}

// Chromium names the capture as details.mediaTypes (request) or
// details.mediaType (check). SpeechRecognition sometimes sends neither;
// an unspecified media request is the microphone, not the camera.
function mediaIsAudio (details) {
  const types = details?.mediaTypes
  if (Array.isArray(types) && types.length > 0) return types.includes('audio')
  const type = details?.mediaType
  if (type && type !== 'unknown') return type === 'audio'
  return true
}

function grantMicrophone (callback) {
  if (process.platform !== 'darwin') {
    callback(true)
    return
  }
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') {
    callback(true)
    return
  }
  systemPreferences.askForMediaAccess('microphone')
    .then((granted) => callback(Boolean(granted)))
    .catch(() => callback(false))
}

app.setName('Configure My AI')
tagUserAgent()

// Linux: run as a native Wayland client when the session is Wayland (Omarchy /
// Hyprland always is) and fall back to X11 otherwise. Recent Electron already
// defaults to this; saying so keeps it true on any build, and native Wayland is
// what makes the window crisp on fractional scaling and tile cleanly.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

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

// Chromium writes cookies to disk on a lazy timer (~30s). A quit that lands
// between flushes loses whatever changed since the last one — most painfully
// the fresh remember-me cookie of someone who signed in and quit, who then
// had to sign in again next launch. Signed-in persistence is the server's
// job (the Rails app forces Devise's persistent remember cookie for this
// app's user agent); this makes sure that cookie actually reaches disk.
// Fire-and-forget: quit must never hang on it.
app.on('before-quit', () => {
  try {
    session.defaultSession.cookies.flushStore().catch(() => {})
  } catch {}
})

// macOS convention: closing the window leaves the app in the Dock.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
