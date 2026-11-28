// The spring module (src/motion.js): the named springs match the tokens; the
// closed form starts where it should and decays; the stepped spring (4
// substeps, dt capped at 1/30 s) tracks the closed form; the sampler turns a
// spring into keyframes that start at `from` and end exactly on `to`; the
// live spring runs on (fake) animation frames, retargets keeping its
// velocity, and under reduced motion jumps without a single frame.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const M = require('../src/motion')

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} ${a} ≉ ${b} (±${eps})`)

test('the named springs are the --spring-* tokens', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/widget-tokens.css'), 'utf8')
  const tokens = Object.fromEntries([...css.matchAll(/--spring-([a-z]+):\s*([^;]+);/g)].map(([, n, v]) => [n, M.springFromToken(v)]))
  assert.deepEqual(Object.keys(tokens).sort(), Object.keys(M.SPRINGS).sort())
  for (const [name, spring] of Object.entries(M.SPRINGS)) assert.deepEqual(tokens[name], { ...spring }, name)
  assert.equal(M.springFromToken('nope'), null)
  assert.equal(M.springFromToken('170'), null)
  assert.equal(M.springFromToken('-1 3'), null)
})

test('response/dampingFraction ⇄ stiffness/damping', () => {
  const s = M.fromResponse(0.5, 0.8)
  near(s.stiffness, (2 * Math.PI / 0.5) ** 2, 1e-9)
  near(s.damping, 2 * 0.8 * (2 * Math.PI / 0.5), 1e-9)
  const back = M.toResponse(s)
  near(back.response, 0.5, 1e-12)
  near(back.dampingFraction, 0.8, 1e-12)
  assert.deepEqual(M.normalize({ response: 0.5, dampingFraction: 0.8 }), s)
  assert.deepEqual(M.normalize('soft'), { stiffness: 170, damping: 19 })
  assert.throws(() => M.normalize('nope'))
  assert.throws(() => M.normalize({ stiffness: 0, damping: 1 }))
  assert.throws(() => M.fromResponse(0, 1))
})

test('the closed form: starts at x0/v0, matches its own derivative, and decays — under, critically and over damped', () => {
  const cases = [M.SPRINGS.wobbly, { stiffness: 100, damping: 20 }, { stiffness: 100, damping: 60 }]
  for (const spring of cases) {
    const at0 = M.solve(spring, 10, -3, 0)
    near(at0.x, 10, 1e-9, 'x(0)')
    near(at0.v, -3, 1e-9, 'v(0)')
    for (const t of [0.05, 0.2, 0.6]) {
      const h = 1e-6
      const numeric = (M.solve(spring, 10, -3, t + h).x - M.solve(spring, 10, -3, t - h).x) / (2 * h)
      near(M.solve(spring, 10, -3, t).v, numeric, 1e-4, `v(${t})`)
    }
    assert.ok(Math.abs(M.solve(spring, 10, -3, 10).x) < 1e-3, 'comes to rest')
  }
  // Underdamped overshoots; overdamped never crosses.
  const xs = (spring) => Array.from({ length: 120 }, (_, i) => M.solve(spring, 1, 0, i / 60).x)
  assert.ok(Math.min(...xs(M.SPRINGS.wobbly)) < -0.1, 'wobbly overshoots')
  assert.ok(Math.min(...xs({ stiffness: 100, damping: 60 })) >= 0, 'overdamped does not')
})

test('one step is 4 semi-implicit Euler substeps, with dt capped at 1/30 s', () => {
  const spring = M.SPRINGS.snappy
  const manual = (x, v, dt) => {
    const h = dt / 4
    for (let i = 0; i < 4; i++) {
      v += (-spring.stiffness * (x - 0) - spring.damping * v) * h
      x += v * h
    }
    return { value: x, velocity: v }
  }
  assert.deepEqual(M.step({ value: 1, velocity: 0 }, 0, spring, 1 / 60), manual(1, 0, 1 / 60))
  assert.deepEqual(M.step({ value: 1, velocity: 0 }, 0, spring, 1), manual(1, 0, 1 / 30), 'a 1 s stall is one 1/30 s step')
  assert.deepEqual(M.step({ value: 1, velocity: 0 }, 0, spring, -5), { value: 1, velocity: 0 }, 'no time, no motion')
})

test('the stepped spring tracks the closed form at 60 fps, and lands where it does', () => {
  for (const name of ['soft', 'snappy', 'wobbly', 'open', 'close']) {
    let state = { value: 0, velocity: 0 }
    let worst = 0
    for (let i = 1; i <= 90; i++) {
      state = M.step(state, 100, name, 1 / 60)
      const exact = 100 + M.solve(name, -100, 0, i / 60).x
      worst = Math.max(worst, Math.abs(state.value - exact))
    }
    for (let i = 0; i < 300; i++) state = M.step(state, 100, name, 1 / 60)
    near(state.value, 100, 1e-3, `${name} rests on the target`)
    // Semi-implicit Euler at 4 substeps a frame: within 3.5% of the range at
    // the fastest point, and the same resting place.
    assert.ok(worst < 3.5, `${name}: within 3.5% of the range (worst ${worst.toFixed(3)})`)
  }
})

test('the sampler: from → to at 60 fps, ending exactly on the target, with a sensible duration', () => {
  const soft = M.sample('soft', { from: 0, to: 1 })
  assert.equal(soft.values[0], 0)
  assert.equal(soft.values.at(-1), 1)
  assert.equal(soft.values.length, Math.round(soft.duration / (1000 / 60)) + 1)
  assert.ok(soft.duration > 300 && soft.duration < 1500, `soft settles in ${soft.duration}ms`)
  const wobbly = M.sample('wobbly', { from: 0, to: 1 })
  assert.ok(Math.max(...wobbly.values) > 1.1, 'wobbly overshoots')
  const close = M.sample('close', { from: 1, to: 0 })
  assert.ok(Math.min(...close.values) > -0.02, 'close barely overshoots')
  assert.ok(close.duration < soft.duration, 'close is quicker than soft')
  // A starting velocity carries it the other way first.
  const flick = M.sample('soft', { from: 0, to: 1, velocity: -20 })
  assert.ok(flick.values[1] < 0)
  // Distance-relative rest: a 300px slide and a 0→1 scale settle alike.
  near(M.sample('soft', { from: 0, to: 300 }).duration, soft.duration, 50)
  // A spring that never settles stops at maxDuration, on its target.
  const capped = M.sample({ stiffness: 100, damping: 0 }, { from: 0, to: 1, maxDuration: 0.5 })
  assert.equal(capped.duration, 500)
  assert.equal(capped.values.at(-1), 1)
})

test('keyframes for Web Animations: one property, linear timing; reduced motion is just the end', () => {
  const k = M.springKeyframes('snappy', { from: 0.6, to: 1, format: (s) => `scale(${s})` })
  assert.equal(k.easing, 'linear')
  assert.deepEqual(k.keyframes[0], { transform: 'scale(0.6)' })
  assert.deepEqual(k.keyframes.at(-1), { transform: 'scale(1)' })
  const r = M.springKeyframes('snappy', { from: 0.6, to: 1, property: 'opacity', reduced: true })
  assert.deepEqual(r, { keyframes: [{ opacity: '1' }], duration: 0, easing: 'linear' })
  const fromResponse = M.springKeyframes({ response: 0.4, dampingFraction: 1 }, { from: 0, to: 10 })
  assert.ok(fromResponse.keyframes.every((f, i, a) => !i || Number(f.transform) >= Number(a[i - 1].transform)), 'critically damped: monotonic')
})

// A fake animation-frame loop.
function frames () {
  let queue = []
  let now = 0
  let id = 0
  return {
    raf: (fn) => { queue.push({ id: ++id, fn }); return id },
    caf: (cancel) => { queue = queue.filter((f) => f.id !== cancel) },
    advance (ms = 1000 / 60) {
      now += ms
      const run = queue
      queue = []
      run.forEach((f) => f.fn(now))
    },
    get pending () { return queue.length },
  }
}

test('the live spring: frames until rest, landing exactly on the target, one onRest', () => {
  const f = frames()
  const updates = []
  let rests = 0
  const s = M.createSpring({ value: 0, spring: 'snappy', reduced: false, raf: f.raf, caf: f.caf, onUpdate: (v) => updates.push(v), onRest: () => rests++ })
  s.setTarget(100)
  assert.equal(f.pending, 1)
  let n = 0
  while (f.pending && n++ < 600) f.advance()
  assert.equal(s.value, 100)
  assert.equal(s.velocity, 0)
  assert.equal(rests, 1)
  assert.equal(updates.at(-1), 100)
  assert.ok(n > 10 && n < 120, `settled in ${n} frames`)
  assert.equal(s.moving, false)
})

test('the live spring: a retarget mid-flight keeps its velocity (no jump); a stalled frame does not leap', () => {
  const f = frames()
  const s = M.createSpring({ value: 0, spring: 'soft', reduced: false, raf: f.raf, caf: f.caf })
  s.setTarget(100)
  for (let i = 0; i < 6; i++) f.advance()
  const { value, velocity } = s
  assert.ok(velocity > 0)
  s.setTarget(-100)
  assert.equal(s.value, value, 'no jump on retarget')
  f.advance()
  assert.ok(s.value > value, 'still carried forward by its velocity first')
  // A 2 s stall: one capped step, not a 2 s leap.
  const before = s.value
  const expected = M.step({ value: s.value, velocity: s.velocity }, -100, 'soft', 1 / 30).value
  f.advance(2000)
  near(s.value, expected, 1e-9)
  assert.ok(Math.abs(s.value - before) < 30)
})

test('reduced motion: every spring jumps to its target — no frames, one update', () => {
  const f = frames()
  const updates = []
  let rests = 0
  const s = M.createSpring({ value: 0, spring: 'wobbly', reduced: true, raf: f.raf, caf: f.caf, onUpdate: (v, vel) => updates.push([v, vel]), onRest: () => rests++ })
  s.setTarget(42)
  assert.equal(f.pending, 0, 'no animation frame requested')
  assert.equal(s.value, 42)
  assert.deepEqual(updates, [[42, 0]])
  assert.equal(rests, 1)
  // The reduced check is live: turned on mid-flight, the next retarget jumps.
  let reduce = false
  const g = frames()
  const t = M.createSpring({ value: 0, spring: 'soft', reduced: () => reduce, raf: g.raf, caf: g.caf })
  t.setTarget(10)
  g.advance()
  reduce = true
  t.setTarget(20)
  assert.equal(t.value, 20)
  assert.equal(g.pending, 0, 'the running frame was cancelled')
})

test('prefersReducedMotion reads the media query; animateSpring honours it', () => {
  const win = (matches) => ({ matchMedia: (q) => ({ matches: q === '(prefers-reduced-motion: reduce)' && matches }) })
  assert.equal(M.prefersReducedMotion(win(true)), true)
  assert.equal(M.prefersReducedMotion(win(false)), false)
  assert.equal(M.prefersReducedMotion({ matchMedia () { throw new Error('x') } }), false)
  assert.equal(M.prefersReducedMotion(null), false)

  const el = (reduced) => {
    const calls = []
    return { calls, style: {}, ownerDocument: { defaultView: win(reduced) }, animate (k, o) { calls.push([k, o]); return { finished: new Promise(() => {}), cancel () {} } } }
  }
  const still = el(true)
  assert.equal(M.animateSpring(still, 'snappy', { from: 0.6, to: 1, format: (s) => `scale(${s})` }), null)
  assert.deepEqual(still.calls, [])
  assert.equal(still.style.transform, 'scale(1)')
  const moving = el(false)
  assert.ok(M.animateSpring(moving, 'snappy', { from: 0.6, to: 1, format: (s) => `scale(${s})` }))
  assert.equal(moving.calls.length, 1)
  assert.equal(moving.calls[0][1].easing, 'linear')
  assert.equal(moving.calls[0][1].fill, 'forwards')
  assert.deepEqual(moving.calls[0][0].at(-1), { transform: 'scale(1)' })
})
