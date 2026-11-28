'use strict'

// Where the island lives: attached to the top or the bottom edge of a
// display, anywhere along it, and — on a notched MacBook display, at top
// centre — wrapped around the notch. Pure, so it is unit-tested without
// Electron (test/island-placement.test.js); island-window.js does the moving.
//
//   * The saved place is { displayId, displayBounds, edge, offsetX }: which
//     display, which edge ('top' | 'bottom'), and where along it the pill's
//     centre sits, as a fraction of the work area's width (0.5 is centre).
//     A fraction, so it means the same on a display of another width, and
//     for a pill of another width.
//   * Dragging slides it along the edge under the pointer; crossing the
//     display's middle flips it to the other edge. Within MAGNET px of the
//     centre it snaps there.
//   * Top centre of a notched display: the pill sits at the very top of the
//     display, as tall as the notch, with ears either side of it. Anywhere
//     else it is a floating pill flush to the work area's edge (just under
//     the menu bar, or just above the Dock / taskbar), with concave
//     shoulders where it meets the edge.
//   * The window is a fixed envelope, wider and taller than the pill, so the
//     pill can grow, shrink and spring inside it without the window moving
//     (setBounds is never animated). The page is click-through outside the
//     pill (the hit rects, as for the dock).
//   * A display that is gone: the island goes to the same edge, at the same
//     offset, on the fallback display, and back when the display returns.
//
// The numbers: compact 212 wide (268 around a notch), 32 tall (the notch's
// height around one), hover +32 wide / +8 tall, concave shoulders of 6px
// (18px open), open 440 wide.

const COMPACT_WIDTH = 212
const NOTCH_COMPACT_WIDTH = 268
const PILL_HEIGHT = 32
const HOVER_GROW_W = 32
const HOVER_GROW_H = 8
const SHOULDER = 6 // compact
const SHOULDER_OPEN = 18 // open (the composer); the envelope keeps room for it
const EXPANDED_WIDTH = 440 // the open island: the Manager composer (island-view.js)
const MAGNET = 24
const PAD = 14 // room for the shadow and the shoulders on the sides away from the edge
const DEFAULT_NOTCH = Object.freeze({ width: 185, height: 32 })
const MAX_COORD = 100000
const EDGES = ['top', 'bottom']

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))
const round4 = (n) => Math.round(n * 10000) / 10000

function validRect (r) {
  if (!r || typeof r !== 'object') return null
  const { x, y, width, height } = r
  if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}
const sameRect = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
const validDisplayId = (id) => (finite(id) || (typeof id === 'string' && /^[\w.:-]{1,64}$/.test(id)) ? id : null)

// --- The saved place ------------------------------------------------------------

function validIslandEdge (p) {
  if (!p || typeof p !== 'object') return null
  if (!EDGES.includes(p.edge)) return null
  const offsetX = Number(p.offsetX)
  if (!Number.isFinite(offsetX)) return null
  const out = { edge: p.edge, offsetX: round4(clamp(offsetX, 0, 1)) }
  const id = validDisplayId(p.displayId)
  const bounds = validRect(p.displayBounds)
  if (id !== null) out.displayId = id
  if (bounds) out.displayBounds = bounds
  return out
}

// The island's old memory (widget-placement.js validIslandPos entries, newest
// first: { id, bounds, pos: { snap: 'top-center' } | { dx, dy } }) as a place
// on an edge, once. A spot in the upper half of its display goes to the top
// edge, the lower half to the bottom; dx was the left of a 380px window.
const LEGACY_WINDOW_WIDTH = 380
function migrateIslandPositions (entries) {
  const e = Array.isArray(entries) ? entries[0] : null
  if (!e || !e.pos || typeof e.pos !== 'object') return null
  const bounds = validRect(e.bounds)
  const displayId = validDisplayId(e.id)
  const base = { ...(displayId !== null ? { displayId } : {}), ...(bounds ? { displayBounds: bounds } : {}) }
  if (e.pos.snap === 'top-center') return { ...base, edge: 'top', offsetX: 0.5 }
  if (!bounds || !finite(e.pos.dx) || !finite(e.pos.dy)) return null
  const edge = e.pos.dy < bounds.height / 2 ? 'top' : 'bottom'
  const centre = e.pos.dx + LEGACY_WINDOW_WIDTH / 2
  const offsetX = Math.abs(centre - bounds.width / 2) <= MAGNET ? 0.5 : round4(clamp(centre / bounds.width, 0, 1))
  return { ...base, edge, offsetX }
}

