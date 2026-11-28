'use strict'

// The dock's quick-chat popover: the focused bot's last messages, its pending
// question or approval, and the replies the user sends from the widget. Pure,
// so it is unit-testable without Electron (test/widget-chat.test.js).
//
// Session-cookie wrappers under /desktop/widget (docs/desktop-widget.md,
// "Conversations", in the Rails app); :id is a bot UUID or 'manager'. Main
// calls them with the default session (X-CMA-Desktop: 1); only the
// validated conversation below reaches the widget renderer.
//
//   GET  /desktop/widget/bots/:id/messages?limit=20[&conversation_id=…]
//   POST /desktop/widget/bots/:id/messages   { body, attachments?, conversation_id? }
//   POST /desktop/widget/bots/:id/answer     { pending_id?, option_ids, text, conversation_id? } | { pending_id?, skip: true, … }
//   POST /desktop/widget/bots/:id/approval   { pending_id?, decision, conversation_id? }
//
// Without conversation_id they use the bot's waiting-or-latest
// conversation (the manager: its latest thread); with it (a row of the
// recents card, widget-threads.js) that conversation is read, sent to and
// settled in. An older server ignores it: the conversation it answers with
// then reports another session_id / thread_id (conversation_id below), and
// main opens the row in the app instead.
//
// Each answers with the conversation (refusals are 422 with it attached):
//   { bot_id, status, url, session_id | thread_id,
//     messages: [{ id, role, body, created_at }],
//     pending: { id, kind: 'question' | 'approval', prompt, detail,
//                options: [{ id, label }], allow_other, multiple,
//                questions_count } | null }
//
// The manager asks in replies, never with question cards, so it can't be
// answered through /answer (422 not_a_question); its proposals are
// approvals, which can.

const { validId, cleanText, validAppUrl, validOptions, botById, stateLabel } = require('./widget-state')
const { isAppAssetUrl } = require('./url-policy')

const MESSAGE_LIMIT = 20
const MAX_BODY = 8000
const MAX_PROMPT = 1000
const MAX_OPTIONS = 8
const MAX_COMPOSE = 10_000
const ROLES = Object.freeze(['user', 'assistant', 'system'])
const PENDING_KINDS = Object.freeze(['question', 'approval'])
const DECISIONS = Object.freeze(['approve', 'decline'])
const ATTACHMENT_TIMEOUT_MS = 60_000
// Must match SCREENSHOT_ONLY_BODY in widget-view.js (the optimistic bubble).
const SCREENSHOT_ONLY_BODY = 'Shared my screen'

function botPath (botId, leaf) {
  const id = validId(botId)
  return id ? `/desktop/widget/bots/${encodeURIComponent(id)}/${leaf}` : null
}

function messagesPath (botId, conversationId = null) {
  const path = botPath(botId, 'messages')
  if (!path) return null
  const pinned = validId(conversationId)
  return `${path}?limit=${MESSAGE_LIMIT}${pinned ? `&conversation_id=${encodeURIComponent(pinned)}` : ''}`
}

// A write's body, pinned to a conversation when there is one.
function pinTo (body, conversationId) {
  const pinned = validId(conversationId)
  return pinned ? { ...body, conversation_id: pinned } : body
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

// A message's attachments (the screenshot a user shared): kind, size, and
// a url only when it is on our own origin. Nothing else is kept.
function validAttachments (input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 4).filter((a) => a && typeof a === 'object' && a.kind === 'screenshot').map((a) => ({
    kind: 'screenshot',
    mime: a.mime === 'image/jpeg' ? 'image/jpeg' : 'image/png',
    width: Math.max(0, Math.trunc(Number(a.width)) || 0),
    height: Math.max(0, Math.trunc(Number(a.height)) || 0),
    url: typeof a.url === 'string' && isAppAssetUrl(a.url) ? a.url : null,
  }))
}

function validMessage (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  const attachments = validAttachments(input.attachments)
  const screenshot = attachments.length > 0
  // A screenshot sent with no words still shows as a bubble.
  const body = cleanBody(input.body, MAX_BODY) || (screenshot ? SCREENSHOT_ONLY_BODY : '')
  if (!id || !body) return null
  const message = { id, role: ROLES.includes(input.role) ? input.role : 'assistant', body, created_at: validTime(input.created_at) }
  return screenshot ? { ...message, screenshot: true, attachments } : message
}

// The server refused the attachment (the confirmed contract): 413
// { error: 'attachment_too_large' } or 422 { error: 'attachment_invalid' }.
// Null for any other answer.
const ATTACHMENT_ERRORS = Object.freeze(['attachment_too_large', 'attachment_invalid'])
function attachmentError (res) {
  if (!res) return null
  const code = res.json && typeof res.json === 'object' ? res.json.error : null
  if (ATTACHMENT_ERRORS.includes(code)) return code
  return res.status === 413 ? 'attachment_too_large' : null
}

function validPending (input) {
  if (!input || typeof input !== 'object') return null
  const id = validId(input.id)
  if (!id || !PENDING_KINDS.includes(input.kind)) return null
  const question = input.kind === 'question'
  const questions = Math.trunc(Number(input.questions_count))
  return {
    id,
    kind: input.kind,
    prompt: cleanBody(input.prompt, MAX_PROMPT) || (question ? 'Question' : 'Approve this?'),
    detail: cleanBody(input.detail, MAX_PROMPT),
    options: question ? validOptions(input.options) : [],
    allow_other: question && input.allow_other !== false,
    multiple: question && input.multiple === true,
    questions_count: Number.isFinite(questions) && questions > 1 ? Math.min(questions, 20) : 1,
  }
}

