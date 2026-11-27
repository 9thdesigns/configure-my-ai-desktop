'use strict'

// Where the dock and the island live, once the user has dragged them: the
// snap rules, the per-display memory, and the clamping that keeps them on
// screen when displays come and go. Pure, so it is unit-tested without
// Electron (test/widget-placement.test.js); widget-window.js and
// island-window.js do the moving.
//
//   * The dock snaps to the nearer side edge (left or right) of the display
//     it is dropped on, at the height it was dropped. It is a column, so a
//     side edge is the only place it reads as a dock; top and bottom would
//     put a vertical strip across the menu bar or the taskbar.
//   * The island snaps back to top-centre when dropped within SNAP_DISTANCE
//     px of it; anywhere else it stays where it was dropped.
//   * Each is remembered per display (id, with the display's bounds as a
//     second key for platforms whose ids change across restarts), newest
//     first, in the prefs store. On launch, and whenever displays change, the
//     newest remembered display that is still connected wins; if none is,
//     the default display and the default position.
//   * Every position is clamped to the current work area, so a resolution
//     change, a moved taskbar or a smaller display never leaves either one
//     off screen.

const SNAP_DISTANCE = 48
const MAX_DISPLAYS = 8
const MAX_COORD = 100000

const finite = (n) => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= MAX_COORD
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), Math.max(lo, hi))

function validRect (r) {
  if (!r || typeof r !== 'object') return null
  const { x, y, width, height } = r
  if (![x, y, width, height].every(finite) || width <= 0 || height <= 0) return null
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

const sameRect = (a, b) => Boolean(a && b) && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// --- Positions --------------------------------------------------------------

// The dock: which side, and how far down the work area its top sits.
function validWidgetPos (p) {
  if (!p || typeof p !== 'object') return null
  if (p.side !== 'left' && p.side !== 'right') return null
  if (!finite(p.offsetY)) return null
  return { side: p.side, offsetY: Math.round(p.offsetY) }
}

// The island: snapped to top-centre, or the top-left of its window relative
// to the work area's top-left.
function validIslandPos (p) {
  if (!p || typeof p !== 'object') return null
  if (p.snap === 'top-center') return { snap: 'top-center' }
  if (!finite(p.dx) || !finite(p.dy)) return null
  return { dx: Math.round(p.dx), dy: Math.round(p.dy) }
}

// --- The per-display memory ---------------------------------------------------

// [{ id, bounds, pos }], newest first. Anything malformed is dropped.
function validEntries (input, validPos) {
  if (!Array.isArray(input)) return []
  const out = []
  for (const e of input.slice(0, MAX_DISPLAYS)) {
    if (!e || typeof e !== 'object') continue
    const bounds = validRect(e.bounds)
    const pos = validPos(e.pos)
    const id = finite(e.id) || (typeof e.id === 'string' && /^[\w.:-]{1,64}$/.test(e.id)) ? e.id : null
    if (!bounds || !pos || id === null) continue
    out.push({ id, bounds, pos })
  }
  return out
}

const matches = (entry, display) => entry.id === display.id || sameRect(entry.bounds, display.bounds)

// The newest remembered position whose display is still connected:
// { display, pos }, or null (use the default display and position).
function findSaved (entries, displays) {
  for (const entry of entries || []) {
    const display = (displays || []).find((d) => d && d.id === entry.id) || (displays || []).find((d) => d && sameRect(entry.bounds, d.bounds))
    if (display) return { display, pos: entry.pos }
  }
  return null
}

// The memory with this display's position at the front.
function remember (entries, display, pos) {
  const entry = { id: display.id, bounds: validRect(display.bounds), pos }
  return [entry, ...(entries || []).filter((e) => !matches(e, display))].slice(0, MAX_DISPLAYS)
}

// --- Dragging -------------------------------------------------------------------

// The drag protocol from the renderers: { phase, screenX, screenY }.
function validDrag (input) {
  if (!input || typeof input !== 'object') return null
  if (!['start', 'move', 'end'].includes(input.phase)) return null
  const screenX = Number(input.screenX)
  const screenY = Number(input.screenY)
  if (!finite(screenX) || !finite(screenY)) return null
  return { phase: input.phase, screenX, screenY }
}

// Where the window goes while dragged: where it started, plus how far the
// pointer has moved since.
function dragPosition (startBounds, startPoint, point) {
  return {
    x: Math.round(startBounds.x + point.screenX - startPoint.screenX),
    y: Math.round(startBounds.y + point.screenY - startPoint.screenY),
  }
}

// The display a point is on, or the nearest one to it.
function displayNearest (displays, point) {
  let best = null
  let bestDist = Infinity
  for (const d of displays || []) {
    const b = d.bounds
    const dx = Math.max(b.x - point.x, 0, point.x - (b.x + b.width - 1))
    const dy = Math.max(b.y - point.y, 0, point.y - (b.y + b.height - 1))
    const dist = Math.hypot(dx, dy)
    if (dist < bestDist) { best = d; bestDist = dist }
  }
  return best
}

const centreOf = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 })

