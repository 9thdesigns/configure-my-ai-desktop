'use strict'

// The floating bot dock: a column of bot avatars on a side edge of the
// screen (the right, until the user drags it), above every app and on every
// Space, that stays put while the main window is minimised, hidden or closed.
// Clicking an avatar focuses that bot and opens its recents card (its last
// chats, budding out of the seat); a row, a double-click or an Option-click
// opens the quick-chat popover beside the dock. An older server without the
// threads route: the click opens the quick chat, as it did before the card.
//
// One transparent, frameless, non-activating window (an NSPanel on macOS):
//   * sized to the dock, or to dock + popover (or the recents card) while
//     one is open,
//     growing inward from the edge the dock is on;
//   * click-through everywhere but the dock and the popover — the renderer
//     reports those rectangles, and main polls the cursor and turns mouse
//     events on only while it is over one (setIgnoreMouseEvents);
//   * never focusable, except while the popover is open (so typing works
//     there and nowhere else steals focus);
//   * draggable by the dock itself (drag-gesture.js tells a drag from a
//     click; main moves the window), along its edge only: x stays on the
//     edge, y follows the pointer. Past the display's midline a ghost shows
//     on the other edge, and letting go there moves the dock across. Onto
//     another display, it re-homes to the same edge there. Remembered per
//     display as an edge and a fraction of the free height
//     (dock-placement.js, widget-placement.js). Not on Wayland, which does
//     not let an app place its windows: there the compositor decides.
//   * setBounds is never animated: opening, the window widens first and the
//     page animates the panel in; closing, the panel animates out and the
//     window is trimmed back to the dock after it settles.
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
const { popoverConversation } = require('./widget-chat')
const { isPaused, reorder, seatContextMenuTemplate, pickerBots, dockFull, MAX_PINNED } = require('./widget-seats')
const { UNSUPPORTED_RETRY_MS, rendererThreads, threadUrl } = require('./widget-threads')
const { workspaceMenuItems, currentWorkspace } = require('./workspaces')
const placement = require('./widget-placement')
const dockPlace = require('./dock-placement')
const edgeDrag = require('./edge-drag')
const { attachmentPayload, asksAboutScreen, serverRefusal, EXPLICIT_REASONS } = require('./screen-share')

// The dock grows out of the screen edge (widget.css): the window is flush
// to the work area's edge, and holds the dock's 56px body (40px seats in 8px
// of padding) plus room for its shadow, which falls away from the edge only
// (inward, and above and below: widget-view.js SHADOW_TOP/BOTTOM).
const DOCK_BODY_WIDTH = 56
const DOCK_SHADOW_X = 32
const DOCK_SHADOW_TOP = 24
const DOCK_SHADOW_BOTTOM = 40
const DOCK_WIDTH = DOCK_BODY_WIDTH + DOCK_SHADOW_X
const EDGE_MARGIN = 0 // flush: the dock meets the edge
const POPOVER_WIDTH = 380
const POPOVER_HEIGHT = 520
const PANEL_GAP = 18 // between the dock body and the quick-chat panel
const EXPANDED_WIDTH = POPOVER_WIDTH + PANEL_GAP + DOCK_BODY_WIDTH
const MIN_DOCK_HEIGHT = 64
// The recents card (a seat's recent chats, widget-threads.js): 288 wide,
// 8px of padding, a 44px header (name and status), 52px rows, and the "New
// chat" / "Open in app" controls (32px, 8px below the rows). It sits
// RECENTS_GAP from the dock body, bridged to the seat; the window holds it
// plus RECENTS_SHADOW of room for its shadow, and keeps it
// RECENTS_EDGE_MARGIN inside the work area. widget.css says the same.
const RECENTS_WIDTH = 288
const RECENTS_PAD = 8
const RECENTS_HEAD = 44
const RECENTS_ROW = 52
const RECENTS_ACTIONS = 40
const RECENTS_GAP = 10
const RECENTS_SHADOW = 24
const RECENTS_EDGE_MARGIN = 8
// The seat's centre sits this far below the card's top: level with the
// header, and below the card's 20px corner with room for the bridge
// (recents-card.js) on its straight edge.
const RECENTS_ANCHOR = 38
const RECENTS_WINDOW_WIDTH = RECENTS_SHADOW + RECENTS_WIDTH + RECENTS_GAP + DOCK_BODY_WIDTH
// A row of the card opened: the card grows into the quick chat, 380×560 (no
// taller than the work area allows), in the card's place beside the dock.
const THREAD_WIDTH = 380
const THREAD_HEIGHT = 560
const THREAD_WINDOW_WIDTH = RECENTS_SHADOW + THREAD_WIDTH + RECENTS_GAP + DOCK_BODY_WIDTH
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
// Collapsed, the window is the dock, against the left or right edge. Expanded,
// it widens inward (away from that edge) to hold the popover, which lines up
// with the top of the dock unless that would run off the bottom of the work
// area. The dock itself never moves on screen.
function layoutFor ({ workArea, dockHeight, offsetY, expanded, side = 'right' }) {
  const height = validDockHeight(dockHeight, workArea)
  const dockY = workArea.y + dockOffset(offsetY, workArea, height)
  const left = side === 'left'
  const edgeX = left ? workArea.x + EDGE_MARGIN : workArea.x + workArea.width - EDGE_MARGIN
  const xFor = (width) => (left ? edgeX : edgeX - width)

  if (!expanded) {
    return {
      bounds: { x: xFor(DOCK_WIDTH), y: dockY, width: DOCK_WIDTH, height },
      dockTop: 0,
      popoverTop: 0,
      popoverHeight: 0,
      expanded: false,
      side: left ? 'left' : 'right',
    }
  }

  const popoverHeight = Math.min(POPOVER_HEIGHT, workArea.height)
  const popoverY = clamp(dockY, workArea.y, workArea.y + workArea.height - popoverHeight)
  const top = Math.min(dockY, popoverY)
  const bottom = Math.max(dockY + height, popoverY + popoverHeight)
  return {
    bounds: { x: xFor(EXPANDED_WIDTH), y: top, width: EXPANDED_WIDTH, height: bottom - top },
    dockTop: dockY - top,
    popoverTop: popoverY - top,
    popoverHeight,
    expanded: true,
    side: left ? 'left' : 'right',
  }
}

