'use strict'

// The desktop widget's state — which workspace, which bots sit in the dock,
// which one is focused, and how many things need the user — in the shape the
// Rails app serves at GET /desktop/widget.json and hands to
// window.cmaiDesktop.widget.publish(state). Pure, so it is unit-testable
// without Electron (test/widget-state.test.js), the same split
// window-chrome.js makes.
//
// Everything here is INPUT: it arrives from a web page or over the network
// and goes on to the OS (the menu bar title, a native menu) and, later, into
// the widget windows. So it is rebuilt field by field into a fresh object of
// known shape — unknown keys dropped, strings trimmed and capped, numbers
// clamped, URLs limited to https — and anything structurally wrong is
// refused rather than repaired.
//
//   {
//     workspace:  { id, name },
//     workspaces: [{ id, name, mark }],
//     manager:    { id, name, avatar_url, mood, state },
//     seats:      [{ bot_id, name, avatar_url, mood, state, needs_count, pinned }],
//     needs_you, focused_bot_id
//   }
//
// mood is idle | working | waiting | failed | responded; state is
// { waiting: 'question' | 'approval' | null, detail }.

const MOODS = Object.freeze(['idle', 'working', 'waiting', 'failed', 'responded'])
const WAITING = Object.freeze(['question', 'approval'])

const MAX_SEATS = 50
const MAX_WORKSPACES = 50
const MAX_NAME = 80
const MAX_MARK = 16
const MAX_DETAIL = 500
const MAX_COUNT = 9999
const MAX_URL = 2048

// Record ids: positive integers or short slug/uuid-like strings, always
// handed on as strings so "7" and 7 compare equal everywhere downstream.
const ID = /^[A-Za-z0-9_-]{1,64}$/

function validId (value) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null
  }
  return typeof value === 'string' && ID.test(value) ? value : null
}

// Control characters and newlines out (a native menu label or a menu bar
// title is one line), whitespace collapsed, then capped.
function cleanText (value, max) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

function count (value) {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, MAX_COUNT)
}

// Avatars are pictures the widget will draw; only https, and only without
// credentials in the URL. Anything else is dropped (the widget falls back to
// initials).
function validImageUrl (value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

function validMood (value) {
  return MOODS.includes(value) ? value : 'idle'
}

function validBotState (input) {
  const state = { waiting: null, detail: '' }
  if (!input || typeof input !== 'object') return state
  if (WAITING.includes(input.waiting)) state.waiting = input.waiting
  state.detail = cleanText(input.detail, MAX_DETAIL)
  return state
}

function validWorkspace (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  if (!id) return null
  return { id, name: cleanText(input.name, MAX_NAME) || 'Workspace', mark: cleanText(input.mark, MAX_MARK) }
}

function validManager (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  if (!id) return null
  const state = validBotState(input.state)
  return {
    id,
    name: cleanText(input.name, MAX_NAME) || 'Manager',
    avatar_url: validImageUrl(input.avatar_url),
    mood: input.mood === undefined && state.waiting ? 'waiting' : validMood(input.mood),
    state,
    needs_count: count(input.needs_count),
  }
}

function validSeat (input) {
  if (!input || typeof input !== 'object') return null
  const botId = validId(input.bot_id)
  if (!botId) return null
  return {
    bot_id: botId,
    name: cleanText(input.name, MAX_NAME) || 'Bot',
    avatar_url: validImageUrl(input.avatar_url),
    mood: validMood(input.mood),
    state: validBotState(input.state),
    needs_count: count(input.needs_count),
    pinned: input.pinned === true,
  }
}

// Arrays: entries that fail validation are skipped, duplicates (by id) keep
// the first, and the length is capped — a page that sends 10,000 seats gets
// a menu of MAX_SEATS, not a hung main process.
function validList (input, validate, key, max, exclude = []) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set(exclude)
  for (const item of input.slice(0, max * 2)) {
    const valid = validate(item)
    if (!valid || seen.has(valid[key])) continue
    seen.add(valid[key])
    out.push(valid)
    if (out.length >= max) break
  }
  return out
}

// The page's (or the server's) widget state, made safe — or null when it is
// not a widget state at all. A state with no workspace is refused: every
// other field is scoped to one.
function widgetStateFrom (input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const workspace = validWorkspace(input.workspace)
  if (!workspace) return null

  const manager = validManager(input.manager)
  const seats = validList(input.seats, validSeat, 'bot_id', MAX_SEATS, manager ? [manager.id] : [])
  const workspaces = validList(input.workspaces, validWorkspace, 'id', MAX_WORKSPACES)
  if (!workspaces.some((w) => w.id === workspace.id)) workspaces.unshift(workspace)

  const known = new Set([manager?.id, ...seats.map((s) => s.bot_id)].filter(Boolean))
  const focused = validId(input.focused_bot_id)

  return {
    workspace: { id: workspace.id, name: workspace.name },
    workspaces,
    manager,
    seats,
    needs_you: count(input.needs_you),
    // The focus has to be a bot the state knows about; otherwise the manager
    // (always first, and the default on launch).
    focused_bot_id: focused && known.has(focused) ? focused : (manager ? manager.id : null),
  }
}

// The focused bot as { id, name, mood, state, needs_count, avatar_url }, or
// null when there is nobody to show.
function focusedBot (state) {
  if (!state) return null
  const id = state.focused_bot_id
  if (state.manager && state.manager.id === id) return { ...state.manager, isManager: true }
  const seat = state.seats.find((s) => s.bot_id === id)
  if (seat) return { id: seat.bot_id, name: seat.name, avatar_url: seat.avatar_url, mood: seat.mood, state: seat.state, needs_count: seat.needs_count, isManager: false }
  return state.manager ? { ...state.manager, isManager: true } : null
}

// The one-line state of a bot, as the menu bar, the dock tooltip and the
// island chip all say it. A pending question or approval outranks the mood.
function stateLabel (bot) {
  if (!bot) return ''
  if (bot.state?.waiting === 'question') return 'Questions'
  if (bot.state?.waiting === 'approval') return 'Needs approval'
  switch (bot.mood) {
    case 'working': return 'Working…'
    case 'waiting': return 'Waiting on you'
    case 'failed': return 'Failed'
    case 'responded': return 'New message'
    default: return 'Idle'
  }
}

module.exports = {
  MOODS,
  WAITING,
  MAX_SEATS,
  MAX_WORKSPACES,
  MAX_NAME,
  validId,
  cleanText,
  validImageUrl,
  widgetStateFrom,
  focusedBot,
  stateLabel,
}
