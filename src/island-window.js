'use strict'

// The island: a status pill centred at the top of the screen, by the notch on
// a MacBook, showing the bot that needs you — its avatar, name and a state
// chip (Questions, Working…, New message, Needs approval, Failed). Hovering
// or clicking it opens the pending question card right there: lettered
// options with A–D shortcuts, "Something else", Skip and Done, or Approve and
// Decline for an approval. Idle, it stays up as a calm pill — the manager's
// mark and "All quiet" — so "Show Island" visibly means something; only the
// pref hides it.
//
// A second non-activating panel with the dock's flags (widget-window.js),
// at the 'status' level so it sits above ordinary floating windows. It is
// focusable only after a click (hovering shows the card without taking
// focus from whatever the user is typing in), and its renderer is the same
// kind of local, cookie-less, offline page as the dock's, fed validated
// data over IPC. Answers go through the same wrappers as the dock
// (widget-feed.js → /desktop/widget/bots/:id/answer | approval).
//
// The choice of bot, the chip, the layout and the window options are pure
// and unit-tested (test/island-window.test.js); the controller at the bottom
// is the Electron half.

const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { validId, focusedBot, dockBots } = require('./widget-state')
const { pendingFromState } = require('./widget-chat')
const { widgetWindowOptions } = require('./widget-window')
const placement = require('./widget-placement')

const ISLAND_WIDTH = 360
const COMPACT_HEIGHT = 36 // the pill (island.css --pill-h)
const MAX_HEIGHT = 440
const TOP_MARGIN = 6
const SHADOW = 10 // room around the pill for its shadow
const PARTITION = 'cma-island'

function islandWindowOptions ({ platform = process.platform, preload }) {
  const base = widgetWindowOptions({ platform, preload })
  return {
    ...base,
    width: ISLAND_WIDTH + SHADOW * 2,
    height: COMPACT_HEIGHT + SHADOW * 2,
    webPreferences: { ...base.webPreferences, partition: PARTITION },
  }
}

// The chip for a bot's state, or null when there is nothing to say (idle).
function islandChip (bot) {
  if (!bot) return null
  if (bot.state?.status === 'paused') return null
  if (bot.state?.waiting === 'question') return { kind: 'question', label: 'Questions' }
  if (bot.state?.waiting === 'approval') return { kind: 'approval', label: 'Needs approval' }
  switch (bot.mood) {
    case 'working': return { kind: 'working', label: 'Working…' }
    case 'responded': return { kind: 'responded', label: 'New message' }
    case 'failed': return { kind: 'failed', label: 'Failed' }
    case 'waiting': return { kind: 'waiting', label: 'Waiting on you' }
    default: return null
  }
}

// Which bot the island shows: the focused one when it has something to say;
// otherwise the first bot that is waiting on the user (manager, then the
// dock in order, then the rest), so a question never sits unseen behind an
// idle focus.
function islandBot (state) {
  if (!state) return null
  const focused = focusedBot(state)
  if (islandChip(focused)) return focused
  const docked = dockBots(state)
  const rest = state.seats.filter((s) => !s.pinned).map((s) => ({ ...s, id: s.bot_id, isManager: false }))
  return [...docked, ...rest].find((b) => b.state?.waiting && islandChip(b)) || null
}

// avatar: the CFA face from a newer feed (cfa-avatar.js); absent from an older one.
const botView = (bot) => ({ id: bot.id, name: bot.name, avatar_url: bot.avatar_url, avatar_color: bot.avatar_color, avatar_shape: bot.avatar_shape, ...(bot.avatar ? { avatar: bot.avatar } : {}) })

// The calm pill shown when nobody needs the user: the manager's mark and a
// one-word status. With no widget state yet (signed out, or the first fetch
// still in flight) it shows the app's initials and says which.
function islandIdleView (state, { signedIn = null } = {}) {
  const manager = state?.manager
  const bot = manager
    ? botView(manager)
    : { id: null, name: 'Configure My AI', avatar_url: null, avatar_color: null, avatar_shape: 'rounded' }
  let label = 'All quiet'
  if (!state) label = signedIn === false ? 'Signed out' : 'Connecting…'
  else if (manager?.state?.status === 'paused') label = 'Paused'
  return { idle: true, bot, chip: { kind: state ? 'idle' : 'offline', label }, detail: '', pending: null }
}

// What the island renderer is sent: the bot that needs the user, or the idle
// pill. Never null — whether the island shows at all is the pref's call.
function islandView (state, options) {
  const bot = islandBot(state)
  const chip = islandChip(bot)
  if (!bot || !chip) return islandIdleView(state, options)
  return {
    idle: false,
    bot: botView(bot),
    chip,
    detail: bot.state.detail,
    pending: pendingFromState(bot),
  }
}

