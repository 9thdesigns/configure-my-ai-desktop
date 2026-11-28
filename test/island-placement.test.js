const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/island-placement')

// A 14" MacBook Pro (notched, 1512x982 points, 37pt menu bar), a plain
// external display to its left, and a non-notched 13" MacBook Air.
const mbp = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
const external = { id: 2, internal: false, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 25, width: 1920, height: 1015 } }
const air = { id: 3, internal: true, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } }

test('the saved place: an edge and an offset along it; junk is null', () => {
  assert.deepEqual(P.validIslandEdge({ edge: 'bottom', offsetX: 0.25, displayId: 7, displayBounds: mbp.bounds }), { edge: 'bottom', offsetX: 0.25, displayId: 7, displayBounds: mbp.bounds })
  assert.deepEqual(P.validIslandEdge({ edge: 'top', offsetX: 3 }), { edge: 'top', offsetX: 1 }, 'clamped')
  assert.deepEqual(P.validIslandEdge({ edge: 'top', offsetX: 0.5, displayId: { evil: 1 }, displayBounds: 'x' }), { edge: 'top', offsetX: 0.5 }, 'a bad display is dropped, the place kept')
  for (const bad of [null, 'top', { edge: 'left', offsetX: 0.5 }, { edge: 'top' }, { edge: 'top', offsetX: NaN }]) assert.equal(P.validIslandEdge(bad), null)
})

test('the old per-display memory migrates once to an edge', () => {
  const entry = (pos) => [{ id: 1, bounds: mbp.bounds, pos }]
  assert.deepEqual(P.migrateIslandPositions(entry({ snap: 'top-center' })), { displayId: 1, displayBounds: mbp.bounds, edge: 'top', offsetX: 0.5 })
  // Dropped low on the left: the bottom edge, its centre's share of the width.
  const low = P.migrateIslandPositions(entry({ dx: 100, dy: 700 }))
  assert.equal(low.edge, 'bottom')
  assert.equal(low.offsetX, Math.round(((100 + 190) / 1512) * 10000) / 10000)
  // Near the old home (dx = centre − 190): centre.
  assert.equal(P.migrateIslandPositions(entry({ dx: 756 - 190 + 10, dy: 20 })).offsetX, 0.5)
  assert.equal(P.migrateIslandPositions([]), null)
  assert.equal(P.migrateIslandPositions([{ id: 1, pos: { dx: 1, dy: 1 } }]), null, 'no bounds, no guess')
})

test('a notch is found on a notched built-in Mac display only', () => {
  assert.deepEqual(P.notchFor(mbp, { platform: 'darwin' }), { width: 185, height: 37 })
  assert.equal(P.notchFor(air, { platform: 'darwin' }), null, '16:10, short menu bar')
  assert.equal(P.notchFor(external, { platform: 'darwin' }), null, 'not built in')
  assert.equal(P.notchFor(mbp, { platform: 'win32' }), null)
  assert.equal(P.notchFor(mbp, { platform: 'linux' }), null)
  // The menu bar hidden: still a notch (by shape), at the default height.
  const hidden = { ...mbp, workArea: { ...mbp.workArea, y: 0, height: 982 } }
  assert.deepEqual(P.notchFor(hidden, { platform: 'darwin' }), { width: 185, height: 32 })
  // Simulated, for development on any display.
  assert.deepEqual(P.notchFor(external, { platform: 'linux', simulate: { width: 200, height: 34 } }), { width: 200, height: 34 })
  assert.deepEqual(P.parseNotch('185x32'), { width: 185, height: 32 })
  for (const bad of ['', '185', '9999x32', '185x2', 'x', null]) assert.equal(P.parseNotch(bad), null)
})

test('resolving: the saved display while it is connected, else the same edge on the fallback', () => {
  const saved = { displayId: 2, displayBounds: external.bounds, edge: 'bottom', offsetX: 0.2 }
  assert.equal(P.resolvePlace(saved, [mbp, external], mbp).display, external)
  const rehomed = P.resolvePlace(saved, [mbp], mbp)
  assert.equal(rehomed.display, mbp)
  assert.deepEqual([rehomed.edge, rehomed.offsetX], ['bottom', 0.2], 'same edge, same offset')
  // Its id changed across a restart, its bounds did not.
  assert.equal(P.resolvePlace({ ...saved, displayId: 99 }, [mbp, external], mbp).display, external)
  assert.deepEqual(P.resolvePlace(null, [mbp], mbp), { display: mbp, edge: 'top', offsetX: 0.5 })
  assert.equal(P.resolvePlace(null, [], null), null)
})

test('top centre of a notched display: wrapped round the notch, at the very top', () => {
  const notch = P.notchFor(mbp, { platform: 'darwin' })
  const g = P.islandGeometry({ display: mbp, edge: 'top', offsetX: 0.5, notch })
  assert.equal(g.pill.wrap, true)
  assert.equal(g.pill.width, 268)
  assert.equal(g.pill.height, 37, 'as tall as the notch')
  assert.equal(g.pill.notchWidth, 185)
  assert.equal(g.window.y, 0, 'over the menu bar, round the notch')
  assert.equal(g.window.x + g.pill.centre, 756, 'centred on the display')
  // The window is wide enough for the open card and the hovered pill, with
  // room for the shoulders and the shadow.
  assert.ok(g.window.width >= P.EXPANDED_WIDTH + 2 * P.SHOULDER)
  assert.ok(g.window.height >= 37 + P.HOVER_GROW_H)
})

