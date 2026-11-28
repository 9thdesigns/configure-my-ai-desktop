// The recents card's maths: the bridge between the card and its seat, the
// frames of the card budding out of the seat (and back into it), the rows'
// entrance, and the rows' relative times. Pure (no DOM): window.RecentsCard
// in the widget page (widget-view.js draws the card), require() in tests.
//
// The bud: the card is laid out at its full size from the start, and a
// clip-path shows only part of it. At rest before it opens, the visible
// part is a 40px circle (a seat) at the card's dock-side edge, level with
// the seat, and the whole card is shifted sideways so that circle sits
// exactly on the seat, under the dock. One spring (SOFT opening, CLOSE
// closing; motion.js) drives a progress p from 0 to 1: the circle grows to
// the card's full height and width at the card's radius (20px, the seat's
// own radius, so the circle and the card share it), and the shift goes to
// zero. The bridge — a short neck with soft concave fillets into the card
// and into the dock — fades in once the card has cleared the seat.
//
// The morph (a row opened): the chat panel (380×560) is laid out whole in
// the card's place and clipped to the card's rectangle, then grows on the
// OPEN spring — height first, then width (WIDTH_LAG_MS behind) — while the
// card fades away on top of it, the row's title flies to the chat's header,
// and the chat's content fades in from scale .97 once the morph is 85% done.
// Back to the card is the same in reverse on CLOSE (width first, then
// height); closing the chat shrinks it into the seat like the card's close.

