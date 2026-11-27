'use strict'

// Switching workspace from the desktop shell — the tray's Workspaces submenu
// and the workspace mark at the top of the dock. Pure, so it is unit-tested
// without Electron (test/workspaces.test.js).
//
// A switch is POST /workspaces/:id/switch (widget-feed.js), then a fresh
// widget.json: the new workspace's seats (dock seats are kept per workspace
// on the server) with the manager first. If the main window is showing the
// app, it follows: a page that belongs to one bot of the old workspace goes
// to the new workspace's home; any other page reloads in place.

const { APP_URL, isAppUrl } = require('./url-policy')

// The small "Workspaces" label at the top of the switcher, so it's clear
// what the list is. A disabled item: the one section label every platform's
// native menus draw (greyed, not clickable).
const WORKSPACES_HEADER = { id: 'workspaces-header', label: 'Workspaces', enabled: false }

// The Workspaces items, as Menu template entries (radio; the current one
// checked; clicking another switches). A workspace with a logo shows it as
// the item's icon once workspace-logos.js has it cached (iconFor returns a
// 16/32px nativeImage, or null while loading or after a failure); otherwise
// the mark's initials lead the label, as before.
function workspaceMenuItems (state, actions, { iconFor, header = false } = {}) {
  if (!state) return []
  const items = state.workspaces.map((w) => {
    const icon = w.logo_url && typeof iconFor === 'function' ? iconFor(w.logo_url) : null
    const item = {
      id: `workspace-${w.id}`,
      label: !icon && w.mark?.initials ? `${w.mark.initials}  ${w.name}` : w.name,
      type: 'radio',
      checked: w.id === state.workspace.id,
      click: () => { if (w.id !== state.workspace.id) actions.switchWorkspace(w.id) },
    }
    if (icon) item.icon = icon
    return item
  })
  if (!header || !items.length) return items
  return [{ ...WORKSPACES_HEADER }, { type: 'separator' }, ...items]
}

// The current workspace with its mark, for the dock.
function currentWorkspace (state) {
  if (!state) return null
  const listed = state.workspaces.find((w) => w.id === state.workspace.id)
  return {
    id: state.workspace.id,
    name: state.workspace.name,
    mark: listed?.mark || { initials: state.workspace.name.slice(0, 2).toUpperCase(), color: null, shape: null, logo_url: null },
    count: state.workspaces.length,
  }
}

// Pages that belong to a single record of the old workspace — they would be
// a 404 (or the wrong thing) in the new one: one bot, session, configuration
// or chat, the manager's threads, and anything under /workspaces/:id/.
const RECORD_PAGES = /^\/(?:(?:autopilot\/bots|bots|bot_sessions|configurations|threads|manager\/threads|chats)\/[^/]+|workspaces\/[^/]+\/)/

// What the main window should do after a switch: { action: 'reload' },
// { action: 'load', url }, or { action: 'none' } when it isn't on the app.
function afterSwitch (currentUrl) {
  if (!currentUrl || !isAppUrl(currentUrl)) return { action: 'none' }
  const path = new URL(currentUrl).pathname
  if (RECORD_PAGES.test(path)) return { action: 'load', url: `${APP_URL}/home` }
  return { action: 'reload' }
}

module.exports = { WORKSPACES_HEADER, workspaceMenuItems, currentWorkspace, afterSwitch }
