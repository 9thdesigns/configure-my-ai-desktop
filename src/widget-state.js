'use strict'

// The desktop widget's state — which workspace, which bots sit in the dock,
// which one is focused, and how many things need the user — in the shape the
// Rails app serves at GET /desktop/widget.json and hands to
// window.cmaiDesktop.widget.publish(state) (docs/desktop-widget.md in the
// Rails app). Pure, so it is unit-testable without Electron
// (test/widget-state.test.js), the same split window-chrome.js makes.
//
// Everything here is INPUT: it arrives from a web page or over the network
// and goes on to the OS (the menu bar title, a native menu) and into the
// widget windows. So it is rebuilt field by field into a fresh object of
// known shape — unknown keys dropped, strings trimmed and capped, numbers
// clamped, URLs limited to https / our own origin — and anything
// structurally wrong is refused rather than repaired.
//
//   {
//     workspace:  { id, name },
//     workspaces: [{ id, name, mark: { initials, color, shape, logo_url } }],
//     manager:    { id: 'manager', name, avatar_url, avatar_color,
//                   avatar_shape, mood, needs_count, url, state },
//     seats:      [{ bot_id, name, avatar_url, avatar_color, avatar_shape,
//                    mood, needs_count, pinned, manager, url, state }],
//     needs_you, focused_bot_id, enabled, avatar_css_url, chat_css_url
//   }
//
// The manager and every seat may also carry `avatar` (the web app's animated
// CFA avatar, cfa-avatar.js), null from an older server. Its markup, and
// avatar_css_url and chat_css_url (chat-tokens.js), are only kept when the caller says the state came from our
// own origin ({ trusted: true }).
//
// Ids are UUID strings; the manager's is the literal 'manager'. Seats list
// every candidate bot: the pinned ones first in the user's order, then the
// rest with pinned: false. mood is idle | working | waiting | failed |
// responded; state is { status, face, waiting: 'question' | 'approval' |
// null, detail, url, session_id, message_id } for a bot and the same with
// run_id / thread_id for the manager.

const { APP_URL, isAppUrl, isAppAssetUrl } = require('./url-policy')
const { validAvatar, validAvatarCssUrl } = require('./cfa-avatar')
const { validChatCssUrl } = require('./chat-tokens')

const MOODS = Object.freeze(['idle', 'working', 'waiting', 'failed', 'responded'])
const WAITING = Object.freeze(['question', 'approval'])
const MANAGER_ID = 'manager'

const MAX_SEATS = 50
const MAX_WORKSPACES = 50
const MAX_NAME = 80
const MAX_INITIALS = 4
const MAX_DETAIL = 500
const CHAT_ATTACHMENT_KINDS = Object.freeze(['screenshot'])
const MAX_COUNT = 9999
const MAX_URL = 2048

// Record ids: UUIDs, 'manager', or other short slugs (positive integers are
// still accepted), always handed on as strings.
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

// Pictures the widget will draw (the manager's workspace logo, workspace
// marks): https only, no credentials in the URL. Anything else is dropped and
// the widget falls back to initials on the avatar colour.
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

// Where something lives in the app — loaded into the main window, so only our
// own https origin. The server sends paths ('/home', '/autopilot/bots/:id');
// full URLs on our origin are accepted too. Always handed on absolute.
function validAppUrl (value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) {
    try {
      value = new URL(value, APP_URL).toString()
    } catch {
      return null
    }
  }
  if (!isAppUrl(value)) return null
  const url = new URL(value)
  if (url.username || url.password) return null
  return url.toString()
}

// "#rgb" / "#rrggbb" only — it becomes a CSS background in the widget.
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i
function validColor (value) {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null
}

// A shape keyword (circle, squircle, square, hexagon, …): a CSS class in the
// widget, so a bare lowercase word or nothing.
const SHAPE = /^[a-z][a-z_-]{0,23}$/
function validShape (value) {
  return typeof value === 'string' && SHAPE.test(value) ? value : null
}

