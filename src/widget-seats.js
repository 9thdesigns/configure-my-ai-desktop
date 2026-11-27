'use strict'

// The dock's seats: who sits in it and in what order, the right-click menu
// on an avatar, the "+" picker's list, and pausing / resuming a bot. Pure,
// so it is unit-testable without Electron (test/widget-seats.test.js).
//
// The manager is always first and is never removed or moved; the pinned
// seats follow in the user's order. Reordering sends the full list
// (PATCH /desktop/widget { seats: ['manager', …] }); pinning sends add_seat,
// unpinning remove_seat (widget-feed.js).

const { validId, cleanText, dockBots, stateLabel } = require('./widget-state')

const MAX_PICKER_QUERY = 80
// The server keeps at most this many pinned seats (the manager is not one);
// a 13th answers 422 (docs/desktop-widget.md, PATCH /desktop/widget).
const MAX_PINNED = 12

// Is the dock full? Then the picker says so instead of offering bots.
function dockFull (state) {
  return Boolean(state) && state.seats.filter((s) => s.pinned).length >= MAX_PINNED
}

// A bot is paused when the server says so in its status.
function isPaused (bot) {
  return bot?.state?.status === 'paused'
}

// The dock's order as ids: manager first, then the pinned seats.
function seatOrder (state) {
  return dockBots(state).map((b) => b.id)
}

// The order after moving one pinned seat up (-1) or down (+1). The manager
// keeps the first place: nothing moves above it, and it doesn't move. null
// when the move isn't possible.
function reorder (state, botId, delta) {
  const order = seatOrder(state)
  const managerId = state?.manager?.id
  const id = validId(botId)
  const from = order.indexOf(id)
  if (from < 0 || id === managerId || (delta !== -1 && delta !== 1)) return null
  const to = from + delta
  const floor = managerId && order[0] === managerId ? 1 : 0
  if (to < floor || to >= order.length) return null
  const next = order.slice()
  next.splice(from, 1)
  next.splice(to, 0, id)
  return next
}

// The avatar's right-click menu, as a Menu.buildFromTemplate template.
// actions: { open(id), remove(id), move(id, delta), setActive(id, on) }
function seatContextMenuTemplate (state, botId, actions) {
  const bot = dockBots(state).find((b) => b.id === validId(botId))
  if (!bot) return []
  const template = [
    { id: 'open', label: `Open ${bot.name}`, click: () => actions.open(bot.id) },
    { type: 'separator' },
    {
      // The manager can't be paused (the server refuses: it coordinates
      // everything else), so its switch is shown on and disabled.
      id: 'active',
      label: 'Active',
      type: 'checkbox',
      checked: !isPaused(bot),
      enabled: !bot.isManager,
      click: () => actions.setActive(bot.id, isPaused(bot)),
    },
  ]
  if (!bot.isManager) {
    template.push(
      { type: 'separator' },
      { id: 'move-up', label: 'Move Up', enabled: Boolean(reorder(state, bot.id, -1)), click: () => actions.move(bot.id, -1) },
      { id: 'move-down', label: 'Move Down', enabled: Boolean(reorder(state, bot.id, 1)), click: () => actions.move(bot.id, 1) },
      { type: 'separator' },
      { id: 'remove', label: 'Remove from Dock', click: () => actions.remove(bot.id) },
    )
  }
  return template
}

// The "+" picker: the workspace's bots not already in the dock, those that
// need attention first, filtered by a case-insensitive name match.
function pickerBots (state, query = '') {
  if (!state) return []
  const q = cleanText(query, MAX_PICKER_QUERY).toLowerCase()
  return state.seats
    .filter((s) => !s.pinned && (!q || s.name.toLowerCase().includes(q)))
    .map((s, index) => ({ s, index }))
    .sort((a, b) => (b.s.needs_count > 0) - (a.s.needs_count > 0) || a.index - b.index)
    .map(({ s }) => ({
      id: s.bot_id,
      name: s.name,
      avatar_color: s.avatar_color,
      avatar_shape: s.avatar_shape,
      avatar_url: s.avatar_url,
      needs_count: s.needs_count,
      label: isPaused(s) ? 'Paused' : stateLabel(s),
    }))
}

module.exports = { MAX_PINNED, dockFull, isPaused, seatOrder, reorder, seatContextMenuTemplate, pickerBots }
