// The ambient state in a page (the dock's, the island's): main's news
// (src/ambient.js — the screen locked, asleep, reduced transparency) and
// the page's own (hidden or covered, the reduced-transparency media query)
// as attributes on the root, for the stylesheets:
//
//   data-ambient="paused"     every animation holds still
//   data-transparency="reduce" solid colours instead of see-through tints
//
// Loaded as a plain script (window.Ambient) and by the tests with require().

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.Ambient = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  // The root's attributes for main's state and the page's own.
  function attributes ({ main = null, hidden = false, mediaTransparency = false } = {}) {
    return {
      ambient: (main && main.paused === true) || hidden ? 'paused' : null,
      transparency: (main && main.transparency === 'reduce') || mediaTransparency ? 'reduce' : null,
    }
  }

  // Wire a page: onAmbient(fn) is its bridge's listener (may be absent).
  function attach (doc, onAmbient) {
    const win = doc.defaultView
    const rootEl = doc.documentElement
    let main = null
    const mq = win && typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-transparency: reduce)') : null
    function apply () {
      const a = attributes({ main, hidden: doc.visibilityState === 'hidden', mediaTransparency: Boolean(mq && mq.matches) })
      if (a.ambient) rootEl.dataset.ambient = a.ambient
      else delete rootEl.dataset.ambient
      if (a.transparency) rootEl.dataset.transparency = a.transparency
      else delete rootEl.dataset.transparency
    }
    doc.addEventListener('visibilitychange', apply)
    if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', apply)
    if (typeof onAmbient === 'function') onAmbient((state) => { main = state && typeof state === 'object' ? state : null; apply() })
    apply()
    return { apply }
  }

  return { attributes, attach }
})
