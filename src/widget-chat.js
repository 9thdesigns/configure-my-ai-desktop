'use strict'

// The dock's quick-chat popover: the focused bot's last messages, its pending
// question or approval, and the replies the user sends from the widget. Pure,
// so it is unit-testable without Electron (test/widget-chat.test.js).
//
// Answers and approvals go to the same endpoints the web app's question and
// plan cards submit to (docs/desktop-widget.md in the Rails app), addressed
// by the session / message ids in the bot's widget state — main builds the
// path from the validated state, never from what the renderer says:
//
//   POST /autopilot/bots/:bot_id/sessions/:session_id/messages/:message_id/answer
//   POST /autopilot/bots/:bot_id/sessions/:session_id/approve_plan | decline_plan
//
// The message history and the composer use session-cookie wrappers (the
// /mobile-api endpoints take a mobile token the shell doesn't hold); until
// the server has them the popover shows the pending card from the widget
// state and "Open in app":
//
//   GET  /desktop/widget/bots/:id/messages?limit=20
//   POST /desktop/widget/bots/:id/messages   { body }
//
// which answer with the conversation:
//   { bot_id, url?, messages: [{ id, role, body, created_at }],
//     pending: { id, kind: 'question' | 'approval', prompt, detail?,
//                options: [{ id, label }], allow_other, multiple } | null }

const { validId, cleanText, validAppUrl, botById, stateLabel } = require('./widget-state')

const MESSAGE_LIMIT = 20
const MAX_BODY = 8000
const MAX_PROMPT = 1000
const MAX_OPTIONS = 8
const MAX_OPTION_LABEL = 200
const MAX_COMPOSE = 10_000
const ROLES = Object.freeze(['user', 'assistant', 'system'])
const PENDING_KINDS = Object.freeze(['question', 'approval'])
const DECISIONS = Object.freeze(['approve', 'decline'])

function botPath (botId, leaf) {
  const id = validId(botId)
  return id ? `/desktop/widget/bots/${encodeURIComponent(id)}/${leaf}` : null
}

function messagesPath (botId) {
  const path = botPath(botId, 'messages')
  return path ? `${path}?limit=${MESSAGE_LIMIT}` : null
}