// While the widget's Share screen is capturing (screen-share.js), the pill
// says so, whatever else it was showing: the user always sees when their
// screen is being looked at.
const SCREEN_CHIP = Object.freeze({ kind: 'screen', label: 'Viewing your screen' })
function withScreenIndicator (view, capturing) {
  if (!view || !capturing) return view
  return { ...view, chip: SCREEN_CHIP, capturing: true }
}

// Centred at the top of the work area. The work area is the display minus
// the menu bar (macOS — the notch lives inside the menu bar, so this is just
// under it), the taskbar (Windows, when docked at the top) or the panel
// (Linux): the pill never hides behind any of them. Kept inside the work
// area on a narrow or portrait display.
function islandBounds (workArea, height) {
  const h = Math.min(Math.max(Math.round(Number(height)) || COMPACT_HEIGHT, COMPACT_HEIGHT), Math.min(MAX_HEIGHT, workArea.height)) + SHADOW * 2
  const w = ISLAND_WIDTH + SHADOW * 2
  const centred = workArea.x + Math.round((workArea.width - w) / 2)
  const x = Math.max(workArea.x - SHADOW, Math.min(centred, workArea.x + workArea.width - w + SHADOW))
  return { x, y: workArea.y + TOP_MARGIN - SHADOW, width: w, height: h }
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))

// Which display the island goes on: the one the main window is mostly on,
// while it is on any display at all; otherwise the primary. A display that
// was unplugged is no longer in the list, so the island follows the main
// window (which the OS moves) or falls back to the primary — never off
// screen.
function islandDisplay ({ displays = [], primary, mainBounds }) {
  if (mainBounds) {
    let best = null
    let bestArea = 0
    for (const d of displays) {
      const area = overlap(d.bounds, mainBounds)
      if (area > bestArea) { best = d; bestArea = area }
    }
    if (best) return best
  }
  return primary || displays[0] || null
}

// The "Show Island" checkbox for the app menu (menu.js), wired straight to
// the pref, and the reverse sync: the tray (or anything else) changing the
// pref ticks or unticks it here.
const ISLAND_MENU_ID = 'show-island'
function islandMenuItem (prefs) {
  return {
    id: ISLAND_MENU_ID,
    label: 'Show Island',
    type: 'checkbox',
    checked: Boolean(prefs.get().showIsland),
    // Electron flips the item before calling click, so item.checked is what
    // the user asked for.
    click: (item) => prefs.set({ showIsland: Boolean(item?.checked) }),
  }
}
function syncIslandMenuItem (menu, prefs) {
  const apply = (p) => {
    const item = menu && typeof menu.getMenuItemById === 'function' ? menu.getMenuItemById(ISLAND_MENU_ID) : null
    if (item) item.checked = Boolean(p.showIsland)
  }
  apply(prefs.get())
  return prefs.onChange(apply)
}

// ---------------------------------------------------------------------------
// The Electron half
// ---------------------------------------------------------------------------

const HTML_PATH = path.join(__dirname, 'island.html')
const HTML_URL = pathToFileURL(HTML_PATH).href
const HOVER_COLLAPSE_MS = 600
const DISPLAY_SETTLE_MS = 300
const MAX_MISSED_MOVES = 3

// The island's window for where the user left it on this display: top-centre
// (islandBounds) when snapped there or never moved, otherwise the spot it was
// dropped at, kept — pill and open card — inside the work area.
function islandPlacement (workArea, height, pos) {
  return placement.islandPlaced(islandBounds(workArea, height), workArea, pos, SHADOW)
}

