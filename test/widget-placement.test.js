const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/widget-placement')

// A laptop with an external display to its left (negative coordinates) and
// one above-right, as macOS and Windows report them.
const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
const leftScreen = { id: 2, bounds: { x: -2560, y: -200, width: 2560, height: 1440 }, workArea: { x: -2560, y: -175, width: 2560, height: 1415 } }
const tall = { id: 3, bounds: { x: 1512, y: -600, width: 1080, height: 1920 }, workArea: { x: 1512, y: -600, width: 1080, height: 1880 } }
const displays = [laptop, leftScreen, tall]
const dock = (x, y) => ({ x, y, width: 72, height: 300 })

// --- The dock ---------------------------------------------------------------

test('the dock snaps to the nearer side edge, at the height it was dropped', () => {
  const wa = laptop.workArea
  assert.deepEqual(P.snapWidget(dock(1300, 200), wa), { side: 'right', offsetY: 163 })
  assert.deepEqual(P.snapWidget(dock(100, 200), wa), { side: 'left', offsetY: 163 })
  // The middle: decided by the dock's centre against the work area's.
  assert.equal(P.snapWidget(dock(755 - 36, 400), wa).side, 'left')
  assert.equal(P.snapWidget(dock(757 - 36, 400), wa).side, 'right')
})

test('the dock dropped past the top or bottom stays on screen', () => {
  const wa = laptop.workArea
  assert.equal(P.snapWidget(dock(1300, -50), wa).offsetY, 0, 'not under the menu bar')
  assert.equal(P.snapWidget(dock(1300, 900), wa).offsetY, 945 - 300, 'not off the bottom')
})

test('multi-display: the dock snaps on the display it was dropped on, negative coordinates included', () => {
  const at = dock(-700, 300)
  const d = P.displayNearest(displays, { x: at.x + 36, y: at.y + 150 })
  assert.equal(d.id, 2)
  assert.deepEqual(P.snapWidget(at, d.workArea), { side: 'right', offsetY: 475 })
  const d3 = P.displayNearest(displays, { x: 1600, y: -500 })
  assert.equal(d3.id, 3)
  assert.equal(P.snapWidget(dock(1600, -500), d3.workArea).side, 'left')
  // In the gap between displays: the nearest one.
  assert.equal(P.displayNearest(displays, { x: 1700, y: 1400 }).id, 3)
  assert.equal(P.displayNearest([], { x: 0, y: 0 }), null)
})

test('while dragged, the window follows the pointer and stays in the work area', () => {
  const start = dock(1400, 300)
  const at = P.dragPosition(start, { screenX: 1430, screenY: 400 }, { screenX: 1000, screenY: 450 })
  assert.deepEqual(at, { x: 970, y: 350 })
  assert.deepEqual(P.clampToArea({ ...start, x: 1600, y: -40 }, laptop.workArea), { ...start, x: 1512 - 72, y: 37 })
  // The island's shadow margin may hang over the edges.
  assert.deepEqual(P.clampToArea({ x: -50, y: 0, width: 380, height: 56 }, laptop.workArea, 10), { x: -10, y: 27, width: 380, height: 56 })
})

// --- Remembered per display -------------------------------------------------

test('positions are remembered per display, newest first, at most 8', () => {
  let entries = []
  entries = P.remember(entries, laptop, { side: 'left', offsetY: 100 })
  entries = P.remember(entries, leftScreen, { side: 'right', offsetY: 40 })
  assert.deepEqual(entries.map((e) => e.id), [2, 1])
  // The same display again: replaced and moved to the front.
  entries = P.remember(entries, laptop, { side: 'right', offsetY: 7 })
  assert.deepEqual(entries.map((e) => [e.id, e.pos.offsetY]), [[1, 7], [2, 40]])
  for (let i = 10; i < 20; i++) entries = P.remember(entries, { id: i, bounds: { x: i * 2000, y: 0, width: 1920, height: 1080 } }, { side: 'left', offsetY: i })
  assert.equal(entries.length, P.MAX_DISPLAYS)
  assert.equal(entries[0].id, 19)
})

test('the newest remembered display that is still connected wins', () => {
  const entries = [
    { id: 2, bounds: leftScreen.bounds, pos: { side: 'right', offsetY: 40 } },
    { id: 1, bounds: laptop.bounds, pos: { side: 'left', offsetY: 100 } },
  ]
  assert.deepEqual(P.findSaved(entries, displays), { display: leftScreen, pos: { side: 'right', offsetY: 40 } })
  // The external display unplugged: the laptop's own position.
  assert.deepEqual(P.findSaved(entries, [laptop]), { display: laptop, pos: { side: 'left', offsetY: 100 } })
  // None of them connected: null, so the caller uses the default.
  assert.equal(P.findSaved(entries, [tall]), null)
  assert.equal(P.findSaved([], displays), null)
})

test('a display whose id changed across a restart is found again by its bounds', () => {
  const entries = [{ id: 2, bounds: leftScreen.bounds, pos: { side: 'left', offsetY: 9 } }]
  const renumbered = { ...leftScreen, id: 77 }
  assert.deepEqual(P.findSaved(entries, [laptop, renumbered]), { display: renumbered, pos: { side: 'left', offsetY: 9 } })
  // And remembering it again replaces the old entry rather than adding one.
  assert.equal(P.remember(entries, renumbered, { side: 'right', offsetY: 1 }).length, 1)
})

test('stored positions are validated: junk is dropped, never trusted', () => {
  const good = { id: 1, bounds: laptop.bounds, pos: { side: 'left', offsetY: 12.4 } }
  assert.deepEqual(P.validEntries([good], P.validWidgetPos), [{ ...good, pos: { side: 'left', offsetY: 12 } }])
  for (const bad of [
    { ...good, pos: { side: 'top', offsetY: 1 } },
    { ...good, pos: { side: 'left', offsetY: 'x' } },
    { ...good, pos: { side: 'left', offsetY: 1e9 } },
    { ...good, bounds: { x: 0, y: 0, width: -5, height: 10 } },
    { ...good, id: { evil: true } },
    { ...good, id: '../../etc' },
    null,
    'nope',
  ]) assert.deepEqual(P.validEntries([bad], P.validWidgetPos), [], JSON.stringify(bad))
  assert.deepEqual(P.validEntries('nope', P.validWidgetPos), [])
  assert.deepEqual(P.validIslandPos({ snap: 'top-center', dx: 5 }), { snap: 'top-center' })
  assert.deepEqual(P.validIslandPos({ dx: 1.6, dy: -2 }), { dx: 2, dy: -2 })
  assert.equal(P.validIslandPos({ snap: 'elsewhere' }), null)
  assert.equal(P.validEntries(Array.from({ length: 20 }, () => good), P.validWidgetPos).length, P.MAX_DISPLAYS)
})

// --- Wayland ------------------------------------------------------------------

test('Wayland sessions do not drag (the compositor places windows); X11 and the others do', () => {
  assert.equal(P.likelyWayland('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1' }), true)
  assert.equal(P.likelyWayland('linux', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-1', ELECTRON_OZONE_PLATFORM_HINT: 'x11' }), false, 'forced onto XWayland')
  assert.equal(P.likelyWayland('linux', { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), false)
  assert.equal(P.likelyWayland('darwin', { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'w' }), false)
  assert.equal(P.landed({ x: 10, y: 10 }, { x: 11, y: 9 }), true, 'a pixel of DPI rounding')
  assert.equal(P.landed({ x: 10, y: 10 }, { x: 0, y: 0 }), false)
})
