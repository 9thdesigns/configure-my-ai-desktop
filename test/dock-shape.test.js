// The dock's outline (src/dock-shape.js): it starts and ends on the edge,
// flares into it through concave fillets, rounds its inner corners, shrinks
// its radii to fit, and the rim light's mood follows the bots.

const test = require('node:test')
const assert = require('node:assert/strict')
const { dockPath, rimActivity } = require('../src/dock-shape')

const commands = (d) => d.match(/[MLAZ][^MLAZ]*/g).map((c) => [c[0], ...c.slice(1).trim().split(/\s+/).filter(Boolean).map(Number)])

test('the outline runs from the edge, out through a fillet, round the body and back into the edge', () => {
  const c = commands(dockPath(56, 300, { fillet: 14, corner: 22 }))
  assert.deepEqual(c[0], ['M', 56, 0], 'starts on the edge at the top')
  assert.deepEqual(c[1], ['A', 14, 14, 0, 0, 1, 42, 14], 'concave fillet out of the edge (sweep 1, centre on the edge line above)')
  assert.deepEqual(c[2], ['L', 22, 14])
  assert.deepEqual(c[3], ['A', 22, 22, 0, 0, 0, 0, 36], 'inner top corner, convex')
  assert.deepEqual(c[4], ['L', 0, 264])
  assert.deepEqual(c[5], ['A', 22, 22, 0, 0, 0, 22, 286], 'inner bottom corner, convex')
  assert.deepEqual(c[6], ['L', 42, 286])
  assert.deepEqual(c[7], ['A', 14, 14, 0, 0, 1, 56, 300], 'concave fillet back into the edge')
  assert.deepEqual(c[8], ['Z'], 'closes up the edge')
})

test('the fillets are concave: the outline bows in toward the edge, not out', () => {
  // At the fillet's midpoint the outline is at the circle centred (w − f, 0):
  // a point just inside the edge, between the fillet and the body top, is
  // in the shape; the convex alternative (centre (w, f)) would leave it out.
  const f = 14
  const w = 56
  const mid = { x: w - f + f * Math.SQRT1_2, y: f * Math.SQRT1_2 }
  assert.ok(Math.hypot(mid.x - (w - f), mid.y - 0) - f < 1e-9)
  // The arc flags say small arc, clockwise — with the centre at (w − f, 0).
  const [, , , , large, sweep] = commands(dockPath(w, 200, { fillet: f }))[1]
  assert.equal(large, 0)
  assert.equal(sweep, 1)
})

test('radii shrink to fit a short or narrow dock; nothing goes negative', () => {
  const short = commands(dockPath(56, 40, { fillet: 14, corner: 22 }))
  // f ≤ h/4 = 10; the body is 20 tall, so r ≤ 10.
  assert.equal(short[1][1], 10)
  assert.equal(short[3][1], 10)
  for (const [x, y] of [[0, 0], [-5, 100], [56, -1]]) assert.doesNotMatch(dockPath(x, y), /NaN|-\d/)
})

test('the rim light: amber while one waits on you, bright while one works, quiet otherwise; paused bots do not count', () => {
  assert.equal(rimActivity([]), 'idle')
  assert.equal(rimActivity([{ mood: 'idle' }, { mood: 'responded' }]), 'idle')
  assert.equal(rimActivity([{ mood: 'idle' }, { mood: 'working' }]), 'working')
  assert.equal(rimActivity([{ mood: 'working' }, { mood: 'idle', waiting: 'question' }]), 'waiting')
  assert.equal(rimActivity([{ mood: 'waiting' }]), 'waiting')
  assert.equal(rimActivity([{ mood: 'working', paused: true }, { mood: 'waiting', paused: true }]), 'idle')
  assert.equal(rimActivity(null), 'idle')
})
