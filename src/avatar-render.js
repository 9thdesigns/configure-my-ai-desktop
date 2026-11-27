// Draws a bot's avatar into a box in the widget windows (the dock, its seats,
// quick chat and the island), the way the web app does: the animated CFA
// face when the feed sends one, a picture when it sends that instead, and
// initials on the avatar colour only when there is neither (or the server is
// an older one that sends no `avatar` at all).
//
// Precedence: avatar.image_url > avatar.tree (the CFA face) > initials. An
// older feed (no `avatar`) keeps the old path: avatar_url, then initials.
//
// The CFA markup arrives already sanitised into a tree by main
// (cfa-avatar.js); it is built here with createElement / setAttribute and
// style.setProperty — never innerHTML, never a style attribute — so the
// windows keep their strict CSP. A box is only rebuilt when the face itself
// changes; a new state (idle → working …) is swapped onto the live nodes, so
// the animation carries on instead of restarting.
//
// Performance: animations pause while the window is hidden
// (visibilitychange) and for boxes scrolled out of view
// (IntersectionObserver); with prefers-reduced-motion the face is static.
//
// Loaded by the pages as a plain script (window.CfaAvatar) and by the tests
// with require(): it touches only the document it is given.

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.CfaAvatar = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const SVG_NS = 'http://www.w3.org/2000/svg'
  const STATE_TOKEN = '{state}'
  const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

  const initialsOf = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

  // Dark ink on a light avatar colour, light ink on a dark one.
  function inkFor (hex) {
    const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16))
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#231d1b' : '#ffffff'
  }

  // What to draw for a bot, and the key that says when it must be rebuilt.
  // failedUrl: a picture that already failed to load (skip it).
  function plan (bot, failedUrl = null) {
    const avatar = bot && bot.avatar
    if (avatar && typeof avatar === 'object') {
      const color = avatar.color || bot.avatar_color || null
      const shape = avatar.shape || bot.avatar_shape || 'circle'
      const state = avatar.state || 'idle'
      if (avatar.image_url && avatar.image_url !== failedUrl) {
        return { mode: 'image', key: `image|${avatar.image_url}`, url: avatar.image_url, color, shape, state, name: bot.name }
      }
      if (Array.isArray(avatar.tree) && avatar.tree.length) {
        return { mode: 'cfa', key: `cfa|${avatar.key || JSON.stringify(avatar.tree)}`, tree: avatar.tree, color, shape, state, name: bot.name }
      }
      const initials = avatar.initials || initialsOf(bot.name)
      return { mode: 'initials', key: `initials|${initials}|${color}|${shape}`, initials, color, shape, state, name: bot.name }
    }
    // An older server: no `avatar`, the old fields.
    const color = (bot && bot.avatar_color) || null
    const shape = (bot && bot.avatar_shape) || 'circle'
    const url = bot && bot.avatar_url
    if (url && url !== failedUrl) return { mode: 'image', key: `image|${url}`, url, color, shape, state: null, name: bot && bot.name }
    const initials = initialsOf(bot && bot.name)
    return { mode: 'initials', key: `initials|${initials}|${color}|${shape}`, initials, color, shape, state: null, name: bot && bot.name }
  }

  const fill = (value, state) => value.split(STATE_TOKEN).join(state)

  // The tree → DOM nodes. refs collects the nodes whose attributes or
  // classes carry the state, so it can be swapped later.
  function build (doc, nodes, parent, state, refs) {
    for (const node of nodes) {
      if (typeof node === 'string') {
        parent.append(doc.createTextNode(node))
        continue
      }
      const el = node.ns === 'svg' ? doc.createElementNS(SVG_NS, node.t) : doc.createElement(node.t)
      for (const [name, value] of Object.entries(node.a || {})) {
        if (name === 'xmlns') continue
        if (value.includes(STATE_TOKEN)) {
          if (name === 'class') refs.push({ el, cls: value })
          else refs.push({ el, attr: name, value })
        }
        el.setAttribute(name, fill(value, state))
      }
      // Through the CSSOM, which the CSP allows (a style attribute it would not).
      for (const [prop, value] of Object.entries(node.s || {})) el.style.setProperty(prop, value)
      build(doc, node.c || [], el, state, refs)
      parent.append(el)
    }
  }

  function setState (box, state) {
    const prev = box.dataset.state || ''
    if (!state) {
      delete box.dataset.state
      return
    }
    if (prev === state) return
    box.dataset.state = state
    for (const ref of box._cfaRefs || []) {
      if (ref.attr) {
        ref.el.setAttribute(ref.attr, fill(ref.value, state))
      } else {
        // Swap only the state tokens; any classes the page added stay.
        const before = prev ? fill(ref.cls, prev).split(/\s+/) : []
        const after = fill(ref.cls, state).split(/\s+/)
        for (const t of before) if (t && !after.includes(t)) ref.el.classList.remove(t)
        for (const t of after) if (t) ref.el.classList.add(t)
      }
    }
  }

  // Draws (or updates) the avatar in box. Returns the plan it drew.
  function paint (box, bot) {
    const doc = box.ownerDocument
    const p = plan(bot, box.dataset.failed || null)
    if (box.dataset.key !== p.key) {
      box.dataset.key = p.key
      box.dataset.mode = p.mode
      box.dataset.shape = p.shape
      box._cfaRefs = []
      delete box.dataset.state
      box.replaceChildren()
      if (p.mode === 'cfa') {
        // The face brings its own shape and colour.
        box.style.background = ''
        box.style.color = ''
        box.setAttribute('aria-hidden', 'true')
        build(doc, p.tree, box, p.state, box._cfaRefs)
      } else {
        box.removeAttribute('aria-hidden')
        box.style.background = p.color || ''
        box.style.color = p.color ? inkFor(p.color) : ''
        if (p.mode === 'image') {
          const img = doc.createElement('img')
          img.alt = ''
          img.referrerPolicy = 'no-referrer'
          img.draggable = false
          img.decoding = 'async'
          img.onerror = () => {
            // The face (or the initials) instead of a broken picture.
            box.dataset.failed = p.url
            paint(box, bot)
          }
          img.src = p.url
          box.append(img)
        } else {
          box.textContent = p.initials
        }
      }
    }
    setState(box, p.state)
    if (watcher) watcher.observe(box)
    return p
  }

  // The avatar stylesheet (main fetched and checked it, avatar-css.js), as a
  // constructed sheet: no <style>, no <link>, nothing for the CSP to allow.
  let sheet = null
  let sheetText = null
  function applyCss (doc, text) {
    if (typeof text !== 'string' || text === sheetText) return false
    const View = doc.defaultView
    if (!View || typeof View.CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in doc)) return false
    try {
      if (!sheet) {
        sheet = new View.CSSStyleSheet()
        doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet]
      }
      sheet.replaceSync(text)
      sheetText = text
      return true
    } catch {
      return false
    }
  }

  function prefersReducedMotion (win) {
    try {
      return Boolean(win && typeof win.matchMedia === 'function' && win.matchMedia(REDUCED_MOTION).matches)
    } catch {
      return false
    }
  }

  // Motion and visibility, once per page: data-motion="reduce" on the root
  // for the static face, data-cfa-paused while the window is hidden, and
  // data-offscreen on boxes out of view. The CSS (widget.css / island.css)
  // does the rest.
  let watcher = null
  function watch (win, doc) {
    const rootEl = doc.documentElement
    const motion = () => { rootEl.dataset.motion = prefersReducedMotion(win) ? 'reduce' : 'full' }
    motion()
    try {
      const mq = win.matchMedia(REDUCED_MOTION)
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', motion)
    } catch {}
    const visibility = () => rootEl.toggleAttribute('data-cfa-paused', doc.visibilityState === 'hidden')
    visibility()
    doc.addEventListener('visibilitychange', visibility)
    let io = null
    if (typeof win.IntersectionObserver === 'function') {
      io = new win.IntersectionObserver((entries) => {
        for (const entry of entries) {
          // A box that was thrown away (a re-rendered list) stops being watched.
          if (!entry.target.isConnected) io.unobserve(entry.target)
          else entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting)
        }
      })
    }
    const seen = new WeakSet()
    watcher = {
      observe (box) {
        if (!io || seen.has(box)) return
        seen.add(box)
        io.observe(box)
      },
    }
    return watcher
  }

  return { plan, paint, setState, applyCss, watch, prefersReducedMotion, inkFor, initialsOf, STATE_TOKEN, REDUCED_MOTION }
})