function conversationFrom (input, expectedBotId) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const botId = validId(input.bot_id)
  if (!botId || (expectedBotId && botId !== validId(expectedBotId))) return null
  const messages = Array.isArray(input.messages)
    ? input.messages.slice(-MESSAGE_LIMIT * 2).map(validMessage).filter(Boolean).slice(-MESSAGE_LIMIT)
    : []
  // Which conversation this is (main checks a pinned chat got the one it
  // asked for); never sent to the renderer.
  const conversationId = validId(input.session_id) || validId(input.thread_id)
  return { bot_id: botId, url: validAppUrl(input.url), conversation_id: conversationId, messages, pending: validPending(input.pending) }
}

// What the widget renderer may ask main to send — rebuilt like everything
// else, since a compromised renderer is still untrusted input to main.
// `attachment` never comes from the renderer: it is the screenshot main is
// holding for this bot (screen-share.js attachmentPayload), and with one the
// text may be empty ("here's my screen").
function composeFrom (input, { attachment = null, conversationId = null } = {}) {
  if (!input || typeof input !== 'object') return null
  const botId = validId(input.bot_id)
  const body = cleanBody(input.body, MAX_COMPOSE)
  if (!botId || (!body && !attachment)) return null
  return {
    botId,
    path: botPath(botId, 'messages'),
    body: pinTo(attachment ? { body, attachments: [attachment] } : { body }, conversationId),
    // An upload of a few MB needs longer than a text reply.
    ...(attachment ? { timeoutMs: ATTACHMENT_TIMEOUT_MS } : {}),
  }
}

// Can the widget answer this bot's pending card itself? Questions, yes —
// except the manager's (it asks in replies); approvals, always.
function canReply (bot, kind) {
  if (!bot) return false
  return kind === 'approval' || (kind === 'question' && !bot.isManager)
}

// The bot the renderer named, if the widget state has it waiting for this
// kind of reply.
function waitingBot (state, botId, kind) {
  const bot = botById(state, validId(botId))
  return bot && bot.state.waiting === kind && canReply(bot, kind) ? bot : null
}

// The card the user answered, when the renderer says (so a card that
// changed under them isn't answered with the old card's choices); the server
// defaults to the one pending now.
function withPendingId (body, input) {
  const pendingId = validId(input.pending_id)
  return pendingId ? { pending_id: pendingId, ...body } : body
}

// { bot_id, pending_id?, option_ids, text } or { bot_id, pending_id?, skip }
function answerFrom (input, state, { conversationId = null } = {}) {
  if (!input || typeof input !== 'object') return null
  const bot = waitingBot(state, input.bot_id, 'question')
  if (!bot) return null
  const optionIds = Array.isArray(input.option_ids)
    ? [...new Set(input.option_ids.map((v) => (typeof v === 'string' ? cleanText(v, 200) : '')).filter(Boolean))].slice(0, MAX_OPTIONS)
    : []
  const text = cleanBody(input.text, MAX_COMPOSE)
  const skip = input.skip === true
  if (!skip && optionIds.length === 0 && !text) return null
  return { botId: bot.id, path: botPath(bot.id, 'answer'), body: pinTo(withPendingId(skip ? { skip: true } : { option_ids: optionIds, text }, input), conversationId) }
}

// { bot_id, pending_id?, decision: 'approve' | 'decline' }
function decisionFrom (input, state, { conversationId = null } = {}) {
  if (!input || typeof input !== 'object' || !DECISIONS.includes(input.decision)) return null
  const bot = waitingBot(state, input.bot_id, 'approval')
  if (!bot) return null
  return { botId: bot.id, path: botPath(bot.id, 'approval'), body: pinTo(withPendingId({ decision: input.decision }, input), conversationId) }
}

// The pending card from the widget state (which carries the first
// question's options), for when there is no conversation yet.
function pendingFromState (bot) {
  if (!bot || !bot.state.waiting) return null
  const kind = bot.state.waiting
  const question = kind === 'question'
  return {
    id: bot.state.message_id || bot.state.session_id || bot.state.run_id || bot.id,
    kind,
    prompt: bot.state.detail || stateLabel(bot),
    detail: '',
    options: question ? bot.state.options : [],
    allow_other: question && (bot.state.allow_other || bot.state.options.length === 0),
    multiple: question && bot.state.multiple,
    questions_count: bot.state.questions_count,
    // Several questions on one card: answered in the app, where they can
    // all be seen together.
    actionable: canReply(bot, kind) && bot.state.questions_count === 1,
  }
}

// What the popover is sent: the server's conversation when there is one,
// with the pending card from the widget state when the conversation has none
// (or there is no conversation endpoint yet).
function popoverConversation (botId, conversation, state) {
  const bot = botById(state, validId(botId))
  const pending = conversation
    // A card with several questions is answered in the app, where they
    // can all be seen together.
    ? (conversation.pending ? { ...conversation.pending, actionable: canReply(bot, conversation.pending.kind) && conversation.pending.questions_count === 1 } : null)
    : pendingFromState(bot)
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
  ATTACHMENT_TIMEOUT_MS,
  SCREENSHOT_ONLY_BODY,
  ATTACHMENT_ERRORS,
  attachmentError,
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
