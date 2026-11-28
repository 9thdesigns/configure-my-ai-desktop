'use strict'

// Where the dock lives, and how it moves: always against the left or the
// right edge of a display, anywhere down it. Pure, so it is unit-tested
// without Electron (test/dock-placement.test.js); widget-window.js does the
// moving. The same conventions as the island's (island-placement.js).
//
//   * A place is { edge: 'left' | 'right', offset }: offset is where the
//     dock's top sits as a fraction (0..1) of the free height — the work
//     area's height less the dock's — so it means the same on a display of
//     another size, and for a dock with more or fewer seats. 0.5 is centred.
//   * It is remembered per display (widget-placement.js's memory: { id,
//     bounds, pos }, newest first); older memory said { side, offsetY } in
//     px, and is migrated the first time that display is used, when its work
//     area and the dock's height are known.
//   * Dragging: x stays locked to the edge, y follows the pointer (keeping
//     where on the dock it was grabbed). Crossing the display's vertical
//     midline shows a ghost on the other edge; letting go there moves the
//     dock across. Onto another display: the same edge there, at the
//     pointer's height.

const MAX_COORD = 100000
const EDGES = ['left', 'right']

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))
const round4 = (n) => Math.round(n * 10000) / 10000

// --- Places ------------------------------------------------------------------

// A remembered position: the new { edge, offset }, or the old { side,
// offsetY } kept as { edge, offsetY, legacy: true } until it is migrated.
function validDockPos (p) {
  if (!p || typeof p !== 'object') return null
  if (EDGES.includes(p.edge) && typeof p.offset === 'number' && Number.isFinite(p.offset)) {
    return { edge: p.edge, offset: round4(clamp(p.offset, 0, 1)) }
  }
  const edge = EDGES.includes(p.side) ? p.side : EDGES.includes(p.edge) ? p.edge : null
  if (edge && finite(p.offsetY)) return { edge, offsetY: Math.round(p.offsetY), legacy: true }
  return null
}

const freeHeight = (workArea, dockHeight) => Math.max(0, workArea.height - dockHeight)

// The fraction for a dock whose top is `top` px down from the work area's top.
function offsetFor (workArea, dockHeight, top) {
  const free = freeHeight(workArea, dockHeight)
  if (!free) return 0.5
  return round4(clamp(top / free, 0, 1))
}

// A legacy { offsetY } on this display as an { edge, offset } place.
function migrate (pos, workArea, dockHeight) {
  if (!pos) return null
  if (!pos.legacy) return { edge: pos.edge, offset: pos.offset }
  return { edge: pos.edge, offset: offsetFor(workArea, dockHeight, pos.offsetY) }
}

// The dock's top (screen px) on this work area.
function dockTop (workArea, dockHeight, offset = 0.5) {
  const o = Number.isFinite(offset) ? clamp(offset, 0, 1) : 0.5
  return workArea.y + Math.round(o * freeHeight(workArea, dockHeight))
}

// The edge nearer to a point: which half of the display it is in.
function edgeAt (display, x) {
  const b = display.bounds
  return x < b.x + b.width / 2 ? 'left' : 'right'
}

// --- Dragging ------------------------------------------------------------------

// Where the dock goes as the pointer moves: { top (screen px), offset, edge
// (where it is now, unchanged while dragging), target (the edge it would
// land on if let go: the pointer's half of the display), ghost }.
//   grab: how far down the dock (px) the pointer was when the drag began.
function dragPlace ({ display, dockHeight, edge, grab, point }) {
  const wa = display.workArea
  const free = freeHeight(wa, dockHeight)
  const top = Math.round(clamp(point.y - grab, wa.y, wa.y + free))
  const target = edgeAt(display, point.x)
  return { top, offset: offsetFor(wa, dockHeight, top - wa.y), edge, target, ghost: target !== edge }
}

// The window's x for a dock window `width` wide flush to `edge`.
function edgeX (workArea, edge, width) {
  return edge === 'left' ? workArea.x : workArea.x + workArea.width - width
}

module.exports = {
  EDGES,
  validDockPos,
  offsetFor,
  migrate,
  dockTop,
  edgeAt,
  dragPlace,
  edgeX,
}
