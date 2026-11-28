'use strict'

// Where the dock lives: always against the left or the right edge of a
// display, anywhere down it. The dock's own layer over edge-drag.js (the
// generic drag-along-an-edge maths it shares with the island): what a
// remembered position looks like, and the one-time migration of the old
// one. Pure, so it is unit-tested without Electron
// (test/dock-placement.test.js); widget-window.js does the moving.
//
//   * A place is { edge: 'left' | 'right', offset }: offset is where the
//     dock's top sits as a fraction (0..1) of the free height — the work
//     area's height less the dock's (edge-drag.js anchor 'start') — so it
//     means the same on a display of another size, and for a dock with more
//     or fewer seats. 0.5 is centred.
//   * It is remembered per display (widget-placement.js's memory: { id,
//     bounds, pos }, newest first); older memory said { side, offsetY } in
//     px, and is migrated the first time that display is used, when its work
//     area and the dock's height are known.

const E = require('./edge-drag')

const MAX_COORD = 100000
const EDGES = ['left', 'right']
const ANCHOR = 'start'

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))
const round4 = (n) => Math.round(n * 10000) / 10000

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

// The fraction for a dock whose top is `top` px down from the work area's top.
function offsetFor (workArea, dockHeight, top) {
  return E.fractionFor({ workArea, edge: 'right', size: dockHeight, pos: workArea.y + top, anchor: ANCHOR })
}

// A legacy { offsetY } on this display as an { edge, offset } place.
function migrate (pos, workArea, dockHeight) {
  if (!pos) return null
  if (!pos.legacy) return { edge: pos.edge, offset: pos.offset }
  return { edge: pos.edge, offset: offsetFor(workArea, dockHeight, pos.offsetY) }
}

// The dock's top (screen px) on this work area.
function dockTop (workArea, dockHeight, offset = 0.5) {
  return E.positionFor({ workArea, edge: 'right', size: dockHeight, fraction: offset, anchor: ANCHOR })
}

// The window's x for a dock window `width` wide flush to `edge`.
const edgeX = (workArea, edge, width) => E.crossPosition(workArea, edge, width)

module.exports = { EDGES, ANCHOR, validDockPos, offsetFor, migrate, dockTop, edgeX }
