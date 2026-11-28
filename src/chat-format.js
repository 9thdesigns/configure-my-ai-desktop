// Quick chat's thread shape, shared rules with the web app's chat (its shared
// bubble component): which messages group, where a time separator goes and
// what it says, and the "Delivered" line under the latest outgoing message.
// Pure, and loaded both by the widget page (window.ChatFormat, before
// widget-view.js) and by node (test/chat-format.test.js).
//
//   * A time separator goes before the first message, and before any message
//     more than 15 minutes after the one before it. Local time:
//     "Today 7:53 PM", "Yesterday 3:10 PM", "Tuesday 9:04 AM" within the
//     last week, else "Nov 20, 4:15 PM" ("Nov 20, 2025, 4:15 PM" in another
//     year).
//   * Consecutive messages from the same role group (tight spacing, inner
//     corners squared off); a role change or a separator ends the group.
//   * "Delivered" sits under the latest user message once the server has it
//     (an id and a created_at), until the bot replies after it. Messages
//     still in the outbox show "Sending…" or "Not delivered" instead.

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.ChatFormat = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const GAP_MS = 15 * 60 * 1000
  const DAY_MS = 24 * 60 * 60 * 1000
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

  const time = (value) => {
    const t = typeof value === 'string' ? Date.parse(value) : NaN
    return Number.isFinite(t) ? t : null
  }

  function clock (d) {
    const h = d.getHours()
    const m = d.getMinutes()
    return `${h % 12 || 12}:${m < 10 ? '0' : ''}${m} ${h < 12 ? 'AM' : 'PM'}`
  }

  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()

  // The separator's label for a message at `t` (ms), seen at `now` (ms).
  function timeLabel (t, now = Date.now()) {
    const d = new Date(t)
    const n = new Date(now)
    // Calendar days apart, by local midnights (a DST day is 23 or 25 hours).
    const days = Math.round((startOfDay(n) - startOfDay(d)) / DAY_MS)
    if (days === 0) return `Today ${clock(d)}`
    if (days === 1) return `Yesterday ${clock(d)}`
    if (days > 1 && days < 7) return `${WEEKDAYS[d.getDay()]} ${clock(d)}`
    const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`
    return d.getFullYear() === n.getFullYear() ? `${date}, ${clock(d)}` : `${date}, ${d.getFullYear()}, ${clock(d)}`
  }

  // The rows to show, in order, each with a stable key:
  //   { key: 'sep:<id>', kind: 'separator', text }
  //   { key: '<id>', kind: 'message', role, body, groupStart, groupEnd, local? }
  //   { key: 'status', kind: 'status', state: 'delivered' | 'sending' | 'failed', text }
  // messages: the server's, oldest first. outbox: the user's messages not yet
  // confirmed, [{ key, body, failed }].
  function threadItems (messages, { outbox = [], now = Date.now() } = {}) {
    const items = []
    let prevTime = null
    let prev = null // the last message item
    let first = true
    const push = (item, t) => {
      const gap = t !== null && (first || (prevTime !== null && t - prevTime > GAP_MS))
      if (gap) items.push({ key: `sep:${item.key}`, kind: 'separator', text: timeLabel(t, now) })
      const startsGroup = !prev || prev.role !== item.role || gap
      item.groupStart = startsGroup
      item.groupEnd = true
      if (prev && !startsGroup) prev.groupEnd = false
      items.push(item)
      prev = item
      first = false
      if (t !== null) prevTime = t
    }
    for (const m of messages) push({ key: m.id, kind: 'message', role: m.role, body: m.body, ...(m.screenshot ? { screenshot: true } : {}) }, time(m.created_at))
    for (const o of outbox) push({ key: o.key, kind: 'message', role: 'user', body: o.body, local: o.failed ? 'failed' : 'sending', ...(o.screenshot ? { screenshot: true } : {}) }, null)

    // The status line: under the last outbox message, else under the latest
    // confirmed user message the bot hasn't answered yet.
    const lastOut = outbox[outbox.length - 1]
    if (lastOut) {
      items.push(lastOut.failed
        ? { key: 'status', kind: 'status', state: 'failed', text: 'Not delivered' }
        : { key: 'status', kind: 'status', state: 'sending', text: 'Sending…' })
      return items
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind !== 'message') continue
      if (item.role === 'assistant') break
      if (item.role !== 'user') continue
      const m = messages.find((x) => x.id === item.key)
      if (m && time(m.created_at) !== null) items.splice(i + 1, 0, { key: 'status', kind: 'status', state: 'delivered', text: 'Delivered' })
      break
    }
    return items
  }

  return { GAP_MS, timeLabel, threadItems }
})