test('anywhere else: a floating pill flush to the work area edge', () => {
  const notch = P.notchFor(mbp, { platform: 'darwin' })
  const off = P.islandGeometry({ display: mbp, edge: 'top', offsetX: 0.3, notch })
  assert.equal(off.pill.wrap, false)
  assert.deepEqual([off.pill.width, off.pill.height], [212, 32])
  assert.equal(off.window.y, 37, 'just under the menu bar')
  assert.equal(off.window.x + off.pill.centre, Math.round(1512 * 0.3))
  const bottom = P.islandGeometry({ display: mbp, edge: 'bottom', offsetX: 0.5, notch })
  assert.equal(bottom.pill.wrap, false, 'the notch is only at the top')
  assert.equal(bottom.window.y + bottom.window.height, 37 + 945, 'flush to the bottom of the work area')
  const plain = P.islandGeometry({ display: air, edge: 'top', offsetX: 0.5, notch: null })
  assert.equal(plain.pill.wrap, false)
  assert.equal(plain.window.y, 25)
})

test('near the sides the pill is kept in, and the window on the display', () => {
  for (const offsetX of [0, 1]) {
    const g = P.islandGeometry({ display: external, edge: 'bottom', offsetX })
    const cx = g.window.x + g.pill.centre
    const half = Math.max(P.EXPANDED_WIDTH, 212 + P.HOVER_GROW_W) / 2
    assert.ok(cx - half >= external.workArea.x && cx + half <= external.workArea.x + external.workArea.width, `pill inside (${offsetX})`)
    assert.ok(g.window.x >= external.bounds.x && g.window.x + g.window.width <= external.bounds.x + external.bounds.width, `window inside (${offsetX})`)
  }
})

test('open on the card, the window grows away from the edge, up to the cap', () => {
  const top = P.islandGeometry({ display: air, edge: 'top', offsetX: 0.5, height: 200 })
  assert.equal(top.window.y, 25)
  assert.equal(top.window.height, 200 + P.HOVER_GROW_H + P.PAD)
  const bottom = P.islandGeometry({ display: air, edge: 'bottom', offsetX: 0.5, height: 200 })
  assert.equal(bottom.window.y + bottom.window.height, 900)
  assert.equal(P.islandGeometry({ display: air, edge: 'top', height: 5000 }).window.height, 440 + P.HOVER_GROW_H + P.PAD)
})

test('dragging: along the edge under the pointer, the other edge past the middle, the magnet at centre', () => {
  const start = { screenX: 756, screenY: 20 }
  const at = (x, y) => P.dragPlace({ display: mbp, startCentre: 756, startPoint: start, point: { screenX: x, screenY: y } })
  assert.deepEqual(at(756 + P.MAGNET, 30), { edge: 'top', offsetX: 0.5, snapped: true })
  const free = at(756 + P.MAGNET + 1, 30)
  assert.equal(free.snapped, false)
  assert.equal(free.edge, 'top')
  assert.equal(free.offsetX, Math.round(((756 + 25) / 1512) * 10000) / 10000)
  assert.equal(at(300, 600).edge, 'bottom', 'past the middle')
  assert.equal(at(300, 480).edge, 'top')
  assert.equal(at(-500, 30).offsetX, 0, 'clamped')
})

test('the keyboard moves it in steps, stopping at centre, or to the other edge', () => {
  const from = { edge: 'top', offsetX: 0.5 }
  assert.deepEqual(P.keyboardMove(from, { step: 1 }), { edge: 'top', offsetX: 0.55 })
  assert.deepEqual(P.keyboardMove({ edge: 'top', offsetX: 0.47 }, { step: 1 }), { edge: 'top', offsetX: 0.5 }, 'stops at centre')
  assert.deepEqual(P.keyboardMove(from, { edge: 'bottom' }), { edge: 'bottom', offsetX: 0.5 })
  assert.equal(P.keyboardMove(from, { edge: 'top' }), null)
  assert.equal(P.keyboardMove({ edge: 'top', offsetX: 0 }, { step: -1 }), null, 'already at the end')
  for (const bad of [null, {}, { step: 5 }, { edge: 'left' }]) assert.equal(P.keyboardMove(from, bad), null)
})

test('the generic edge maths is edge-drag.js, shared with the dock: no second copy here', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '../src/island-placement.js'), 'utf8')
  assert.match(src, /require\('\.\/edge-drag'\)/)
  for (const fn of ['E.resolve(', 'E.positionFor(', 'E.dragTo(']) assert.ok(src.includes(fn), fn)
  assert.doesNotMatch(src, /const findDisplay|function findDisplay|sameRect/, 'display lookup lives in edge-drag.js')
})
