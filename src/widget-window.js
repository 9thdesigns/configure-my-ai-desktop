'use strict'

// The floating bot dock: a column of bot avatars on the right edge of the
// screen, above every app and on every Space, that stays put while the main
// window is minimised, hidden or closed. Clicking an avatar focuses that bot
// and opens a quick-chat popover beside the dock.
//
// One transparent, frameless, non-activating window (an NSPanel on macOS):
//   * sized to the dock, or to dock + popover while the popover is open,
//     growing inward from the right edge of the work area;
//   * click-through everywhere but the dock and the popover — the renderer
//     reports those rectangles, and main polls the cursor and turns mouse
//     events on only while it is over one (setIgnoreMouseEvents);
//   * never focusable, except while the popover is open (so typing works
//     there and nowhere else steals focus);
//   * vertically draggable by its grip, the offset kept across launches in
//     userData/widget-position.json (window-state.js style).
//
// The renderer (src/widget.html) is a local file in its own in-memory
// session: it never holds the site's cookies, has no network access of its
// own (its CSP allows none), and gets only validated state from main over
// IPC. Main does every fetch, on the default session (widget-feed.js).
//
// The layout maths, the window options, the hit-rect check and the IPC
// validation are pure and unit-tested (test/widget-window.test.js); the
// controller at the bottom is the Electron half.

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { validId, dockBots, stateLabel, focusedBot } = require('./widget-state')

const DOCK_WIDTH = 72 // the dock column, including room for its shadow
const EDGE_MARGIN = 4 // gap between the dock and the screen edge
const POPOVER_WIDTH = 380
const POPOVER_HEIGHT = 520
const POPOVER_GAP = 4
const EXPANDED_WIDTH = POPOVER_WIDTH + POPOVER_GAP + DOCK_WIDTH
const MIN_DOCK_HEIGHT = 64
const MAX_RECTS = 16
const POINTER_POLL_MS = 33
const CONVERSATION_POLL_MS = 5000
const PARTITION = 'cma-widget'

// The BrowserWindow options: a transparent panel that never activates the
// app, floats above everything, and is invisible to Mission Control, the
// Dock/taskbar and the Window menu.
function widgetWindowOptions ({ platform = process.platform, preload }) {
  return {
    type: platform === 'darwin' ? 'panel' : 'toolbar',
    width: DOCK_WIDTH,
    height: MIN_DOCK_HEIGHT,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hiddenInMissionControl: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Its own in-memory session: no site cookies here, ever.
      partition: PARTITION,
      spellcheck: true,
      backgroundThrottling: false,
    },
  }
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))

function validDockHeight (value, workArea) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return MIN_DOCK_HEIGHT
  return clamp(n, MIN_DOCK_HEIGHT, workArea.height)
}

// The dock's distance from the top of the work area: the user's offset,
// clamped so the dock stays fully on screen; centred when there is none.
function dockOffset (offsetY, workArea, dockHeight) {
  const max = workArea.height - dockHeight
  if (!Number.isFinite(offsetY)) return Math.round(max / 2)
  return clamp(Math.round(offsetY), 0, max)
}

// Where the window goes, and where the dock and the popover sit inside it.
// Collapsed, the window is the dock. Expanded, it widens leftwards to hold
// the popover, which lines up with the top of the dock unless that would run
// off the bottom of the work area. The dock itself never moves on screen.
function layoutFor ({ workArea, dockHeight, offsetY, expanded }) {
  const height = validDockHeight(dockHeight, workArea)
  const dockY = workArea.y + dockOffset(offsetY, workArea, height)
  const right = workArea.x + workArea.width - EDGE_MARGIN

  if (!expanded) {
    return {
      bounds: { x: right - DOCK_WIDTH, y: dockY, width: DOCK_WIDTH, height },
      dockTop: 0,
      popoverTop: 0,
      popoverHeight: 0,
      expanded: false,
    }
  }

  const popoverHeight = Math.min(POPOVER_HEIGHT, workArea.height)
  const popoverY = clamp(dockY, workArea.y, workArea.y + workArea.height - popoverHeight)
  const top = Math.min(dockY, popoverY)
  const bottom = Math.max(dockY + height, popoverY + popoverHeight)
  return {
    bounds: { x: right - EXPANDED_WIDTH, y: top, width: EXPANDED_WIDTH, height: bottom - top },
    dockTop: dockY - top,
    popoverTop: popoverY - top,
    popoverHeight,
    expanded: true,
  }
}