// A window kept inside an area, allowing `slack` px of it (its transparent
// shadow margin) to hang over each edge. Too big for the area: pinned to
// its top-left.
function clampToArea (bounds, area, slack = 0) {
  return {
    ...bounds,
    x: Math.round(clamp(bounds.x, area.x - slack, area.x + area.width - bounds.width + slack)),
    y: Math.round(clamp(bounds.y, area.y - slack, area.y + area.height - bounds.height + slack)),
  }
}

// --- The dock -------------------------------------------------------------------

// Dropped at `bounds` (the collapsed dock window) on a display with this work
// area: the nearer side, and the height it was dropped at, kept on screen.
function snapWidget (bounds, workArea) {
  const c = centreOf(bounds)
  const side = c.x < workArea.x + workArea.width / 2 ? 'left' : 'right'
  const offsetY = Math.round(clamp(bounds.y - workArea.y, 0, workArea.height - bounds.height))
  return { side, offsetY }
}

// --- The island -----------------------------------------------------------------

// Dropped at `bounds`; `home` is where top-centre would put it. Within
// SNAP_DISTANCE px (measured between the windows' top-centre points) it goes
// home; otherwise it stays where it was dropped, relative to the work area.
function snapIsland (bounds, home, workArea, distance = SNAP_DISTANCE) {
  const d = Math.hypot((bounds.x + bounds.width / 2) - (home.x + home.width / 2), bounds.y - home.y)
  if (d <= distance) return { snap: 'top-center' }
  return { dx: Math.round(bounds.x - workArea.x), dy: Math.round(bounds.y - workArea.y) }
}

// The island's window for a saved position: home when snapped (or nothing
// saved), else the saved spot, clamped so the whole pill — and, while it is
// open, the card under it — stays in the work area.
function islandPlaced (home, workArea, pos, slack = 0) {
  if (!pos || pos.snap === 'top-center') return home
  return clampToArea({ ...home, x: workArea.x + pos.dx, y: workArea.y + pos.dy }, workArea, slack)
}

// --- Wayland ----------------------------------------------------------------------

// Wayland compositors (GNOME, KDE, Hyprland, Sway …) do not let a client place
// its own windows, so setPosition is ignored there. Detected up front from
// the environment, and confirmed at run time: a move that did not land
// (getBounds disagrees) means the platform will not let us.
function likelyWayland (platform, env = {}) {
  if (platform !== 'linux') return false
  const hint = String(env.ELECTRON_OZONE_PLATFORM_HINT || '').toLowerCase()
  if (hint === 'x11') return false
  return env.XDG_SESSION_TYPE === 'wayland' && Boolean(env.WAYLAND_DISPLAY) && hint !== 'x11'
}

const landed = (asked, actual, tolerance = 2) =>
  Boolean(actual) && Math.abs(actual.x - asked.x) <= tolerance && Math.abs(actual.y - asked.y) <= tolerance

module.exports = {
  SNAP_DISTANCE,
  MAX_DISPLAYS,
  validRect,
  validWidgetPos,
  validIslandPos,
  validEntries,
  findSaved,
  remember,
  validDrag,
  dragPosition,
  displayNearest,
  clampToArea,
  snapWidget,
  snapIsland,
  islandPlaced,
  likelyWayland,
  landed,
}
