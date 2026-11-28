// "Hide when not in use" (tray; prefs.hideWhenNotInUse, off by default):
// once the dock has gone unused for HIDE_DELAY_MS it tucks TUCK_PX into
// its screen edge on the tuck spring (motion.js, 260 / 22), leaving a
// STRIP_PX strip flush to the edge. Hovering the strip slides it back out;
// a question while it is tucked sends an amber wash up the strip.
//
// The rules, pure: window.AutoHide in the dock page (widget-view.js does the
// moving), require() in tests (test/auto-hide.test.js).
//
//   inUse(s)            is anything using the dock right now? s: { hover
//                       (the pointer is on the dock, the shelf or the
//                       strip), expanded (a chat, the picker or a recents
//                       card is open), dragging, shelf (finished-work pills
//                       are out), focused (keyboard focus is in the dock) }
//   shouldHide(s)       the pref is on and nothing is using it
//   newQuestions(prev, bots)
//                       the ids of bots that now wait on the user (a
//                       question or an approval) and did not before; paused
//                       bots never count. prev: a Set of ids (or null on the
//                       first state, which asks nothing).
//   waitingIds(bots)    that Set, for the next call

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.AutoHide = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const HIDE_DELAY_MS = 900
  const TUCK_PX = 90
  const STRIP_PX = 3
  const SPRING = 'tuck' // motion.js SPRINGS.tuck: { stiffness: 260, damping: 22 }
  const WASH_MS = 900

  function inUse ({ hover = false, expanded = false, dragging = false, shelf = false, focused = false } = {}) {
    return Boolean(hover || expanded || dragging || shelf || focused)
  }

  function shouldHide ({ enabled = false, ...state } = {}) {
    return Boolean(enabled) && !inUse(state)
  }

  const waits = (bot) => Boolean(bot && !bot.paused && (bot.waiting || bot.mood === 'waiting'))

  function waitingIds (bots) {
    const ids = new Set()
    for (const bot of bots || []) if (waits(bot)) ids.add(bot.id)
    return ids
  }

  function newQuestions (prev, bots) {
    if (!prev) return []
    return [...waitingIds(bots)].filter((id) => !prev.has(id))
  }

  return { HIDE_DELAY_MS, TUCK_PX, STRIP_PX, SPRING, WASH_MS, inUse, shouldHide, waitingIds, newQuestions }
})
