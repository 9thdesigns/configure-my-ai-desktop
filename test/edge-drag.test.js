// Dragging along a screen edge (src/edge-drag.js), on its own: both axes
// (left / right slide on y, top / bottom on x), both anchors ('center', the
// island's offsetX; 'start', the dock's "fraction of the free height"), the
// locked cross coordinate, the drag step (grab kept, clamped, target edge
// past the midline, magnet), re-homing to the display under the pointer,
// resolving a saved place, and the stretch feel. The 'center' maths agrees
// with island-placement.js, so the island can move onto it without a prefs
// migration.

const test = require('node:test')
const assert = require('node:assert/strict')
const E = require('../src/edge-drag')
const island = require('../src/island-placement')

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
const external = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }

test('axes and spans: left/right slide on y, top/bottom on x', () => {
  assert.deepEqual(['left', 'right', 'top', 'bottom'].map(E.axisOf), ['y', 'y', 'x', 'x'])
  assert.deepEqual(['left', 'right', 'top', 'bottom'].map(E.opposite), ['right', 'left', 'bottom', 'top'])
  assert.deepEqual(E.span(laptop.workArea, 'right'), { start: 37, length: 945 })
  assert.deepEqual(E.span(laptop.workArea, 'top'), { start: 0, length: 1512 })
})

test('the locked coordinate: flush to each edge of the work area', () => {
  assert.equal(E.crossPosition(laptop.workArea, 'left', 88), 0)
  assert.equal(E.crossPosition(laptop.workArea, 'right', 88), 1512 - 88)
  assert.equal(E.crossPosition(laptop.workArea, 'top', 40), 37)
  assert.equal(E.crossPosition(laptop.workArea, 'bottom', 40), 37 + 945 - 40)
})

test("anchor 'start' (the dock): a fraction of the free length, round-tripping", () => {
  const wa = laptop.workArea
  assert.equal(E.positionFor({ workArea: wa, edge: 'right', size: 300, fraction: 0, anchor: 'start' }), 37)
  assert.equal(E.positionFor({ workArea: wa, edge: 'right', size: 300, fraction: 1, anchor: 'start' }), 37 + 645)
  assert.equal(E.positionFor({ workArea: wa, edge: 'right', size: 300, fraction: NaN, anchor: 'start' }), 37 + Math.round(645 / 2), 'no fraction: centred')
  assert.equal(E.fractionFor({ workArea: wa, edge: 'right', size: 300, pos: 37 + 161, anchor: 'start' }), 0.2496)
  assert.equal(E.fractionFor({ workArea: wa, edge: 'right', size: 2000, pos: 37, anchor: 'start' }), 0.5, 'too big to move: centred')
  for (const f of [0, 0.25, 0.6, 1]) {
    const pos = E.positionFor({ workArea: wa, edge: 'left', size: 300, fraction: f, anchor: 'start' })
    assert.ok(Math.abs(E.fractionFor({ workArea: wa, edge: 'left', size: 300, pos, anchor: 'start' }) - f) < 0.002)
  }
})

test("anchor 'center' (default, the island): the window's centre at start + fraction × length, kept inside", () => {
  const wa = laptop.workArea
  assert.equal(E.positionFor({ workArea: wa, edge: 'top', size: 212, fraction: 0.5 }), 756 - 106)
  assert.equal(E.positionFor({ workArea: wa, edge: 'top', size: 212, fraction: 0 }), 0, 'clamped inside at the start')
  assert.equal(E.positionFor({ workArea: wa, edge: 'top', size: 212, fraction: 1 }), 1512 - 212, 'and the end')
  assert.equal(E.positionFor({ workArea: wa, edge: 'top', size: 212, fraction: 0.05, margin: 220 }), 220 - 106, 'margin keeps the centre further in')
  assert.equal(E.fractionFor({ workArea: wa, edge: 'top', size: 212, pos: 650 }), 0.5)
  assert.deepEqual(E.boundsFor({ workArea: wa, edge: 'bottom', size: 212, thickness: 40, fraction: 0.25 }), { x: 378 - 106, y: 37 + 945 - 40, width: 212, height: 40 })
  assert.deepEqual(E.boundsFor({ workArea: wa, edge: 'right', size: 300, thickness: 88, fraction: 0.5, anchor: 'start' }), { x: 1424, y: 37 + 323, width: 88, height: 300 })
})