// Message bodies keep their line breaks (it is a chat), but lose other control
// characters, and are capped. The renderer sets them as text, never HTML.
function cleanBody (value, max) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function validTime (value) {
  if (typeof value !== 'string' || value.length > 40) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

function validMessage (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  const body = cleanBody(input.body, MAX_BODY)
  if (!id || !body) return null
  return { id, role: ROLES.includes(input.role) ? input.role : 'assistant', body, created_at: validTime(input.created_at) }
}

function validPending (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  if (!id || !PENDING_KINDS.includes(input.kind)) return null
  const options = []
  const seen = new Set()
  if (Array.isArray(input.options)) {
    for (const option of input.options.slice(0, MAX_OPTIONS * 2)) {
      const optionId = validId(option?.id)
      const label = cleanText(option?.label, MAX_OPTION_LABEL)
      if (!optionId || !label || seen.has(optionId)) continue
      seen.add(optionId)
      options.push({ id: optionId, label })
      if (options.length >= MAX_OPTIONS) break
    }
  }
  return {
    id,
    kind: input.kind,
    prompt: cleanBody(input.prompt, MAX_PROMPT) || (input.kind === 'approval' ? 'Approve this?' : 'Question'),
    detail: cleanBody(input.detail, MAX_PROMPT),
    options: input.kind === 'question' ? options : [],
    allow_other: input.kind === 'question' && input.allow_other !== false,
    multiple: input.kind === 'question' && input.multiple === true,
  }
}

function conversationFrom (input, expectedBotId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const botId = validId(input.bot_id)
  if (!botId || (expectedBotId && botId !== validId(expectedBotId))) return null
  const messages = Array.isArray(input.messages)
    ? input.messages.slice(-MESSAGE_LIMIT * 2).map(validMessage).filter(Boolean).slice(-MESSAGE_LIMIT)
    : []
  return { bot_id: botId, url: validAppUrl(input.url), messages, pending: validPending(input.pending) }
}

// What the widget renderer may ask main to send — rebuilt like everything
// else, since a compromised renderer is still untrusted input to main.
function composeFrom (input) {
  if (!input || typeof input !== 'object') return null
  const botId = validId(input.bot_id)
  const body = cleanBody(input.body, MAX_COMPOSE)
  if (!botId || !body) return null
  return { botId, path: botPath(botId, 'messages'), body: { body } }
}

// The bot the renderer named, if the widget state has it waiting for this
// kind of reply with the ids the endpoint needs.
function waitingBot (state, botId, kind) {
  const bot = botById(state, validId(botId))
  if (!bot || bot.isManager || bot.state.waiting !== kind || !bot.state.session_id) return null
  return bot
}

function sessionPath (bot) {
  return `/autopilot/bots/${encodeURIComponent(bot.id)}/sessions/${encodeURIComponent(bot.state.session_id)}`
}

// { bot_id, option_ids, text } or { bot_id, skip: true } → the answer POST.
function answerFrom (input, state) {
  if (!input || typeof input !== 'object') return null
  const bot = waitingBot(state, input.bot_id, 'question')
  if (!bot || !bot.state.message_id) return null
  const optionIds = Array.isArray(input.option_ids) ? [...new Set(input.option_ids.map(validId).filter(Boolean))].slice(0, MAX_OPTIONS) : []
  const text = cleanBody(input.text, MAX_COMPOSE)
  const skip = input.skip === true
  if (!skip && optionIds.length === 0 && !text) return null
  return {
    botId: bot.id,
    path: `${sessionPath(bot)}/messages/${encodeURIComponent(bot.state.message_id)}/answer`,
    body: skip ? { skip: true } : { option_ids: optionIds, text },
  }
}

// { bot_id, decision: 'approve' | 'decline' } → the plan approve/decline POST.
function decisionFrom (input, state) {
  if (!input || typeof input !== 'object' || !DECISIONS.includes(input.decision)) return null
  const bot = waitingBot(state, input.bot_id, 'approval')
  if (!bot) return null
  return { botId: bot.id, path: `${sessionPath(bot)}/${input.decision === 'approve' ? 'approve_plan' : 'decline_plan'}`, body: {} }
}

// The pending card when the server has no richer one: what the widget state
// says the bot is waiting for. actionable is whether the widget can reply
// itself (it has the ids) or only offer "Open in app".
function pendingFromState (bot) {
  if (!bot || !bot.state.waiting) return null
  const kind = bot.state.waiting
  const actionable = !bot.isManager && Boolean(bot.state.session_id) && (kind === 'approval' || Boolean(bot.state.message_id))
  return {
    id: bot.state.message_id || bot.state.session_id || bot.id,
    kind,
    prompt: bot.state.detail || stateLabel(bot),
    detail: '',
    options: [],
    allow_other: kind === 'question',
    multiple: false,
    actionable,
  }
}

// What the popover is sent: the server's conversation when there is one,
// with the pending card from the widget state when the conversation has none
// (or there is no conversation endpoint yet).
function popoverConversation (botId, conversation, state) {
  const bot = botById(state, validId(botId))
  const fromState = pendingFromState(bot)
  let pending = conversation?.pending ? { ...conversation.pending, actionable: Boolean(fromState?.actionable) } : fromState
  if (pending && fromState && pending.kind !== fromState.kind) pending = fromState
  return {
    bot_id: validId(botId),
    messages: conversation ? conversation.messages : [],
    history: Boolean(conversation),
    pending,
  }
}

// "A", "B", … for the lettered options (and their keyboard shortcuts).
function optionLetter (index) {
  return index >= 0 && index < 26 ? String.fromCharCode(65 + index) : ''
}

module.exports = {
  MESSAGE_LIMIT,
  messagesPath,
  botPath,
  cleanBody,
  conversationFrom,
  composeFrom,
  answerFrom,
  decisionFrom,
  pendingFromState,
  popoverConversation,
  optionLetter,
}