(function (root, factory) {
  const api = factory(root && root.Motion ? root.Motion : (typeof require === 'function' ? require('./motion') : null))
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.RecentsCard = api
})(typeof self !== 'undefined' ? self : this, function (Motion) {
  'use strict'

  const SEAT = 40 // the dock seat's circle (--dock-seat)
  const RADIUS = 20 // the card's corners: the seat circle's radius
  const BRIDGE_NECK = 20 // the bridge at its narrowest
  const BRIDGE_FILLET = 5 // its concave flare into the card and the dock
  const ROW_STAGGER_MS = 30
  const ROW_DELAY_MS = 60 // the first row, after the card starts to open
  const ROW_SHIFT = 10 // rows come in from this far toward the screen edge
  const ROW_BLUR = 2
  const ROW_MS = 280
  const ROW_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
  const REDUCED_FADE_MS = 120
  const WIDTH_LAG_MS = 80 // the morph's width follows its height by this much
  const CONTENT_AT = 0.85 // the chat's content starts fading in this far into the morph
  const CONTENT_MS = 180
  const CONTENT_FROM_SCALE = 0.97
  const FRAME_MS = 1000 / 60

  const n = (v) => Math.round(v * 100) / 100
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi))

  // The bridge's outline, in a box `gap + 2 * overlap` wide and
  // `neck + 2 * fillet` tall: a band across the gap whose top and bottom
  // edges curve out (concave quarter circles of radius `fillet`) into the
  // card on one side and the dock on the other. `overlap` runs it a pixel
  // under both, so no seam shows between the shapes.
  function bridgePath (gap, { neck = BRIDGE_NECK, fillet = BRIDGE_FILLET, overlap = 1 } = {}) {
    const g = Math.max(0, Number(gap) || 0)
    const f = Math.max(0, Math.min(fillet, g / 2))
    const o = Math.max(0, overlap)
    const top = 0
    const mid = f // the neck's top edge
    const low = f + neck // the neck's bottom edge
    const bottom = low + f
    const x0 = o
    const x1 = o + g
    const w = x1 + o
    return [
      `M 0 ${n(top)}`,
      `L ${n(x0)} ${n(top)}`,
      `A ${n(f)} ${n(f)} 0 0 0 ${n(x0 + f)} ${n(mid)}`,
      `L ${n(x1 - f)} ${n(mid)}`,
      `A ${n(f)} ${n(f)} 0 0 0 ${n(x1)} ${n(top)}`,
      `L ${n(w)} ${n(top)}`,
      `L ${n(w)} ${n(bottom)}`,
      `L ${n(x1)} ${n(bottom)}`,
      `A ${n(f)} ${n(f)} 0 0 0 ${n(x1 - f)} ${n(low)}`,
      `L ${n(x0 + f)} ${n(low)}`,
      `A ${n(f)} ${n(f)} 0 0 0 ${n(x0)} ${n(bottom)}`,
      `L 0 ${n(bottom)}`,
      'Z',
    ].join(' ')
  }

  // Where the bridge's centre goes, px down the card: level with the seat,
  // but kept on the card's straight edge (clear of its rounded corners).
  function bridgeCentre (seat, height, { neck = BRIDGE_NECK, fillet = BRIDGE_FILLET, radius = RADIUS } = {}) {
    const half = neck / 2 + fillet
    return clamp(seat, radius + half, height - radius - half)
  }

  // The card's look at progress p (0: a seat circle on the seat; 1: the
  // card). seat: the seat's centre, px down the card; travel: px from the
  // card's dock-side edge circle to the seat (positive, toward the edge);
  // side: the screen edge the dock is on.
  function budState (p, { width, height, seat, travel, side = 'right' }) {
    const q = Math.max(0, p) // past 1 (a spring's overshoot) the clip is simply the box
    const grow = (from) => n(Math.max(0, from * (1 - Math.min(q, 1))))
    const top = grow(clamp(seat - SEAT / 2, 0, height - SEAT))
    const bottom = grow(clamp(height - seat - SEAT / 2, 0, height - SEAT))
    const across = grow(width - SEAT)
    const shift = n(travel * (1 - q)) * (side === 'left' ? -1 : 1)
    const inset = side === 'left' ? `${top}px ${across}px ${bottom}px 0px` : `${top}px 0px ${bottom}px ${across}px`
    return {
      clipPath: `inset(${inset} round ${RADIUS}px)`,
      transform: shift ? `translateX(${n(shift)}px)` : 'none',
      bridge: n(clamp((q - 0.35) / 0.4, 0, 1)),
    }
  }

  // The bud (open: SOFT from 0 to 1) or its reverse (close: CLOSE from 1
  // to 0) as Web Animations keyframes for the card and the bridge, linear
  // in time (the spring is in the values). Reduced motion: no movement —
  // a fade of at most REDUCED_FADE_MS.
  function budFrames ({ width, height, seat, travel, side = 'right', closing = false, reduced = false, spring }) {
    if (reduced) {
      const fade = closing ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }]
      return { card: fade, bridge: fade, duration: REDUCED_FADE_MS }
    }
    const { values, duration } = Motion.sample(spring || (closing ? 'close' : 'soft'), { from: closing ? 1 : 0, to: closing ? 0 : 1 })
    const card = []
    const bridge = []
    for (const p of values) {
      const s = budState(p, { width, height, seat, travel, side })
      card.push({ clipPath: s.clipPath, transform: s.transform })
      bridge.push({ opacity: String(s.bridge) })
    }
    return { card, bridge, duration }
  }

  // The chat panel's clip at height progress ph and width progress pw: from
  // the card's rectangle (cardTop down the panel, cardHeight tall, cardWidth
  // wide at the dock-side edge) to the whole panel.
  function morphClip (ph, pw, { width, height, cardTop, cardHeight, cardWidth, side = 'right' }) {
    const h = clamp(ph, 0, 1)
    const w = clamp(pw, 0, 1)
    const top = n(Math.max(0, cardTop) * (1 - h))
    const bottom = n(Math.max(0, height - cardTop - cardHeight) * (1 - h))
    const across = n(Math.max(0, width - cardWidth) * (1 - w))
    const inset = side === 'left' ? `${top}px ${across}px ${bottom}px 0px` : `${top}px 0px ${bottom}px ${across}px`
    return `inset(${inset} round ${RADIUS}px)`
  }

  // The morph as Web Animations keyframes for the chat panel (linear in
  // time; the springs are in the values): opening on OPEN, height leading;
  // back (to the card) on CLOSE, width leading. contentDelay: when the chat's
  // content starts to fade in. Reduced motion: a fade, no movement.
  function morphFrames ({ width, height, cardTop, cardHeight, cardWidth = 288, side = 'right', back = false, reduced = false }) {
    if (reduced) {
      return { keyframes: back ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }], duration: REDUCED_FADE_MS, contentDelay: 0 }
    }
    const { values } = Motion.sample(back ? 'close' : 'open', { from: back ? 1 : 0, to: back ? 0 : 1 })
    const lag = Math.round(WIDTH_LAG_MS / FRAME_MS)
    const last = values.length - 1
    const keyframes = []
    for (let i = 0; i <= last + lag; i++) {
      const lead = values[Math.min(i, last)]
      const follow = values[Math.max(0, Math.min(i - lag, last))]
      const ph = back ? follow : lead
      const pw = back ? lead : follow
      keyframes.push({ clipPath: morphClip(ph, pw, { width, height, cardTop, cardHeight, cardWidth, side }) })
    }
    const duration = Math.round((keyframes.length - 1) * FRAME_MS)
    return { keyframes, duration, contentDelay: Math.round(duration * CONTENT_AT) }
  }

  // The chat's content coming in (or, back, going out first).
  function contentFrames ({ delay = 0, back = false, reduced = false } = {}) {
    if (reduced) return null
    const shown = { opacity: 1, transform: 'none' }
    const hidden = { opacity: 0, transform: `scale(${CONTENT_FROM_SCALE})` }
    return back
      ? { keyframes: [shown, hidden], options: { duration: 100, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' } }
      : { keyframes: [hidden, shown], options: { duration: CONTENT_MS, delay, easing: ROW_EASE, fill: 'backwards' } }
  }

  // The row's title flying to the chat's header: from one rectangle (and
  // font size) to the other, as a transform on a copy placed at the first.
  function flight (from, to, { fromSize, toSize } = {}) {
    const scale = fromSize > 0 && toSize > 0 ? toSize / fromSize : 1
    return [
      { transform: 'none', opacity: 1 },
      { transform: `translate(${n(to.left - from.left)}px, ${n(to.top - from.top)}px) scale(${n(scale)})`, opacity: 1 },
    ]
  }

  // Row i's entrance: from ROW_SHIFT toward the screen edge, faded and
  // blurred, staggered ROW_STAGGER_MS apart. null under reduced motion.
  function rowEntrance (i, { side = 'right', reduced = false } = {}) {
    if (reduced) return null
    const dx = side === 'left' ? -ROW_SHIFT : ROW_SHIFT
    return {
      keyframes: [
        { opacity: 0, transform: `translateX(${dx}px)`, filter: `blur(${ROW_BLUR}px)` },
        { opacity: 1, transform: 'none', filter: 'none' },
      ],
      options: { duration: ROW_MS, delay: ROW_DELAY_MS + i * ROW_STAGGER_MS, easing: ROW_EASE, fill: 'backwards' },
    }
  }

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

  // A row's time, short: "now", "5m", "3h" today; "Yesterday"; a weekday
  // within the week; "Mar 4" this year; "Mar 4, 2025" before. Local time.
  function relativeTime (iso, now = Date.now()) {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    const diff = Math.max(0, now - t)
    const d = new Date(t)
    const today = new Date(now)
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    if (diff < 60_000) return 'now'
    if (t >= startOfToday) {
      if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
      return `${Math.floor(diff / 3_600_000)}h`
    }
    const days = Math.ceil((startOfToday - t) / 86_400_000)
    if (days <= 1) return 'Yesterday'
    if (days < 7) return DAYS[d.getDay()]
    const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`
    return d.getFullYear() === today.getFullYear() ? md : `${md}, ${d.getFullYear()}`
  }

  // The full form, for a row's tooltip and its accessible label.
  function fullTime (iso) {
    const t = Date.parse(iso)
    if (!Number.isFinite(t)) return ''
    try {
      return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    } catch {
      return new Date(t).toISOString()
    }
  }

  return { WIDTH_LAG_MS, CONTENT_AT, CONTENT_MS, CONTENT_FROM_SCALE, morphClip, morphFrames, contentFrames, flight, SEAT, RADIUS, BRIDGE_NECK, BRIDGE_FILLET, ROW_STAGGER_MS, ROW_DELAY_MS, ROW_SHIFT, ROW_BLUR, ROW_MS, ROW_EASE, REDUCED_FADE_MS, bridgePath, bridgeCentre, budState, budFrames, rowEntrance, relativeTime, fullTime }
})
