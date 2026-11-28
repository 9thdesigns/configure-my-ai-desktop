// The dock's outline: one filled shape that grows out of the screen edge.
//
// The dock body is a column of seats with rounded inner corners; where it
// meets the edge, the outline flares into it through concave fillets, so the
// dock reads as part of the bezel rather than a card floating beside it. The
// outline is drawn for the right edge (the edge is x = width); the page
// mirrors the SVG for the left edge.
//
//            edge
//     ┌───────╮│  ← concave fillet (radius f), y 0 → f
//    ╭        ││
//    │ body   ││  ← the body: x 0 → width, y f → height − f,
//    │        ││    inner corners of radius r
//    ╰        ││
//     └───────╯│  ← concave fillet back into the edge
//
// Also the rim light's mood: what the 2px seam along the edge says about the
// dock as a whole. Pure (no DOM): window.DockShape in the page,
// require('./dock-shape') in tests.

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.DockShape = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const n = (v) => Math.round(v * 100) / 100

  // The SVG path for a dock `width` wide and `height` tall (fillets
  // included), with concave fillets of radius `fillet` at the edge and inner
  // corners of radius `corner`. Radii shrink to fit a short or narrow dock.
  function dockPath (width, height, { fillet = 14, corner = 22 } = {}) {
    const w = Math.max(0, Number(width) || 0)
    const h = Math.max(0, Number(height) || 0)
    const f = Math.max(0, Math.min(fillet, w / 2, h / 4))
    const body = h - 2 * f
    const r = Math.max(0, Math.min(corner, (w - f) , body / 2))
    const top = f
    const bottom = h - f
    return [
      `M ${n(w)} 0`,
      // Concave fillet out of the edge: centre (w − f, 0).
      `A ${n(f)} ${n(f)} 0 0 1 ${n(w - f)} ${n(top)}`,
      `L ${n(r)} ${n(top)}`,
      // Inner top corner (convex).
      `A ${n(r)} ${n(r)} 0 0 0 0 ${n(top + r)}`,
      `L 0 ${n(bottom - r)}`,
      // Inner bottom corner (convex).
      `A ${n(r)} ${n(r)} 0 0 0 ${n(r)} ${n(bottom)}`,
      `L ${n(w - f)} ${n(bottom)}`,
      // Concave fillet back into the edge: centre (w − f, h).
      `A ${n(f)} ${n(f)} 0 0 1 ${n(w)} ${n(h)}`,
      'Z',
    ].join(' ')
  }

  // The rim light: amber while any bot waits on the user, bright while any
  // works, quiet otherwise. Paused bots don't count.
  function rimActivity (bots) {
    let working = false
    for (const bot of Array.isArray(bots) ? bots : []) {
      if (!bot || bot.paused) continue
      if (bot.waiting || bot.mood === 'waiting') return 'waiting'
      if (bot.mood === 'working') working = true
    }
    return working ? 'working' : 'idle'
  }

  return { dockPath, rimActivity }
})