function createIslandController ({ store, prefs, feed, getMainWindow, openBot, openApp = () => {}, avatarCss = null, platform = process.platform, env = process.env, electron = require('electron') }) {
  const { BrowserWindow, screen, session } = electron

  let win = null
  let expanded = false
  let focused = false
  let height = COMPACT_HEIGHT
  let view = null
  let collapseTimer = null
  let settleTimer = null
  // Where the user dragged it: the display, and the position there (null:
  // top-centre). Until then it follows the main window's display.
  let placedDisplayId = null
  let pos = null
  let drag = null
  let missedMoves = 0
  // Wayland: the compositor places windows (see the README's Hyprland rules).
  let draggable = !placement.likelyWayland(platform, env)
  let capturing = false

  const islandSession = session.fromPartition(PARTITION)
  islandSession.setPermissionRequestHandler((_c, _p, callback) => callback(false))
  islandSession.setPermissionCheckHandler(() => false)

  const alive = () => Boolean(win && !win.isDestroyed())
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload) }

  // The display it is on: the one it was dropped on while that is connected;
  // else the newest remembered display that is; else (never dragged, or the
  // display is gone) the main window's display at top-centre.
  function display () {
    const displays = screen.getAllDisplays()
    const kept = placedDisplayId !== null && displays.find((d) => d.id === placedDisplayId)
    if (kept) return kept
    const saved = placement.findSaved(prefs.get().islandPositions, displays)
    if (saved) {
      placedDisplayId = saved.display.id
      pos = saved.pos
      return saved.display
    }
    placedDisplayId = null
    pos = null
    const main = getMainWindow()
    const mainBounds = main && !main.isDestroyed() && !main.isMinimized?.() ? main.getBounds() : null
    return islandDisplay({ displays, primary: screen.getPrimaryDisplay(), mainBounds })
  }

  function place () {
    if (!alive() || drag) return
    const d = display()
    if (!d) return
    win.setBounds(islandPlacement(d.workArea, expanded ? height : COMPACT_HEIGHT, pos))
    send('cma-island:layout', { expanded, focused, draggable })
  }

  // --- Dragging by the bar: the window follows the pointer, kept inside the
  // work area under it, and snaps home to top-centre when dropped near it.
  function dragStart (point) {
    if (!draggable || !alive()) return
    clearTimeout(collapseTimer)
    if (expanded || focused) collapse()
    drag = { startBounds: win.getBounds(), startPoint: point, bounds: win.getBounds() }
    missedMoves = 0
  }

  function dragMove (point) {
    if (!drag || !alive()) return
    const at = placement.dragPosition(drag.startBounds, drag.startPoint, point)
    const d = placement.displayNearest(screen.getAllDisplays(), { x: point.screenX, y: point.screenY })
    const next = d ? placement.clampToArea({ ...drag.startBounds, ...at }, d.workArea, SHADOW) : { ...drag.startBounds, ...at }
    win.setBounds(next)
    drag.bounds = next
    if (placement.landed(next, win.getBounds())) missedMoves = 0
    else if (++missedMoves >= MAX_MISSED_MOVES) {
      draggable = false
      drag = null
      place()
    }
  }

  function dragEnd (point) {
    if (!drag || !alive()) return
    dragMove(point)
    if (!drag) return
    const bounds = drag.bounds
    drag = null
    const d = placement.displayNearest(screen.getAllDisplays(), { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
    if (!d) return place()
    pos = placement.snapIsland(bounds, islandBounds(d.workArea, COMPACT_HEIGHT), d.workArea)
    placedDisplayId = d.id
    prefs.set({ islandPositions: placement.remember(prefs.get().islandPositions, d, pos) })
    place()
  }

  function collapse () {
    clearTimeout(collapseTimer)
    if (!alive()) return
    if (!expanded && !focused) return
    expanded = false
    focused = false
    win.setFocusable(false)
    place()
  }

  function expand ({ focus }) {
    clearTimeout(collapseTimer)
    if (!alive() || !view || view.idle) return
    expanded = true
    if (focus && !focused) {
      focused = true
      win.setFocusable(true)
      win.focus()
    }
    place()
  }

  function create () {
    win = new BrowserWindow(islandWindowOptions({ platform, preload: path.join(__dirname, 'island-preload.js') }))
    win.setAlwaysOnTop(true, 'status')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    if (platform === 'darwin') win.excludedFromShownWindowsMenu = true
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('blur', collapse)
    win.on('closed', () => {
      win = null
      drag = null
      sentCssUrl = null
      expanded = false
      focused = false
    })
    win.once('ready-to-show', () => {
      if (!alive()) return
      place()
      if (view) win.showInactive()
    })
    win.loadFile(HTML_PATH)
  }

  // Shown whenever the pref is on: the bot that needs the user, or the idle
  // pill. (It used to show only while a bot had something to say, and only
  // while the dock's server-side "enabled" flag was on, so with a quiet team
  // — or the dock turned off — "Show Island" did nothing visible at all.)
  function sync () {
    const state = store.get()
    const next = prefs.get().showIsland
      ? withScreenIndicator(islandView(state, { signedIn: typeof feed?.isSignedIn === 'function' ? feed.isSignedIn() : null }), capturing)
      : null
    const pendingChanged = JSON.stringify(next?.pending) !== JSON.stringify(view?.pending) || next?.bot.id !== view?.bot.id
    view = next
    if (!view) {
      if (alive()) {
        collapse()
        win.hide()
      }
      return
    }
    if (!alive()) return create()
    if ((pendingChanged || view.idle) && expanded && !focused) collapse()
    send('cma-island:view', view)
    pushAvatarCss()
    if (!win.isVisible()) {
      place()
      win.showInactive()
    }
  }

  // The CFA avatar stylesheet, once per URL per window (avatar-css.js).
  let sentCssUrl = null
  function pushAvatarCss () {
    const url = store.get()?.avatar_css_url
    if (!avatarCss || !url || url === sentCssUrl) return
    avatarCss.get(url).then((css) => {
      if (!css || !alive() || store.get()?.avatar_css_url !== url) return
      sentCssUrl = url
      send('cma-island:avatar-css', { url, css })
    }).catch(() => {})
  }

  // A display added, removed, rescaled, rotated, or its menu bar / taskbar
  // moved: place now, and again once the OS has finished moving windows
  // between displays (the main window may land somewhere else).
  const onDisplays = () => {
    place()
    clearTimeout(settleTimer)
    settleTimer = setTimeout(place, DISPLAY_SETTLE_MS)
  }
  screen.on('display-metrics-changed', onDisplays)
  screen.on('display-added', onDisplays)
  screen.on('display-removed', onDisplays)
  const offStore = store.onChange(sync)
  const offPrefs = prefs.onChange(sync)

  function fromIsland (event) {
    if (!alive() || event.sender !== win.webContents) return false
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL()
    return url === HTML_URL
  }

  function registerIpc (ipcMain) {
    ipcMain.on('cma-island:ready', (event) => {
      if (!fromIsland(event)) return
      sentCssUrl = null
      if (view) send('cma-island:view', view)
      pushAvatarCss()
      place()
    })

    ipcMain.on('cma-island:height', (event, value) => {
      if (!fromIsland(event)) return
      const next = Math.round(Number(value))
      if (!Number.isFinite(next)) return
      height = Math.min(Math.max(next, COMPACT_HEIGHT), MAX_HEIGHT)
      if (expanded) place()
    })

    // Hover: open the card without taking focus. Leaving closes it again,
    // after a beat, unless the user clicked into it.
    ipcMain.on('cma-island:hover', (event, inside) => {
      if (!fromIsland(event) || drag) return
      if (inside === true) return expand({ focus: false })
      if (focused) return
      clearTimeout(collapseTimer)
      collapseTimer = setTimeout(collapse, HOVER_COLLAPSE_MS)
    })

    ipcMain.on('cma-island:drag', (event, input) => {
      const d = placement.validDrag(input)
      if (!fromIsland(event) || !d) return
      if (d.phase === 'start') dragStart(d)
      else if (d.phase === 'move') dragMove(d)
      else dragEnd(d)
    })

    ipcMain.on('cma-island:activate', (event) => {
      if (fromIsland(event)) expand({ focus: true })
    })

    ipcMain.on('cma-island:collapse', (event) => {
      if (fromIsland(event)) collapse()
    })

    // The idle pill's click: bring the app forward.
    ipcMain.on('cma-island:open-app', (event) => {
      if (!fromIsland(event)) return
      collapse()
      openApp()
    })

    ipcMain.on('cma-island:open-in-app', (event, botId) => {
      const id = validId(botId)
      if (!fromIsland(event) || !id) return
      collapse()
      openBot(id)
    })

    // Replies: true when the server took it (the island then closes and the
    // fresh widget state decides what it shows next).
    const reply = (run) => async (event, input) => {
      if (!fromIsland(event)) return false
      const conversation = await run(input).catch(() => null)
      if (!conversation) return false
      collapse()
      return true
    }
    ipcMain.handle('cma-island:answer', reply((input) => feed.answer(input)))
    ipcMain.handle('cma-island:decide', reply((input) => feed.decide(input)))
  }

  return {
    sync,
    registerIpc,
    isVisible: () => alive() && win.isVisible(),
    window: () => (alive() ? win : null),
    setCapturing (on) {
      if (capturing === Boolean(on)) return
      capturing = Boolean(on)
      sync()
    },
    destroy () {
      clearTimeout(collapseTimer)
      clearTimeout(settleTimer)
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
  ISLAND_WIDTH,
  COMPACT_HEIGHT,
  MAX_HEIGHT,
  TOP_MARGIN,
  SHADOW,
  PARTITION,
  HTML_URL,
  islandWindowOptions,
  islandPlacement,
  MAX_MISSED_MOVES,
  islandChip,
  islandBot,
  islandView,
  withScreenIndicator,
  SCREEN_CHIP,
  islandIdleView,
  islandBounds,
  islandDisplay,
  ISLAND_MENU_ID,
  islandMenuItem,
  syncIslandMenuItem,
  createIslandController,
}