function validMood (value) {
  return MOODS.includes(value) ? value : 'idle'
}

const KEYWORD = /^[a-z][a-z0-9_-]{0,31}$/
function validKeyword (value) {
  return typeof value === 'string' && KEYWORD.test(value) ? value : null
}

// A question's options, as the server sends them: { id, label }, where id is
// the option's value (any short one-line string) — handed back verbatim in
// an answer.
const MAX_OPTIONS = 8
const MAX_OPTION_ID = 200
function validOptions (input) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const option of input.slice(0, MAX_OPTIONS * 2)) {
    const id = typeof option?.id === 'number' ? String(option.id) : cleanText(option?.id, MAX_OPTION_ID)
    const label = cleanText(option?.label, MAX_OPTION_ID) || id
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, label })
    if (out.length >= MAX_OPTIONS) break
  }
  return out
}

function validBotState (input) {
  const state = {
    status: null,
    face: null,
    waiting: null,
    detail: '',
    url: null,
    session_id: null,
    message_id: null,
    run_id: null,
    thread_id: null,
    options: [],
    allow_other: false,
    multiple: false,
    questions_count: 1,
  }
  if (!input || typeof input !== 'object') return state
  state.status = validKeyword(input.status)
  state.face = validKeyword(input.face)
  if (WAITING.includes(input.waiting)) state.waiting = input.waiting
  state.detail = cleanText(input.detail, MAX_DETAIL)
  state.url = validAppUrl(input.url)
  for (const key of ['session_id', 'message_id', 'run_id', 'thread_id']) state[key] = validId(input[key])
  if (state.waiting) {
    state.options = validOptions(input.options)
    state.allow_other = input.allow_other === true
    state.multiple = input.multiple === true
    // How many questions the card holds; the feed's options are the first
    // one's. Absent means one.
    const questions = Math.trunc(Number(input.questions_count))
    state.questions_count = Number.isFinite(questions) && questions > 1 ? Math.min(questions, 20) : 1
  }
  return state
}

function validMark (input, name) {
  const fallback = cleanText(name, MAX_NAME).split(' ').filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()
  if (typeof input === 'string') return { initials: cleanText(input, MAX_INITIALS) || fallback, color: null, shape: null, logo_url: null }
  if (!input || typeof input !== 'object') return { initials: fallback, color: null, shape: null, logo_url: null }
  return {
    initials: cleanText(input.initials, MAX_INITIALS) || fallback,
    color: validColor(input.color),
    shape: validShape(input.shape),
    logo_url: validImageUrl(input.logo_url),
  }
}

// A workspace logo: an image on the app origin or one of its asset hosts
// (url-policy.js isAppAssetUrl), or null.
function validLogoUrl (value) {
  const url = validImageUrl(value)
  return url && isAppAssetUrl(url) ? url : null
}

// The workspace's logo comes from its own logo_url (absolute URL or null).
// Older feeds have no logo_url key; for them, the mark's logo_url is used,
// under the same origin rule. The mark carries the same logo, so everything
// that already draws a mark picks it up.
function validWorkspace (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  if (!id) return null
  const name = cleanText(input.name, MAX_NAME) || 'Workspace'
  const mark = validMark(input.mark, name)
  const logo = validLogoUrl(Object.prototype.hasOwnProperty.call(input, 'logo_url') ? input.logo_url : mark.logo_url)
  return { id, name, logo_url: logo, mark: { ...mark, logo_url: logo } }
}

// The fields every bot (manager or seat) carries.
function botFields (input, fallbackName, trusted) {
  const state = validBotState(input.state)
  return {
    name: cleanText(input.name, MAX_NAME) || fallbackName,
    avatar_url: validImageUrl(input.avatar_url),
    avatar_color: validColor(input.avatar_color),
    avatar_shape: validShape(input.avatar_shape),
    avatar: validAvatar(input.avatar, { trusted }),
    url: validAppUrl(input.url) || state.url,
    mood: input.mood === undefined && state.waiting ? 'waiting' : validMood(input.mood),
    needs_count: count(input.needs_count),
    state,
  }
}

