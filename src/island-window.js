'use strict'

// The island: a status pill attached to the top or bottom edge of the screen
// (top centre until dragged; wrapped around the notch on a MacBook), showing the bot that needs you — its avatar, name and a state
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
const { widgetWindowOptions, validRects, cursorOverRects } = require('./widget-window')
const placement = require('./widget-placement')
const edges = require('./island-placement')
const composer = require('./island-composer')

const ISLAND_WIDTH = edges.EXPANDED_WIDTH // the open card
const COMPACT_HEIGHT = edges.PILL_HEIGHT // the floating pill (island.css --pill-h)
const MAX_HEIGHT = 440
const PARTITION = 'cma-island'

function islandWindowOptions ({ platform = process.platform, preload }) {
  const base = widgetWindowOptions({ platform, preload })
  // The envelope for the floating pill at top centre; place() sizes it for
  // where it really is before it is shown.
  const half = Math.ceil(Math.max(ISLAND_WIDTH, edges.COMPACT_WIDTH + edges.HOVER_GROW_W) / 2) + edges.SHOULDER_OPEN
  return {
    ...base,
    width: 2 * (half + edges.PAD),
    height: COMPACT_HEIGHT + edges.HOVER_GROW_H + edges.PAD,
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
  return { idle: true, mode: 'idle', bot, chip: { kind: state ? 'idle' : 'offline', label }, badge: 0, detail: '', pending: null }
}

// The island's states, from its chip: idle, working, message (a reply, or
// a failure to read), question (a question, or a bot waiting on the user),
// approval, and recording (the screen is being looked at). Each has its own
// compact look, and moving between them is the mode swap (island-view.js).
const MODES = Object.freeze(['idle', 'working', 'message', 'question', 'approval', 'recording'])
const MODE_OF_CHIP = Object.freeze({
  idle: 'idle',
  offline: 'idle',
  working: 'working',
  responded: 'message',
  failed: 'message',
  question: 'question',
  waiting: 'question',
  approval: 'approval',
  screen: 'recording',
})
const islandMode = (chip) => MODE_OF_CHIP[chip?.kind] || 'idle'

// Hovering a message or a question previews it (the card), after a beat.
const PREVIEW_MODES = Object.freeze(['message', 'question'])
const previews = (view) => Boolean(view && !view.idle && PREVIEW_MODES.includes(view.mode))

// What the island renderer is sent: the bot that needs the user, or the idle
// pill. Never null — whether the island shows at all is the pref's call.
// badge: how many things the bot has for the user (the avatar's badge).
function islandView (state, options) {
  const bot = islandBot(state)
  const chip = islandChip(bot)
  if (!bot || !chip) return islandIdleView(state, options)
  return {
    idle: false,
    mode: islandMode(chip),
    bot: botView(bot),
    chip,
    badge: Math.min(Math.max(Math.trunc(Number(bot.needs_count)) || 0, 0), 99),
    detail: bot.state.detail,
    pending: pendingFromState(bot),
  }
}

// A reply that has just arrived (the widget's "response arrived" event):
// the island says "New message" for that bot — unless something more urgent
// (a question, an approval, the screen being viewed) is already showing —
// until the user opens it, or the bot moves on in the feed.
const NEW_MESSAGE_CHIP = Object.freeze({ kind: 'responded', label: 'New message' })
function withArrival (view, arrival, state) {
  if (!view || !arrival || view.capturing) return view
  if (!view.idle && !['idle', 'working', 'message'].includes(view.mode)) return view
  const bot = arrival.botId === 'manager' ? state?.manager && { ...state.manager, id: 'manager' } : (state?.seats || []).map((s) => ({ ...s, id: s.bot_id })).find((s) => s.id === arrival.botId)
  if (!bot) return view
  return { idle: false, mode: 'message', bot: botView(bot), chip: NEW_MESSAGE_CHIP, badge: view.bot?.id === bot.id ? view.badge || 0 : 0, detail: bot.state?.detail || '', pending: null }
}

// While the widget's Share screen is capturing (screen-share.js), the pill
// says so, whatever else it was showing: the user always sees when their
// screen is being looked at.
const SCREEN_CHIP = Object.freeze({ kind: 'screen', label: 'Viewing your screen' })
function withScreenIndicator (view, capturing) {
  if (!view || !capturing) return view
  return { ...view, mode: 'recording', chip: SCREEN_CHIP, capturing: true }
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
const HOVER_PREVIEW_MS = 300 // a message or question previews after this much hover
const HOVER_LEAVE_MS = 100 // and goes this long after the pointer leaves
// Closing, the page takes the content out (280ms) and then the shell
// (~260ms); the window keeps its open size until then and is trimmed after.
const CLOSE_TRIM_MS = 600
const DISPLAY_SETTLE_MS = 300
const MAX_MISSED_MOVES = 3
const POINTER_POLL_MS = 33

// Where the island goes, and its window: the saved place (or the one a drag
// is proposing) resolved against the connected displays — the saved display
// while it is there, else the same edge on the fallback display — and the
// envelope and pill for it (island-placement.js). `height` is the pill's
// natural height while open on the card; 0 when compact.
function islandPlace ({ saved, displays, fallback, height = 0, platform = process.platform, simulateNotch = null }) {
  const at = edges.resolvePlace(saved, displays, fallback)
  if (!at) return null
  const notch = edges.notchFor(at.display, { platform, simulate: simulateNotch })
  const geometry = edges.islandGeometry({ display: at.display, edge: at.edge, offsetX: at.offsetX, notch, height, maxHeight: MAX_HEIGHT })
  return { ...at, notch, ...geometry }
}

const sameBounds = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

function createIslandController ({ store, prefs, feed, getMainWindow, openBot, openApp = () => {}, avatarCss = null, chatCss = null, platform = process.platform, env = process.env, devOverrides = false, electron = require('electron') }) {
  const { BrowserWindow, screen, session, globalShortcut } = electron

  let win = null
  let expanded = false
  let focused = false
  let height = COMPACT_HEIGHT
  let view = null
  let collapseTimer = null
  let previewTimer = null
  let settleTimer = null
  // A reply that just arrived ({ botId, mood }: the bot's mood then), shown
  // as "New message" until the user opens it or the bot moves on.
  let arrival = null
  // The Manager composer (island-composer.js): open, the Manager's
  // conversation, what the user sent, and whether a reply is on its way.
  let composing = false
  let managerConversation = null
  let sent = null
  let awaiting = false
  let composeError = null
  let replyTimer = null
  let replyDeadline = 0
  // Closing: the open height the window keeps until the page has closed.
  let holdHeight = 0
  let trimTimer = null
  // The global shortcut registered now, and whether the OS refused it.
  let registeredShortcut = null
  let shortcutTaken = false
  let pointerTimer = null
  // Where it is right now (islandPlace), and a drag in progress: where the
  // pill's centre and the pointer were at the start, and the place it is
  // proposing (saved on the drop).
  let current = null
  let drag = null
  let missedMoves = 0
  // Wayland: the compositor places windows (see the README's Hyprland rules).
  let draggable = !placement.likelyWayland(platform, env)
  let capturing = false
  // Click-through outside the pill and its card (the page reports them).
  let rects = []
  let ignoring = null
  // A notch to draw on a display that has none: development and the Linux
  // recordings only (CMA_SIMULATE_NOTCH=185x32, unpackaged builds).
  const simulateNotch = devOverrides ? edges.parseNotch(env.CMA_SIMULATE_NOTCH) : null

  const islandSession = session.fromPartition(PARTITION)
  islandSession.setPermissionRequestHandler((_c, _p, callback) => callback(false))
  islandSession.setPermissionCheckHandler(() => false)

  const alive = () => Boolean(win && !win.isDestroyed())
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload) }

  function fallbackDisplay (displays) {
    const main = getMainWindow()
    const mainBounds = main && !main.isDestroyed() && !main.isMinimized?.() ? main.getBounds() : null
    return islandDisplay({ displays, primary: screen.getPrimaryDisplay(), mainBounds })
  }

  function resolve () {
    const displays = screen.getAllDisplays()
    return islandPlace({
      saved: drag ? drag.place : prefs.get().islandEdge,
      displays,
      fallback: fallbackDisplay(displays),
      height: expanded ? height : holdHeight,
      platform,
      simulateNotch,
    })
  }

  // Size and move the window for where the island is (once — the pill's own
  // motion happens inside it) and tell the page where the pill sits.
  function place () {
    if (!alive()) return
    const next = resolve()
    if (!next) return
    current = next
    if (!sameBounds(win.getBounds(), next.window)) win.setBounds(next.window)
    send('cma-island:layout', {
      expanded,
      focused,
      composing,
      draggable,
      dragging: Boolean(drag),
      snapped: Boolean(drag && drag.snapped),
      pill: { ...next.pill, screenX: next.window.x + next.pill.centre },
    })
  }

  // --- Dragging: the pill slides along the edge under the pointer, flips to
  // the other edge past the display's middle, and is caught by the centre
  // magnet; the drop is saved.
  function dragStart (point) {
    if (!draggable || !alive()) return
    clearTimeout(collapseTimer)
    clearTimeout(previewTimer)
    if (expanded || focused) collapse()
    if (!current) place()
    if (!current) return
    drag = { startCentre: edges.screenCentre(current), startPoint: point, place: null, snapped: false }
    missedMoves = 0
    setIgnore(false)
  }

  function dragMove (point) {
    if (!drag || !alive()) return
    const d = placement.displayNearest(screen.getAllDisplays(), { x: point.screenX, y: point.screenY })
    if (!d) return
    const at = edges.dragPlace({ display: d, startCentre: drag.startCentre, startPoint: drag.startPoint, point })
    drag.place = { displayId: d.id, displayBounds: d.bounds, edge: at.edge, offsetX: at.offsetX }
    drag.snapped = at.snapped
    place()
    // A platform that ignores client positioning: stop trying, put it back.
    if (placement.landed(current.window, win.getBounds())) missedMoves = 0
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
    const at = drag.place
    drag = null
    if (at) prefs.set({ islandEdge: at })
    place()
  }

  function setIgnore (ignore) {
    if (!alive() || ignoring === ignore) return
    ignoring = ignore
    win.setIgnoreMouseEvents(ignore, { forward: true })
  }

  function pollPointer () {
    if (!alive() || !win.isVisible()) return
    if (drag || focused) return setIgnore(false)
    setIgnore(!cursorOverRects(screen.getCursorScreenPoint(), win.getBounds(), rects))
  }

  // The arrival while it still holds: the bot is still there and has not
  // started on something new (working, or waiting on the user).
  function arrivalFor (state) {
    if (!arrival) return null
    const bot = arrival.botId === 'manager' ? state?.manager : (state?.seats || []).find((s) => s.bot_id === arrival.botId)
    if (!bot || bot.state?.waiting || (bot.mood === 'working' && arrival.mood !== 'working')) arrival = null
    return arrival
  }

  function collapse () {
    clearTimeout(collapseTimer)
    clearTimeout(previewTimer)
    if (!alive()) return
    if (!expanded && !focused) return
    const wasOpen = expanded
    expanded = false
    composing = false
    // Give the keyboard back. On macOS the island is a non-activating
    // panel, so resigning key leaves the app the user was in frontmost.
    // Elsewhere blur() lowers the window (X11 Deactivate), which would push
    // the always-on-top island under other windows: not focusable is enough
    // there, and the next click elsewhere takes the keyboard.
    if (focused) {
      focused = false
      if (platform === 'darwin' && typeof win.blur === 'function') win.blur()
    }
    win.setFocusable(false)
    // Keep the open size until the page has closed the shell, then trim.
    clearTimeout(trimTimer)
    if (wasOpen) {
      holdHeight = height
      trimTimer = setTimeout(() => {
        holdHeight = 0
        place()
      }, CLOSE_TRIM_MS)
    }
    place()
  }

  // --- The Manager composer ---------------------------------------------------

  function managerView () {
    const manager = store.get()?.manager
    return manager ? botView({ ...manager, id: composer.MANAGER_ID }) : null
  }

  function pushComposer () {
    send('cma-island:composer', composer.composerView({ manager: managerView(), conversation: managerConversation, sent, awaiting, error: composeError }))
  }

  async function loadManager () {
    const next = await Promise.resolve(feed?.conversation?.(composer.MANAGER_ID)).catch(() => null)
    if (next) managerConversation = next
    pushComposer()
    return next
  }

  // Click on the island (or the shortcut): open into the composer, focused.
  function openComposer () {
    if (!alive() || !view) return
    clearTimeout(previewTimer)
    clearTimeout(collapseTimer)
    clearTimeout(trimTimer)
    holdHeight = 0
    composing = true
    expanded = true
    // A fresh start unless a reply is still on its way.
    if (!awaiting) {
      sent = null
      composeError = null
    }
    if (!win.isVisible()) win.showInactive()
    if (!focused) {
      focused = true
      win.setFocusable(true)
      win.focus()
    }
    pushComposer()
    loadManager()
    place()
  }

  const toggleComposer = () => (composing ? collapse() : openComposer())

  function stopReplyPoll () {
    clearInterval(replyTimer)
    replyTimer = null
  }

  function startReplyPoll () {
    stopReplyPoll()
    replyDeadline = Date.now() + composer.REPLY_TIMEOUT_MS
    replyTimer = setInterval(pollReply, composer.REPLY_POLL_MS)
  }

  // Waiting for the Manager's answer: refetch until it is there (or give up
  // after REPLY_TIMEOUT_MS). Landing while the island is closed, it says
  // "New message" instead.
  let polling = false
  async function pollReply () {
    if (!awaiting) return stopReplyPoll()
    if (Date.now() > replyDeadline) {
      awaiting = false
      composeError = 'timeout'
      stopReplyPoll()
      return pushComposer()
    }
    if (polling) return
    polling = true
    const next = await Promise.resolve(feed?.conversation?.(composer.MANAGER_ID)).catch(() => null)
    polling = false
    if (!next || !awaiting) return
    managerConversation = next
    if (composer.replyTo(sent, next)) {
      awaiting = false
      stopReplyPoll()
      if (!composing) {
        arrival = { botId: composer.MANAGER_ID, mood: store.get()?.manager?.mood }
        sync()
      }
    }
    pushComposer()
  }

  async function sendToManager (text) {
    const body = typeof text === 'string' ? text : ''
    if (!composing || awaiting || !body.trim()) return false
    composeError = null
    const conversation = await Promise.resolve(feed?.sendMessage?.({ bot_id: composer.MANAGER_ID, body })).catch(() => null)
    if (!conversation || !Array.isArray(conversation.messages)) {
      composeError = 'send'
      pushComposer()
      return false
    }
    managerConversation = conversation
    sent = composer.sentIn(conversation, body)
    awaiting = !composer.replyTo(sent, conversation)
    pushComposer()
    if (awaiting) startReplyPoll()
    return true
  }

  // The global shortcut (prefs.islandShortcut, a fixed list): registered
  // while the island is shown; a combination another app holds is reported
  // (the tray says so) rather than retried.
  function applyShortcut () {
    if (!globalShortcut) return
    const p = prefs.get()
    const accelerator = p.showIsland ? composer.shortcutFor(p.islandShortcut).accelerator : null
    if (accelerator === registeredShortcut && !shortcutTaken) return
    if (registeredShortcut) {
      try { globalShortcut.unregister(registeredShortcut) } catch {}
      registeredShortcut = null
    }
    shortcutTaken = false
    if (!accelerator) return
    let ok = false
    try { ok = globalShortcut.register(accelerator, toggleComposer) } catch { ok = false }
    if (ok) registeredShortcut = accelerator
    else shortcutTaken = true
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
      current = null
      sentCssUrl = null
      sentChatCssUrl = null
      composing = false
      expanded = false
      focused = false
      rects = []
      ignoring = null
      clearInterval(pointerTimer)
      pointerTimer = null
    })
    win.once('ready-to-show', () => {
      if (!alive()) return
      place()
      if (view) win.showInactive()
    })
    win.loadFile(HTML_PATH)
    pointerTimer = setInterval(pollPointer, POINTER_POLL_MS)
    pointerTimer.unref?.()
  }

  // Shown whenever the pref is on: the bot that needs the user, or the idle
  // pill. (It used to show only while a bot had something to say, and only
  // while the dock's server-side "enabled" flag was on, so with a quiet team
  // — or the dock turned off — "Show Island" did nothing visible at all.)
  function sync () {
    const state = store.get()
    if (awaiting && replyTimer) pollReply()
    const next = prefs.get().showIsland
      ? withScreenIndicator(withArrival(islandView(state, { signedIn: typeof feed?.isSignedIn === 'function' ? feed.isSignedIn() : null }), arrivalFor(state), state), capturing)
      : null
    const pendingChanged = JSON.stringify(next?.pending) !== JSON.stringify(view?.pending) || next?.bot.id !== view?.bot.id || next?.mode !== view?.mode
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
    pushChatCss()
    if (!win.isVisible()) {
      place()
      win.showInactive()
    }
  }

  // The web app's chat tokens (chat-tokens.js), once per URL per window: the
  // composer wears the web composer's look. Without them, island.css's
  // bundled values.
  let sentChatCssUrl = null
  function pushChatCss () {
    const url = store.get()?.chat_css_url
    if (!chatCss || !url || url === sentChatCssUrl) return
    chatCss.get(url).then((css) => {
      if (!css || !alive() || store.get()?.chat_css_url !== url) return
      sentChatCssUrl = url
      send('cma-island:chat-css', { url, css })
    }).catch(() => {})
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
  // moved: place now (re-homed to the same edge if its display went, kept
  // inside the work area if it shrank), and again once the OS has finished
  // moving windows between displays (the main window may land elsewhere).
  const onDisplays = () => {
    place()
    clearTimeout(settleTimer)
    settleTimer = setTimeout(place, DISPLAY_SETTLE_MS)
  }
  screen.on('display-metrics-changed', onDisplays)
  screen.on('display-added', onDisplays)
  screen.on('display-removed', onDisplays)
  const offStore = store.onChange(sync)
  const offPrefs = prefs.onChange(() => {
    applyShortcut()
    sync()
  })
  applyShortcut()

  function fromIsland (event) {
    if (!alive() || event.sender !== win.webContents) return false
    const url = (event.senderFrame && event.senderFrame.url) || event.sender.getURL()
    return url === HTML_URL
  }

  function registerIpc (ipcMain) {
    ipcMain.on('cma-island:ready', (event) => {
      if (!fromIsland(event)) return
      sentCssUrl = null
      sentChatCssUrl = null
      if (view) send('cma-island:view', view)
      pushAvatarCss()
      pushChatCss()
      if (composing) pushComposer()
      place()
    })

    ipcMain.on('cma-island:height', (event, value) => {
      if (!fromIsland(event)) return
      const next = Math.round(Number(value))
      if (!Number.isFinite(next)) return
      height = Math.min(Math.max(next, COMPACT_HEIGHT), MAX_HEIGHT)
      if (expanded) place()
    })

    // The pill (and its card, while open): where the window takes the mouse.
    ipcMain.on('cma-island:hit-rects', (event, input) => {
      if (!fromIsland(event)) return
      rects = validRects(input, win.getBounds())
    })

    // Hover: open the card without taking focus. Leaving closes it again,
    // after a beat, unless the user clicked into it.
    // Hover: a message or a question previews (the card, without taking
    // focus) after HOVER_PREVIEW_MS; leaving closes it HOVER_LEAVE_MS later,
    // unless the user clicked into it. Other states just lift (the page).
    ipcMain.on('cma-island:hover', (event, inside) => {
      if (!fromIsland(event) || drag) return
      clearTimeout(previewTimer)
      if (inside === true) {
        clearTimeout(collapseTimer)
        if (!expanded && previews(view)) previewTimer = setTimeout(() => { if (previews(view)) expand({ focus: false }) }, HOVER_PREVIEW_MS)
        return
      }
      if (focused) return
      clearTimeout(collapseTimer)
      collapseTimer = setTimeout(collapse, HOVER_LEAVE_MS)
    })

    ipcMain.on('cma-island:drag', (event, input) => {
      const d = placement.validDrag(input)
      if (!fromIsland(event) || !d) return
      if (d.phase === 'start') dragStart(d)
      else if (d.phase === 'move') dragMove(d)
      else dragEnd(d)
    })

    // Alt + arrows on the focused bar: along the edge, or to the other one.
    ipcMain.on('cma-island:move', (event, input) => {
      if (!fromIsland(event) || drag || !draggable || !current) return
      const from = { displayId: current.display.id, displayBounds: current.display.bounds, edge: current.edge, offsetX: current.offsetX }
      const next = edges.keyboardMove(from, input)
      if (!next) return
      prefs.set({ islandEdge: next })
      place()
    })

    // A click on the bar: the Manager composer.
    ipcMain.on('cma-island:compose', (event) => {
      if (fromIsland(event)) openComposer()
    })

    // Enter in the composer: to the Manager (true when the server took it).
    ipcMain.handle('cma-island:send', async (event, text) => {
      if (!fromIsland(event)) return false
      return sendToManager(text)
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
      clearArrival()
      collapse()
      openApp()
    })

    ipcMain.on('cma-island:open-in-app', (event, botId) => {
      const id = validId(botId)
      if (!fromIsland(event) || !id) return
      if (arrival?.botId === id) clearArrival()
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

  function clearArrival () {
    if (!arrival) return
    arrival = null
    sync()
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
    // The widget's "response arrived" event ({ bot_id }): main.js wires it
    // here once the dock emits it.
    responseArrived (input) {
      const id = validId(input?.bot_id)
      if (!id) return
      const state = store.get()
      const bot = id === 'manager' ? state?.manager : (state?.seats || []).find((s) => s.bot_id === id)
      if (!bot) return
      arrival = { botId: id, mood: bot.mood }
      sync()
    },
    openComposer,
    shortcutUnavailable: () => shortcutTaken,
    destroy () {
      clearTimeout(collapseTimer)
      clearTimeout(previewTimer)
      clearTimeout(trimTimer)
      stopReplyPoll()
      if (registeredShortcut && globalShortcut) {
        try { globalShortcut.unregister(registeredShortcut) } catch {}
        registeredShortcut = null
      }
      clearTimeout(settleTimer)
      clearInterval(pointerTimer)
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
  PARTITION,
  HTML_URL,
  islandWindowOptions,
  islandPlace,
  MAX_MISSED_MOVES,
  islandChip,
  islandMode,
  MODES,
  previews,
  withArrival,
  HOVER_PREVIEW_MS,
  HOVER_LEAVE_MS,
  CLOSE_TRIM_MS,
  islandBot,
  islandView,
  withScreenIndicator,
  SCREEN_CHIP,
  islandIdleView,
  islandDisplay,
  ISLAND_MENU_ID,
  islandMenuItem,
  syncIslandMenuItem,
  createIslandController,
}
