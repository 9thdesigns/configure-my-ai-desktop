// Springs for the widget and the island: one model, two ways to run it.
//
//   * createSpring — a live value stepped on requestAnimationFrame (for
//     things that follow the pointer or retarget mid-flight: the dock's drag
//     stretch, its tuck, a seat's nudge). Unit mass, stiffness k, damping c;
//     each frame advances in 4 semi-implicit Euler substeps, the frame's dt
//     capped at 1/30 s so a stalled frame never makes it leap.
//   * springKeyframes / animateSpring — the same spring sampled ahead of time
//     into Web Animations keyframes (a linear-timed list of values), for
//     fire-and-forget motion the compositor can run: an open, a pop, a
//     wobble. Springs are given as { stiffness, damping } or, like SwiftUI,
//     as { response, dampingFraction }; the sampler uses the closed-form
//     solution, which the stepped spring tracks (test/motion.test.js).
//
// Under reduced motion every spring jumps straight to its target: no frames,
// no keyframes, one update with the final value.
//
// The named springs are the --spring-* tokens in widget-tokens.css
// ("stiffness damping"); SPRINGS mirrors them, and springFromToken reads one
// off a computed style. Loaded by the widget and island pages
// (window.Motion) and by node (tests). Nothing here touches the DOM except
// animateSpring, and only the element it is given.

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Motion = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const SUBSTEPS = 4
  const MAX_DT = 1 / 30
  const SAMPLE_FPS = 60
  const MAX_DURATION = 3 // seconds: a sampled spring stops here, at its target
  const REST_DELTA = 0.01
  const REST_SPEED = 0.01
  const REDUCED = '(prefers-reduced-motion: reduce)'

  const SPRINGS = Object.freeze({
    soft: Object.freeze({ stiffness: 170, damping: 19 }),
    snappy: Object.freeze({ stiffness: 320, damping: 24 }),
    wobbly: Object.freeze({ stiffness: 210, damping: 13 }),
    open: Object.freeze({ stiffness: 190, damping: 19 }),
    close: Object.freeze({ stiffness: 280, damping: 33 }),
    stretch: Object.freeze({ stiffness: 300, damping: 30 }),
    tuck: Object.freeze({ stiffness: 260, damping: 22 }),
  })

  // --- Spring descriptions ---------------------------------------------------

  // { stiffness, damping } from either form; a named spring by name.
  function normalize (spring) {
    if (typeof spring === 'string') spring = SPRINGS[spring]
    if (!spring || typeof spring !== 'object') throw new TypeError('unknown spring')
    if (Number.isFinite(spring.response)) return fromResponse(spring.response, spring.dampingFraction)
    const stiffness = Number(spring.stiffness)
    const damping = Number(spring.damping)
    if (!(stiffness > 0) || !(damping >= 0)) throw new TypeError('a spring needs stiffness > 0 and damping >= 0')
    return { stiffness, damping }
  }

  // SwiftUI-style: response is the undamped period (s), dampingFraction ζ
  // (1 = critically damped). Unit mass: ω0 = 2π / response, k = ω0², c = 2ζω0.
  function fromResponse (response, dampingFraction = 1) {
    if (!(response > 0) || !(dampingFraction >= 0)) throw new TypeError('a spring needs response > 0 and dampingFraction >= 0')
    const omega = (2 * Math.PI) / response
    return { stiffness: omega * omega, damping: 2 * dampingFraction * omega }
  }

  function toResponse (spring) {
    const { stiffness, damping } = normalize(spring)
    const omega = Math.sqrt(stiffness)
    return { response: (2 * Math.PI) / omega, dampingFraction: damping / (2 * omega) }
  }

  // "170 19" (a --spring-* token) → { stiffness: 170, damping: 19 }; null if
  // it isn't one.
  function springFromToken (value) {
    const parts = String(value || '').trim().split(/[\s,]+/).map(Number)
    if (parts.length !== 2 || !(parts[0] > 0) || !(parts[1] >= 0)) return null
    return { stiffness: parts[0], damping: parts[1] }
  }

  // --- Stepping (the live spring) ---------------------------------------------

  // Advance { value, velocity } toward target by dt seconds: dt capped at
  // MAX_DT, split into SUBSTEPS semi-implicit Euler steps. Pure.
  function step (state, target, spring, dt) {
    const { stiffness, damping } = normalize(spring)
    const h = Math.min(Math.max(dt, 0), MAX_DT) / SUBSTEPS
    let x = state.value
    let v = state.velocity
    for (let i = 0; i < SUBSTEPS; i++) {
      const a = -stiffness * (x - target) - damping * v
      v += a * h
      x += v * h
    }
    return { value: x, velocity: v }
  }

  const atRest = (state, target, restDelta = REST_DELTA, restSpeed = REST_SPEED) =>
    Math.abs(state.value - target) < restDelta && Math.abs(state.velocity) < restSpeed

  // --- The closed form (the sampler) ------------------------------------------

  // Displacement from the target and velocity at time t (s), for a unit-mass
  // spring released at displacement x0 with velocity v0.
  function solve (spring, x0, v0, t) {
    const { stiffness, damping } = normalize(spring)
    const w0 = Math.sqrt(stiffness)
    const zeta = damping / (2 * w0)
    if (zeta < 1 - 1e-9) {
      const wd = w0 * Math.sqrt(1 - zeta * zeta)
      const B = (v0 + zeta * w0 * x0) / wd
      const e = Math.exp(-zeta * w0 * t)
      const cos = Math.cos(wd * t)
      const sin = Math.sin(wd * t)
      const x = e * (x0 * cos + B * sin)
      const v = e * ((B * wd - zeta * w0 * x0) * cos - (x0 * wd + zeta * w0 * B) * sin)
      return { x, v }
    }
    if (zeta <= 1 + 1e-9) {
      const e = Math.exp(-w0 * t)
      const B = v0 + w0 * x0
      return { x: e * (x0 + B * t), v: e * (B - w0 * (x0 + B * t)) }
    }
    const s = Math.sqrt(zeta * zeta - 1)
    const r1 = -w0 * (zeta - s)
    const r2 = -w0 * (zeta + s)
    const c1 = (v0 - r2 * x0) / (r1 - r2)
    const c2 = x0 - c1
    return { x: c1 * Math.exp(r1 * t) + c2 * Math.exp(r2 * t), v: c1 * r1 * Math.exp(r1 * t) + c2 * r2 * Math.exp(r2 * t) }
  }

  // The spring from `from` to `to` (starting velocity in units/s) as values
  // sampled at fps, ending exactly on `to` once it comes to rest (or at
  // maxDuration). → { values, duration (ms) }. Reduced motion: [to], 0 ms.
  function sample (spring, { from = 0, to = 1, velocity = 0, fps = SAMPLE_FPS, maxDuration = MAX_DURATION, restDelta, restSpeed, reduced = false } = {}) {
    if (reduced) return { values: [to], duration: 0 }
    const range = Math.abs(to - from) || 1
    // Rest thresholds in proportion to the distance, so a 0→1 scale and a
    // 0→300px slide settle alike.
    const delta = restDelta ?? REST_DELTA * range / 10
    const speed = restSpeed ?? REST_SPEED * range
    const x0 = from - to
    const values = [from]
    const frames = Math.ceil(maxDuration * fps)
    for (let i = 1; i <= frames; i++) {
      const { x, v } = solve(spring, x0, velocity, i / fps)
      if (Math.abs(x) < delta && Math.abs(v) < speed) {
        values.push(to)
        return { values, duration: Math.round((i / fps) * 1000) }
      }
      values.push(to + x)
    }
    values[values.length - 1] = to
    return { values, duration: Math.round(maxDuration * 1000) }
  }

  // Web Animations keyframes for one property: format(value) gives the CSS
  // value, e.g. (s) => `scale(${s})`. Timing is linear across the samples
  // (the spring is in the values).
  function springKeyframes (spring, { property = 'transform', format = (v) => String(v), ...options } = {}) {
    const { values, duration } = sample(spring, options)
    return {
      keyframes: values.map((v) => ({ [property]: format(round(v)) })),
      duration,
      easing: 'linear',
    }
  }

  const round = (v) => Math.round(v * 10000) / 10000

  function prefersReducedMotion (win = typeof window !== 'undefined' ? window : null) {
    try {
      return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia(REDUCED).matches)
    } catch {
      return false
    }
  }

  // Run a sampled spring on an element; under reduced motion, set the final
  // value and run nothing. Returns the Animation, or null.
  function animateSpring (el, spring, options = {}) {
    const win = el.ownerDocument && el.ownerDocument.defaultView
    const reduced = options.reduced ?? prefersReducedMotion(win)
    const { keyframes, duration, easing } = springKeyframes(spring, { ...options, reduced })
    const last = keyframes[keyframes.length - 1]
    if (reduced || !duration || typeof el.animate !== 'function') {
      for (const [prop, value] of Object.entries(last)) el.style[prop] = value
      return null
    }
    const animation = el.animate(keyframes, { duration, easing, fill: 'forwards' })
    // Keep the end state once it's done, then let go of the fill.
    animation.finished.then(() => {
      for (const [prop, value] of Object.entries(last)) el.style[prop] = value
      animation.cancel()
    }, () => {})
    return animation
  }

  // --- The live spring -----------------------------------------------------------

  // A value that springs toward its target on animation frames.
  //   onUpdate(value, velocity) every frame it moves; onRest(value) when it
  //   settles. raf/caf/now are injectable (tests run on a fake clock).
  //   reduced: a boolean, or a function asked at each retarget.
  function createSpring ({
    value = 0,
    spring = 'soft',
    onUpdate = () => {},
    onRest = () => {},
    restDelta = REST_DELTA,
    restSpeed = REST_SPEED,
    reduced = () => prefersReducedMotion(),
    raf = (fn) => requestAnimationFrame(fn),
    caf = (id) => cancelAnimationFrame(id),
  } = {}) {
    let params = normalize(spring)
    let state = { value, velocity: 0 }
    let target = value
    let frame = null
    let last = null
    const isReduced = () => (typeof reduced === 'function' ? reduced() : Boolean(reduced))

    function tick (time) {
      frame = null
      const dt = last === null ? 1 / SAMPLE_FPS : (time - last) / 1000
      last = time
      state = step(state, target, params, dt)
      if (atRest(state, target, restDelta, restSpeed)) {
        state = { value: target, velocity: 0 }
        last = null
        onUpdate(state.value, 0)
        onRest(state.value)
        return
      }
      onUpdate(state.value, state.velocity)
      frame = raf(tick)
    }

    function stop () {
      if (frame !== null) caf(frame)
      frame = null
      last = null
    }

    // Spring to a new target (keeping the current velocity), or jump there
    // under reduced motion.
    function setTarget (next, { velocity } = {}) {
      target = next
      if (Number.isFinite(velocity)) state = { ...state, velocity }
      if (isReduced()) return jump(next)
      if (atRest(state, target, restDelta, restSpeed)) {
        state = { value: target, velocity: 0 }
        return
      }
      if (frame === null) frame = raf(tick)
    }

    // Go there now, no motion.
    function jump (next) {
      stop()
      target = next
      state = { value: next, velocity: 0 }
      onUpdate(next, 0)
      onRest(next)
    }

    return {
      setTarget,
      jump,
      stop,
      setSpring: (s) => { params = normalize(s) },
      get value () { return state.value },
      get velocity () { return state.velocity },
      get target () { return target },
      get moving () { return frame !== null },
    }
  }

  return {
    SPRINGS,
    SUBSTEPS,
    MAX_DT,
    normalize,
    fromResponse,
    toResponse,
    springFromToken,
    step,
    atRest,
    solve,
    sample,
    springKeyframes,
    animateSpring,
    prefersReducedMotion,
    createSpring,
  }
})