// The hit rectangles the renderer reports, in window coordinates (CSS px):
// at most MAX_RECTS, finite, non-negative size, clipped to the window.
function validRects (input, size) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const r of input.slice(0, MAX_RECTS)) {
    if (!r || typeof r !== 'object') continue
    const nums = [r.x, r.y, r.width, r.height].map(Number)
    if (!nums.every(Number.isFinite)) continue
    let [x, y, w, h] = nums
    const x2 = clamp(x + w, 0, size.width)
    const y2 = clamp(y + h, 0, size.height)
    x = clamp(x, 0, size.width)
    y = clamp(y, 0, size.height)
    w = x2 - x
    h = y2 - y
    if (w > 0 && h > 0) out.push({ x, y, width: w, height: h })
  }
  return out
}

// Is the cursor (screen coordinates) over one of the window's live areas?
function cursorOverRects (cursor, bounds, rects) {
  if (!cursor || !bounds) return false
  const x = cursor.x - bounds.x
  const y = cursor.y - bounds.y
  return rects.some((r) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height)
}

// The drag protocol from the renderer: { phase: start | move | end, screenY }.
function validDrag (input) {
  if (!input || typeof input !== 'object') return null
  if (!['start', 'move', 'end'].includes(input.phase)) return null
  const screenY = Number(input.screenY)
  if (!Number.isFinite(screenY) || Math.abs(screenY) > 100000) return null
  return { phase: input.phase, screenY }
}

// What the widget renderer is sent: the dock's bots in order, each with its
// one-line state, and which one is focused. Already-validated data only;
// nothing else from the server (no CSRF token, no workspace list) goes in.
function widgetView (state) {
  const focused = focusedBot(state)
  return {
    focused_bot_id: focused ? focused.id : null,
    needs_you: state ? state.needs_you : 0,
    bots: dockBots(state).map((bot) => ({
      id: bot.id,
      name: bot.name,
      avatar_url: bot.avatar_url,
      mood: bot.mood,
      waiting: bot.state.waiting,
      detail: bot.state.detail,
      needs_count: bot.needs_count,
      label: stateLabel(bot),
      isManager: bot.isManager,
    })),
  }
}

// The saved vertical offset: a finite number, or null for "centred".
function loadOffset (file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isFinite(saved?.offsetY) ? saved.offsetY : null
  } catch {
    return null
  }
}

function saveOffset (file, offsetY) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ offsetY }))
  } catch {
    // A failed save costs the position at next launch, nothing more.
  }
}

// ---------------------------------------------------------------------------
// The Electron half
// ---------------------------------------------------------------------------

const HTML_PATH = path.join(__dirname, 'widget.html')
const HTML_URL = pathToFileURL(HTML_PATH).href

