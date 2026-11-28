// Where the dock lives and how it moves (src/dock-placement.js), and the
// drag's feel (src/dock-shape.js): places are an edge and a fraction of the
// free height; old px memory migrates; dragging locks x to the edge, keeps
// the grab under the pointer, clamps to the work area, and targets the
// pointer's half of the display; the stretch follows the pointer's speed.

const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/dock-placement')
const S = require('../src/dock-shape')

const laptop = { id: 1, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
const external = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, workArea: { x: -1920, y: 0, width: 1920, height: 1040 } }

test('a place: an edge and a fraction (0..1); older { side, offsetY } is kept, marked legacy', () => {
  assert.deepEqual(P.validDockPos({ edge: 'left', offset: 0.33333333 }), { edge: 'left', offset: 0.3333 })
  assert.deepEqual(P.validDockPos({ edge: 'right', offset: 7 }), { edge: 'right', offset: 1 })
  assert.deepEqual(P.validDockPos({ side: 'left', offsetY: 120.4 }), { edge: 'left', offsetY: 120, legacy: true })
  assert.deepEqual(P.validDockPos({ edge: 'right', offsetY: 5, legacy: true }), { edge: 'right', offsetY: 5, legacy: true }, 'round-trips through the prefs file')
  for (const junk of [null, {}, { edge: 'top', offset: 0.5 }, { edge: 'left', offset: 'x' }, { side: 'up', offsetY: 3 }, { side: 'left', offsetY: Infinity }]) assert.equal(P.validDockPos(junk), null)
})

test('the fraction is of the free height (work area less the dock), so it survives a different display or dock height', () => {
  const free = 945 - 300
  assert.equal(P.dockTop(laptop.workArea, 300, 0), 37)
  assert.equal(P.dockTop(laptop.workArea, 300, 1), 37 + free)
  assert.equal(P.dockTop(laptop.workArea, 300, 0.5), 37 + Math.round(free / 2))
  assert.equal(P.dockTop(laptop.workArea, 300, NaN), 37 + Math.round(free / 2), 'no offset: centred')
  assert.equal(P.offsetFor(laptop.workArea, 300, free / 4), 0.25)
  assert.equal(P.offsetFor(laptop.workArea, 300, -50), 0)
  assert.equal(P.offsetFor(laptop.workArea, 2000, 10), 0.5, 'a dock taller than the area: centred')
  // The same fraction on the external display: same relative height.
  const o = P.offsetFor(laptop.workArea, 300, 100)
  assert.equal(P.dockTop(external.workArea, 300, o), Math.round(o * (1040 - 300)))
})

test('migrating old px memory once its display is known', () => {
  assert.deepEqual(P.migrate({ edge: 'left', offsetY: 161, legacy: true }, laptop.workArea, 300), { edge: 'left', offset: 0.2496 })
  assert.deepEqual(P.migrate({ edge: 'right', offset: 0.4 }, laptop.workArea, 300), { edge: 'right', offset: 0.4 })
  assert.equal(P.migrate(null, laptop.workArea, 300), null)
})

test('dragging: x locked to the edge, the grab kept under the pointer, clamped; the target is the pointer\'s half', () => {
  const at = P.dragPlace({ display: laptop, dockHeight: 300, edge: 'right', grab: 40, point: { x: 1300, y: 500 } })
  assert.deepEqual(at, { top: 460, offset: P.offsetFor(laptop.workArea, 300, 460 - 37), edge: 'right', target: 'right', ghost: false })
  const across = P.dragPlace({ display: laptop, dockHeight: 300, edge: 'right', grab: 40, point: { x: 700, y: 500 } })
  assert.equal(across.target, 'left')
  assert.equal(across.ghost, true)
  assert.equal(across.edge, 'right', 'it stays on its edge until let go')
  assert.equal(P.dragPlace({ display: laptop, dockHeight: 300, edge: 'right', grab: 40, point: { x: 1300, y: -500 } }).top, 37)
  assert.equal(P.dragPlace({ display: laptop, dockHeight: 300, edge: 'right', grab: 40, point: { x: 1300, y: 5000 } }).top, 37 + 945 - 300)
  assert.equal(P.edgeAt(external, -100), 'right')
  assert.equal(P.edgeAt(external, -1500), 'left')
  assert.equal(P.edgeX(laptop.workArea, 'right', 88), 1512 - 88)
  assert.equal(P.edgeX(external.workArea, 'left', 88), -1920)
})

test('the feel: velocity from recent samples, stretch 9px per px/ms capped at 12, seats lag 0.3', () => {
  const now = 1000
  assert.equal(S.velocity([{ t: 950, y: 100 }, { t: 1000, y: 150 }], now), 1)
  assert.equal(S.velocity([{ t: 800, y: 100 }, { t: 850, y: 150 }], now), 0, 'stale samples: stopped')
  assert.equal(S.velocity([{ t: 1000, y: 100 }], now), 0)
  assert.equal(S.stretchFor(1), 9)
  assert.equal(S.stretchFor(5), 12)
  assert.equal(S.stretchFor(-5), -12)
  assert.equal(S.stretchFor(NaN), 0)
  assert.deepEqual(S.stretchStyle(0, 300), { scale: 1, origin: 'top', seats: 0 })
  const down = S.stretchStyle(12, 300)
  assert.deepEqual([down.scale, down.origin], [312 / 300, 'top'], 'dragged down: grows downward from its top')
  assert.ok(Math.abs(down.seats - -3.6) < 1e-9, 'seats lag 0.3 behind')
  assert.equal(S.stretchStyle(-6, 300).origin, 'bottom')
})
