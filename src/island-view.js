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
      const natural = shellOpen && clipEl ? Math.max(island.offsetHeight, clipEl.scrollHeight) : island.offsetHeight
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
  // A click on the bar opens the Manager composer (whatever the state);
  // a second click closes it again.
  bar.addEventListener('click', () => {
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
    chipEl.textContent = next.chip.label
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

  const rowsOf = (section) => (section ? [...section.children].filter((n) => !n.hidden) : [])

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

  function openShell (section) {
    cancelRows()
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
    exiting = tween(ms, (t) => {
      for (const row of rows) look(row, { opacity: 1 - t, scale: 1, blur: reducedMotion() ? 0 : SWAP_OUT.blur * t })
    }).then(() => { contentOut = true })
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
    exitContent().then(() => api.collapse())
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
    const hasText = composeEls.input.value.trim().length > 0
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
    updateComposerButtons()
    reportHeight()
  }
  if (typeof api.onComposer === 'function') api.onComposer(renderComposer)

  async function sendComposed () {
    const text = composeEls.input.value.trim()
    if (!text || sending || composerState?.awaiting) return
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
  composeEls.actions.addEventListener('click', (event) => event.preventDefault())

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
    if (section && (!shellOpen || section !== openSection)) openShell(section)
    else if (!section && shellOpen) (contentOut ? Promise.resolve() : exitContent()).then(() => { if (!layout.expanded) closeShell() })
    refresh()
    reportHeight()
  })

  api.ready()
})()
