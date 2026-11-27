const test = require('node:test')
const assert = require('node:assert/strict')
const G = require('../src/drag-gesture')

test('a drag needs both distance and time, or a deliberate throw', () => {
  assert.equal(G.DRAG_DISTANCE, 4)
  // Under 4px is a tap however long it is held.
  assert.equal(G.isDrag(3, 0, 5000), false)
  assert.equal(G.isDrag(2, 2, 5000), false, '2.8px')
  // 4px after the delay is a drag; diagonal distance counts.
  assert.equal(G.isDrag(4, 0, G.DRAG_DELAY_MS), true)
  assert.equal(G.isDrag(3, 3, G.DRAG_DELAY_MS), true, '4.2px')
  // The same 4–11px in the first instant is a click that jittered (a
  // trackpad press often moves a few px at once): still a tap.
  assert.equal(G.isDrag(6, 0, 20), false)
  assert.equal(G.isDrag(11, 0, G.DRAG_DELAY_MS - 1), false)
  // A throw of 12px or more is a drag at once.
  assert.equal(G.isDrag(12, 0, 0), true)
  assert.equal(G.isDrag(0, -15, 5), true)
  // Junk in: no drag.
  assert.equal(G.isDrag('x', null, 1000), false)
})

function run (events, options) {
  const seen = []
  const g = G.createGesture({
    options,
    onStart: (p) => seen.push(['start', p.x, p.y]),
    onMove: (p) => seen.push(['move', p.x, p.y]),
    onEnd: (p) => seen.push(['end', p.x, p.y]),
  })
  const results = events.map(([kind, x, y, t, button]) => g[kind]({ x, y, t, button }))
  return { seen, results, g }
}

test('a tap with a little wobble stays a click', () => {
  const { seen, results } = run([['down', 100, 100, 0], ['move', 102, 101, 40], ['move', 103, 102, 150], ['up', 103, 102, 200]])
  assert.deepEqual(results, [true, 'pending', 'pending', 'tap'])
  assert.deepEqual(seen, [], 'nothing sent to main')
})

test('a slow press that moves 4px becomes a drag, starting from where it was pressed', () => {
  const { seen, results } = run([['down', 100, 100, 0], ['move', 101, 100, 50], ['move', 104, 100, 120], ['move', 140, 130, 200], ['up', 150, 140, 260]])
  assert.deepEqual(results, [true, 'pending', 'drag', 'drag', 'drop'])
  assert.deepEqual(seen, [['start', 100, 100], ['move', 104, 100], ['move', 140, 130], ['end', 150, 140]])
})

test('a fast throw drags at once; jitter in the first instant does not', () => {
  assert.deepEqual(run([['down', 0, 0, 0], ['move', 6, 0, 10], ['up', 6, 0, 30]]).results, [true, 'pending', 'tap'])
  assert.deepEqual(run([['down', 0, 0, 0], ['move', 20, 0, 10], ['up', 30, 0, 30]]).results, [true, 'drag', 'drop'])
})

test('only the primary button presses; a cancelled drag still ends', () => {
  const right = run([['down', 0, 0, 0, 2], ['move', 50, 0, 200], ['up', 50, 0, 300]])
  assert.deepEqual(right.results, [false, 'none', 'none'])
  assert.deepEqual(right.seen, [])
  const { g, seen } = run([['down', 0, 0, 0], ['move', 30, 0, 200]])
  g.cancel({ x: 31, y: 0 })
  assert.deepEqual(seen.at(-1), ['end', 31, 0])
  assert.equal(g.active, false)
  // A press that never became a drag cancels silently.
  const quiet = run([['down', 0, 0, 0]])
  quiet.g.cancel()
  assert.deepEqual(quiet.seen, [])
})

test('presses on text, inputs, the popover or the card never drag; nor while text is selected', () => {
  const node = (matches) => ({ closest: (sel) => (matches && sel === G.NO_DRAG ? {} : null) })
  const win = (text) => ({ getSelection: () => ({ isCollapsed: !text, toString: () => text }) })
  assert.equal(G.canStartOn(node(false), win('')), true)
  assert.equal(G.canStartOn(node(true), win('')), false)
  assert.equal(G.canStartOn(node(false), win('selected words')), false)
  assert.equal(G.canStartOn(null, win('')), false)
  for (const sel of ['input', 'textarea', '.popover', '.card', '[data-no-drag]']) assert.ok(G.NO_DRAG.includes(sel), sel)
})