// The recents card's height for `rows` rows.
function recentsCardHeight (rows) {
  const n = Math.max(0, Math.min(5, Math.trunc(Number(rows)) || 0))
  return 2 * RECENTS_PAD + RECENTS_HEAD + n * RECENTS_ROW + RECENTS_ACTIONS
}

// The window with a seat's recents card open. The card's header lines up
// with the seat (RECENTS_ANCHOR; seatY: the seat's centre, px down the collapsed dock
// window), unless that would take it off the top or bottom of the work
// area; the window widens inward only as far as the card (and its shadow)
// needs, and the dock never moves on screen.
function recentsLayoutFor ({ workArea, dockHeight, offsetY, side = 'right', seatY, rows }) {
  const height = validDockHeight(dockHeight, workArea)
  const dockY = workArea.y + dockOffset(offsetY, workArea, height)
  const left = side === 'left'
  const edgeX = left ? workArea.x + EDGE_MARGIN : workArea.x + workArea.width - EDGE_MARGIN
  const seat = dockY + clamp(Number.isFinite(seatY) ? seatY : height / 2, 0, height)
  const cardHeight = Math.min(recentsCardHeight(rows), workArea.height - 2 * RECENTS_EDGE_MARGIN)
  const cardY = clamp(Math.round(seat - RECENTS_ANCHOR), workArea.y + RECENTS_EDGE_MARGIN, workArea.y + workArea.height - RECENTS_EDGE_MARGIN - cardHeight)
  const top = Math.max(workArea.y, Math.min(dockY, cardY - RECENTS_SHADOW))
  const bottom = Math.min(workArea.y + workArea.height, Math.max(dockY + height, cardY + cardHeight + RECENTS_SHADOW))
  return {
    bounds: { x: left ? edgeX : edgeX - RECENTS_WINDOW_WIDTH, y: top, width: RECENTS_WINDOW_WIDTH, height: bottom - top },
    dockTop: dockY - top,
    popoverTop: 0,
    popoverHeight: 0,
    cardTop: cardY - top,
    cardHeight,
    seatY: Math.round(seat - top),
    expanded: true,
    side: left ? 'left' : 'right',
  }
}

