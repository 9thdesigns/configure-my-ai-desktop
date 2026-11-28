// The jelly badge: the count on a bot's face — in the dock's seats, on the
// island's compact avatar — and the "working" dots under it. One component:
// window.CmaJellyBadge in the pages (the island calls
// CmaJellyBadge.paint(slot, { count, mode }), island-view.js), require() in
// main for the pure parts (the tray title's count, tray.js) and in tests
// (test/jelly-badge.test.js, test/jelly-badge-page.test.js).
//
// What it shows (kindFor):
//   unread  — brand indigo (#6d5efc → #4b3fd6), the count in white digits
//             (12px/700, tabular), capped at 99 → "99+"; a small dot when
//             there is something new but no count
//   waiting — amber (#ff9a1f → #d0700c), "?"  (a question or an approval)
//   failed  — red (#f04a5a → #b5172a), "!"
//   working — no badge: a 28×14 pill under the face with three 6px dots
//             hopping (960ms loop, 130ms apart, squash and stretch), paused
//             while the page is hidden
// An 18px pill with a 3px ring in the colour behind it (--jelly-ring), so it
// reads as cut out of the dock (or the island).
//
// How it moves (Web Animations; origin bottom centre):
//   in      scale .7 → 1, 200ms (.2, 0, 0, 1)
//   change  the old glyph rolls out (200ms ease-in, 65% of its height) as
//           the new one rolls in from the other side (280ms (.22, 1, .36, 1)),
//           the pill's width follows (280ms), and — up — it squashes 1.12/.88
//           then .97/1.04 (360ms)
//   out     a small squash, then scale .2 and fade (240ms (.5, 0, .75, 0))
//   bursts  changes within 400ms of the last one collapse into one move to
//           the latest value
// Reduced motion: no motion at all; the glyph changes in place.

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.CmaJellyBadge = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const MAX = 99
  const BURST_MS = 400
  const KINDS = ['unread', 'waiting', 'failed', 'working']
  const EASE_IN = 'cubic-bezier(0.2, 0, 0, 1)'
  const EASE_ROLL_IN = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const EASE_EXIT = 'cubic-bezier(0.5, 0, 0.75, 0)'
  const ROLL = 0.65

  // --- Pure ------------------------------------------------------------------

  // 0 → '', 1..99 → '1'..'99', more → '99+'.
  function formatCount (input) {
    const n = Math.trunc(Number(input))
    if (!Number.isFinite(n) || n <= 0) return ''
    return n > MAX ? `${MAX}+` : String(n)
  }

  // A mode (ours, or the island's: idle | working | message | question |
  // approval | recording) and a count → the kind to show, or null for
  // nothing.
  function kindFor ({ mode, count } = {}) {
    switch (mode) {
      case 'waiting': case 'question': case 'approval': return 'waiting'
      case 'failed': return 'failed'
      case 'working': return 'working'
      case 'unread': case 'message': case 'responded': return 'unread'
      default: return Number(count) > 0 ? 'unread' : null
    }
  }

  // The glyph on the pill ('' for the unread dot).
  function glyphFor (kind, count) {
    if (kind === 'waiting') return '?'
    if (kind === 'failed') return '!'
    if (kind === 'unread') return formatCount(count)
    return ''
  }

  // A dock seat's bot (widget-view.js) → { mode, count }.
  function forBot (bot) {
    if (!bot || bot.paused) return { mode: null, count: 0 }
    const count = Math.max(0, Math.trunc(Number(bot.needs_count)) || 0)
    if (bot.waiting || bot.mood === 'waiting') return { mode: 'waiting', count }
    if (bot.mood === 'failed') return { mode: 'failed', count }
    if (bot.mood === 'responded') return { mode: 'unread', count }
    if (bot.mood === 'working') return { mode: 'working', count }
    return { mode: null, count: 0 }
  }

  // Burst control, as a pure step: given when the last animated change was
  // (or null) and now, should this change animate now, or wait for the burst
  // to end (and when)?
  function burstStep (lastAt, now, window = BURST_MS) {
    if (lastAt === null || now - lastAt >= window) return { animate: true, waitUntil: null }
    return { animate: false, waitUntil: lastAt + window }
  }

  // --- The DOM -----------------------------------------------------------------

  const state = new WeakMap() // slot → { kind, glyph, count, lastAt, timer, pending }

  const reduced = (doc) => {
    try {
      const win = doc.defaultView
      return Boolean(win && win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches)
    } catch {
      return false
    }
  }

  const animate = (el, frames, opts) => (el && typeof el.animate === 'function' ? el.animate(frames, opts) : null)

  function build (slot) {
    const doc = slot.ownerDocument
    const make = (tag, cls) => { const n = doc.createElement(tag); n.className = cls; return n }
    const root = make('span', 'jelly')
    root.setAttribute('aria-hidden', 'true')
    const pill = make('span', 'jelly-pill')
    const glyphs = make('span', 'jelly-glyphs')
    const glyph = make('span', 'jelly-glyph')
    glyphs.append(glyph)
    pill.append(glyphs)
    const dots = make('span', 'jelly-dots')
    for (let i = 0; i < 3; i++) dots.append(make('i', 'jelly-dot'))
    root.append(pill, dots)
    root.setAttribute('data-empty', '')
    slot.textContent = ''
    slot.append(root)
    return root
  }

  const parts = (root) => ({ pill: root.querySelector('.jelly-pill'), glyphs: root.querySelector('.jelly-glyphs'), glyph: root.querySelector('.jelly-glyph:not(.is-leaving)') })

  function setKind (root, kind, glyph) {
    root.dataset.kind = kind || ''
    root.toggleAttribute('data-dot', kind === 'unread' && !glyph)
    // Empty: no pill (the working dots, if any, still show).
    root.toggleAttribute('data-empty', !kind)
  }

  // The pill appears: scale .7 → 1.
  function enter (root, still) {
    const { pill } = parts(root)
    if (still) return
    animate(pill, [{ transform: 'scale(0.7)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 200, easing: EASE_IN })
  }

  // The pill goes: a small squash, then scale .2 and fade; hidden after.
  function leave (root, still, done) {
    const { pill } = parts(root)
    const a = still ? null : animate(pill, [
      { transform: 'scale(1, 1)', opacity: 1, offset: 0 },
      { transform: 'scale(1.08, 0.92)', opacity: 1, offset: 0.25 },
      { transform: 'scale(0.2)', opacity: 0, offset: 1 },
    ], { duration: 240, easing: EASE_EXIT })
    if (!a) return done()
    a.finished.then(done, done)
  }

  // Up by one (or more): squash 1.12/.88, then .97/1.04, then rest.
  function squash (root, still) {
    if (still) return
    animate(parts(root).pill, [
      { transform: 'scale(1, 1)', offset: 0 },
      { transform: 'scale(1.12, 0.88)', offset: 0.35 },
      { transform: 'scale(0.97, 1.04)', offset: 0.7 },
      { transform: 'scale(1, 1)', offset: 1 },
    ], { duration: 360, easing: 'ease-out' })
  }

  // A new glyph: the old one rolls out, the new one rolls in; the width
  // follows.
  function change (root, next, up, still) {
    const { pill, glyphs, glyph: old } = parts(root)
    if (still || !old) {
      if (old) old.textContent = next
      return
    }
    const doc = root.ownerDocument
    const fromW = pill.getBoundingClientRect().width
    const incoming = doc.createElement('span')
    incoming.className = 'jelly-glyph'
    incoming.textContent = next
    old.classList.add('is-leaving')
    glyphs.append(incoming)
    const toW = pill.getBoundingClientRect().width
    const dir = up ? -1 : 1
    const out = animate(old, [{ transform: 'translateY(0)', opacity: 1 }, { transform: `translateY(${dir * ROLL * 100}%)`, opacity: 0 }], { duration: 200, easing: 'ease-in', fill: 'forwards' })
    animate(incoming, [{ transform: `translateY(${-dir * ROLL * 100}%)`, opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }], { duration: 280, easing: EASE_ROLL_IN })
    if (fromW && toW && Math.abs(fromW - toW) > 0.5) {
      animate(pill, [{ width: `${fromW}px` }, { width: `${toW}px` }], { duration: 280, easing: EASE_ROLL_IN })
    }
    const drop = () => old.remove()
    if (out) out.finished.then(drop, drop)
    else drop()
  }

  // Paint a slot: { count, mode } (see kindFor). Idempotent; changes animate.
  function paint (slot, { count = 0, mode = null } = {}, { now = Date.now() } = {}) {
    if (!slot || !slot.ownerDocument) return
    const root = slot.querySelector(':scope > .jelly') || build(slot)
    const kind = kindFor({ mode, count })
    const shownKind = kind === 'working' ? null : kind
    const glyph = shownKind ? glyphFor(shownKind, count) : ''
    const still = reduced(slot.ownerDocument)
    root.toggleAttribute('data-working', kind === 'working')
    let s = state.get(slot)
    if (!s) {
      s = { kind: null, glyph: '', count: 0, lastAt: null, timer: null, pending: null }
      state.set(slot, s)
    }

    // In, out, or a different kind: at once.
    if (!s.kind && shownKind) {
      clearTimeout(s.timer)
      s.timer = null
      s.pending = null
      parts(root).glyph.textContent = glyph
      setKind(root, shownKind, glyph)
      enter(root, still)
      Object.assign(s, { kind: shownKind, glyph, count, lastAt: now })
      return
    }
    if (s.kind && !shownKind) {
      clearTimeout(s.timer)
      s.timer = null
      s.pending = null
      const was = s.kind
      s.kind = null
      s.glyph = ''
      s.count = 0
      leave(root, still, () => { if (!s.kind && root.dataset.kind === was) setKind(root, null, '') })
      return
    }
    if (!shownKind) return
    if (s.kind !== shownKind) {
      setKind(root, shownKind, glyph)
      change(root, glyph, false, still)
      Object.assign(s, { kind: shownKind, glyph, count, lastAt: now })
      return
    }
    if (glyph === s.glyph && count === s.count) return

    // The same kind, a new count: bursts collapse to one move.
    const step = burstStep(s.lastAt, now)
    if (!step.animate) {
      s.pending = { glyph, count }
      if (!s.timer) {
        s.timer = setTimeout(() => {
          s.timer = null
          const p = s.pending
          s.pending = null
          if (p && s.kind === shownKind && (p.glyph !== s.glyph || p.count !== s.count)) {
            const up = p.count > s.count
            setKind(root, shownKind, p.glyph)
            if (p.glyph !== s.glyph) change(root, p.glyph, up, still)
            if (up) squash(root, still)
            Object.assign(s, { glyph: p.glyph, count: p.count, lastAt: Date.now() })
          }
        }, Math.max(0, step.waitUntil - now))
      }
      return
    }
    const up = count > s.count
    setKind(root, shownKind, glyph)
    if (glyph !== s.glyph) change(root, glyph, up, still)
    if (up) squash(root, still)
    Object.assign(s, { glyph, count, lastAt: now })
  }

  return { MAX, BURST_MS, KINDS, formatCount, kindFor, glyphFor, forBot, burstStep, paint }
})
