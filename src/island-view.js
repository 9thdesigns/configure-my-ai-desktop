// The island window's page (src/island.html): the status pill and its
// question card. Renders only what main sends over window.cmaIsland
// (src/island-preload.js), every string as text; every action is a request
// to main.

(() => {
  'use strict'

  const api = window.cmaIsland
  if (!api) return

  const $ = (sel) => document.querySelector(sel)
  const island = $('#island')
  const bar = $('[data-role="bar"]')
  const avatar = $('[data-role="avatar"]')
  const nameEl = $('[data-role="name"]')
  const chipEl = $('[data-role="chip"]')
  const card = $('[data-role="card"]')
  const promptEl = $('[data-role="prompt"]')
  const optionsEl = $('[data-role="options"]')
  const other = $('[data-role="other"]')
  const actionsEl = $('[data-role="actions"]')
  const errorEl = $('[data-role="error"]')

  let view = null
  let layout = { expanded: false, focused: false }
  let cardKey
  let selected = new Set()
  let busy = false

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // The bot's avatar — the web app's animated CFA face, its picture, or its
  // initials (src/avatar-render.js decides, and swaps states in place).
  const avatars = window.CfaAvatar
  const paintAvatar = (bot) => avatars.paint(avatar, bot)
  avatars.watch(window, document)
  if (typeof api.onAvatarCss === 'function') api.onAvatarCss((payload) => avatars.applyCss(document, payload && payload.css))

  function reportHeight () {
    requestAnimationFrame(() => {
      api.reportHeight(Math.ceil(island.offsetHeight))
      reportHitRects()
    })
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportHeight).observe(island)

  // Where the window takes the mouse: the pill (and its card) and its
  // shoulders, a few px over; everywhere else in the window clicks through
  // to whatever is underneath.
  const SLACK = 8
  function reportHitRects () {
    if (typeof api.reportHitRects !== 'function') return
    const r = island.getBoundingClientRect()
    api.reportHitRects([{ x: r.left - SLACK, y: r.top - SLACK, width: r.width + SLACK * 2, height: r.height + SLACK * 2 }])
  }
  island.addEventListener('transitionend', reportHitRects)

  const letter = (i) => String.fromCharCode(65 + i)
  const otherText = () => other.value.trim()

  function setError (text) {
    errorEl.hidden = !text
    errorEl.textContent = text || ''
  }

  function button (label, className, onClick) {
    const node = el('button', className, label)
    node.type = 'button'
    node.addEventListener('click', onClick)
    return node
  }

  // The card for what the bot is waiting on — or, when it isn't waiting, the
  // detail line and a way into the app.
  function renderCard () {
    const pending = view?.pending
    const key = pending ? `${view.bot.id}:${pending.kind}:${pending.id}:${pending.actionable}` : `${view?.bot.id}:none:${view?.detail}`
    if (key === cardKey) return
    cardKey = key
    selected = new Set()
    optionsEl.textContent = ''
    actionsEl.textContent = ''
    other.value = ''
    other.hidden = true
    setError(null)
    if (!view) return

    const openButton = button('Open in app', 'btn-link', () => api.openInApp(view.bot.id))

    if (!pending) {
      promptEl.textContent = view.detail || view.chip.label
      actionsEl.append(button('Open', 'btn btn-primary', () => api.openInApp(view.bot.id)))
      return reportHeight()
    }

    promptEl.textContent = pending.prompt

    if (!pending.actionable) {
      actionsEl.append(button(pending.kind === 'approval' ? 'Review in app' : 'Answer in app', 'btn btn-primary', () => api.openInApp(view.bot.id)))
      return reportHeight()
    }

    if (pending.kind === 'approval') {
      actionsEl.append(openButton, button('Decline', 'btn', () => decide('decline')), button('Approve', 'btn btn-primary', () => decide('approve')))
      return reportHeight()
    }

    pending.options.slice(0, 26).forEach((option, index) => {
      const node = el('button', 'option')
      node.type = 'button'
      node.dataset.optionId = option.id
      node.append(el('span', 'option-key', letter(index)), el('span', '', option.label))
      node.addEventListener('click', () => toggle(option.id))
      optionsEl.append(node)
    })
    other.hidden = !pending.allow_other
    const done = button('Done', 'btn btn-primary', () => submit())
    done.dataset.role = 'done'
    actionsEl.append(openButton, button('Skip', 'btn', () => submit({ skip: true })), done)
    updateDone()
    reportHeight()
  }

  function updateDone () {
    const done = actionsEl.querySelector('[data-role="done"]')
    if (done) done.disabled = busy || (selected.size === 0 && !otherText())
  }

  function toggle (id) {
    const pending = view?.pending
    if (!pending || pending.kind !== 'question' || busy) return
    if (selected.has(id)) {
      selected.delete(id)
    } else {
      if (!pending.multiple) selected.clear()
      selected.add(id)
    }
    for (const node of optionsEl.querySelectorAll('.option')) node.classList.toggle('is-selected', selected.has(node.dataset.optionId))
    updateDone()
    if (!pending.multiple && !otherText()) submit()
  }

  function setBusy (on) {
    busy = on
    for (const node of card.querySelectorAll('button')) node.disabled = on
    other.disabled = on
    if (!on) updateDone()
  }

  async function submit ({ skip = false } = {}) {
    const pending = view?.pending
    if (!pending || busy) return
    const text = otherText()
    if (!skip && selected.size === 0 && !text) return
    setBusy(true)
    const ok = await api.answer({ bot_id: view.bot.id, pending_id: pending.id, option_ids: [...selected], text, skip })
    setBusy(false)
    setError(ok ? null : 'Couldn’t send that. Try again, or open in app.')
  }

  async function decide (decision) {
    const pending = view?.pending
    if (!pending || busy) return
    setBusy(true)
    const ok = await api.decide({ bot_id: view.bot.id, pending_id: pending.id, decision })
    setBusy(false)
    setError(ok ? null : 'Couldn’t send that. Try again, or open in app.')
  }

  other.addEventListener('input', updateDone)
  other.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    }
  })

  // Hover opens the card without focus; a click takes focus (for the
  // shortcuts and "Something else").
  island.addEventListener('mouseenter', () => {
    island.classList.add('is-hover')
    hovering = true
    refresh()
    api.hover(true)
  })
  island.addEventListener('mouseleave', () => {
    island.classList.remove('is-hover')
    hovering = false
    refresh()
    api.hover(false)
  })
  bar.addEventListener('click', () => {
    // The idle pill has no card: a click just brings the app forward.
    if (view?.idle) return api.openApp()
    if (layout.focused) api.collapse()
    else api.activate()
  })
  card.addEventListener('mousedown', () => { if (!layout.focused) api.activate() })

  // Drag the pill by its bar or the grabber: main slides it along the edge
  // (or flips it to the other one) and the centre magnet catches it. A tap
  // stays a click (drag-gesture.js); the card, with its text and options,
  // never drags.
  if (window.DragGesture && typeof api.drag === 'function') {
    window.DragGesture.attach(island, (phase, x, y) => api.drag(phase, x, y), {
      onDragChange: (on) => {
        document.documentElement.toggleAttribute('data-dragging', on)
        dragging = on
        refresh()
      },
    })
  }

  // The keyboard's way to move it, with the bar focused: Alt + left / right
  // along the edge, Alt + up / down to the top or bottom edge.
  bar.addEventListener('keydown', (event) => {
    if (!event.altKey || event.metaKey || event.ctrlKey || typeof api.move !== 'function') return
    const input = { ArrowLeft: { step: -1 }, ArrowRight: { step: 1 }, ArrowUp: { edge: 'top' }, ArrowDown: { edge: 'bottom' } }[event.key]
    if (!input) return
    event.preventDefault()
    event.stopPropagation()
    api.move(input)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      api.collapse()
      return
    }
    const pending = view?.pending
    if (document.activeElement === other || !pending || !pending.actionable || event.metaKey || event.ctrlKey || event.altKey) return
    if (pending.kind === 'question') {
      const index = event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) - 65 : -1
      if (index >= 0 && index < Math.min(pending.options.length, 4)) {
        event.preventDefault()
        toggle(pending.options[index].id)
      }
      if (event.key === 'Enter') submit()
    }
  })

  api.onView((next) => {
    if (!next || !next.bot || !next.chip) return
    view = next
    island.dataset.chip = next.chip.kind
    island.classList.toggle('is-idle', next.idle === true)
    paintAvatar(next.bot)
    nameEl.textContent = next.bot.name
    chipEl.textContent = next.chip.label
    bar.setAttribute('aria-label', `${next.bot.name}: ${next.chip.label}`)
    renderCard()
  })

  // The pill's place in the window (island-placement.js): its centre, its
  // compact size, the edge it hangs from, and the notch it wraps. The window
  // never moves while the pill animates: width, the hover growth, the
  // magnet's settle and the grabber are springs on animation frames
  // (motion.js), so a reduced-motion setting makes each one jump.
  const root = document.documentElement
  const grabber = $('[data-role="grabber"]')
  const Motion = window.Motion
  const reducedMotion = () => root.dataset.motion === 'reduce' || Boolean(Motion && Motion.prefersReducedMotion(window))
  const SPRING = {
    shape: { response: 0.42, dampingFraction: 1 }, // the width, opening and closing
    hover: { response: 0.42, dampingFraction: 0.7 }, // the hover growth, the magnet, the grabber widening
    fade: { response: 0.24, dampingFraction: 1 }, // the grabber fading in (most of the way in ~120ms)
  }
  const OPEN_WIDTH = 360
  const HOVER_GROW = 8
  const GRABBER = { width: 28, dragging: 36 }

  // A value that springs to its targets and paints itself; without
  // motion.js (it always ships with the page) it just jumps.
  function live (value, spring, paint, onRest = () => {}) {
    paint(value)
    if (!Motion) return { setTarget: (v) => { paint(v); onRest(v) }, jump: (v) => { paint(v); onRest(v) } }
    return Motion.createSpring({ value, spring, onUpdate: paint, onRest, reduced: reducedMotion })
  }
  // Whole pixels, so the face stays on the pixel grid mid-spring.
  const px = (v) => `${Math.round(v)}px`
  const widthSpring = live(212, SPRING.shape, (v) => island.style.setProperty('--w', px(Math.max(0, v))), reportHitRects)
  const growSpring = live(0, SPRING.hover, (v) => island.style.setProperty('--grow', px(Math.max(0, v))), reportHitRects)
  const nudgeSpring = live(0, SPRING.hover, (v) => island.style.setProperty('--nudge', px(v)))
  const grabOpacity = live(0, SPRING.fade, (v) => { grabber.style.opacity = String(Math.min(Math.max(v, 0), 1)) })
  const grabWidth = live(GRABBER.width, SPRING.hover, (v) => { grabber.style.width = `${v}px` })

  let hovering = false
  let dragging = false
  let pillWidth = 212
  let placed = false
  const focusShown = () => bar.matches(':focus-visible')

  // Where every spring is heading, from what is going on now.
  function refresh () {
    const open = layout.expanded === true
    const lifted = (hovering || dragging) && !open
    widthSpring.setTarget(open ? OPEN_WIDTH : pillWidth)
    growSpring.setTarget(lifted ? HOVER_GROW : 0)
    grabOpacity.setTarget((hovering || dragging || focusShown()) && !open && layout.draggable !== false ? 1 : 0)
    grabWidth.setTarget(dragging ? GRABBER.dragging : GRABBER.width)
  }
  // Keyboard focus shows the grabber too (it is what says "this moves"):
  // checked on focus, and on the first key after a mouse focus.
  bar.addEventListener('focus', refresh)
  bar.addEventListener('blur', refresh)
  bar.addEventListener('keyup', refresh)

  let lastPill = null
  let lastSnapped = false
  function applyPill (pill, snapped) {
    if (!pill || typeof pill !== 'object') return
    const num = (n, lo, hi) => Math.min(Math.max(Number(n) || 0, lo), hi)
    const style = island.style
    style.setProperty('--cx', `${num(pill.centre, 0, 4000)}px`)
    style.setProperty('--pill-h', `${num(pill.height, 20, 60)}px`)
    style.setProperty('--notch-w', `${pill.wrap ? num(pill.notchWidth, 0, 400) : 0}px`)
    pillWidth = num(pill.width, 100, 600)
    const edge = pill.edge === 'bottom' ? 'bottom' : 'top'
    const flipped = lastPill && lastPill.edge !== edge
    island.dataset.edge = edge
    island.toggleAttribute('data-wrap', pill.wrap === true)
    // The magnet caught it, or let it go: main moved the window, so draw
    // the pill where the pointer had it and spring the rest of the way.
    if (lastPill && snapped !== lastSnapped && !flipped) {
      nudgeSpring.jump(num(lastPill.screenX, -1e5, 1e5) - num(pill.screenX, -1e5, 1e5) + nudgeSpring.value)
      nudgeSpring.setTarget(0)
    }
    // To the other edge: it fades up where it lands.
    if (flipped && Motion) Motion.animateSpring(island, SPRING.shape, { property: 'opacity', from: 0.4, to: 1, reduced: reducedMotion() })
    lastPill = pill
    lastSnapped = snapped
  }

  api.onLayout((next) => {
    if (!next) return
    layout = next
    root.toggleAttribute('data-no-drag', next.draggable === false)
    island.classList.toggle('is-expanded', next.expanded)
    card.hidden = !next.expanded
    applyPill(next.pill, next.snapped === true)
    if (!placed && next.pill) {
      // The first place: no motion, just there.
      placed = true
      widthSpring.jump(next.expanded ? OPEN_WIDTH : pillWidth)
    }
    refresh()
    reportHeight()
  })

  api.ready()
})()
