'use strict'

// The menu bar item (macOS) / tray icon (Windows, Linux): the focused bot and
// how many things need you, readable without opening the app — "Max · 2" next
// to the clock on a Mac — and a menu to open the app, switch workspace, pick
// which bots sit in the floating dock, and the shell's own switches.
//
// The title, tooltip and menu template are pure functions of the widget
// state (widget-state.js) and the prefs, so they are unit-tested without
// Electron (test/tray.test.js); createTray is the thin Electron half.

const path = require('node:path')
const { focusedBot, stateLabel, cleanText } = require('./widget-state')
const { workspaceMenuItems } = require('./workspaces')

const TITLE_NAME_MAX = 18

function needsText (n) {
  if (!n || n <= 0) return ''
  return n > 99 ? '99+' : String(n)
}

// "Max · 2" — the focused bot's name and the needs-you count; just the name
// when nothing is waiting; empty (icon only) before there is any state, so a
// signed-out app shows no stale name.
function trayTitle (state) {
  const bot = focusedBot(state)
  if (!bot) return ''
  const name = cleanText(bot.name, TITLE_NAME_MAX)
  const needs = needsText(state.needs_you)
  return needs ? `${name} · ${needs}` : name
}

function trayTooltip (state) {
  const bot = focusedBot(state)
  if (!bot) return 'Configure My AI'
  const needs = state.needs_you
  const tail = needs > 0 ? ` — ${needs} need${needs === 1 ? 's' : ''} you` : ''
  return `Configure My AI — ${bot.name}: ${stateLabel(bot)}${tail}`
}

function botLabel (name, needsCount) {
  return needsCount > 0 ? `${name} (${needsText(needsCount)})` : name
}

// The context menu, as a Menu.buildFromTemplate template.
//   state   — validated widget state, or null (signed out / not loaded yet)
//   options — { prefs: { showWidget, keepRunningInBackground }, openAtLogin,
//               platform }
//   actions — { openApp, openBot(id), switchWorkspace(id), setPinned(id, on),
//               setShowWidget(on), setShowIsland(on), setKeepRunning(on), setOpenAtLogin(on),
//               quit }
function trayMenuTemplate (state, options, actions) {
  const { prefs = {}, openAtLogin = false, platform = process.platform } = options || {}
  const template = [
    { id: 'open', label: 'Open Configure My AI', click: () => actions.openApp() },
    { type: 'separator' },
  ]

  const bot = focusedBot(state)
  if (bot) {
    template.push({
      id: 'focused-bot',
      label: `${bot.name} — ${stateLabel(bot)}`,
      click: () => actions.openBot(bot.id),
    })
  } else {
    template.push({ id: 'focused-bot', label: 'Sign in to see your bots…', click: () => actions.openApp() })
  }

  if (state) {
    template.push({
      id: 'workspaces',
      label: 'Workspaces',
      enabled: state.workspaces.length > 0,
      submenu: workspaceMenuItems(state, actions),
    })

    const bots = []
    if (state.manager) {
      // The manager always sits first in the dock; it can't be unpinned.
      bots.push({
        id: `bot-${state.manager.id}`,
        label: botLabel(state.manager.name, state.manager.needs_count),
        type: 'checkbox',
        checked: true,
        enabled: false,
      })
    }
    if (state.manager && state.seats.length) bots.push({ type: 'separator' })
    for (const seat of state.seats) {
      bots.push({
        id: `bot-${seat.bot_id}`,
        label: botLabel(seat.name, seat.needs_count),
        type: 'checkbox',
        checked: seat.pinned,
        click: () => actions.setPinned(seat.bot_id, !seat.pinned),
      })
    }
    template.push({ id: 'bots', label: 'Bots', enabled: bots.length > 0, submenu: bots })
  }

  template.push(
    { type: 'separator' },
    {
      id: 'show-widget',
      label: 'Show Widget',
      type: 'checkbox',
      checked: Boolean(prefs.showWidget),
      click: () => actions.setShowWidget(!prefs.showWidget),
    },
    {
      id: 'show-island',
      label: 'Show Island',
      type: 'checkbox',
      checked: Boolean(prefs.showIsland),
      click: () => actions.setShowIsland(!prefs.showIsland),
    },
    {
      id: 'keep-running',
      label: 'Keep Running in Background',
      type: 'checkbox',
      checked: Boolean(prefs.keepRunningInBackground),
      click: () => actions.setKeepRunning(!prefs.keepRunningInBackground),
    },
  )

  // Login items exist on macOS and Windows only (app.setLoginItemSettings);
  // Linux autostart is a .desktop file the distro owns.
  if (platform === 'darwin' || platform === 'win32') {
    template.push({
      id: 'open-at-login',
      label: 'Start at Login',
      type: 'checkbox',
      checked: Boolean(openAtLogin),
      click: () => actions.setOpenAtLogin(!openAtLogin),
    })
  }

  template.push(
    { type: 'separator' },
    { id: 'quit', label: 'Quit Configure My AI', click: () => actions.quit() },
  )
  return template
}

// macOS gets a template image (black + alpha; the OS tints it for light and
// dark menu bars, and the "Template" suffix tells nativeImage so); Windows
// and Linux get the colour app icon. The @2x files are picked up by name.
function trayIconPath (platform = process.platform) {
  return path.join(__dirname, 'assets', platform === 'darwin' ? 'trayTemplate.png' : 'tray.png')
}

function createTray ({ store, prefs, actions, getOpenAtLogin, platform = process.platform }) {
  const { Tray, Menu, nativeImage } = require('electron')
  const image = nativeImage.createFromPath(trayIconPath(platform))
  if (platform === 'darwin') image.setTemplateImage(true)
  const tray = new Tray(image)

  const render = () => {
    if (tray.isDestroyed()) return
    const state = store.get()
    const template = trayMenuTemplate(state, { prefs: prefs.get(), openAtLogin: getOpenAtLogin(), platform }, actions)
    tray.setContextMenu(Menu.buildFromTemplate(template))
    tray.setToolTip(trayTooltip(state))
    if (platform === 'darwin') tray.setTitle(trayTitle(state), { fontType: 'monospacedDigit' })
  }

  // Windows convention: a left click on the tray icon opens the app; the menu
  // is on right click (setContextMenu). macOS shows the menu on any click.
  if (platform === 'win32') tray.on('click', () => actions.openApp())

  const unsubscribe = [store.onChange(render), prefs.onChange(render)]
  render()

  return {
    tray,
    render,
    destroy () {
      for (const off of unsubscribe) off()
      if (!tray.isDestroyed()) tray.destroy()
    },
  }
}

module.exports = { trayTitle, trayTooltip, trayMenuTemplate, trayIconPath, createTray }