// --- Displays -------------------------------------------------------------------

// The notch of a built-in MacBook display, or null. Electron does not expose
// NSScreen's safe-area insets, so it is inferred: a built-in display on
// macOS whose shape is the notched panels' (about 1.54:1 in points — the
// 16:10 panel plus the strip the notch sits in), or whose menu bar is as
// tall as a notch. Its height is the menu bar's (macOS makes them match), or
// 32 when the menu bar hides itself. `simulate` ({ width, height }) forces
// one, for development and the recordings on Linux.
function notchFor (display, { platform = process.platform, simulate = null } = {}) {
  if (!display || !display.bounds) return null
  if (simulate) return { width: simulate.width, height: simulate.height }
  if (platform !== 'darwin' || display.internal !== true) return null
  const b = display.bounds
  const inset = display.workArea ? display.workArea.y - b.y : 0
  const aspect = b.width / b.height
  if (!(aspect >= 1.52 && aspect <= 1.565) && inset < 32) return null
  return { width: DEFAULT_NOTCH.width, height: inset >= 30 && inset <= 44 ? inset : DEFAULT_NOTCH.height }
}

// "185x32" → { width, height }, or null.
function parseNotch (value) {
  const m = /^(\d{2,3})x(\d{2})$/.exec(String(value || '').trim())
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  if (width < 60 || width > 400 || height < 16 || height > 60) return null
  return { width, height }
}

const findDisplay = (displays, place) => {
  if (!place) return null
  const list = displays || []
  return (place.displayId !== undefined && list.find((d) => d && d.id === place.displayId)) ||
    (place.displayBounds && list.find((d) => d && sameRect(d.bounds, place.displayBounds))) || null
}

// The display the island goes on and where: the saved display while it is
// connected; otherwise the same edge and offset on the fallback (the main
// window's display, or the primary). Nothing saved: top centre.
function resolvePlace (place, displays, fallback) {
  const saved = validIslandEdge(place)
  const display = findDisplay(displays, saved) || fallback || (displays || [])[0] || null
  if (!display) return null
  return { display, edge: saved ? saved.edge : 'top', offsetX: saved ? saved.offsetX : 0.5 }
}

// --- Geometry -------------------------------------------------------------------

// Is the island wrapping the notch? Only at top centre of a notched display.
const wraps = (edge, offsetX, notch) => Boolean(notch) && edge === 'top' && offsetX === 0.5

// The compact pill's size on this edge: around the notch, or floating.
function compactSize (wrap, notch) {
  if (wrap) return { width: Math.max(NOTCH_COMPACT_WIDTH, notch.width + 2 * 40), height: notch.height }
  return { width: COMPACT_WIDTH, height: PILL_HEIGHT }
}

// The widest the pill gets on this edge (hovered, or open on the card), and
// so how much room the window keeps for it on either side.
const maxPillWidth = (compact) => Math.max(EXPANDED_WIDTH, compact.width + HOVER_GROW_W)

// The pill's centre, in screen x, for an offset along this work area: kept
// far enough in that the widest pill (and its shoulders) stays inside it.
function centreX (workArea, offsetX, half) {
  const raw = workArea.x + workArea.width * offsetX
  return Math.round(clamp(raw, workArea.x + half, workArea.x + workArea.width - half))
}

