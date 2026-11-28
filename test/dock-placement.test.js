// Where the dock lives (src/dock-placement.js, over edge-drag.js): places
// are an edge and a fraction of the free height (anchor 'start'); old px
// memory migrates. The drag maths itself: test/edge-drag.test.js.

const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../src/dock-placement')

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

test('the dock is edge-drag with anchor start: its top and x come from there', () => {
  assert.equal(P.ANCHOR, 'start')
  assert.equal(P.edgeX(laptop.workArea, 'right', 88), 1512 - 88)
  assert.equal(P.edgeX(external.workArea, 'left', 88), -1920)
})