// The window with a row of the card opened as a chat. It holds the card
// where it was (cardTop, cardHeight: the morph starts there) and the chat
// panel it grows into (popoverTop, popoverHeight): the panel's top is the
// card's, lifted only as far as it must be to stay 8px inside the work area.
// Wider than the card's window; never moved on screen relative to the dock.
function threadLayoutFor ({ workArea, dockHeight, offsetY, side = 'right', seatY, rows }) {
  const card = recentsLayoutFor({ workArea, dockHeight, offsetY, side, seatY, rows })
  const cardY = card.bounds.y + card.cardTop
  const dockY = card.bounds.y + card.dockTop
  const seat = card.bounds.y + card.seatY
  const height = validDockHeight(dockHeight, workArea)
  const panelHeight = Math.min(THREAD_HEIGHT, workArea.height - 2 * RECENTS_EDGE_MARGIN)
  const panelY = clamp(cardY, workArea.y + RECENTS_EDGE_MARGIN, workArea.y + workArea.height - RECENTS_EDGE_MARGIN - panelHeight)
  const top = Math.max(workArea.y, Math.min(dockY, cardY - RECENTS_SHADOW, panelY - RECENTS_SHADOW))
  const bottom = Math.min(workArea.y + workArea.height, Math.max(dockY + height, cardY + card.cardHeight + RECENTS_SHADOW, panelY + panelHeight + RECENTS_SHADOW))
  const left = side === 'left'
  const edgeX = left ? workArea.x + EDGE_MARGIN : workArea.x + workArea.width - EDGE_MARGIN
  return {
    bounds: { x: left ? edgeX : edgeX - THREAD_WINDOW_WIDTH, y: top, width: THREAD_WINDOW_WIDTH, height: bottom - top },
    dockTop: dockY - top,
    popoverTop: panelY - top,
    popoverHeight: panelHeight,
    cardTop: cardY - top,
    cardHeight: card.cardHeight,
    seatY: seat - top,
    expanded: true,
    side: left ? 'left' : 'right',
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

// The drag protocol from the renderer: { phase: start | move | end,
// screenX, screenY } (widget-placement.js).
const { validDrag } = placement

// What the widget renderer is sent: the dock's bots in order, each with its
// one-line state, and which one is focused. Already-validated data only;
// nothing else from the server (no CSRF token, no workspace list) goes in.
function widgetView (state, { shareScreen = false } = {}) {
  const focused = focusedBot(state)
  return {
    // The composer's Share screen button: offered when the server takes a
    // screenshot on a chat turn; `enabled` is the user's "Let Manager see
    // your screen" switch (off: the button asks to turn it on first).
    screen_share: {
      available: Boolean(state && Array.isArray(state.chat_attachments) && state.chat_attachments.includes('screenshot')),
      enabled: Boolean(shareScreen),
    },
    focused_bot_id: focused ? focused.id : null,
    needs_you: state ? state.needs_you : 0,
    bots: dockBots(state).map((bot) => ({
      id: bot.id,
      name: bot.name,
      avatar_url: bot.avatar_url,
      avatar_color: bot.avatar_color,
      avatar_shape: bot.avatar_shape,
      avatar: bot.avatar,
      mood: bot.mood,
      waiting: bot.state.waiting,
      detail: bot.state.detail,
      needs_count: bot.needs_count,
      label: isPaused(bot) ? 'Paused' : stateLabel(bot),
      paused: isPaused(bot),
      isManager: bot.isManager,
    })),
    // The "+" picker's list: the workspace's bots not in the dock.
    candidates: pickerBots(state),
    dock_full: dockFull(state),
    max_pinned: MAX_PINNED,
    // The workspace mark at the top of the dock.
    workspace: currentWorkspace(state),
  }
}

// The vertical offset older versions saved (userData/widget-position.json,
// right edge only): a finite number, or null for "centred". Read once, as
// the starting point until the dock is first dragged; positions now live in
// the prefs store, per display.
function loadOffset (file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Number.isFinite(saved?.offsetY) ? saved.offsetY : null
  } catch {
    return null
  }
}

// After this many moves in a row that did not land where asked, the platform
// is taken not to allow moving windows, and dragging stops.
const MAX_MISSED_MOVES = 3

// ---------------------------------------------------------------------------
// The Electron half
// ---------------------------------------------------------------------------

const HTML_PATH = path.join(__dirname, 'widget.html')
const GHOST_PATH = path.join(__dirname, 'dock-ghost.html')
const HTML_URL = pathToFileURL(HTML_PATH).href

// How long the dock takes to tuck into the edge it is leaving before it
// moves across (the renderer's tuck is 160ms), how often main reads the
// pointer while dragging, how long the widened window waits after the panel
// has closed before it is trimmed back to the dock.
// Main-process timers that must never keep the process alive on their own.
const unref = (t) => { if (t && typeof t.unref === 'function') t.unref(); return t }

const SWITCH_DELAY_MS = 170
const DRAG_TICK_MS = 16
const TRIM_DELAY_MS = 700
const CLOSE_MS = 320

function createWidgetController ({ store, prefs, feed, getMainWindow, openBot, switchWorkspace = () => {}, logos = null, positionFile, avatarCss = null, chatCss = null, screenShare = null, openScreenSettings = () => {}, platform = process.platform, env = process.env, electron = require('electron'), timers = { setTimeout, clearTimeout, setInterval, clearInterval } }) {
  const { BrowserWindow, screen, session } = electron

  let win = null
  let expanded = false
  let openBotId = null
  let mode = 'chat' // what the expanded window shows: 'chat', 'picker' or 'recents'
  let closingMode = null // what the closing panel showed
  // The recents card: the seat it buds from (px down the collapsed dock
  // window), each bot's last list, a sequence that drops answers arriving
  // after the user has moved on, and until when the route is taken to be
  // missing (an older server: the seat opens the quick chat instead).
  let recentsSeat = null
  let recentsRows = 0
  const threadCache = new Map()
  let recentsSeq = 0
  let threadsOffUntil = 0
  let refreshing = null
  // The quick chat pinned to one conversation (a row of the card), or null
  // for the bot's waiting-or-latest one; and where that row opens in the app.
  let pinned = null // { id, url, title }
  // Stepping back from a chat to its card: the window stays wide while the
  // chat shrinks back into the card, and is trimmed to the card after.
  let steppingBack = false
  let dockHeight = MIN_DOCK_HEIGHT
  let rects = []
  // Where the dock is: the display, the edge, and the offset down it as a
  // fraction of the free height (dock-placement.js).
  let displayId = null
  let side = 'right'
  let offset = 0.5
  // Older memory, in px (the right edge only): turned into a fraction the
  // first time it is used, once the work area and the dock's height are known.
  let legacyOffset = positionFile ? loadOffset(positionFile) : null
  let pendingLegacy = null
  let ghost = null
  let dragTimer = null
  let switchTimer = null
  let trimTimer = null
  let closing = false
  // Wayland: the compositor places windows, so the dock does not drag.
  let draggable = !placement.likelyWayland(platform, env)
  let missedMoves = 0
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

  // The display the dock is on: the one it was last on while that is still
  // connected; else the newest remembered display that is; else the default
  // (the main window's display, or the primary) at the default position.
  function display () {
    const displays = screen.getAllDisplays()
    const kept = displays.find((d) => d.id === displayId)
    if (kept) return kept
    const saved = placement.findSaved(prefs.get().widgetPositions, displays)
    if (saved) {
      displayId = saved.display.id
      side = saved.pos.edge
      if (saved.pos.legacy) {
        // { side, offsetY } from before: a fraction from now on, saved once.
        const pos = dockPlace.migrate(saved.pos, saved.display.workArea, dockHeight)
        offset = pos.offset
        prefs.set({ widgetPositions: placement.remember(prefs.get().widgetPositions, saved.display, pos) })
      } else {
        offset = saved.pos.offset
      }
      return saved.display
    }
    const main = getMainWindow()
    const chosen = main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
    displayId = chosen.id
    side = 'right'
    offset = Number.isFinite(legacyOffset) ? dockPlace.offsetFor(chosen.workArea, dockHeight, legacyOffset) : 0.5
    legacyOffset = null
    return chosen
  }

  // The layout for where the dock is now (layoutFor works in px down the
  // work area).
  function currentLayout (open = expanded, shown = mode) {
    const workArea = display().workArea
    const offsetY = dockPlace.dockTop(workArea, validDockHeight(dockHeight, workArea), offset) - workArea.y
    if (open && shown === 'recents') {
      return recentsLayoutFor({ workArea, dockHeight, offsetY, side, seatY: recentsSeat, rows: recentsRows })
    }
    if (open && shown === 'thread') {
      return threadLayoutFor({ workArea, dockHeight, offsetY, side, seatY: recentsSeat, rows: recentsRows })
    }
    return layoutFor({ workArea, dockHeight, offsetY, expanded: open, side })
  }

  const cardPart = (layout) => (layout.cardHeight ? { cardTop: layout.cardTop, cardHeight: layout.cardHeight, seatY: layout.seatY } : {})

  function layoutMessage (layout, extra = {}) {
    return { expanded: layout.expanded, dockTop: layout.dockTop, popoverTop: layout.popoverTop, popoverHeight: layout.popoverHeight, botId: openBotId, mode, side: layout.side, draggable, ...cardPart(layout), ...extra }
  }

  // setBounds is never animated: the window jumps to its new size and the
  // page animates inside it. Opening, the window widens first (the renderer
  // waits a frame before it animates the panel in); closing, it stays wide
  // while the panel animates out, and is trimmed back TRIM_DELAY_MS after.
  function place () {
    if (!alive() || drag) return
    timers.clearTimeout(trimTimer)
    trimTimer = null
    if (!expanded && closing) {
      // Keep the open window's bounds; tell the page to close the panel.
      const wide = currentLayout(true, closingMode || 'chat')
      const narrow = currentLayout(false)
      send('cma-widget:layout', layoutMessage(narrow, { closing: true, closingMode: closingMode || 'chat', dockTop: wide.dockTop, popoverTop: wide.popoverTop, popoverHeight: wide.popoverHeight, ...cardPart(wide) }))
      trimTimer = unref(timers.setTimeout(() => {
        trimTimer = null
        closing = false
        closingMode = null
        place()
      }, CLOSE_MS + TRIM_DELAY_MS))
      return
    }
    if (expanded && mode === 'recents' && steppingBack) {
      // Back from the chat: keep the chat's window while the chat shrinks
      // into the card (the card's place in it), then trim to the card.
      const wide = currentLayout(true, 'thread')
      send('cma-widget:layout', layoutMessage(wide, { back: true }))
      trimTimer = unref(timers.setTimeout(() => {
        trimTimer = null
        steppingBack = false
        place()
      }, CLOSE_MS + TRIM_DELAY_MS))
      return
    }
    const layout = currentLayout()
    win.setBounds(layout.bounds)
    const thread = mode === 'thread' && pinned && pinned.title ? { threadId: pinned.id, threadTitle: pinned.title } : {}
    send('cma-widget:layout', layoutMessage(layout, expanded ? { opening: true, ...thread } : {}))
  }

  // --- Dragging: along the edge only. x stays locked to the edge the dock
  // is on; y follows the pointer (where on the dock it was grabbed stays
  // under it). Main reads the pointer every frame as well as taking the
  // page's moves, so a drag onto another display re-homes the dock there —
  // the same edge, at the pointer's height — even between page events.
  // Crossing the display's vertical midline shows a ghost on the other
  // edge; letting go there tucks the dock out and buds it in over there.
  function dragStart (point) {
    if (!draggable || !alive()) return
    recentsSeq++
    steppingBack = false
    if (expanded) {
      expanded = false
      openBotId = null
      mode = 'chat'
      win.setFocusable(false)
    }
    closing = false
    closingMode = null
    timers.clearTimeout(trimTimer)
    timers.clearTimeout(switchTimer)
    trimTimer = switchTimer = null
    const d = display()
    const layout = currentLayout(false)
    win.setBounds(layout.bounds)
    send('cma-widget:layout', layoutMessage(layout, { dragging: true }))
    drag = { grab: point.screenY - layout.bounds.y, displayId: d.id, edge: side, target: side, top: layout.bounds.y, offset, ghost: false, last: null }
    missedMoves = 0
    setIgnore(false)
    timers.clearInterval(dragTimer)
    dragTimer = unref(timers.setInterval(() => dragTo(null), DRAG_TICK_MS))
  }

  // The pointer: the page's point when it sends one, else the cursor.
  function dragTo (point) {
    if (!drag || !alive()) return
    const p = point ? { x: point.screenX, y: point.screenY } : screen.getCursorScreenPoint()
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return
    if (drag.last && drag.last.x === p.x && drag.last.y === p.y) return
    drag.last = p
    const d = edgeDrag.displayAt(screen.getAllDisplays(), p)
    if (!d) return
    if (d.id !== drag.displayId) {
      // Onto another display: the same edge there.
      drag.displayId = d.id
      displayId = d.id
    }
    const height = validDockHeight(dockHeight, d.workArea)
    const at = edgeDrag.dragTo({ display: d, edge: drag.edge, size: height, grab: drag.grab, point: p, anchor: dockPlace.ANCHOR })
    const next = { x: edgeDrag.crossPosition(d.workArea, drag.edge, DOCK_WIDTH), y: at.pos, width: DOCK_WIDTH, height }
    win.setBounds(next)
    drag.top = at.pos
    drag.offset = at.fraction
    drag.target = at.target
    showGhost(at.ghost ? { display: d, edge: at.target, top: at.pos, height } : null)
    // A platform that ignores client positioning (some Wayland setups behind
    // XWayland): stop trying, and put the dock back.
    if (placement.landed(next, win.getBounds())) missedMoves = 0
    else if (++missedMoves >= MAX_MISSED_MOVES) {
      draggable = false
      endDrag()
      place()
    }
  }

  function dragMove (point) {
    dragTo(point)
  }

  function endDrag () {
    timers.clearInterval(dragTimer)
    dragTimer = null
    showGhost(null)
    drag = null
  }

  function dragEnd (point) {
    if (!drag || !alive()) return
    dragTo(point)
    if (!drag) return
    const { displayId: id, target, edge, offset: dropped } = drag
    endDrag()
    const d = screen.getAllDisplays().find((x) => x.id === id) || display()
    displayId = d.id
    offset = dropped
    prefs.set({ widgetPositions: placement.remember(prefs.get().widgetPositions, d, { edge: target, offset: dropped }) })
    if (target === edge) return place()
    // Across: tuck out of this edge, then bud in on the other.
    send('cma-widget:layout', layoutMessage(currentLayout(false), { tuck: true }))
    switchTimer = unref(timers.setTimeout(() => {
      switchTimer = null
      side = target
      if (!alive() || drag) return
      const layout = currentLayout(false)
      win.setBounds(layout.bounds)
      send('cma-widget:layout', layoutMessage(layout, { budIn: true }))
    }, SWITCH_DELAY_MS))
  }

  // The ghost: an outline of the dock on the edge it would land on, in a
  // window of its own (click-through, never focused), shown only while the
  // drag is past the midline.
  function showGhost (at) {
    if (!at) {
      if (ghost && !ghost.isDestroyed()) ghost.destroy()
      ghost = null
      return
    }
    const bounds = { x: dockPlace.edgeX(at.display.workArea, at.edge, DOCK_WIDTH), y: at.top, width: DOCK_WIDTH, height: at.height }
    if (ghost && !ghost.isDestroyed() && ghost.cmaEdge === at.edge) {
      ghost.setBounds(bounds)
      return
    }
    if (ghost && !ghost.isDestroyed()) ghost.destroy()
    ghost = new BrowserWindow({ ...widgetWindowOptions({ platform, preload: undefined }), ...bounds, show: false })
    ghost.cmaEdge = at.edge
    ghost.setBounds(bounds)
    ghost.setIgnoreMouseEvents(true)
    ghost.setAlwaysOnTop(true, 'floating')
    ghost.webContents.on('will-navigate', (event) => event.preventDefault())
    ghost.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    ghost.loadFile(GHOST_PATH, { query: { edge: at.edge, h: String(Math.round(at.height)) } })
    ghost.once('ready-to-show', () => { if (ghost && !ghost.isDestroyed()) ghost.showInactive() })
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
    const state = store.get()
    send('cma-widget:state', widgetView(state, { shareScreen: prefs.get().shareScreen }))
    pushAvatarCss(state)
    pushChatCss(state)
  }

  // The web app's chat tokens (chat-tokens.js), likewise once per URL. No
  // URL in the feed (an older server): the bundled tokens in widget.css stay.
  let sentChatCssUrl = null
  function pushChatCss (state) {
    const url = state?.chat_css_url
    if (!chatCss || !url || url === sentChatCssUrl) return
    chatCss.get(url).then((css) => {
      if (!css || !alive() || store.get()?.chat_css_url !== url) return
      sentChatCssUrl = url
      send('cma-widget:chat-css', { url, css })
    }).catch(() => {})
  }

  // The CFA avatar stylesheet, once per URL per window (avatar-css.js).
  let sentCssUrl = null
  function pushAvatarCss (state) {
    const url = state?.avatar_css_url
    if (!avatarCss || !url || url === sentCssUrl) return
    avatarCss.get(url).then((css) => {
      if (!css || !alive() || store.get()?.avatar_css_url !== url) return
      sentCssUrl = url
      send('cma-widget:avatar-css', { url, css })
    }).catch(() => {})
  }

  // The popover's view of a bot: the server's history when there is one, the
  // pending card from the widget state either way (widget-chat.js).
  async function popoverFor (botId, conversation) {
    if (conversation === undefined) conversation = await feed.conversation(botId, pinnedFor(botId)).catch(() => null)
    return popoverConversation(botId, conversation, store.get())
  }

  // The conversation the open chat is pinned to, for writes to this bot.
  const pinnedFor = (botId) => (pinned && botId === openBotId ? pinned.id : null)
  const pinOptions = (botId) => (pinnedFor(botId) ? { conversationId: pinnedFor(botId) } : {})

  async function loadConversation () {
    if (!openBotId) return
    const botId = openBotId
    const pin = pinned
    const conversation = await feed.conversation(botId, pinnedFor(botId)).catch(() => null)
    if (botId !== openBotId || pin !== pinned) return
    // Pinned, but the server answered with another conversation: an older
    // server that ignores conversation_id. Open the row in the app instead.
    if (pin && conversation && conversation.conversation_id && conversation.conversation_id !== pin.id) {
      collapse()
      openBot(botId, pin.url)
      return
    }
    send('cma-widget:conversation', await popoverFor(botId, conversation))
  }

  // fromCard: a row (or "New chat") of the open card — the card grows into
  // the chat ('thread'); otherwise the quick chat beside the dock ('chat').
  function expand (botId, pin = null, { fromCard = false } = {}) {
    if (!alive()) return
    recentsSeq++
    pinned = pin
    steppingBack = false
    openBotId = botId
    mode = fromCard ? 'thread' : 'chat'
    expanded = true
    closing = false
    win.setFocusable(true)
    place()
    win.focus()
    loadConversation()
    clearInterval(conversationTimer)
    conversationTimer = unref(setInterval(loadConversation, CONVERSATION_POLL_MS))
  }

  // --- The recents card: a seat's last chats, budding out of the seat. The
  // list is fetched first (so the window is sized to it); a bot with none
  // goes straight to the quick chat's composer, and so does every seat when
  // the server has no such route (404) or can't be reached — the click then
  // does exactly what it did before the card.

  const threadsMissing = () => typeof feed.threads !== 'function' || Date.now() < threadsOffUntil

  // A threads answer into the cache: true when there is a list.
  function takeThreads (botId, result) {
    if (result && result.status === 'unsupported') {
      threadsOffUntil = Date.now() + UNSUPPORTED_RETRY_MS
      threadCache.clear()
      return false
    }
    if (!result || result.status !== 'ok') return false
    threadCache.set(botId, result.threads)
    return true
  }

  function sendThreads () {
    if (openBotId) send('cma-widget:threads', { bot_id: openBotId, threads: rendererThreads(threadCache.get(openBotId)) })
  }

  async function openRecents (botId, seatY) {
    if (!alive()) return
    const seq = ++recentsSeq
    if (threadsMissing()) return expand(botId)
    const cached = threadCache.get(botId)
    if (!cached) {
      const result = await feed.threads(botId).catch(() => null)
      if (seq !== recentsSeq || !alive()) return
      if (!takeThreads(botId, result)) return expand(botId)
    }
    if (!threadCache.get(botId).length) return expand(botId)
    clearInterval(conversationTimer)
    conversationTimer = null
    openBotId = botId
    mode = 'recents'
    steppingBack = false
    pinned = null
    recentsSeat = seatY
    recentsRows = threadCache.get(botId).length
    expanded = true
    closing = false
    closingMode = null
    win.setFocusable(true)
    sendThreads()
    place()
    win.focus()
    // Shown from the cache: fetch the fresh list behind it.
    if (cached) refreshThreads()
  }

  // The open card's list again (a cable broadcast, a reopen from the
  // cache): resent when it changed, the window re-placed when the number of
  // rows did. One request at a time; a list that comes back empty or
  // missing leaves the card as it is.
  function refreshThreads () {
    if (!expanded || mode !== 'recents' || !openBotId || refreshing || threadsMissing()) return
    const botId = openBotId
    const before = threadCache.get(botId) || []
    refreshing = feed.threads(botId).catch(() => null).then((result) => {
      refreshing = null
      if (!result || result.status !== 'ok' || !result.threads.length) return
      threadCache.set(botId, result.threads)
      if (!expanded || mode !== 'recents' || openBotId !== botId) return
      if (JSON.stringify(result.threads) === JSON.stringify(before)) return
      sendThreads()
      if (result.threads.length !== recentsRows) {
        recentsRows = result.threads.length
        // Mid-step back, the trim that follows places the card anyway.
        if (!steppingBack) place()
      }
    })
  }

  // The "+" picker: the same expanded window, showing the bot list instead
  // of a conversation.
  function openPicker () {
    if (!alive()) return
    recentsSeq++
    clearInterval(conversationTimer)
    conversationTimer = null
    openBotId = null
    mode = 'picker'
    expanded = true
    win.setFocusable(true)
    place()
    win.focus()
  }

  // Pause / resume a bot in the dock (never the manager: the server
  // refuses, and its menu item is disabled).
  function setActive (botId, active) {
    const bot = dockBots(store.get()).find((b) => b.id === botId)
    if (!bot || bot.isManager) return
    feed.setActive(botId, active).catch(() => {})
  }

  function showSeatMenu (botId) {
    const { Menu } = require('electron')
    const template = seatContextMenuTemplate(store.get(), botId, {
      open: (id) => openBot(id),
      remove: (id) => { feed.setPinned(id, false).catch(() => {}) },
      move: (id, delta) => {
        const order = reorder(store.get(), id, delta)
        if (order) feed.setSeatOrder(order).catch(() => {})
      },
      setActive: (id, on) => { setActive(id, on) },
      setShareScreen: (on) => { prefs.set({ shareScreen: Boolean(on) }) },
    }, { shareScreen: prefs.get().shareScreen })
    if (template.length && alive()) Menu.buildFromTemplate(template).popup({ window: win })
  }

  // The workspace mark's menu: the same radio list as the tray's, under a
  // "Workspaces" label, with each workspace's logo once it's cached.
  function showWorkspaceMenu () {
    const { Menu } = require('electron')
    const items = workspaceMenuItems(store.get(), { switchWorkspace: (id) => switchWorkspace(id) }, { iconFor: logos?.iconFor, header: true, platform })
    if (items.length && alive()) Menu.buildFromTemplate(items).popup({ window: win })
  }

  function collapse () {
    // A screenshot the user took but didn't send goes with the popover.
    if (openBotId) screenShare?.discard(openBotId)
    clearInterval(conversationTimer)
    conversationTimer = null
    recentsSeq++
    pinned = null
    steppingBack = false
    if (!expanded || !alive()) return
    closingMode = mode
    expanded = false
    openBotId = null
    mode = 'chat'
    // The panel animates out in the still-wide window (place()); focus goes
    // back to whatever had it before the panel opened.
    closing = true
    place()
    win.setFocusable(false)
    if (typeof win.blur === 'function') win.blur()
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

    // Not while a screen capture is asking for permission: the explainer and
    // the system prompt take focus, and the answer comes back here.
    win.on('blur', () => { if (!screenShare?.busy) collapse() })
    win.on('closed', () => {
      win = null
      drag = null
      sentCssUrl = null
      sentChatCssUrl = null
      expanded = false
      openBotId = null
      clearInterval(pointerTimer)
      clearInterval(conversationTimer)
      pointerTimer = null
      timers.clearInterval(dragTimer)
      timers.clearTimeout(switchTimer)
      timers.clearTimeout(trimTimer)
      dragTimer = switchTimer = trimTimer = null
      closing = false
      showGhost(null)
    })
    win.once('ready-to-show', () => {
      place()
      win.showInactive()
    })
    win.loadFile(HTML_PATH)
    pointerTimer = unref(setInterval(pollPointer, POINTER_POLL_MS))
  }

  // Shown while the pref is on and there is somebody to show (signed in);
  // the main window's state has nothing to do with it.
  function sync () {
    const state = store.get()
    // Both switches: the shell's pref (tray "Show Widget") and the server's
    // enabled flag, which the tray toggle also sets.
    const show = prefs.get().showWidget && Boolean(state?.enabled) && dockBots(state).length > 0
    if (show && !alive()) create()
    if (!show && alive()) win.destroy()
    if (show) pushState()
    if (!state) threadCache.clear()
    if (expanded && openBotId && !dockBots(state).some((b) => b.id === openBotId)) collapse()
    else if (expanded && openBotId && mode === 'recents') refreshThreads()
    else if (expanded && openBotId) loadConversation()
  }

  // A display added, removed or changed (resolution, scale, a moved taskbar):
  // place again — display() falls back if the dock's display is gone, and
  // layoutFor clamps the offset to the new work area.
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

  // The server takes a screenshot on a chat turn (widget.json says so).
  const screenAvailable = () => widgetView(store.get()).screen_share.available

  // A message, with the screenshot held for its bot when there is one. A
  // message that asks about the screen ("what's this error?") takes one
  // first, when the switch is on and nothing is attached yet: the user asked,
  // and the indicator shows it. The screenshot is dropped once the server
  // has it; a failed send keeps it for the retry. `screen` is the capture's
  // outcome, for the composer to show a refusal.
  async function sendWithScreen (input) {
    const botId = validId(input?.bot_id)
    const can = Boolean(botId && screenShare && screenAvailable())
    let screen = null
    if (can && botId === openBotId && prefs.get().shareScreen === true && !screenShare.has(botId) && asksAboutScreen(input?.body)) {
      screen = await screenShare.request({ reason: 'message', botId }).catch(() => null)
    }
    const held = can ? screenShare.peek(botId) : null
    const attachment = held ? attachmentPayload(held) : null
    const pin = pinOptions(botId)
    const result = attachment ? await feed.sendMessage(input, { attachment, ...pin }) : (pin.conversationId ? await feed.sendMessage(input, pin) : await feed.sendMessage(input))
    // The server refused the screenshot (413 / 422): resending it won't
    // help, so it is dropped, and the message (not sent) waits for a retry.
    if (result && result.attachment_error) {
      screenShare.discard(botId)
      return { conversation: null, screen: serverRefusal(result.attachment_error), failed: true }
    }
    if (result && attachment) screenShare.discard(botId)
    return { conversation: result, screen }
  }

  function registerIpc (ipcMain) {
    ipcMain.on('cma-widget:ready', (event) => {
      if (!fromWidget(event)) return
      // A fresh page has no stylesheet yet, whatever was sent before.
      sentCssUrl = null
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
      if (d.phase === 'start') dragStart(d)
      else if (d.phase === 'move') dragMove(d)
      else dragEnd(d)
    })

    // Straight to the quick chat: a double-click or Option-click on a seat,
    // or a row / "New chat" in the recents card. Again on the bot whose chat
    // is open closes it.
    ipcMain.on('cma-widget:open', (event, botId) => {
      const id = validId(botId)
      if (!fromWidget(event) || !id) return
      if (expanded && mode === 'chat' && openBotId === id) return collapse()
      feed.setFocus(id).catch(() => {})
      expand(id)
    })

    // A row of the recents card: the quick chat pinned to that conversation.
    // Only a row the card was given, for the bot whose card is open.
    ipcMain.on('cma-widget:open-thread', (event, input) => {
      if (!fromWidget(event) || !input || typeof input !== 'object') return
      const id = validId(input.bot_id)
      if (!id || !expanded || mode !== 'recents' || openBotId !== id) return
      // thread_id null: "New chat" — the bot's chat, grown out of the card.
      if (input.thread_id === null) return expand(id, null, { fromCard: true })
      const threadId = validId(input.thread_id)
      const thread = threadId && (threadCache.get(id) || []).find((t) => t.id === threadId)
      if (!thread) return
      expand(id, { id: thread.id, url: threadUrl(id, thread), title: thread.title }, { fromCard: true })
    })

    // The chat's back chevron (or Esc): back to the card it grew out of.
    ipcMain.on('cma-widget:back', (event) => {
      if (!fromWidget(event) || !expanded || mode !== 'thread' || !openBotId) return
      if (openBotId) screenShare?.discard(openBotId)
      clearInterval(conversationTimer)
      conversationTimer = null
      pinned = null
      mode = 'recents'
      steppingBack = true
      sendThreads()
      place()
      refreshThreads()
    })

    // A seat's click: its recents card, budding from the seat at seat_y (its
    // centre, px down the collapsed dock window). Again on the open bot
    // closes it.
    ipcMain.on('cma-widget:recents', (event, input) => {
      if (!fromWidget(event) || !input || typeof input !== 'object') return
      const id = validId(input.bot_id)
      const seatY = Number(input.seat_y)
      if (!id || !Number.isFinite(seatY) || seatY < 0 || seatY > dockHeight || !dockBots(store.get()).some((b) => b.id === id)) return
      if (expanded && mode !== 'picker' && openBotId === id) return collapse()
      feed.setFocus(id).catch(() => {})
      openRecents(id, Math.round(seatY))
    })

    ipcMain.on('cma-widget:context-menu', (event, botId) => {
      const id = validId(botId)
      if (!fromWidget(event) || !id) return
      showSeatMenu(id)
    })

    ipcMain.on('cma-widget:workspace-menu', (event) => {
      if (fromWidget(event)) showWorkspaceMenu()
    })

    ipcMain.on('cma-widget:picker', (event) => {
      if (!fromWidget(event)) return
      if (expanded && mode === 'picker') return collapse()
      openPicker()
    })

    // Pin a bot from the picker; it must be one the picker offered.
    ipcMain.on('cma-widget:pin', (event, botId) => {
      const id = validId(botId)
      if (!fromWidget(event) || !id || dockFull(store.get()) || !pickerBots(store.get()).some((b) => b.id === id)) return
      collapse()
      feed.setPinned(id, true).catch(() => {})
    })

    ipcMain.on('cma-widget:collapse', (event) => {
      if (fromWidget(event)) collapse()
    })

    // The bot in the main window; from a chat pinned to a row, that row.
    ipcMain.on('cma-widget:open-in-app', (event, botId) => {
      const id = validId(botId)
      if (!fromWidget(event) || !id) return
      const url = pinnedFor(id) ? pinned.url : null
      collapse()
      if (url) openBot(id, url)
      else openBot(id)
    })

    // Each answers with the popover's refreshed view, or null when the server
    // didn't take it (the renderer keeps what the user typed and says so).
    const reply = (run) => async (event, input) => {
      if (!fromWidget(event)) return null
      const conversation = await run(input).catch(() => null)
      return conversation ? popoverFor(conversation.bot_id, conversation) : null
    }
    ipcMain.handle('cma-widget:send', async (event, input) => {
      if (!fromWidget(event)) return null
      const { conversation, screen, failed } = await sendWithScreen(input).catch(() => ({}))
      const shown = screen ? { status: screen.status, message: screen.message, settingsUrl: screen.settingsUrl } : null
      if (failed) return { failed: true, screen: shown }
      if (!conversation) return null
      const view = await popoverFor(conversation.bot_id, conversation)
      return shown ? { ...view, screen: shown } : view
    })
    ipcMain.handle('cma-widget:answer', reply((input) => feed.answer(input, pinOptions(validId(input?.bot_id)))))

    // Share screen: only for the chat that is open, only for a user action
    // (the button, or a message asking about the screen), and only while
    // the server takes screenshots. screen-share.js refuses the rest (the
    // switch off, no OS permission). The renderer gets a small preview,
    // never the image.
    ipcMain.handle('cma-widget:share-screen', async (event, input) => {
      if (!fromWidget(event) || !screenShare || !input || typeof input !== 'object') return null
      const botId = validId(input.bot_id)
      if (!expanded || !botId || botId !== openBotId || !EXPLICIT_REASONS.includes(input.reason)) return null
      if (!screenAvailable()) return null
      return screenShare.request({ reason: input.reason, botId }).catch(() => null)
    })
    ipcMain.on('cma-widget:discard-screen', (event, botId) => {
      const id = validId(botId)
      if (fromWidget(event) && id && screenShare) screenShare.discard(id)
    })
    // The fixed macOS Screen Recording pane; the renderer names no URL.
    ipcMain.on('cma-widget:screen-settings', (event) => {
      if (fromWidget(event)) openScreenSettings()
    })
    // "Turn on" from the composer's prompt: the same switch as the menus'.
    ipcMain.on('cma-widget:set-share-screen', (event, on) => {
      if (fromWidget(event)) prefs.set({ shareScreen: on === true })
    })
    ipcMain.handle('cma-widget:decide', reply((input) => feed.decide(input, pinOptions(validId(input?.bot_id)))))
  }

  return {
    sync,
    registerIpc,
    collapse,
    window: () => (alive() ? win : null),
    // The indicator (screen-share.js createIndicator): the composer says
    // "Viewing your screen" for as long as the island does.
    setCapturing: (on) => send('cma-widget:screen', { capturing: Boolean(on) }),
    isWidgetWindow: (w) => Boolean(w && w === win),
    // The cable's "threads" ping (widget-cable.js): refetch the open card.
    refreshThreads: () => refreshThreads(),
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
  DOCK_BODY_WIDTH,
  DOCK_SHADOW_TOP,
  DOCK_SHADOW_BOTTOM,
  PANEL_GAP,
  EDGE_MARGIN,
  POPOVER_WIDTH,
  POPOVER_HEIGHT,
  EXPANDED_WIDTH,
  MIN_DOCK_HEIGHT,
  RECENTS_WIDTH,
  RECENTS_PAD,
  RECENTS_HEAD,
  RECENTS_ROW,
  RECENTS_ACTIONS,
  RECENTS_GAP,
  RECENTS_SHADOW,
  RECENTS_WINDOW_WIDTH,
  THREAD_WIDTH,
  THREAD_HEIGHT,
  THREAD_WINDOW_WIDTH,
  recentsCardHeight,
  recentsLayoutFor,
  threadLayoutFor,
  MAX_RECTS,
  PARTITION,
  HTML_URL,
  widgetWindowOptions,
  validDockHeight,
  dockOffset,
  MAX_MISSED_MOVES,
  layoutFor,
  validRects,
  cursorOverRects,
  validDrag,
  widgetView,
  loadOffset,
  createWidgetController,
}
