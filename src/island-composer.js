'use strict'

// The island's Manager composer: click the island (or press the global
// shortcut) and it opens into the Manager — its avatar and name, its last two
// lines, and a composer — and Enter sends to the Manager over the widget's
// own chat route (POST /desktop/widget/bots/manager/messages, the same
// session-cookie wrapper the dock's quick chat uses; widget-chat.js). The
// reply appears in place when it lands; "Open in app" carries on there.
//
// Pure, so it is unit-tested without Electron (test/island-composer.test.js):
// the shortcut choices, the lines shown, and how a reply is recognised.

const MANAGER_ID = 'manager'
const LINES = 2
const MAX_LINE = 600
const REPLY_POLL_MS = 1500 // while a reply is awaited (and on every cable ping)
const REPLY_TIMEOUT_MS = 120_000 // then stop polling; "Open in app" still works

// The global shortcut, from a fixed list — never an accelerator string from
// anywhere else. Electron accelerators; labels in each platform's words.
const SHORTCUTS = Object.freeze([
  Object.freeze({ id: 'ctrl-alt-space', accelerator: 'Control+Alt+Space', mac: '⌃⌥Space', other: 'Ctrl+Alt+Space' }),
  Object.freeze({ id: 'ctrl-alt-m', accelerator: 'Control+Alt+M', mac: '⌃⌥M', other: 'Ctrl+Alt+M' }),
  Object.freeze({ id: 'cmd-shift-space', accelerator: 'CommandOrControl+Shift+Space', mac: '⌘⇧Space', other: 'Ctrl+Shift+Space' }),
  Object.freeze({ id: 'off', accelerator: null, mac: 'Off', other: 'Off' }),
])
const DEFAULT_SHORTCUT = 'ctrl-alt-space'

const validShortcut = (id) => (SHORTCUTS.some((s) => s.id === id) ? id : DEFAULT_SHORTCUT)
const shortcutFor = (id) => SHORTCUTS.find((s) => s.id === validShortcut(id))
const shortcutLabel = (id, platform = process.platform) => shortcutFor(id)[platform === 'darwin' ? 'mac' : 'other']

// The tray's "Island Shortcut" submenu: one radio item per choice.
function shortcutMenuItems (current, { platform = process.platform, unavailable = false } = {}, setShortcut = () => {}) {
  const id = validShortcut(current)
  return SHORTCUTS.map((s) => ({
    id: `island-shortcut-${s.id}`,
    label: s.id === id && unavailable && s.accelerator ? `${shortcutLabel(s.id, platform)} (in use by another app)` : shortcutLabel(s.id, platform),
    type: 'radio',
    checked: s.id === id,
    click: () => setShortcut(s.id),
  }))
}

const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim()
const clip = (text, max = MAX_LINE) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

// The Manager's last LINES lines (its own messages, not the user's), oldest
// first, as text — what the open island shows above the composer.
function managerLines (conversation, n = LINES) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : []
  return messages
    .filter((m) => m && m.role === 'assistant' && typeof m.body === 'string')
    .slice(-n)
    .map((m) => ({ id: m.id, body: clip(oneLine(m.body)) }))
    .filter((m) => m.body)
}

// The Manager's reply to what the user sent: the first assistant message
// after the sent one (by id; failing that, after the last user message whose
// text matches). Null while it hasn't come.
function replyTo (sent, conversation) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : []
  if (!sent) return null
  let at = sent.id ? messages.findIndex((m) => m && m.id === sent.id) : -1
  if (at < 0 && sent.body) {
    const body = oneLine(sent.body)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === 'user' && oneLine(messages[i].body) === body) { at = i; break }
    }
  }
  if (at < 0) return null
  const reply = messages.slice(at + 1).find((m) => m && m.role === 'assistant' && m.body)
  return reply ? { id: reply.id, body: clip(String(reply.body).trim(), 4000) } : null
}

// The message the user just sent, as the conversation the server answered
// with shows it: the last user message with that text.
function sentIn (conversation, body) {
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : []
  const text = oneLine(body)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role === 'user' && oneLine(m.body) === text) return { id: m.id, body: text }
  }
  return { id: null, body: text }
}

// What the renderer is sent about the composer.
//   lines    — the Manager's last lines (before anything was sent)
//   sent     — what the user sent, while it is in flight or answered
//   awaiting — a reply is on its way
//   reply    — the Manager's reply, once it lands
//   error    — 'send' (it didn't go) | 'timeout' (no reply yet; open the app)
function composerView ({ manager, conversation, sent = null, awaiting = false, error = null }) {
  return {
    manager: manager || { id: MANAGER_ID, name: 'Manager', avatar_url: null, avatar_color: null, avatar_shape: 'rounded' },
    lines: managerLines(conversation),
    sent: sent ? { body: clip(oneLine(sent.body), 1000) } : null,
    awaiting: Boolean(awaiting),
    reply: sent ? replyTo(sent, conversation) : null,
    error: ['send', 'timeout'].includes(error) ? error : null,
  }
}

module.exports = {
  MANAGER_ID,
  LINES,
  REPLY_POLL_MS,
  REPLY_TIMEOUT_MS,
  SHORTCUTS,
  DEFAULT_SHORTCUT,
  validShortcut,
  shortcutFor,
  shortcutLabel,
  shortcutMenuItems,
  managerLines,
  replyTo,
  sentIn,
  composerView,
}
