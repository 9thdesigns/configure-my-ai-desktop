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
  const MODES = ['idle', 'working', 'message', 'question', 'approval', 'recording']
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
      // Open, the window is sized for where the shell is going (its
      // content's full height), not each frame of the spring.
      const clipEl = island.querySelector('.island-clip')
      const menuEl = document.querySelector('[data-role="menu"]')
      let natural = shellOpen && clipEl ? Math.max(island.offsetHeight, clipEl.scrollHeight) : island.offsetHeight
      // An open actions menu hangs below the island (top edge): room for it.
      if (menuEl && !menuEl.hidden) for (const m of document.querySelectorAll('.menu:not([hidden])')) natural = Math.max(natural, m.offsetTop + m.offsetHeight + 8)
      api.reportHeight(Math.ceil(natural))
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
    const rects = [{ x: r.left - SLACK, y: r.top - SLACK, width: r.width + SLACK * 2, height: r.height + SLACK * 2 }]
    for (const m of document.querySelectorAll('.menu:not([hidden])')) {
      const b = m.getBoundingClientRect()
      rects.push({ x: b.left - SLACK, y: b.top - SLACK, width: b.width + SLACK * 2, height: b.height + SLACK * 2 })
    }
    api.reportHitRects(rects)
  }
  island.addEventListener('transitionend', reportHitRects)

  const letter = (i) => String.fromCharCode(65 + i)

  // 16px line icons, drawn here (no assets): name → path data.
  const ICONS = {
    camera: 'M2.5 5.5h2.2l1.1-1.7h4.4l1.1 1.7h2.2v7h-11z M8 11a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
    display: 'M2 3.5h12v8H2z M6 14h4 M8 11.5V14',
    window: 'M2 3h12v10H2z M2 6h12',
    crop: 'M4.5 1.5v10h10 M1.5 4.5h10v10',
    record: 'M8 13.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11z M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    share: 'M8 2v8 M4.75 5.25 8 2l3.25 3.25 M3 9.5v4h10v-4',
    clip: 'M10.5 4.5 5.6 9.4a1.4 1.4 0 0 0 2 2l5-5a2.8 2.8 0 0 0-4-4l-5 5a4.2 4.2 0 0 0 6 6l4.4-4.4',
    mic: 'M6 3.25a2 2 0 0 1 4 0V8a2 2 0 0 1-4 0z M3.5 7.5a4.5 4.5 0 0 0 9 0 M8 12v2.25',
    open: 'M9 2.5h4.5V7 M13.5 2.5 7.5 8.5 M11.5 9.5v4h-9v-9h4',
    close: 'M4.5 4.5l7 7 M11.5 4.5l-7 7',
  }
  const SVG = 'http://www.w3.org/2000/svg'
  function icon (name, className = 'menu-icon') {
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('class', className)
    svg.setAttribute('aria-hidden', 'true')
    const p = document.createElementNS(SVG, 'path')
    p.setAttribute('d', ICONS[name] || '')
    p.setAttribute('fill', 'none')
    p.setAttribute('stroke', 'currentColor')
    p.setAttribute('stroke-width', '1.4')
    p.setAttribute('stroke-linecap', 'round')
    p.setAttribute('stroke-linejoin', 'round')
    svg.append(p)
    return svg
  }

  // mm:ss (h:mm:ss past an hour): recorder.js clock().
  function clockText (ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const sec = total % 60
    const two = (n) => String(n).padStart(2, '0')
    return h ? `${h}:${two(m)}:${two(sec)}` : `${two(m)}:${two(sec)}`
  }

  // The chip: the state's label, or while recording the label and a timer
  // that counts on from what main said (a fake clock in the tests).
  let recTimer = 0
  function renderChip (v) {
    clearInterval(recTimer)
    recTimer = 0
    if (!v.recording) {
      chipEl.textContent = v.chip.label
      return
    }
    const base = performance.now() - (Number(v.recording.elapsedMs) || 0)
    const label = el('span', 'chip-label', v.chip.label)
    const time = el('span', 'chip-timer', clockText(performance.now() - base))
    time.setAttribute('role', 'timer')
    chipEl.replaceChildren(label, time)
    recTimer = setInterval(() => { time.textContent = clockText(performance.now() - base) }, 250)
  }
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
  // A click on the bar opens the Manager composer (whatever the state);
  // a second click closes it again. While recording, it stops.
  bar.addEventListener('click', () => {
    if (view?.recording && typeof api.stopRecording === 'function') return api.stopRecording()
    if (layout.composing || (layout.expanded && layout.focused)) return closeOpen()
    api.compose()
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
      closeOpen()
      return
    }
    const pending = view?.pending
    if (layout.composing || document.activeElement === other || !pending || !pending.actionable || event.metaKey || event.ctrlKey || event.altKey) return
    if (pending.kind === 'question') {
      const index = event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) - 65 : -1
      if (index >= 0 && index < Math.min(pending.options.length, 4)) {
        event.preventDefault()
        toggle(pending.options[index].id)
      }
      if (event.key === 'Enter') submit()
    }
  })

  let shownMode = null
  api.onView((next) => {
    if (!next || !next.bot || !next.chip) return
    const mode = MODES.includes(next.mode) ? next.mode : 'idle'
    // A new state (or a new bot in the same state): swap the content.
    if (shownMode !== null && (mode !== shownMode || next.bot.id !== view?.bot.id || next.chip.label !== view?.chip.label)) startSwap()
    shownMode = mode
    view = next
    island.dataset.mode = mode
    island.dataset.chip = next.chip.kind
    island.classList.toggle('is-idle', next.idle === true)
    paintAvatar(next.bot)
    nameEl.textContent = next.bot.name
    renderChip(next)
    bar.setAttribute('aria-label', `${next.bot.name}: ${next.chip.label}`)
    renderBadge(next)
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
  const HOVER_GROW = 8 // taller, away from the edge (room for the grabber)
  const HOVER_WIDEN = 32 // and wider
  const GRABBER = { width: 28, dragging: 36 }
  // Hovered, the avatar grows to 1.2x and moves 10px out (toward the pill's
  // end) and 4px away from the edge.
  const AVATAR_LIFT = { scale: 0.2, out: 10, down: 4 }

  // A value that springs to its targets and paints itself; without
  // motion.js (it always ships with the page) it just jumps.
  function live (value, spring, paint, onRest = () => {}) {
    paint(value)
    if (!Motion) return { setTarget: (v) => { paint(v); onRest(v) }, jump: (v) => { paint(v); onRest(v) }, setSpring () {}, stop () {}, value }
    return Motion.createSpring({ value, spring, onUpdate: paint, onRest, reduced: reducedMotion })
  }
  // Whole pixels, so the face stays on the pixel grid mid-spring.
  const px = (v) => `${Math.round(v)}px`
  const widthSpring = live(212, SPRING.shape, (v) => island.style.setProperty('--w', px(Math.max(0, v))), reportHitRects)
  const growSpring = live(0, SPRING.hover, (v) => island.style.setProperty('--grow', px(Math.max(0, v))), reportHitRects)
  const nudgeSpring = live(0, SPRING.hover, (v) => island.style.setProperty('--nudge', px(v)))
  const grabOpacity = live(0, SPRING.fade, (v) => { grabber.style.opacity = String(Math.min(Math.max(v, 0), 1)) })
  const grabWidth = live(GRABBER.width, SPRING.hover, (v) => { grabber.style.width = `${v}px` })
  const avatarWrap = $('[data-role="avatar-wrap"]')
  const avatarLift = live(0, SPRING.hover, (v) => {
    // No transform at rest: a transformed box puts the face off the pixel grid.
    if (Math.abs(v) < 0.001) { avatarWrap.style.transform = ''; return }
    const away = island.dataset.edge === 'bottom' ? -1 : 1
    avatarWrap.style.transform = `translate(${(-AVATAR_LIFT.out * v).toFixed(2)}px, ${(away * AVATAR_LIFT.down * v).toFixed(2)}px) scale(${(1 + AVATAR_LIFT.scale * v).toFixed(4)})`
  })

  let hovering = false
  let dragging = false
  let pillWidth = 212
  let placed = false
  const focusShown = () => bar.matches(':focus-visible')

  // Where every spring is heading, from what is going on now.
  function refresh () {
    const open = shellOpen
    const lifted = (hovering || dragging) && !open
    widthSpring.setTarget(open ? (openSection === compose ? COMPOSE_WIDTH : OPEN_WIDTH) : pillWidth + (lifted ? HOVER_WIDEN : 0))
    growSpring.setTarget(lifted ? HOVER_GROW : 0)
    avatarLift.setTarget(lifted ? 1 : 0)
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

  // --- The mode swap: a change of state (idle → working → a message …)
  // takes the old content out over SWAP_OUT_MS — fading, shrinking to
  // 0.985 and blurring 4px — while the width springs to its new size, then
  // springs the new content in from 0.965 with the blur clearing. Frames
  // run on requestAnimationFrame (a fake clock in the tests); with reduced
  // motion the content simply changes.
  const content = $('[data-role="content"]')
  const SWAP_OUT_MS = 160
  const SWAP_OUT = { scale: 0.985, blur: 4 }
  const SWAP_IN = { from: 0.965, blur: 4, spring: { response: 0.42, dampingFraction: 1 } }
  let ghost = null
  let swapFrame = 0
  let swapIn = null

  const look = (el, { opacity, scale, blur }) => {
    el.style.opacity = opacity >= 0.999 ? '' : String(Math.max(0, opacity))
    el.style.transform = scale === 1 ? '' : `scale(${scale.toFixed(4)})`
    el.style.filter = blur < 0.05 ? '' : `blur(${blur.toFixed(2)}px)`
  }

  function endSwap () {
    if (swapFrame) cancelAnimationFrame(swapFrame)
    swapFrame = 0
    if (swapIn) swapIn.stop()
    swapIn = null
    if (ghost) ghost.remove()
    ghost = null
    look(content, { opacity: 1, scale: 1, blur: 0 })
  }

  // Call before the new content is painted into the bar.
  function startSwap () {
    endSwap()
    if (reducedMotion() || !Motion) return
    ghost = content.cloneNode(true)
    ghost.classList.add('bar-ghost')
    ghost.removeAttribute('data-role')
    ghost.setAttribute('aria-hidden', 'true')
    for (const n of ghost.querySelectorAll('[data-role]')) n.removeAttribute('data-role')
    Object.assign(ghost.style, { left: `${content.offsetLeft}px`, top: `${content.offsetTop}px`, width: `${content.offsetWidth}px`, height: `${content.offsetHeight}px` })
    bar.append(ghost)
    look(content, { opacity: 0, scale: SWAP_IN.from, blur: SWAP_IN.blur })
    const t0 = performance.now()
    const out = () => {
      const t = Math.min(1, (performance.now() - t0) / SWAP_OUT_MS)
      if (ghost) look(ghost, { opacity: 1 - t, scale: 1 - (1 - SWAP_OUT.scale) * t, blur: SWAP_OUT.blur * t })
      if (t < 1) { swapFrame = requestAnimationFrame(out); return }
      swapFrame = 0
      if (ghost) ghost.remove()
      ghost = null
      swapIn = Motion.createSpring({
        value: 0,
        spring: SWAP_IN.spring,
        reduced: reducedMotion,
        onUpdate: (p) => look(content, { opacity: Math.min(1, p), scale: SWAP_IN.from + (1 - SWAP_IN.from) * p, blur: SWAP_IN.blur * Math.max(0, 1 - p) }),
        onRest: () => { swapIn = null; look(content, { opacity: 1, scale: 1, blur: 0 }) },
      })
      swapIn.setTarget(1)
    }
    swapFrame = requestAnimationFrame(out)
  }

  // The avatar's badge: DX2's jelly badge (window.CmaJellyBadge, once the
  // dock ships it) paints the count; without it the island shows none, as
  // before.
  const badgeSlot = $('[data-role="badge"]')
  function renderBadge (v) {
    const jelly = window.CmaJellyBadge
    const count = Math.max(0, Math.trunc(Number(v && v.badge)) || 0)
    if (!jelly || typeof jelly.paint !== 'function') { badgeSlot.hidden = true; return }
    badgeSlot.hidden = count === 0
    jelly.paint(badgeSlot, { count, mode: v.mode })
  }

  // --- Opening and closing -------------------------------------------------
  // Open: the shell springs out (open .42/1) to the card (360) or the
  // composer (440) — width, height, corners 16→24, shoulders 6→18 — and
  // 90ms later its rows come in one after another (0/40/80ms, .34/.88),
  // blur clearing. Closing (Esc, a click away): the rows go first (280ms),
  // then the shell (close .45/1), about 540ms in all; main keeps the window
  // open-sized until then. Reduced motion: 150ms opacity fades, no springs.
  const clip = $('.island-clip')
  const compose = $('[data-role="compose"]')
  const COMPOSE_WIDTH = 440
  const SPRING_OPEN = { response: 0.42, dampingFraction: 1 }
  const SPRING_CLOSE = { response: 0.45, dampingFraction: 1 }
  const SPRING_CONTENT = { response: 0.34, dampingFraction: 0.88 }
  const CONTENT_DELAY_MS = 90
  const ROW_STAGGER_MS = 40
  const CONTENT_EXIT_MS = 280
  const FADE_MS = 150
  const CORNER = { open: 24 }
  const SHOULDER = { compact: 6, open: 18 }
  let shellOpen = false
  let openSection = null
  let contentOut = false
  let exiting = null
  let heightRun = null
  let rowTimers = []
  let rowSprings = []

  const openness = live(0, SPRING_OPEN, (p) => {
    const q = Math.min(Math.max(p, 0), 1)
    if (q < 0.001) {
      island.style.removeProperty('--radius')
      island.style.removeProperty('--shoulder')
      return
    }
    const base = island.hasAttribute('data-wrap') ? 14 : 16
    island.style.setProperty('--radius', `${(base + (CORNER.open - base) * q).toFixed(2)}px`)
    island.style.setProperty('--shoulder', `${(SHOULDER.compact + (SHOULDER.open - SHOULDER.compact) * q).toFixed(2)}px`)
  })

  // Time-based frames (the fake clock in the tests drives these too).
  function tween (ms, paint) {
    return new Promise((resolve) => {
      const t0 = performance.now()
      const step = () => {
        const t = Math.min(1, Math.max(0, (performance.now() - t0) / ms))
        paint(t)
        if (t < 1) requestAnimationFrame(step)
        else resolve()
      }
      requestAnimationFrame(step)
    })
  }

  const rowsOf = (section) => (section ? [...section.children].filter((n) => !n.hidden && n.getClientRects().length > 0) : [])

  function cancelRows () {
    for (const t of rowTimers) clearTimeout(t)
    for (const sp of rowSprings) sp.stop()
    rowTimers = []
    rowSprings = []
  }

  function runHeight (from, to, spring, done) {
    if (heightRun) heightRun.stop()
    heightRun = null
    if (!Motion || reducedMotion() || Math.abs(from - to) < 1) {
      clip.style.height = ''
      done()
      return
    }
    clip.style.height = px(from)
    heightRun = Motion.createSpring({
      value: from,
      spring,
      reduced: reducedMotion,
      onUpdate: (h) => { clip.style.height = px(Math.max(0, h)) },
      onRest: () => { heightRun = null; done() },
    })
    heightRun.setTarget(to)
  }

  function naturalHeight () {
    const was = clip.style.height
    clip.style.height = ''
    const h = clip.offsetHeight
    clip.style.height = was
    return h
  }

  // Bumped on every open: a close still fading out the old content must not
  // touch the content that is coming back in.
  let shellGen = 0
  let closedByMain = false

  function openShell (section) {
    cancelRows()
    shellGen++
    closedByMain = false
    exiting = null
    contentOut = false
    const from = clip.offsetHeight
    for (const s of [card, compose]) s.hidden = s !== section
    openSection = section
    shellOpen = true
    const rows = rowsOf(section)
    widthSpring.setSpring(SPRING_OPEN)
    openness.setSpring(SPRING_OPEN)
    openness.setTarget(1)
    if (reducedMotion() || !Motion) {
      for (const row of rows) look(row, { opacity: 1, scale: 1, blur: 0 })
      clip.style.height = ''
      section.style.opacity = '0'
      tween(FADE_MS, (t) => { section.style.opacity = t >= 1 ? '' : String(t) })
    } else {
      for (const row of rows) look(row, { opacity: 0, scale: 1, blur: SWAP_IN.blur })
      runHeight(from, naturalHeight(), SPRING_OPEN, () => { if (shellOpen) clip.style.height = '' })
      rows.forEach((row, i) => {
        rowTimers.push(setTimeout(() => {
          const sp = Motion.createSpring({
            value: 0,
            spring: SPRING_CONTENT,
            reduced: reducedMotion,
            onUpdate: (p) => look(row, { opacity: Math.min(1, p), scale: 1, blur: SWAP_IN.blur * Math.max(0, 1 - p) }),
            onRest: () => look(row, { opacity: 1, scale: 1, blur: 0 }),
          })
          rowSprings.push(sp)
          sp.setTarget(1)
        }, CONTENT_DELAY_MS + i * ROW_STAGGER_MS))
      })
    }
    if (section === compose && layout.focused) {
      rowTimers.push(setTimeout(() => composeEls.input.focus(), reducedMotion() ? 0 : CONTENT_DELAY_MS))
    }
  }

  // The rows leave together over CONTENT_EXIT_MS (fading, blurring).
  function exitContent () {
    if (exiting) return exiting
    cancelRows()
    const rows = rowsOf(openSection)
    const ms = reducedMotion() || !Motion ? FADE_MS : CONTENT_EXIT_MS
    const gen = shellGen
    exiting = tween(ms, (t) => {
      if (gen !== shellGen) return
      for (const row of rows) look(row, { opacity: 1 - t, scale: 1, blur: reducedMotion() ? 0 : SWAP_OUT.blur * t })
    }).then(() => { if (gen === shellGen) contentOut = true })
    return exiting
  }

  function closeShell () {
    if (!shellOpen) return
    shellOpen = false
    const from = clip.offsetHeight
    const to = bar.offsetHeight
    widthSpring.setSpring(SPRING_CLOSE)
    openness.setSpring(SPRING_CLOSE)
    openness.setTarget(0)
    refresh()
    runHeight(from, to, SPRING_CLOSE, () => {
      if (shellOpen) return
      for (const s of [card, compose]) {
        s.hidden = true
        s.style.opacity = ''
        for (const row of rowsOf(s)) look(row, { opacity: 1, scale: 1, blur: 0 })
      }
      for (const row of [...card.children, ...compose.children]) look(row, { opacity: 1, scale: 1, blur: 0 })
      openSection = null
      exiting = null
      contentOut = false
      clip.style.height = ''
      widthSpring.setSpring(SPRING.shape)
      reportHeight()
    })
  }

  // Esc, or a second click: the content out first, then main closes the
  // shell (cma-island:layout with expanded false).
  function closeOpen () {
    if (!layout.expanded) return api.collapse()
    const gen = shellGen
    exitContent().then(() => { if (gen === shellGen) api.collapse() })
  }

  // --- The Manager composer --------------------------------------------------
  const composeEls = {
    avatar: $('[data-role="manager-avatar"]'),
    name: $('[data-role="manager-name"]'),
    lines: $('[data-role="lines"]'),
    form: $('[data-role="composer"]'),
    input: $('[data-role="input"]'),
    mic: $('[data-role="mic"]'),
    send: $('[data-role="send"]'),
    open: $('[data-role="compose-open"]'),
    actions: $('[data-role="compose-actions"]'),
  }
  const COMPOSE_ERRORS = {
    send: 'Couldn’t send that. Try again, or open in app.',
    timeout: 'No reply yet. Open in app to keep going.',
  }
  let composerState = null
  let sending = false
  let replyEl = null
  let replyId = null
  let revealFrame = 0

  const line = (className, text) => el('p', className, text)

  function typingDots () {
    const node = el('span', 'compose-typing')
    node.setAttribute('aria-label', 'The Manager is replying')
    node.append(el('span'), el('span'), el('span'))
    return node
  }

  // The reply comes in as if typed (there is no token stream to follow):
  // at least 90 characters a second, never more than ~1.5s in all. Reduced
  // motion: all at once.
  function reveal (node, text) {
    cancelAnimationFrame(revealFrame)
    if (reducedMotion()) { node.textContent = text; return }
    const rate = Math.max(90, text.length / 1.5)
    const t0 = performance.now()
    node.textContent = ''
    const step = () => {
      const n = Math.min(text.length, Math.ceil(((performance.now() - t0) / 1000) * rate))
      node.textContent = text.slice(0, n)
      reportHeight()
      if (n < text.length) revealFrame = requestAnimationFrame(step)
    }
    revealFrame = requestAnimationFrame(step)
  }

  function updateComposerButtons () {
    const hasText = composeEls.input.value.trim().length > 0 || Boolean(composerState?.attachments?.screenshot) || Boolean(composerState?.attachments?.file)
    composeEls.send.hidden = !hasText
    composeEls.mic.hidden = hasText
    composeEls.send.disabled = sending || Boolean(composerState?.awaiting)
  }

  function renderComposer (cv) {
    if (!cv || typeof cv !== 'object') return
    composerState = cv
    if (cv.manager) {
      avatars.paint(composeEls.avatar, cv.manager)
      composeEls.name.textContent = cv.manager.name || 'Manager'
    }
    const nodes = []
    if (!cv.sent) {
      for (const l of Array.isArray(cv.lines) ? cv.lines : []) nodes.push(line('compose-line', l.body))
      replyEl = null
      replyId = null
    } else {
      nodes.push(line('compose-line is-sent', cv.sent.body))
      if (cv.reply) {
        if (cv.reply.id !== replyId || !replyEl) {
          replyId = cv.reply.id
          replyEl = line('compose-line is-reply', '')
          reveal(replyEl, cv.reply.body)
        }
        nodes.push(replyEl)
      } else if (cv.awaiting) {
        nodes.push(typingDots())
      }
    }
    if (cv.error && COMPOSE_ERRORS[cv.error]) nodes.push(line('compose-line is-error', COMPOSE_ERRORS[cv.error]))
    composeEls.lines.replaceChildren(...nodes)
    renderAttachments(cv.attachments || {}, cv.revealLabel || 'Show in Folder')
    updateComposerButtons()
    reportHeight()
  }
  if (typeof api.onComposer === 'function') api.onComposer(renderComposer)

  async function sendComposed () {
    const text = composeEls.input.value.trim()
    const attached = Boolean(composerState?.attachments?.screenshot || composerState?.attachments?.file)
    if ((!text && !attached) || sending || composerState?.awaiting) return
    sending = true
    updateComposerButtons()
    const ok = await api.send(text)
    sending = false
    if (ok) composeEls.input.value = ''
    updateComposerButtons()
  }
  composeEls.form.addEventListener('submit', (event) => {
    event.preventDefault()
    sendComposed()
  })
  composeEls.input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault()
      sendComposed()
    }
  })
  composeEls.input.addEventListener('input', updateComposerButtons)
  // Dictation happens in the app's composer, where the microphone works.
  composeEls.mic.addEventListener('click', () => api.openInApp('manager'))
  composeEls.open.addEventListener('click', () => api.openInApp('manager'))
  // --- Attachments: the chips under the Manager's lines ---------------------
  const attachEl = $('[data-role="attach"]')
  function chipX (what, label) {
    const x = el('button', 'chip-x')
    x.type = 'button'
    x.setAttribute('aria-label', label)
    x.append(icon('close'))
    x.addEventListener('click', () => api.attachment('remove', what))
    return x
  }
  function revealButton (what, label) {
    const b = el('button', 'btn-link', label)
    b.type = 'button'
    b.addEventListener('click', () => api.attachment('reveal', what))
    return b
  }
  function renderAttachments (a, revealLabel) {
    const nodes = []
    if (a.screenshot) {
      const row = el('div', 'chip-row')
      if (a.screenshot.preview) {
        const img = el('img')
        img.alt = ''
        img.src = a.screenshot.preview
        row.append(img)
      }
      row.append(el('span', 'chip-text', a.screenshot.source === 'window' ? 'Screenshot of a window' : 'Screenshot'), chipX('screenshot', 'Remove the screenshot'))
      nodes.push(row)
    }
    if (a.file) {
      const row = el('div', 'chip-row')
      row.append(icon('clip'), el('span', 'chip-text', a.file.name), revealButton('file', revealLabel), chipX('file', 'Remove the file'))
      row.title = a.file.shown
      nodes.push(row)
      nodes.push(el('p', 'chip-hint', a.file.readable
        ? 'Sends where the file is, not the file. The Manager asks before opening it.'
        : 'Turn on Computer → Allow Bots to Ask to Use This Computer so the Manager can open it.'))
    }
    if (a.saved) {
      const row = el('div', 'chip-row')
      const what = a.saved.kind === 'voice' ? 'Voice note saved' : 'Screen recording saved'
      row.append(icon(a.saved.kind === 'voice' ? 'mic' : 'record'), el('span', 'chip-text', `${what} · ${clockText(a.saved.durationMs)}`), revealButton('saved', revealLabel), chipX('saved', 'Dismiss'))
      row.title = a.saved.name
      nodes.push(row)
      nodes.push(el('p', 'chip-hint', 'Kept on this computer: the Manager can’t receive recordings yet.'))
    }
    if (a.notice) {
      const row = el('div', 'notice')
      row.setAttribute('role', 'status')
      row.append(el('p', '', a.notice.message))
      if (a.notice.turnOn) {
        const b = el('button', 'btn', 'Turn on')
        b.type = 'button'
        b.addEventListener('click', () => api.attachment('turn-on', 'notice'))
        row.append(b)
      }
      if (a.notice.settings) {
        const b = el('button', 'btn', 'Open Settings')
        b.type = 'button'
        b.addEventListener('click', () => api.attachment('settings', 'notice'))
        row.append(b)
      }
      row.append(chipX('notice', 'Dismiss'))
      nodes.push(row)
    }
    attachEl.replaceChildren(...nodes)
  }

  // --- The actions menu ("+") -------------------------------------------------
  // The same items as island-actions.js MENU (test/island-actions.test.js
  // keeps the two in step). Main runs them; the page only names one.
  const MENU = [
    { id: 'screenshot', label: 'Screenshot', key: 'S', icon: 'camera', submenu: [
      { id: 'screenshot-display', label: 'Whole screen', key: 'W', icon: 'display' },
      { id: 'screenshot-window', label: 'This window', key: 'T', icon: 'window' },
      { id: 'screenshot-area', label: 'Select area', key: 'A', icon: 'crop' },
    ] },
    { id: 'record', label: 'Record screen', key: 'R', icon: 'record' },
    { id: 'share', label: 'Share what’s on screen with Manager', key: 'H', icon: 'share' },
    { id: 'attach', label: 'Attach file', key: 'F', icon: 'clip' },
    { id: 'voice', label: 'Voice note', key: 'V', icon: 'mic' },
    { id: 'open-app', label: 'Open Manager in app', key: 'O', icon: 'open' },
  ]
  const MENU_MS = 160
  const menuEl = $('[data-role="menu"]')
  const trigger = composeEls.actions
  let subEl = null
  let menuBusy = false

  function buildMenu (root, items, { sub = false } = {}) {
    root.replaceChildren()
    root.classList.toggle('is-sub', sub)
    for (const item of items) {
      const b = el('button', 'menu-item')
      b.type = 'button'
      b.setAttribute('role', 'menuitem')
      b.tabIndex = -1
      b.dataset.action = item.id
      b.dataset.key = item.key
      const key = el('span', 'menu-key', item.submenu ? '›' : item.key)
      key.setAttribute('aria-hidden', 'true')
      b.append(icon(item.icon, 'menu-icon'), el('span', 'menu-label', item.label), key)
      if (item.submenu) {
        b.setAttribute('aria-haspopup', 'menu')
        b.setAttribute('aria-expanded', 'false')
        b.setAttribute('aria-keyshortcuts', item.key)
        b.addEventListener('click', () => openSub(b, item.submenu))
      } else {
        b.setAttribute('aria-keyshortcuts', item.key)
        b.addEventListener('click', () => choose(item.id))
      }
      root.append(b)
    }
  }

  const itemsOf = (root) => [...root.querySelectorAll('.menu-item')]

  // Grow from the corner nearest the trigger: 0.96 → 1 and fading in.
  function grow (root, origin) {
    root.style.transformOrigin = origin
    if (reducedMotion() || !Motion) {
      root.style.opacity = '0'
      return tween(FADE_MS, (t) => { root.style.opacity = t >= 1 ? '' : String(t) })
    }
    root.style.opacity = '0'
    root.style.transform = 'scale(0.96)'
    return tween(MENU_MS, (t) => {
      const e = 1 - Math.pow(1 - t, 3)
      root.style.opacity = t >= 1 ? '' : String(e)
      root.style.transform = t >= 1 ? '' : `scale(${(0.96 + 0.04 * e).toFixed(4)})`
    })
  }

  function placeMenu () {
    const ir = island.getBoundingClientRect()
    const tr = trigger.getBoundingClientRect()
    const up = island.dataset.edge === 'bottom'
    menuEl.style.left = `${Math.round(tr.left - ir.left)}px`
    if (up) {
      menuEl.style.top = ''
      menuEl.style.bottom = `${Math.round(ir.bottom - tr.top + 6)}px`
    } else {
      menuEl.style.bottom = ''
      menuEl.style.top = `${Math.round(tr.bottom - ir.top + 6)}px`
    }
    return up ? 'bottom left' : 'top left'
  }

  function openMenu ({ focusFirst = true } = {}) {
    if (!menuEl.hidden || !layout.composing) return
    buildMenu(menuEl, MENU)
    menuEl.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    grow(menuEl, placeMenu())
    if (focusFirst) itemsOf(menuEl)[0]?.focus()
    reportHeight()
  }

  function closeSub () {
    if (!subEl) return
    subEl.remove()
    subEl = null
    for (const b of itemsOf(menuEl)) if (b.hasAttribute('aria-expanded')) b.setAttribute('aria-expanded', 'false')
  }

  function closeMenu ({ refocus = true } = {}) {
    if (menuEl.hidden) return
    closeSub()
    menuEl.hidden = true
    menuEl.style.transform = ''
    menuEl.style.opacity = ''
    trigger.setAttribute('aria-expanded', 'false')
    if (refocus) trigger.focus()
    reportHeight()
  }

  function openSub (owner, items) {
    if (subEl) return itemsOf(subEl)[0]?.focus()
    subEl = el('div', 'menu')
    subEl.setAttribute('role', 'menu')
    subEl.setAttribute('aria-label', owner.querySelector('.menu-label').textContent)
    subEl.dataset.noDrag = ''
    buildMenu(subEl, items, { sub: true })
    island.append(subEl)
    owner.setAttribute('aria-expanded', 'true')
    const up = island.dataset.edge === 'bottom'
    const ir = island.getBoundingClientRect()
    const or = owner.getBoundingClientRect()
    const mr = menuEl.getBoundingClientRect()
    subEl.style.left = `${Math.round(mr.right - ir.left - 4)}px`
    subEl.style.top = `${Math.round(or.top - ir.top - 7)}px`
    grow(subEl, up ? 'bottom left' : 'top left')
    itemsOf(subEl)[0]?.focus()
    reportHeight()
  }

  async function choose (id) {
    if (menuBusy) return
    menuBusy = true
    closeMenu({ refocus: false })
    try {
      await api.action(id)
    } finally {
      menuBusy = false
      if (layout.composing) composeEls.input.focus()
    }
  }

  trigger.addEventListener('click', (event) => {
    event.preventDefault()
    if (menuEl.hidden) openMenu({ focusFirst: event.detail === 0 })
    else closeMenu()
  })
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      openMenu()
    }
  })

  // Keys inside the menus: arrows move, → opens the submenu, ← or Esc goes
  // back, Enter or Space picks, a row's letter picks it, Tab leaves.
  function onMenuKey (event) {
    const root = event.target.closest('.menu')
    if (!root) return
    const items = itemsOf(root)
    const i = items.indexOf(document.activeElement)
    const isSub = root !== menuEl
    const move = (to) => { event.preventDefault(); items[(to + items.length) % items.length]?.focus() }
    if (event.key === 'ArrowDown') return move(i + 1)
    if (event.key === 'ArrowUp') return move(i - 1)
    if (event.key === 'Home') return move(0)
    if (event.key === 'End') return move(items.length - 1)
    if (event.key === 'ArrowRight' && !isSub && items[i]?.hasAttribute('aria-haspopup')) { event.preventDefault(); return items[i].click() }
    if ((event.key === 'ArrowLeft' || event.key === 'Escape') && isSub) {
      event.preventDefault()
      event.stopPropagation()
      const owner = itemsOf(menuEl).find((b) => b.hasAttribute('aria-haspopup'))
      closeSub()
      return owner?.focus()
    }
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); return closeMenu() }
    if (event.key === 'Tab') return closeMenu({ refocus: false })
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); return items[i]?.click() }
    if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      const hit = items.find((b) => b.dataset.key === event.key.toUpperCase())
      if (hit) { event.preventDefault(); hit.focus(); hit.click() }
    }
  }
  island.addEventListener('keydown', onMenuKey, true)
  // A click anywhere else closes it.
  document.addEventListener('pointerdown', (event) => {
    if (menuEl.hidden || event.target.closest('.menu') || trigger.contains(event.target)) return
    closeMenu({ refocus: false })
  })

  // The web app's chat tokens: a constructed sheet, adopted after island.css
  // (nothing for the CSP to allow).
  let chatSheet = null
  function applyChatCss (text) {
    if (typeof text !== 'string' || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in document)) return
    try {
      if (!chatSheet) {
        chatSheet = new CSSStyleSheet()
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, chatSheet]
      }
      chatSheet.replaceSync(text)
    } catch {}
  }
  if (typeof api.onChatCss === 'function') api.onChatCss((payload) => applyChatCss(payload && payload.css))

  api.onLayout((next) => {
    if (!next) return
    layout = next
    root.toggleAttribute('data-no-drag', next.draggable === false)
    island.classList.toggle('is-expanded', next.expanded)
    island.classList.toggle('is-composing', next.composing === true)
    applyPill(next.pill, next.snapped === true)
    if (!placed && next.pill) {
      // The first place: no motion, just there.
      placed = true
      widthSpring.jump(pillWidth)
    }
    const section = next.expanded ? (next.composing ? compose : card) : null
    // Open again while the content is on its way out: bring it back in.
    // (Only after main closed it: while Esc's own exit runs, main keeps
    // saying "open" until it is asked to close.)
    if (section && (!shellOpen || section !== openSection || (exiting && closedByMain))) openShell(section)
    else if (!section && shellOpen) {
      closedByMain = true
      const gen = shellGen
      ;(contentOut ? Promise.resolve() : exitContent()).then(() => { if (!layout.expanded && gen === shellGen) closeShell() })
    }
    refresh()
    reportHeight()
  })

  api.ready()
})()