function createWidgetController ({ store, prefs, feed, getMainWindow, openBot, positionFile, platform = process.platform }) {
  const { BrowserWindow, screen, session } = require('electron')

  let win = null
  let expanded = false
  let openBotId = null
  let dockHeight = MIN_DOCK_HEIGHT
  let rects = []
  let offsetY = loadOffset(positionFile)
  let displayId = null
  let ignoring = null
  let drag = null
  let pointerTimer = null
  let conversationTimer = null

  // Nothing in the widget's own session may ask for anything.
  const widgetSession = session.fromPartition(PARTITION)
  widgetSession.setPermissionRequestHandler((_c, _p, callback) => callback(false))
  widgetSession.setPermissionCheckHandler(() => false)

  const alive = () => Boolean(win && !win.isDestroyed())
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload) }

  function display () {
    const displays = screen.getAllDisplays()
    const kept = displays.find((d) => d.id === displayId)
    if (kept) return kept
    const main = getMainWindow()
    const chosen = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
    displayId = chosen.id
    return chosen
  }

  function place () {
    if (!alive()) return
    const workArea = display().workArea
    const layout = layoutFor({ workArea, dockHeight, offsetY, expanded })
    win.setBounds(layout.bounds)
    send('cma-widget:layout', { expanded: layout.expanded, dockTop: layout.dockTop, popoverTop: layout.popoverTop, popoverHeight: layout.popoverHeight, botId: openBotId })
  }

  function setIgnore (ignore) {
    if (!alive() || ignoring === ignore) return
    ignoring = ignore
    win.setIgnoreMouseEvents(ignore, { forward: true })
  }

  function pollPointer () {
    if (!alive() || !win.isVisible()) return
    if (drag) return setIgnore(false)
    setIgnore(!cursorOverRects(screen.getCursorScreenPoint(), win.getBounds(), rects))
  }

  function pushState () {
    send('cma-widget:state', widgetView(store.get()))
  }

  async function loadConversation () {
    if (!openBotId) return
    const botId = openBotId
    const conversation = await feed.conversation(botId).catch(() => null)
    if (botId === openBotId) send('cma-widget:conversation', conversation || { bot_id: botId, error: true })
  }

  function expand (botId) {
    if (!alive()) return
    openBotId = botId
    expanded = true
    win.setFocusable(true)
    place()
    win.focus()
    loadConversation()
    clearInterval(conversationTimer)
    conversationTimer = setInterval(loadConversation, CONVERSATION_POLL_MS)
  }

  function collapse () {
    clearInterval(conversationTimer)
    conversationTimer = null
    if (!expanded || !alive()) return
    expanded = false
    openBotId = null
    place()
    win.setFocusable(false)
  }

  function create () {
    win = new BrowserWindow(widgetWindowOptions({ platform, preload: path.join(__dirname, 'widget-preload.js') }))
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    if (platform === 'darwin') win.excludedFromShownWindowsMenu = true
    ignoring = null
    setIgnore(true)

    // A local page with nowhere to go.
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

    win.on('blur', collapse)
    win.on('closed', () => {
      win = null
      expanded = false
      openBotId = null
      clearInterval(pointerTimer)
      clearInterval(conversationTimer)
      pointerTimer = null
    })
    win.once('ready-to-show', () => {
      place()
      win.showInactive()
    })
    win.loadFile(HTML_PATH)
    pointerTimer = setInterval(pollPointer, POINTER_POLL_MS)
  }

  // Shown while the pref is on and there is somebody to show (signed in);
  // the main window's state has nothing to do with it.
  function sync () {
    const state = store.get()
    const show = prefs.get().showWidget && dockBots(state).length > 0
    if (show && !alive()) create()
    if (!show && alive()) win.destroy()
    if (show) pushState()
    if (expanded && openBotId && !dockBots(state).some((b) => b.id === openBotId)) collapse()
  }

  const onDisplays = () => place()
  screen.on('display-metrics-changed', onDisplays)
  screen.on('display-added', onDisplays)
  screen.on('display-removed', onDisplays)
  const offStore = store.onChange(sync)
  const offPrefs = prefs.onChange(sync)

  // Only the widget page, in the widget window, may drive the widget.
  function fromWidget (event) {
    if (!alive() || event.sender !== win.webContents) return false
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL()
    return url === HTML_URL
  }

  function registerIpc (ipcMain) {
    ipcMain.on('cma-widget:ready', (event) => {
      if (!fromWidget(event)) return
      pushState()
      place()
    })

    ipcMain.on('cma-widget:hit-rects', (event, input) => {
      if (!fromWidget(event) || !input || typeof input !== 'object') return
      const bounds = win.getBounds()
      rects = validRects(input.rects, bounds)
      const height = validDockHeight(input.dockHeight, display().workArea)
      if (height !== dockHeight) {
        dockHeight = height
        place()
      }
    })

    ipcMain.on('cma-widget:drag', (event, input) => {
      const d = validDrag(input)
      if (!fromWidget(event) || !d) return
      const workArea = display().workArea
      if (d.phase === 'start') {
        drag = { startY: d.screenY, startOffset: dockOffset(offsetY, workArea, dockHeight) }
        return
      }
      if (!drag) return
      offsetY = dockOffset(drag.startOffset + d.screenY - drag.startY, workArea, dockHeight)
      place()
      if (d.phase === 'end') {
        drag = null
        saveOffset(positionFile, offsetY)
      }
    })

    ipcMain.on('cma-widget:open', (event, botId) => {
      const id = validId(botId)
      if (!fromWidget(event) || !id) return
      if (expanded && openBotId === id) return collapse()
      feed.setFocus(id).catch(() => {})
      expand(id)
    })

    ipcMain.on('cma-widget:collapse', (event) => {
      if (fromWidget(event)) collapse()
    })

    ipcMain.on('cma-widget:open-in-app', (event, botId) => {
      const id = validId(botId)
      if (!fromWidget(event) || !id) return
      collapse()
      openBot(id)
    })

    ipcMain.handle('cma-widget:send', (event, input) => (fromWidget(event) ? feed.sendMessage(input) : null))
    ipcMain.handle('cma-widget:answer', (event, input) => (fromWidget(event) ? feed.answer(input) : null))
    ipcMain.handle('cma-widget:decide', (event, input) => (fromWidget(event) ? feed.decide(input) : null))
  }

  return {
    sync,
    registerIpc,
    collapse,
    isWidgetWindow: (w) => Boolean(w && w === win),
    destroy () {
      offStore()
      offPrefs()
      screen.removeListener('display-metrics-changed', onDisplays)
      screen.removeListener('display-added', onDisplays)
      screen.removeListener('display-removed', onDisplays)
      if (alive()) win.destroy()
    },
  }
}

module.exports = {
  DOCK_WIDTH,
  EDGE_MARGIN,
  POPOVER_WIDTH,
  POPOVER_HEIGHT,
  EXPANDED_WIDTH,
  MIN_DOCK_HEIGHT,
  MAX_RECTS,
  PARTITION,
  HTML_URL,
  widgetWindowOptions,
  validDockHeight,
  dockOffset,
  layoutFor,
  validRects,
  cursorOverRects,
  validDrag,
  widgetView,
  loadOffset,
  saveOffset,
  createWidgetController,
}