function validManager (input, trusted = false) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  if (!id) return null
  return { id, ...botFields(input, 'Manager', trusted) }
}

function validSeat (input, trusted = false) {
  if (!input || typeof input !== 'object') return null
  const botId = validId(input.bot_id)
  if (!botId) return null
  return {
    bot_id: botId,
    ...botFields(input, 'Bot', trusted),
    pinned: input.pinned === true,
    manager: input.manager === true || botId === MANAGER_ID,
  }
}

// Arrays: entries that fail validation are skipped, duplicates (by id) keep
// the first, and the length is capped — a page that sends 10,000 seats gets
// a menu of MAX_SEATS, not a hung main process.
function validList (input, validate, key, max, skip = () => false) {
  if (!Array.isArray(input)) return []
  const out = []
  const seen = new Set()
  for (const item of input.slice(0, max * 2)) {
    const valid = validate(item)
    if (!valid || seen.has(valid[key]) || skip(valid)) continue
    seen.add(valid[key])
    out.push(valid)
    if (out.length >= max) break
  }
  return out
}

// The page's (or the server's) widget state, made safe — or null when it is
// not a widget state at all. A state with no workspace is refused: every
// other field is scoped to one. trusted: it came from our own origin (the
// server's feed, or the app's own page), so avatar markup may be kept.
function widgetStateFrom (input, { trusted = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const workspace = validWorkspace(input.workspace)
  if (!workspace) return null

  const manager = validManager(input.manager, trusted)
  // The manager is its own field and always first in the dock; its seat in
  // the list (bot_id 'manager') is not repeated as a second avatar.
  const seats = validList(input.seats, (s) => validSeat(s, trusted), 'bot_id', MAX_SEATS, (s) => s.manager || (manager && s.bot_id === manager.id))
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
    enabled: input.enabled !== false,
    avatar_css_url: trusted ? validAvatarCssUrl(input.avatar_css_url) : null,
    chat_css_url: trusted ? validChatCssUrl(input.chat_css_url) : null,
    // What the server takes on a chat turn besides text (widget-chat.js);
    // the widget offers Share screen only when it lists 'screenshot'.
    chat_attachments: Array.isArray(input.chat_attachments)
      ? CHAT_ATTACHMENT_KINDS.filter((k) => input.chat_attachments.includes(k))
      : [],
  }
}

function seatAsBot (seat) {
  const { bot_id: id, pinned, manager, ...rest } = seat
  return { id, ...rest, isManager: false }
}

// Any bot the state knows, by id, as { id, name, …, isManager }.
function botById (state, id) {
  if (!state || !id) return null
  if (state.manager && state.manager.id === id) return { ...state.manager, isManager: true }
  const seat = state.seats.find((s) => s.bot_id === id)
  return seat ? seatAsBot(seat) : null
}

// The focused bot, or the manager, or null when there is nobody to show.
function focusedBot (state) {
  if (!state) return null
  return botById(state, state.focused_bot_id) || (state.manager ? { ...state.manager, isManager: true } : null)
}

// The avatars the dock shows, in order: the manager always first, then the
// pinned seats in the user's order.
function dockBots (state) {
  if (!state) return []
  const bots = []
  if (state.manager) bots.push({ ...state.manager, isManager: true })
  for (const seat of state.seats) if (seat.pinned) bots.push(seatAsBot(seat))
  return bots
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
  MANAGER_ID,
  MAX_SEATS,
  MAX_WORKSPACES,
  MAX_NAME,
  CHAT_ATTACHMENT_KINDS,
  validId,
  cleanText,
  validImageUrl,
  validAppUrl,
  validColor,
  validShape,
  validOptions,
  widgetStateFrom,
  botById,
  focusedBot,
  dockBots,
  stateLabel,
}
