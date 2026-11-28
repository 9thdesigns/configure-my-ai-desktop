// Dragging something along a screen edge: the dock (left / right edges,
// sliding on y) and, later, the island (top / bottom edges, sliding on x).
// Pure and dependency-free: window.EdgeDrag in the pages, require() in main
// and in tests (test/edge-drag.test.js).
//
// A place on an edge is a fraction (0..1) of the work area's length along
// that edge, with an anchor saying which point of the window it measures:
//
//   anchor 'center' (default): the window's centre sits at
//       start + fraction × length            (island-placement.js's offsetX)
//   anchor 'start': the window's leading side sits at
//       start + fraction × (length − size)   (the dock: "of the free height")
//
// Either way the window is kept inside the work area (re-clamped for any
// display, any size), so a fraction saved on one display means the same on
// another.
//
// API (all coordinates are screen px; edge is 'left' | 'right' | 'top' |
// 'bottom'; a display is { id, bounds, workArea }):
//   axisOf(edge)                     'y' for left / right, 'x' for top / bottom
//   opposite(edge)                   the other edge on the same axis
//   span(workArea, edge)             { start, length } along the edge
//   crossPosition(workArea, edge, thickness)
//                                    the locked coordinate: the window's x for
//                                    left / right, its y for top / bottom
//   positionFor({ workArea, edge, size, fraction, anchor, margin })
//                                    the window's start along the edge
//   fractionFor({ workArea, edge, size, pos, anchor })
//                                    …and back (0..1, 4 decimals)
//   boundsFor({ workArea, edge, size, thickness, fraction, anchor, margin })
//                                    the whole window rect
//   targetEdge(display, edge, point) the edge on the pointer's side of the
//                                    display's midline (across the axis)
//   dragTo({ display, edge, size, grab, point, anchor, magnet })
//                                    one step of a drag: the edge stays
//                                    locked; along it, the pointer less the
//                                    grab, clamped; optional magnet to centre.
//                                    → { pos, fraction, snapped, edge, target, ghost }
//   displayAt(displays, point)       the display under (or nearest) a point:
//                                    re-homing during a drag
//   findDisplay(displays, place)     by place.displayId, else displayBounds
//   resolve(place, displays, fallback, defaults)
//                                    { display, edge, fraction }: the saved
//                                    display while connected, else the same
//                                    edge and fraction on the fallback
//
// The feel while dragging (the page): the dragged thing stretches toward
// where it is going — STRETCH_PER_SPEED px per px/ms of pointer speed, at
// most MAX_STRETCH px, on the SPRINGS.stretch spring (motion.js) — its
// contents lag by LAG of that, and letting go releases it on SPRINGS.release.
//   velocity(samples, now, window)   px/ms from [{ t, v }] samples
//   stretchFor(speed)                px, signed, capped
//   stretchStyle(s, length)          { scale, origin: 'start' | 'end', lag }

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.EdgeDrag = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const EDGES = ['left', 'right', 'top', 'bottom']
  const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' }
  const STRETCH_PER_SPEED = 9
  const MAX_STRETCH = 12
  const LAG = 0.3
  const SPRINGS = Object.freeze({ stretch: 'stretch', release: 'wobbly' })

  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))
  const round4 = (n) => Math.round(n * 10000) / 10000

  const axisOf = (edge) => (edge === 'top' || edge === 'bottom' ? 'x' : 'y')
  const opposite = (edge) => OPPOSITE[edge] || null

  function span (workArea, edge) {
    return axisOf(edge) === 'y'
      ? { start: workArea.y, length: workArea.height }
      : { start: workArea.x, length: workArea.width }
  }

  function crossPosition (workArea, edge, thickness) {
    switch (edge) {
      case 'left': return workArea.x
      case 'right': return workArea.x + workArea.width - thickness
      case 'top': return workArea.y
      default: return workArea.y + workArea.height - thickness
    }
  }

  const validFraction = (f) => (typeof f === 'number' && Number.isFinite(f) ? clamp(f, 0, 1) : 0.5)

  // The window's start along the edge. margin (anchor 'center'): how far in
  // the centre must stay from either end (at least half the size).
  function positionFor ({ workArea, edge, size, fraction, anchor = 'center', margin = 0 }) {
    const { start, length } = span(workArea, edge)
    const f = validFraction(fraction)
    if (anchor === 'start') return start + Math.round(f * Math.max(0, length - size))
    const half = Math.max(size / 2, margin)
    const centre = clamp(start + length * f, start + half, start + length - half)
    return Math.round(centre - size / 2)
  }

  function fractionFor ({ workArea, edge, size, pos, anchor = 'center' }) {
    const { start, length } = span(workArea, edge)
    if (anchor === 'start') {
      const free = length - size
      return free > 0 ? round4(clamp((pos - start) / free, 0, 1)) : 0.5
    }
    return length > 0 ? round4(clamp((pos + size / 2 - start) / length, 0, 1)) : 0.5
  }

  function boundsFor ({ workArea, edge, size, thickness, fraction, anchor = 'center', margin = 0 }) {
    const along = positionFor({ workArea, edge, size, fraction, anchor, margin })
    const cross = crossPosition(workArea, edge, thickness)
    return axisOf(edge) === 'y'
      ? { x: cross, y: along, width: thickness, height: size }
      : { x: along, y: cross, width: size, height: thickness }
  }

  // The edge on the pointer's side of the display's midline, on the same axis.
  function targetEdge (display, edge, point) {
    const b = display.bounds
    if (axisOf(edge) === 'y') return point.x < b.x + b.width / 2 ? 'left' : 'right'
    return point.y < b.y + b.height / 2 ? 'top' : 'bottom'
  }

  // grab: how far along the window (px from its start) the pointer took it.
  // magnet (anchor 'center'): within this many px of the work area's middle,
  // the centre snaps there.
  function dragTo ({ display, edge, size, grab, point, anchor = 'center', magnet = 0 }) {
    const wa = display.workArea
    const axis = axisOf(edge)
    const { start, length } = span(wa, edge)
    let pos = Math.round(clamp(point[axis] - grab, start, start + length - size))
    let snapped = false
    if (anchor === 'center' && magnet > 0 && Math.abs(pos + size / 2 - (start + length / 2)) <= magnet) {
      pos = Math.round(start + length / 2 - size / 2)
      snapped = true
    }
    const fraction = snapped ? 0.5 : fractionFor({ workArea: wa, edge, size, pos, anchor })
    const target = targetEdge(display, edge, point)
    return { pos, fraction, snapped, edge, target, ghost: target !== edge }
  }

  // The display a point is on, or the nearest one to it.
  function displayAt (displays, point) {
    let best = null
    let bestDist = Infinity
    for (const d of displays || []) {
      if (!d || !d.bounds) continue
      const b = d.bounds
      const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1))
      const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1))
      const dist = Math.hypot(dx, dy)
      if (dist < bestDist) { best = d; bestDist = dist }
    }
    return best
  }

  const sameRect = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

  function findDisplay (displays, place) {
    if (!place) return null
    const list = displays || []
    return (place.displayId !== undefined && list.find((d) => d && d.id === place.displayId)) ||
      (place.displayBounds && list.find((d) => d && sameRect(d.bounds, place.displayBounds))) || null
  }

  // Where it goes now: the saved display while it is connected, otherwise
  // the same edge and fraction on the fallback (then the first display).
  function resolve (place, displays, fallback, { edge = 'right', fraction = 0.5 } = {}) {
    const display = findDisplay(displays, place) || fallback || (displays || [])[0] || null
    if (!display) return null
    return {
      display,
      edge: place && EDGES.includes(place.edge) ? place.edge : edge,
      fraction: place && typeof place.fraction === 'number' ? validFraction(place.fraction) : fraction,
    }
  }

  // --- The feel ------------------------------------------------------------------

  // Pointer velocity (px/ms) from recent samples [{ t, v }] (v: the position
  // along the edge), newest last: the slope over the last `window` ms; 0
  // once the pointer has stopped.
  function velocity (samples, now, window = 60) {
    const recent = (samples || []).filter((s) => now - s.t <= window)
    if (recent.length < 2) return 0
    const a = recent[0]
    const b = recent[recent.length - 1]
    const dt = b.t - a.t
    return dt > 0 ? (b.v - a.v) / dt : 0
  }

  const stretchFor = (speed) => clamp((Number(speed) || 0) * STRETCH_PER_SPEED, -MAX_STRETCH, MAX_STRETCH)

  // A stretch of s px (positive: toward the end of the axis) on something
  // `length` px long: it grows toward the drag from its trailing side
  // (origin), and its contents shift back by LAG of the stretch.
  function stretchStyle (s, length) {
    const amount = Math.abs(s)
    if (!length || amount < 0.01) return { scale: 1, origin: 'start', lag: 0 }
    return { scale: (length + amount) / length, origin: s > 0 ? 'start' : 'end', lag: -s * LAG }
  }

  return {
    EDGES,
    STRETCH_PER_SPEED,
    MAX_STRETCH,
    LAG,
    SPRINGS,
    axisOf,
    opposite,
    span,
    crossPosition,
    positionFor,
    fractionFor,
    boundsFor,
    targetEdge,
    dragTo,
    displayAt,
    findDisplay,
    resolve,
    velocity,
    stretchFor,
    stretchStyle,
  }
})
