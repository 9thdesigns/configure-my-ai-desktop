// Quick chat's animated composer placeholder, the web app's behaviour
// (configure-my-ai, the composer's typing placeholder):
//
//   * it types each hint a character at a time, always on one line;
//   * while it types, the visible window follows the caret: the text shifts
//     left by data-ph-offset px — the typed width less the room — and that
//     offset never goes back down while a hint is typing;
//   * at rest it shows the whole hint when it fits, else the head cut at a
//     word boundary with a trailing "…" (no fade);
//   * then the next hint, in turn;
//   * reduced motion: one still, fitted line, no typing and no rotation;
//   * the composer never changes height: the placeholder is one fixed line
//     laid over the field (widget.css).
//
// The pure parts (fitAtWord, nextOffset) are unit-tested in node
// (test/typing-placeholder.test.js); the controller runs in the widget page
// (window.TypingPlaceholder, loaded before widget-view.js) and is driven in
// Playwright (test/widget-chat-style.test.js).

(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.TypingPlaceholder = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const TYPE_MS = 45
  const REST_MS = 2600
  const ELLIPSIS = '…'
  const REDUCED = '(prefers-reduced-motion: reduce)'

  // The longest head of `hint`, cut where a word ends, that fits(text) says
  // fits once "…" is added; the whole hint if it fits as it is. A hint that
  // already ends in "…" doesn't get a second one.
  function fitAtWord (hint, fits) {
    if (fits(hint)) return hint
    const base = hint.endsWith(ELLIPSIS) ? hint.slice(0, -1) : hint
    const cuts = []
    for (let i = 1; i < base.length; i++) if (/\s/.test(base[i]) && !/\s/.test(base[i - 1])) cuts.push(i)
    for (let k = cuts.length - 1; k >= 0; k--) {
      const text = base.slice(0, cuts[k]).replace(/[\s,;:.!?-]+$/, '') + ELLIPSIS
      if (fits(text)) return text
    }
    // Not even one word fits: the first, cut by the box.
    return (cuts.length ? base.slice(0, cuts[0]) : base) + ELLIPSIS
  }

  // The window's shift while typing: the typed width past the room, and never
  // less than it was (so the line doesn't jitter back).
  function nextOffset (previous, typedWidth, room) {
    return Math.max(previous || 0, Math.ceil(typedWidth - room), 0)
  }

  // box: the one-line placeholder (overflow hidden); its text goes in an
  // inner span that is shifted by the offset.
  function create (box, { win = window } = {}) {
    let inner = box.querySelector('.compose-placeholder-text')
    if (!inner) {
      inner = box.ownerDocument.createElement('span')
      inner.className = 'compose-placeholder-text'
      box.textContent = ''
      box.append(inner)
    }
    const text = box.ownerDocument.createTextNode('')
    inner.textContent = ''
    inner.append(text)

    let hints = []
    let index = 0
    let typed = 0
    let offset = 0
    let timer = null
    let active = false
    let state = null

    const reduced = () => {
      try {
        return Boolean(win.matchMedia && win.matchMedia(REDUCED).matches)
      } catch {
        return false
      }
    }

    const setText = (value) => { if (text.data !== value) text.data = value }
    const width = () => inner.getBoundingClientRect().width
    const room = () => box.clientWidth

    function setOffset (px) {
      offset = px
      const value = String(px)
      if (box.dataset.phOffset !== value) box.dataset.phOffset = value
      const transform = px ? `translateX(${-px}px)` : ''
      if (inner.style.transform !== transform) inner.style.transform = transform
    }

    function setState (next) {
      state = next
      if (box.dataset.phState !== next) box.dataset.phState = next
    }

    const stop = () => {
      if (timer !== null) win.clearTimeout(timer)
      timer = null
    }

    // At rest: the hint, fitted, from the start of the line.
    function rest (stateName = 'rest') {
      setOffset(0)
      const hint = hints[index] || ''
      setText(fitAtWord(hint, (candidate) => {
        setText(candidate)
        return width() <= room() + 0.5
      }))
      setState(stateName)
    }

    function tick () {
      timer = null
      const hint = hints[index] || ''
      if (typed < hint.length) {
        typed++
        setText(hint.slice(0, typed))
        setOffset(nextOffset(offset, width(), room()))
        setState('typing')
        timer = win.setTimeout(tick, TYPE_MS)
        return
      }
      rest()
      if (hints.length > 1) timer = win.setTimeout(next, REST_MS)
    }

    function next () {
      timer = null
      index = (index + 1) % hints.length
      type()
    }

    function type () {
      stop()
      typed = 0
      setOffset(0)
      setText('')
      timer = win.setTimeout(tick, TYPE_MS)
    }

    // Start (or settle) according to what's wanted now.
    function run () {
      stop()
      if (!hints.length) {
        setOffset(0)
        setText('')
        return
      }
      if (reduced()) {
        index = 0
        return rest('still')
      }
      if (!active) return rest()
      type()
    }

    // The hints for the bot on screen; the same list again changes nothing
    // (state pushes come often).
    function setHints (list) {
      const clean = (Array.isArray(list) ? list : []).filter((h) => typeof h === 'string' && h)
      if (clean.length === hints.length && clean.every((h, i) => h === hints[i])) return
      hints = clean
      index = 0
      run()
    }

    // Typing only while it can be seen: the popover open and the field empty.
    function setActive (on) {
      on = Boolean(on)
      if (on === active) return
      active = on
      run()
    }

    // The room changed (a resize): a line at rest is fitted again.
    function refit () {
      if (state === 'rest' || state === 'still') rest(state)
    }

    try {
      const mq = win.matchMedia(REDUCED)
      if (mq && typeof mq.addEventListener === 'function') mq.addEventListener('change', run)
    } catch {}
    if (typeof win.ResizeObserver === 'function') new win.ResizeObserver(refit).observe(box)

    return { setHints, setActive, refit, get state () { return state }, get offset () { return offset } }
  }

  return { TYPE_MS, REST_MS, fitAtWord, nextOffset, create }
})
