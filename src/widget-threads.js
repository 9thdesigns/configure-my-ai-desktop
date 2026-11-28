'use strict'

// A bot's recent chats, for the recents card that buds out of a dock seat
// (widget-window.js opens it, widget-view.js draws it). Pure, so it is
// unit-testable without Electron (test/widget-threads.test.js).
//
// A session-cookie wrapper under /desktop/widget, like the conversation
// routes (docs/desktop-widget.md in the Rails app); :id is a bot UUID or
// 'manager'. Main calls it on the default session (X-CMA-Desktop: 1); only
// the validated list below reaches the widget renderer.
//
//   GET /desktop/widget/bots/:id/threads?limit=5
//     → [{ id, title, preview, updated_at, unread }], newest first
//
// An older server has no such route and answers 404: the seat click then
// does what it did before the card (opens the quick chat), and main stops
// asking for a while (UNSUPPORTED_RETRY_MS).

const { validId, cleanText } = require('./widget-state')

const THREAD_LIMIT = 5
const MAX_TITLE = 120
const MAX_PREVIEW = 200
const UNTITLED = 'New chat'
// After a 404, the seat goes straight to the quick chat; the route is tried
// again after this long (the server may have been updated meanwhile).
const UNSUPPORTED_RETRY_MS = 10 * 60_000

function threadsPath (botId) {
  const id = validId(botId)
  return id ? `/desktop/widget/bots/${encodeURIComponent(id)}/threads?limit=${THREAD_LIMIT}` : null
}

function validTime (value) {
  if (typeof value !== 'string' || value.length > 40) return null
  const t = Date.parse(value)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

// The server's list (a bare array, or { threads: [...] }) as at most
// THREAD_LIMIT rows, each with a valid id, one-line text and a real time.
// Rows that fail are dropped; a body that isn't a list is null.
function threadsFrom (json) {
  const list = Array.isArray(json) ? json : (json && typeof json === 'object' && Array.isArray(json.threads) ? json.threads : null)
  if (!list) return null
  const out = []
  const seen = new Set()
  for (const t of list) {
    if (out.length >= THREAD_LIMIT) break
    if (!t || typeof t !== 'object') continue
    const id = validId(t.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      title: cleanText(t.title, MAX_TITLE) || UNTITLED,
      preview: cleanText(t.preview, MAX_PREVIEW),
      updated_at: validTime(t.updated_at),
      unread: t.unread === true || (Number.isFinite(t.unread) && t.unread > 0),
    })
  }
  return out
}

// A response → { status: 'ok', threads } | { status: 'unsupported' } | null
// (signed out, a server error, no answer: the caller fails soft).
function threadsResult (res) {
  if (!res) return null
  if (res.status === 404) return { status: 'unsupported' }
  if (res.status !== 200) return null
  const threads = threadsFrom(res.json)
  return threads ? { status: 'ok', threads } : null
}

module.exports = { THREAD_LIMIT, MAX_TITLE, MAX_PREVIEW, UNTITLED, UNSUPPORTED_RETRY_MS, threadsPath, threadsFrom, threadsResult }