// Everything the controller and the page need for one place:
//   window — the envelope's bounds (setBounds once, never animated)
//   pill   — the compact pill: its centre in window x, width, height; the
//            edge it hangs from; whether it wraps the notch (and the notch's
//            width, for the ears)
// `height` is the pill's natural height as the page reports it (the bar, or
// the bar and the open card); the window keeps HOVER_GROW_H and PAD more.
function islandGeometry ({ display, edge = 'top', offsetX = 0.5, notch = null, height = 0, maxHeight = 440 }) {
  const wa = display.workArea
  const b = display.bounds
  const wrap = wraps(edge, offsetX, notch)
  const compact = compactSize(wrap, notch)
  const half = Math.ceil(maxPillWidth(compact) / 2) + SHOULDER_OPEN
  const cx = wrap ? Math.round(b.x + b.width / 2) : centreX(wa, offsetX, half)
  const pillH = clamp(Math.round(Number(height)) || compact.height, compact.height, Math.min(maxHeight, wa.height))
  const winW = 2 * (half + PAD)
  const winH = pillH + HOVER_GROW_H + PAD
  // The window stays on the display; the pill moves inside it near the sides.
  const winX = Math.round(clamp(cx - winW / 2, b.x, b.x + b.width - winW))
  let winY
  if (edge === 'bottom') winY = wa.y + wa.height - winH
  else winY = wrap ? b.y : wa.y
  return {
    window: { x: winX, y: winY, width: winW, height: winH },
    pill: { centre: cx - winX, width: compact.width, height: compact.height, edge, wrap, notchWidth: wrap ? notch.width : 0 },
  }
}

// --- Dragging -------------------------------------------------------------------

// Where a drag puts the island: the display under the pointer, the edge on
// the pointer's half of it, and the offset of the pill's centre (which
// keeps the distance it had from the pointer at the start), snapped to
// centre within MAGNET px. `snapped` says the magnet caught it.
function dragPlace ({ display, startCentre, startPoint, point }) {
  const wa = display.workArea
  const cx = startCentre + (point.screenX - startPoint.screenX)
  const edge = point.screenY < display.bounds.y + display.bounds.height / 2 ? 'top' : 'bottom'
  const mid = wa.x + wa.width / 2
  if (Math.abs(cx - mid) <= MAGNET) return { edge, offsetX: 0.5, snapped: true }
  return { edge, offsetX: round4(clamp((cx - wa.x) / wa.width, 0, 1)), snapped: false }
}

// The keyboard's way to move it (the bar focused, Alt + arrows): a step of
// KEY_STEP along the edge — stopping at centre on the way past it — or the
// other edge. Anything else: null.
const KEY_STEP = 0.05
function keyboardMove (place, input) {
  const from = validIslandEdge(place) || { edge: 'top', offsetX: 0.5 }
  if (!input || typeof input !== 'object') return null
  if (EDGES.includes(input.edge)) return input.edge === from.edge ? null : { ...from, edge: input.edge }
  if (input.step !== 1 && input.step !== -1) return null
  let offsetX = round4(clamp(from.offsetX + input.step * KEY_STEP, 0, 1))
  if ((from.offsetX - 0.5) * (offsetX - 0.5) < 0) offsetX = 0.5
  return offsetX === from.offsetX ? null : { ...from, offsetX }
}

// The pill's centre on screen, for the start of a drag.
const screenCentre = (geometry) => geometry.window.x + geometry.pill.centre

module.exports = {
  COMPACT_WIDTH,
  NOTCH_COMPACT_WIDTH,
  PILL_HEIGHT,
  HOVER_GROW_W,
  HOVER_GROW_H,
  SHOULDER,
  SHOULDER_OPEN,
  EXPANDED_WIDTH,
  MAGNET,
  PAD,
  DEFAULT_NOTCH,
  validIslandEdge,
  migrateIslandPositions,
  notchFor,
  parseNotch,
  resolvePlace,
  wraps,
  compactSize,
  islandGeometry,
  dragPlace,
  KEY_STEP,
  keyboardMove,
  screenCentre,
}
