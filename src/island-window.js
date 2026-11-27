'use strict'

// The island: a status pill centred at the top of the screen, by the notch on
// a MacBook, showing the bot that needs you — its avatar, name and a state
// chip (Questions, Working…, New message, Needs approval, Failed). Hovering
// or clicking it opens the pending question card right there: lettered
// options with A–D shortcuts, "Something else", Skip and Done, or Approve and
// Decline for an approval. Idle, it hides.
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

const ISLAND_WIDTH = 360
const COMPACT_HEIGHT = 44
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

// What the island renderer is sent, or null to hide.
function islandView (state) {
  const bot = islandBot(state)
  const chip = islandChip(bot)
  if (!bot || !chip) return null
  return {
    bot: { id: bot.id, name: bot.name, avatar_url: bot.avatar_url, avatar_color: bot.avatar_color, avatar_shape: bot.avatar_shape },
    chip,
    detail: bot.state.detail,
    pending: pendingFromState(bot),
  }
}

// Centred at the top of the work area (under the menu bar, by the notch).
function islandBounds (workArea, height) {
  const h = Math.min(Math.max(Math.round(Number(height)) || COMPACT_HEIGHT, COMPACT_HEIGHT), Math.min(MAX_HEIGHT, workArea.height)) + SHADOW * 2
  const w = ISLAND_WIDTH + SHADOW * 2
  return { x: workArea.x + Math.round((workArea.width - w) / 2), y: workArea.y + TOP_MARGIN - SHADOW, width: w, height: h }
}

// ---------------------------------------------------------------------------
// The Electron half
// ---------------------------------------------------------------------------

const HTML_PATH = path.join(__dirname, 'island.html')
const HTML_URL = pathToFileURL(HTML_PATH).href
const HOVER_COLLAPSE_MS = 600

function createIslandController ({ store, prefs, feed, getMainWindow, openBot, platform = process.platform }) {
  const { BrowserWindow, screen, session } = require('electron')

  let win = null
  let expanded = false
  let focused = false
  let height = COMPACT_HEIGHT
  let view = null
  let collapseTimer = null

  const islandSession = session.fromPartition(PARTITION)
  islandSession.setPermissionRequestHandler((_c, _p, callback) => callback(false))
  islandSession.setPermissionCheckHandler(() => false)

  const alive = () => Boolean(win && !win.isDestroyed())
  const send = (channel, payload) => { if (alive()) win.webContents.send(channel, payload) }

  function display () {
    const main = getMainWindow()
    return main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay()
  }

  function place () {
    if (!alive()) return
    win.setBounds(islandBounds(display().workArea, expanded ? height : COMPACT_HEIGHT))
    send('cma-island:layout', { expanded, focused })
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
    if (!alive() || !view) return
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
      expanded = false
      focused = false
    })
    win.once('ready-to-show', () => {
      place()
      if (view) win.showInactive()
    })
    win.loadFile(HTML_PATH)
  }

  // Shown while the pref is on and some bot has something to say.
  function sync () {
    const state = store.get()
    const enabled = prefs.get().showIsland && Boolean(state?.enabled)
    const next = enabled ? islandView(state) : null
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
    if (pendingChanged && expanded && !focused) collapse()
    send('cma-island:view', view)
    if (!win.isVisible()) {
      place()
      win.showInactive()
    }
  }

  const onDisplays = () => place()
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
      if (view) send('cma-island:view', view)
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
      if (!fromIsland(event)) return
      if (inside === true) return expand({ focus: false })
      if (focused) return
      clearTimeout(collapseTimer)
      collapseTimer = setTimeout(collapse, HOVER_COLLAPSE_MS)
    })

    ipcMain.on('cma-island:activate', (event) => {
      if (fromIsland(event)) expand({ focus: true })
    })

    ipcMain.on('cma-island:collapse', (event) => {
      if (fromIsland(event)) collapse()
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
  ISLAND_WIDTH,
  COMPACT_HEIGHT,
  MAX_HEIGHT,
  TOP_MARGIN,
  SHADOW,
  PARTITION,
  HTML_URL,
  islandWindowOptions,
  islandChip,
  islandBot,
  islandView,
  islandBounds,
  createIslandController,
}
