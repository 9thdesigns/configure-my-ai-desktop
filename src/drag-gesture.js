// Click or drag? The widget pages (the dock, the island) move their window by
// a controlled drag: pointer events here, IPC to main, main moves the window
// (widget-window.js / island-window.js). -webkit-app-region: drag is not
// used: it hands the gesture to the OS, which swallows the clicks on the bots,
// chips and the island bar that sit in the same place.
//
// A press only becomes a drag once the pointer has travelled DRAG_DISTANCE px
// and the press has lasted DRAG_DELAY_MS — or it has travelled FLING_DISTANCE
// px at once (a quick, deliberate throw). Anything less is a tap, and the
// click goes through as usual. After a drag, the click the browser fires on
// release is swallowed, so a drop never opens a bot.
//
// Presses that start on something you type in or select text from (inputs,
// the quick-chat popover, the island's card, [data-no-drag]) never drag, nor
// does any press while text is selected.
//
// Loaded by the pages as a plain script (window.DragGesture) and by the tests
// with require(): the decision logic is pure; attach() wires it to an element.

;(function (root, factory) {
  const api = factory()
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.DragGesture = api
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict'

  const DRAG_DISTANCE = 4
  const DRAG_DELAY_MS = 90
  const FLING_DISTANCE = 12
  const NO_DRAG = 'input, textarea, select, option, [contenteditable=""], [contenteditable="true"], .popover, .card, [data-no-drag]'

  // The decision, from how far the pointer has gone (px) and for how long
  // the button has been down (ms).
  function isDrag (dx, dy, dt, { distance = DRAG_DISTANCE, delay = DRAG_DELAY_MS, fling = FLING_DISTANCE } = {}) {
    const d = Math.hypot(Number(dx) || 0, Number(dy) || 0)
    if (d >= fling) return true
    return d >= distance && Number(dt) >= delay
  }

  // One press, start to finish. Feed it down / move / up; it says when the
  // press became a drag and whether the release was a tap or a drop.
  //   onStart(point), onMove(point), onEnd(point): drag phases, screen coords.
  function createGesture ({ onStart = () => {}, onMove = () => {}, onEnd = () => {}, options = {} } = {}) {
    let press = null // { x, y, t, dragging }
    return {
      get active () { return Boolean(press) },
      get dragging () { return Boolean(press && press.dragging) },
      down ({ x, y, t, button = 0 }) {
        if (button !== 0) return false
        press = { x, y, t, dragging: false }
        return true
      },
      move ({ x, y, t }) {
        if (!press) return 'none'
        if (!press.dragging) {
          if (!isDrag(x - press.x, y - press.y, t - press.t, options)) return 'pending'
          press.dragging = true
          onStart({ x: press.x, y: press.y })
        }
        onMove({ x, y })
        return 'drag'
      },
      // 'tap', 'drop' or 'none'.
      up ({ x, y }) {
        if (!press) return 'none'
        const was = press.dragging
        press = null
        if (!was) return 'tap'
        onEnd({ x, y })
        return 'drop'
      },
      cancel ({ x, y } = {}) {
        if (!press) return
        const was = press.dragging
        const last = { x: x ?? press.x, y: y ?? press.y }
        press = null
        if (was) onEnd(last)
      },
    }
  }

  // Should a press on this target be allowed to start a drag?
  function canStartOn (target, win) {
    if (!target || typeof target.closest !== 'function') return false
    if (target.closest(NO_DRAG)) return false
    const sel = win && typeof win.getSelection === 'function' ? win.getSelection() : null
    if (sel && !sel.isCollapsed && String(sel).length > 0) return false
    return true
  }

  // Wires a gesture to an element. send(phase, screenX, screenY) carries the
  // drag to main; moves are coalesced to one per animation frame.
  function attach (el, send, { win = el.ownerDocument.defaultView, options = {}, onDragChange = () => {} } = {}) {
    let frame = 0
    let last = null
    let pointerId = null
    let swallowClick = false
    const flush = () => {
      frame = 0
      if (last) send('move', last.x, last.y)
    }
    const gesture = createGesture({
      options,
      onStart: (p) => {
        swallowClick = true
        try { el.setPointerCapture(pointerId) } catch {}
        onDragChange(true)
        send('start', p.x, p.y)
      },
      onMove: (p) => {
        last = p
        if (!frame) frame = win.requestAnimationFrame(flush)
      },
      onEnd: (p) => {
        if (frame) win.cancelAnimationFrame(frame)
        frame = 0
        last = null
        send('end', p.x, p.y)
        onDragChange(false)
      },
    })
    const now = () => (win.performance ? win.performance.now() : Date.now())

    el.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !event.isPrimary || !canStartOn(event.target, win)) return
      swallowClick = false
      pointerId = event.pointerId
      gesture.down({ x: event.screenX, y: event.screenY, t: now(), button: event.button })
    })
    el.addEventListener('pointermove', (event) => {
      if (!gesture.active || event.pointerId !== pointerId) return
      if (gesture.move({ x: event.screenX, y: event.screenY, t: now() }) === 'drag') event.preventDefault()
    })
    const finish = (event) => {
      if (!gesture.active || event.pointerId !== pointerId) return
      if (event.type === 'pointercancel') gesture.cancel({ x: event.screenX, y: event.screenY })
      else gesture.up({ x: event.screenX, y: event.screenY })
      try { el.releasePointerCapture(event.pointerId) } catch {}
      pointerId = null
    }
    el.addEventListener('pointerup', finish)
    el.addEventListener('pointercancel', finish)
    el.addEventListener('lostpointercapture', (event) => { if (gesture.dragging) finish({ type: 'pointercancel', pointerId: event.pointerId, screenX: event.screenX, screenY: event.screenY }) })
    // The click that follows a drop is not a click.
    el.addEventListener('click', (event) => {
      if (!swallowClick) return
      swallowClick = false
      event.preventDefault()
      event.stopImmediatePropagation()
    }, true)
    // A drag never selects text or starts a native drag of an image.
    el.addEventListener('dragstart', (event) => event.preventDefault())
    return gesture
  }

  return { DRAG_DISTANCE, DRAG_DELAY_MS, FLING_DISTANCE, NO_DRAG, isDrag, createGesture, canStartOn, attach }
})
