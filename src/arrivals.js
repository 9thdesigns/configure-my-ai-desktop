'use strict'

// "A response arrived": a bot in the dock that has just answered. Read from
// two widget states in a row (widget-state.js) — the feed has no event of
// its own — and handed to the dock (the seat's nudge and the finished-work
// shelf, widget-view.js) and the island (island-window.js responseArrived).
// Pure: test/arrivals.test.js.
//
// A bot has arrived when its mood turns to 'responded', or when it is
// responded already and its message changes (a second answer). Nothing on
// the first state (a launch is not news), nothing for paused bots.

const { dockBots } = require('./widget-state')
const { isPaused } = require('./widget-seats')

const MAX_LABEL = 160
// A finished file rather than a message: the detail names one.
const FILE = /\.(pdf|docx?|xlsx?|pptx?|csv|md|txt|json|zip|png|jpe?g|gif|svg|html?)\b/i

function arrivalFor (bot) {
  const detail = (bot.state && bot.state.detail) || ''
  const label = (detail || 'New message').slice(0, MAX_LABEL)
  // The conversation it arrived in (the id the conversation routes take to
  // pin a chat: a bot's session_id, the manager's thread_id), or null.
  const state = bot.state || {}
  const conversation = (bot.id === 'manager' ? state.thread_id : state.session_id) || null
  return { bot_id: bot.id, name: bot.name, label, kind: FILE.test(detail) ? 'file' : 'message', conversation_id: conversation }
}

function detectArrivals (prev, next) {
  if (!prev || !next) return []
  const before = new Map(dockBots(prev).map((b) => [b.id, b]))
  const out = []
  for (const bot of dockBots(next)) {
    if (isPaused(bot) || bot.mood !== 'responded') continue
    const was = before.get(bot.id)
    if (!was) continue // newly pinned: not an arrival
    const message = bot.state && bot.state.message_id
    const wasMessage = was.state && was.state.message_id
    if (was.mood !== 'responded' || (message && message !== wasMessage)) out.push(arrivalFor(bot))
  }
  return out
}

module.exports = { detectArrivals, arrivalFor }