test("'center' agrees with island-placement.js: same centre for the same offsetX, same offsetX from a drag", () => {
  for (const offsetX of [0.1, 0.3, 0.5, 0.72, 0.95]) {
    const g = island.islandGeometry({ display: laptop, edge: 'top', offsetX })
    const islandCentre = g.window.x + g.pill.centre
    const half = (g.pill.centre)
    // The island keeps its widest pill (and shoulders) in: half the envelope less its padding.
    const margin = g.window.width / 2 - island.PAD
    const mine = E.positionFor({ workArea: laptop.workArea, edge: 'top', size: 0, fraction: offsetX, margin })
    assert.equal(mine, islandCentre, `offsetX ${offsetX}: centre ${mine} vs ${islandCentre} (half ${half})`)
  }
  // A drag: the island's dragPlace vs dragTo with the grab measured to the centre.
  const startCentre = 700
  const startPoint = { screenX: 720, screenY: 20 }
  for (const x of [300, 900, 1400]) {
    const theirs = island.dragPlace({ display: laptop, startCentre, startPoint, point: { screenX: x, screenY: 20 } })
    const mine = E.dragTo({ display: laptop, edge: 'top', size: 0, grab: startPoint.screenX - startCentre, point: { x, y: 20 }, magnet: island.MAGNET })
    assert.equal(mine.fraction, theirs.offsetX, `x ${x}`)
    assert.equal(mine.target, theirs.edge)
  }
  const snap = E.dragTo({ display: laptop, edge: 'top', size: 0, grab: 20, point: { x: 756 + 20 + 10, y: 20 }, magnet: island.MAGNET })
  assert.equal(snap.snapped, true)
  assert.equal(snap.fraction, 0.5)
})

test('a drag step: the edge locked, the grab kept, clamped; the target edge on the pointer\'s side of the midline', () => {
  const at = E.dragTo({ display: laptop, edge: 'right', size: 300, grab: 40, point: { x: 1300, y: 500 }, anchor: 'start' })
  assert.deepEqual(at, { pos: 460, fraction: E.fractionFor({ workArea: laptop.workArea, edge: 'right', size: 300, pos: 460, anchor: 'start' }), snapped: false, edge: 'right', target: 'right', ghost: false })
  const across = E.dragTo({ display: laptop, edge: 'right', size: 300, grab: 40, point: { x: 700, y: 500 }, anchor: 'start' })
  assert.deepEqual([across.edge, across.target, across.ghost], ['right', 'left', true], 'stays on its edge until let go')
  assert.equal(E.dragTo({ display: laptop, edge: 'right', size: 300, grab: 40, point: { x: 1300, y: -500 }, anchor: 'start' }).pos, 37)
  assert.equal(E.dragTo({ display: laptop, edge: 'right', size: 300, grab: 40, point: { x: 1300, y: 5000 }, anchor: 'start' }).pos, 37 + 945 - 300)
  // Top / bottom: the midline is across y.
  assert.equal(E.dragTo({ display: laptop, edge: 'top', size: 212, grab: 100, point: { x: 500, y: 800 } }).target, 'bottom')
  assert.equal(E.targetEdge(external, 'left', { x: -100, y: 5 }), 'right')
  assert.equal(E.targetEdge(external, 'right', { x: -1500, y: 5 }), 'left')
  // No magnet for anchor 'start'.
  assert.equal(E.dragTo({ display: laptop, edge: 'right', size: 300, grab: 0, point: { x: 1300, y: 37 + 322 }, anchor: 'start', magnet: 50 }).snapped, false)
})

test('re-homing: the display under (or nearest) the pointer; resolving a saved place onto the fallback', () => {
  assert.equal(E.displayAt([laptop, external], { x: -300, y: 600 }).id, 2)
  assert.equal(E.displayAt([laptop, external], { x: 2000, y: 100 }).id, 1, 'off every display: the nearest')
  assert.equal(E.displayAt([], { x: 0, y: 0 }), null)
  assert.equal(E.findDisplay([laptop, external], { displayId: 2 }).id, 2)
  assert.equal(E.findDisplay([laptop, { ...external, id: 9 }], { displayId: 2, displayBounds: external.bounds }).id, 9, 'by bounds when the id changed')
  assert.deepEqual(E.resolve({ displayId: 2, edge: 'left', fraction: 0.3 }, [laptop, external], laptop), { display: external, edge: 'left', fraction: 0.3 })
  assert.deepEqual(E.resolve({ displayId: 2, edge: 'left', fraction: 7 }, [laptop], laptop), { display: laptop, edge: 'left', fraction: 1 }, 'gone: same edge and fraction on the fallback, clamped')
  assert.deepEqual(E.resolve(null, [laptop], null, { edge: 'top' }), { display: laptop, edge: 'top', fraction: 0.5 })
})

test('the feel: velocity from recent samples, 9px per px/ms capped at 12, contents lag 0.3', () => {
  const now = 1000
  assert.equal(E.velocity([{ t: 950, v: 100 }, { t: 1000, v: 150 }], now), 1)
  assert.equal(E.velocity([{ t: 800, v: 100 }, { t: 850, v: 150 }], now), 0, 'stale: stopped')
  assert.equal(E.velocity([{ t: 1000, v: 100 }], now), 0)
  assert.equal(E.stretchFor(1), 9)
  assert.equal(E.stretchFor(5), 12)
  assert.equal(E.stretchFor(-5), -12)
  assert.equal(E.stretchFor(NaN), 0)
  assert.deepEqual(E.stretchStyle(0, 300), { scale: 1, origin: 'start', lag: 0 })
  const down = E.stretchStyle(12, 300)
  assert.deepEqual([down.scale, down.origin], [312 / 300, 'start'])
  assert.ok(Math.abs(down.lag + 3.6) < 1e-9)
  assert.equal(E.stretchStyle(-6, 300).origin, 'end')
  assert.deepEqual(E.SPRINGS, { stretch: 'stretch', release: 'wobbly' })
})
