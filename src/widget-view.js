// The widget window's page (src/widget.html): the dock of bot avatars and the
// quick-chat popover. It renders only what main sends over window.cmaWidget
// (src/widget-preload.js) and sets every string as text, never as HTML. It has
// no network access and no credentials; every action is a request to main.

(() => {
  'use strict'

  const api = window.cmaWidget
  if (!api) return

  // Room inside the window for the dock's shadow, above and below it
  // (widget-window.js DOCK_SHADOW_TOP/BOTTOM say the same).
  const SHADOW_TOP = 24
  const SHADOW_BOTTOM = 40

  const $ = (sel, root = document) => root.querySelector(sel)
  const dock = $('#dock')
  const botsEl = $('[data-role="bots"]', dock)
  const popover = $('#popover')
  const picker = $('#picker')
  const pickerQuery = $('[data-role="picker-query"]', picker)
  const pickerList = $('[data-role="picker-list"]', picker)
  const addButton = $('[data-role="add"]', dock)
  const workspaceButton = $('[data-role="workspace"]', dock)
  const messagesEl = $('[data-role="messages"]', popover)
  const pendingEl = $('[data-role="pending"]', popover)
  const composer = $('[data-role="composer"]', popover)
  const compose = $('[data-role="compose"]', popover)
  const sendButton = $('.btn-send', composer)
  // The composer's animated placeholder (typing-placeholder.js): it types
  // its hints on one line while the field is empty and the popover open.
  const placeholderTyping = window.TypingPlaceholder.create($('[data-role="compose-placeholder"]', popover))
  const syncPlaceholder = () => placeholderTyping.setActive(!popover.hidden && !compose.value && !attached)
  const screenEl = $('[data-role="screen"]', popover)
  const format = window.ChatFormat

  let view = { bots: [], candidates: [], focused_bot_id: null }
  let layout = { expanded: false, dockTop: 0, popoverTop: 0, popoverHeight: 0, botId: null }
  let conversation = null
  // The pending card on screen: 'kind:id', null for none, undefined to force a
  // redraw.
  let pendingKey
  let selected = new Set()
  let busy = false
  // Share screen: what main allows (the server takes screenshots; the user's
  // switch), the screenshot held for this chat (a small preview only — the
  // image stays in main), whether a capture is under way, and the notice.
  let screenState = { available: false, enabled: false }
  let attached = null
  let capturingHere = false
  let capturingMain = false
  let notice = null

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  // Share screen mounts into the composer's tools slot only when it is
  // offered (the server takes screenshots); otherwise the slot stays empty
  // and takes no room.
  const toolsSlot = $('[data-slot="composer-tools"]', composer)
  const screenButton = (() => {
    const button = el('button', 'btn-screen')
    button.type = 'button'
    button.dataset.action = 'share-screen'
    button.setAttribute('aria-label', 'Share screen')
    button.title = 'Share screen'
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('viewBox', '0 0 20 20')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const rect = document.createElementNS(ns, 'rect')
    for (const [k, v] of Object.entries({ x: '2.5', y: '3.5', width: '15', height: '10', rx: '1.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.5' })) rect.setAttribute(k, v)
    const stand = document.createElementNS(ns, 'path')
    for (const [k, v] of Object.entries({ d: 'M7 16.5h6M10 13.5v3', stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' })) stand.setAttribute(k, v)
    svg.append(rect, stand)
    button.append(svg)
    return button
  })()

  // The bot's avatar — the web app's animated CFA face, its picture, or its
  // initials (src/avatar-render.js decides, and swaps states in place).
  const avatars = window.CfaAvatar
  const paintAvatar = (node, bot) => avatars.paint(node, bot)
  const inkFor = avatars.inkFor
  avatars.watch(window, document)
  if (typeof api.onAvatarCss === 'function') api.onAvatarCss((payload) => avatars.applyCss(document, payload && payload.css))

  // The web app's chat tokens (main fetched and checked them, chat-tokens.js),
  // adopted after widget.css so they override its bundled values. A
  // constructed sheet: nothing for the CSP to allow.
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

  const botById = (id) => view.bots.find((b) => b.id === id)

  // --- The dock ------------------------------------------------------------

  const buttons = new Map()

  function renderDock () {
    const ids = view.bots.map((b) => b.id)
    for (const [id, button] of buttons) {
      if (!ids.includes(id)) {
        button.remove()
        buttons.delete(id)
      }
    }
    view.bots.forEach((bot, index) => {
      let button = buttons.get(bot.id)
      if (!button) {
        button = el('button', 'dock-bot')
        button.type = 'button'
        button.dataset.botId = bot.id
        button.append(el('span', 'avatar'))
        button.addEventListener('click', () => api.open(bot.id))
        button.addEventListener('contextmenu', (event) => {
          event.preventDefault()
          api.contextMenu(bot.id)
        })
        buttons.set(bot.id, button)
      }
      if (botsEl.children[index] !== button) botsEl.insertBefore(button, botsEl.children[index] || null)
      paintAvatar(button.firstChild, bot)
      button.dataset.mood = bot.mood
      button.toggleAttribute('data-paused', Boolean(bot.paused))
      button.classList.toggle('is-focused', bot.id === view.focused_bot_id)
      paintBadge(button, bot)
      button.title = `${bot.name} — ${bot.label}`
      button.setAttribute('aria-label', `${bot.name}, ${bot.label}`)
    })
    const activity = window.DockShape.rimActivity(view.bots)
    if (dock.dataset.activity !== activity) dock.dataset.activity = activity
    markOverflow()
    reportLayout()
  }

  // Waiting: an orange count (or dot); a fresh reply: a blue dot.
  // The seat's jelly badge (jelly-badge.js): the count, "?" or "!" on the
  // face's corner, or the working dots under it; it animates its own changes.
  function paintBadge (button, bot) {
    let slot = button.querySelector('.jelly-slot')
    if (!slot) {
      slot = el('span', 'jelly-slot')
      slot.setAttribute('aria-hidden', 'true')
      button.append(slot)
    }
    window.CmaJellyBadge.paint(slot, window.CmaJellyBadge.forBot(bot))
  }

  addButton.addEventListener('click', () => api.picker())

  // --- The workspace mark --------------------------------------------------

  function renderWorkspace () {
    const ws = view.workspace
    workspaceButton.hidden = !ws
    if (!ws) return
    const mark = workspaceButton.firstChild
    const key = [ws.id, ws.mark.initials, ws.mark.color, ws.mark.shape, ws.mark.logo_url].join('|')
    if (mark.dataset.key !== key) {
      mark.dataset.key = key
      mark.dataset.shape = ws.mark.shape || 'rounded'
      mark.style.background = ws.mark.color || ''
      mark.style.color = ws.mark.color ? inkFor(ws.mark.color) : ''
      mark.textContent = ''
      if (ws.mark.logo_url) {
        const img = new Image()
        img.alt = ''
        img.referrerPolicy = 'no-referrer'
        img.draggable = false
        img.onerror = () => { mark.textContent = ws.mark.initials }
        img.src = ws.mark.logo_url
        mark.append(img)
      } else {
        mark.textContent = ws.mark.initials
      }
    }
    workspaceButton.disabled = ws.count < 2
    workspaceButton.title = ws.count < 2 ? ws.name : `${ws.name} — switch workspace`
    workspaceButton.setAttribute('aria-label', workspaceButton.title)
  }

  workspaceButton.addEventListener('click', () => {
    if (workspaceButton.disabled) return
    api.workspaceMenu()
  })

  // --- The "+" picker ------------------------------------------------------

  function renderPicker () {
    const q = pickerQuery.value.trim().toLowerCase()
    const bots = (view.candidates || []).filter((b) => !q || b.name.toLowerCase().includes(q))
    pickerList.textContent = ''
    pickerQuery.disabled = Boolean(view.dock_full)
    if (view.dock_full) {
      pickerList.append(el('li', 'messages-empty', `The dock holds up to ${view.max_pinned} bots. Remove one (right-click it) to add another.`))
      return
    }
    if (!bots.length) {
      pickerList.append(el('li', 'messages-empty', view.candidates?.length ? 'No bots match.' : 'Every bot is already in the dock.'))
      return
    }
    for (const bot of bots) {
      const li = el('li')
      const button = el('button', 'picker-item')
      button.type = 'button'
      const avatar = el('span', 'avatar')
      paintAvatar(avatar, bot)
      const name = el('span', 'picker-name')
      name.append(el('strong', '', bot.name), el('span', 'muted', bot.label))
      button.append(avatar, name)
      if (bot.needs_count > 0) button.append(el('span', 'picker-count', String(bot.needs_count)))
      button.addEventListener('click', () => api.pin(bot.id))
      li.append(button)
      pickerList.append(li)
    }
  }

  pickerQuery.addEventListener('input', renderPicker)
  pickerQuery.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const first = pickerList.querySelector('.picker-item')
      if (first) first.click()
    }
  })

  // --- Hit rects: where the window takes the mouse -------------------------

  let reportQueued = false
  function reportLayout () {
    if (reportQueued) return
    reportQueued = true
    requestAnimationFrame(() => {
      reportQueued = false
      const rects = [dock, popover, picker, shelfEl]
        .filter((node) => !node.hidden)
        .map((node) => {
          const r = node.getBoundingClientRect()
          return { x: r.left, y: r.top, width: r.width, height: r.height }
        })
      // The dock plus room for its shadow above and below.
      api.reportHitRects(rects, Math.ceil(dock.offsetHeight + SHADOW_TOP + SHADOW_BOTTOM))
    })
  }

  // --- The dock's shape ----------------------------------------------------
  // One filled outline (dock-shape.js) sized to the dock, its fillets and
  // corners from the tokens; redrawn only when the dock's size changes.

  const shapeSvg = $('[data-role="shape"]', dock)
  const shapeFill = $('[data-role="fill"]', dock)
  const shapeRim = $('[data-role="rim"]', dock)
  let shapeKey = ''
  const tokenPx = (name, fallback) => {
    const v = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name))
    return Number.isFinite(v) ? v : fallback
  }

  function drawShape () {
    const w = dock.offsetWidth
    const h = dock.offsetHeight
    const fillet = tokenPx('--dock-fillet', 14)
    const corner = tokenPx('--dock-corner', 22)
    const key = `${w}x${h}:${fillet}:${corner}`
    if (!w || !h || key === shapeKey) return
    shapeKey = key
    shapeSvg.setAttribute('viewBox', `0 0 ${w} ${h}`)
    shapeFill.setAttribute('d', window.DockShape.dockPath(w, h, { fillet, corner }))
    shapeRim.setAttribute('x', String(w - 2))
    shapeRim.setAttribute('y', '0')
    shapeRim.setAttribute('height', String(h))
  }

  // The seat column scrolls past seven; it fades out at the end with more.
  function markOverflow () {
    const above = botsEl.scrollTop > 1
    const below = botsEl.scrollTop + botsEl.clientHeight < botsEl.scrollHeight - 1
    const more = above && below ? 'both' : above ? 'above' : below ? 'below' : ''
    if ((botsEl.dataset.more || '') !== more) {
      if (more) botsEl.dataset.more = more
      else delete botsEl.dataset.more
    }
  }
  botsEl.addEventListener('scroll', markOverflow, { passive: true })

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(reportLayout)
    observer.observe(dock)
    new ResizeObserver(() => { drawShape(); markOverflow() }).observe(dock)
    observer.observe(popover)
    observer.observe(picker)
  }

  // --- Dragging the dock anywhere ------------------------------------------
  // Press anywhere on the dock and move: main moves the window and snaps it
  // to the nearer side edge on release. A tap stays a click on the bot, the
  // "+" or the workspace mark (drag-gesture.js tells them apart).

  // The feel (dock-shape.js, motion.js): while dragged, the dock's shape
  // stretches toward where it is going (up to 12px, from the pointer's
  // speed, sprung 300/30) and its seats lag behind by 0.3 of that; let go,
  // it wobbles back (210/13). The faces never scale, only the outline.
  // Off under reduced motion.
  const Motion = window.Motion
  const ED = window.EdgeDrag
  const reducedMotion = () => Motion.prefersReducedMotion(window)
  const bodyEl = $('.dock-body', dock)
  const samples = []
  let feelFrame = null
  const stretch = Motion.createSpring({
    value: 0,
    spring: 'stretch',
    reduced: false, // the stretch is simply never started under reduced motion
    onUpdate: (v) => applyStretch(v),
  })

  function applyStretch (v) {
    const st = ED.stretchStyle(v, dock.offsetHeight)
    dock.style.setProperty('--stretch-scale', String(st.scale))
    dock.style.setProperty('--stretch-origin', st.origin === 'start' ? '0%' : '100%')
    bodyEl.style.transform = st.lag ? `translateY(${st.lag.toFixed(2)}px)` : ''
  }

  // While dragging: aim the stretch at the pointer's current speed, every
  // frame (so it relaxes when the pointer stops).
  function feelTick () {
    feelFrame = requestAnimationFrame(feelTick)
    stretch.setTarget(ED.stretchFor(ED.velocity(samples, performance.now())))
  }

  function onDragPhase (phase, screenY) {
    if (phase === 'move') {
      samples.push({ t: performance.now(), v: screenY })
      if (samples.length > 12) samples.shift()
    }
  }

  function onDragChange (on) {
    document.documentElement.toggleAttribute('data-dragging', on)
    if (on) clearShelf()
    samples.length = 0
    if (feelFrame !== null) cancelAnimationFrame(feelFrame)
    feelFrame = null
    if (reducedMotion()) return stretch.jump(0)
    if (on) {
      stretch.setSpring(ED.SPRINGS.stretch)
      feelFrame = requestAnimationFrame(feelTick)
    } else {
      // Let go: wobble back to rest, carrying the stretch's velocity.
      stretch.setSpring(ED.SPRINGS.release)
      stretch.setTarget(0)
    }
  }

  window.DragGesture.attach(dock, (phase, x, y) => {
    api.drag(phase, x, y)
    onDragPhase(phase, y)
  }, { onDragChange })

  // Moving across to the other edge: tuck out of this one (160ms, into the
  // screen edge), then — main moves the window — bud in on the new one
  // (SOFT). Reduced motion: it just moves.
  const TUCK_PX = 72
  let tuckAnim = null
  function tuck () {
    if (reducedMotion() || typeof dock.animate !== 'function') return
    const dir = layout.side === 'left' ? -1 : 1
    tuckAnim?.cancel()
    tuckAnim = dock.animate([{ transform: 'translateX(0)' }, { transform: `translateX(${dir * TUCK_PX}px)` }], { duration: 160, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' })
  }
  function budIn (sideNow) {
    tuckAnim?.cancel()
    tuckAnim = null
    const dir = sideNow === 'left' ? -1 : 1
    Motion.animateSpring(dock, 'soft', { from: dir * TUCK_PX, to: 0, format: (v) => (v ? `translateX(${v}px)` : 'none') })
  }

  // Opening, the window has just widened: wait a frame (at most 250ms) so
  // the bigger window is on screen before the panel animates into it.
  function armPanel (panel) {
    panel.setAttribute('data-arming', '')
    let done = false
    const go = () => {
      if (done) return
      done = true
      panel.removeAttribute('data-arming')
    }
    requestAnimationFrame(() => requestAnimationFrame(go))
    setTimeout(go, 250)
  }

  // Closing, the window stays wide: the panel animates out, then hides.
  function closePanel (panel) {
    if (panel.hidden) return
    const reduced = reducedMotion()
    const frames = reduced
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${layout.side === 'left' ? -8 : 8}px) scale(0.98)` }]
    if (typeof panel.animate !== 'function') { panel.hidden = true; return }
    const anim = panel.animate(frames, { duration: reduced ? 150 : 200, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' })
    panel.dataset.closing = ''
    anim.finished.then(() => {
      if (!('closing' in panel.dataset)) return
      delete panel.dataset.closing
      panel.hidden = true
      anim.cancel()
      reportLayout()
    }, () => {})
  }

  // --- A response arrived: the seat's nudge and the finished-work shelf --
  // The seat springs 1 → 1.10 → 1 (snappy; nothing under reduced motion);
  // the jelly badge enters or bumps on its own (the state says so).
  function nudgeSeat (botId) {
    const button = buttons.get(botId)
    if (!button || reducedMotion() || typeof button.animate !== 'function') return
    const { values, duration } = Motion.sample('snappy', { from: 1, to: 1, velocity: 1 })
    const peak = Math.max(...values.map((v) => v - 1)) || 1
    const frames = values.map((v) => ({ transform: `scale(${(1 + ((v - 1) / peak) * 0.1).toFixed(4)})` }))
    frames[frames.length - 1] = { transform: 'scale(1)' }
    button.animate(frames, { duration, easing: 'linear' })
  }

  // The shelf: up to three pills (then "N more"), each a bot's face, an
  // icon (a message or a file) and its label; it drips out (560ms, from
  // scale .6, transparent, 32px toward the edge, overshooting), lives 8s —
  // hovering the dock or the shelf pauses that, with 600ms more once the
  // pointer leaves — and leaves (300ms, fading 24px toward the edge).
  // Clicking one opens that chat. Main widens the window while the shelf
  // is out (api.shelf). Reduced motion: it fades.
  const shelfEl = $('#shelf')
  const shelfList = $('[data-role="shelf-list"]', shelfEl)
  const SHELF_LIFE = 8000
  const SHELF_GRACE = 600
  const SHELF_SHOWN = 3
  const SHELF_INSET = 22 // level with the first seat
  // Our own icons, drawn as SVG nodes (nothing is set as HTML here).
  const ICON_PATHS = {
    message: 'M3.5 3h9A1.5 1.5 0 0 1 14 4.5v5a1.5 1.5 0 0 1-1.5 1.5H8l-3 2.5V11H3.5A1.5 1.5 0 0 1 2 9.5v-5A1.5 1.5 0 0 1 3.5 3Z',
    file: 'M4.5 1.75h4.75L12.5 5v8.25a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1V2.75a1 1 0 0 1 1-1Z M9 1.9V5.25h3.3',
  }
  function iconNode (kind) {
    const NS = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(NS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', ICON_PATHS[kind] || ICON_PATHS.message)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '1.4')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
    return svg
  }
  let shelfItems = [] // { botId, name, label, kind, el, remaining, startedAt, timer, leaving }
  let shelfHover = false
  let moreEl = null
  let shelfReported = false

  const towardEdge = () => (document.documentElement.dataset.side === 'left' ? -1 : 1)

  function reportShelf (open) {
    if (open === shelfReported) return
    shelfReported = open
    if (typeof api.shelf === 'function') api.shelf(open)
  }

  function shelfArrive (a) {
    const name = typeof a.name === 'string' ? a.name : ''
    const label = typeof a.label === 'string' && a.label ? a.label : 'New message'
    const kind = a.kind === 'file' ? 'file' : 'message'
    const same = shelfItems.find((i) => i.botId === a.bot_id && !i.leaving)
    if (same) {
      Object.assign(same, { name, label, kind })
      paintPill(same)
      restartLife(same)
      return
    }
    shelfItems.push({ botId: a.bot_id, name, label, kind, el: null, remaining: SHELF_LIFE, startedAt: 0, timer: null, leaving: false })
    // Ask for the room first; enter once the wider window is up (a frame,
    // at most 250ms).
    const wasOpen = shelfReported
    reportShelf(true)
    if (wasOpen) renderShelf()
    else {
      let done = false
      const go = () => { if (!done) { done = true; renderShelf() } }
      requestAnimationFrame(() => requestAnimationFrame(go))
      setTimeout(go, 250)
    }
  }

  function paintPill (item) {
    const bot = botById(item.botId) || { id: item.botId, name: item.name }
    const button = item.el
    paintAvatar(button.querySelector('.avatar'), bot)
    const icon = button.querySelector('.shelf-icon')
    if (icon.dataset.kind !== item.kind) {
      icon.dataset.kind = item.kind
      icon.replaceChildren(iconNode(item.kind))
    }
    const text = item.label
    button.querySelector('.shelf-label').textContent = text
    button.title = `${item.name || bot.name}: ${text}`
    button.setAttribute('aria-label', `${item.name || bot.name}: ${text}. Open the chat.`)
  }

  function makePill (item) {
    const li = el('li')
    const button = el('button', 'shelf-pill')
    button.type = 'button'
    button.append(el('span', 'avatar'), el('span', 'shelf-icon'), el('span', 'shelf-label'))
    button.addEventListener('click', () => {
      api.open(item.botId)
      removeItem(item)
    })
    li.append(button)
    item.el = button
    item.li = li
    paintPill(item)
    return li
  }

  function startLife (item) {
    if (item.timer || item.leaving || shelfHover) return
    item.startedAt = Date.now()
    item.timer = setTimeout(() => { item.timer = null; removeItem(item) }, Math.max(0, item.remaining))
  }
  function pauseLife (item) {
    if (!item.timer) return
    clearTimeout(item.timer)
    item.timer = null
    item.remaining -= Date.now() - item.startedAt
  }
  function restartLife (item) {
    pauseLife(item)
    item.remaining = SHELF_LIFE
    startLife(item)
  }

  function renderShelf () {
    const shown = shelfItems.filter((i) => !i.leaving).slice(0, SHELF_SHOWN)
    for (const item of shown) {
      if (item.li) continue
      const li = makePill(item)
      shelfList.insertBefore(li, moreEl ? moreEl.parentNode : null)
      enterPill(item.el)
      startLife(item)
    }
    const extra = shelfItems.filter((i) => !i.leaving).length - shown.length
    if (extra > 0) {
      if (!moreEl) {
        const li = el('li')
        moreEl = el('span', 'shelf-pill shelf-more')
        li.append(moreEl)
        shelfList.append(li)
      }
      moreEl.textContent = `${extra} more`
    } else if (moreEl) {
      moreEl.parentNode.remove()
      moreEl = null
    }
    shelfEl.hidden = shelfItems.length === 0
    if (!shelfItems.length) reportShelf(false)
    reportLayout()
  }

  function enterPill (button) {
    if (typeof button.animate !== 'function') return
    if (reducedMotion()) return button.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 150 })
    const dx = 32 * towardEdge()
    button.animate([
      { opacity: 0, transform: `translateX(${dx}px) scale(0.6)` },
      { opacity: 1, transform: 'none' },
    ], { duration: 560, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' })
  }

  function removeItem (item) {
    if (item.leaving) return
    item.leaving = true
    pauseLife(item)
    const finish = () => {
      shelfItems = shelfItems.filter((i) => i !== item)
      if (item.li) item.li.remove()
      renderShelf()
    }
    if (!item.el || typeof item.el.animate !== 'function') return finish()
    const frames = reducedMotion()
      ? [{ opacity: 1 }, { opacity: 0 }]
      : [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: `translateX(${24 * towardEdge()}px)` }]
    const a = item.el.animate(frames, { duration: reducedMotion() ? 150 : 300, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' })
    a.finished.then(finish, finish)
    renderShelf() // the next one in line comes in as this one goes
  }

  function clearShelf () {
    for (const item of shelfItems) pauseLife(item)
    shelfItems = []
    shelfList.textContent = ''
    moreEl = null
    shelfEl.hidden = true
    reportShelf(false)
  }

  // Hovering the dock or the shelf holds every pill; once the pointer has
  // been off both for 600ms, their clocks run on from where they stopped
  // (so they still leave oldest first).
  let graceTimer = null
  function setShelfHover (on) {
    clearTimeout(graceTimer)
    graceTimer = null
    if (on) {
      if (shelfHover) return
      shelfHover = true
      for (const item of shelfItems) pauseLife(item)
      return
    }
    if (!shelfHover) return
    graceTimer = setTimeout(() => {
      graceTimer = null
      shelfHover = false
      for (const item of shelfItems) startLife(item)
    }, SHELF_GRACE)
  }
  let hoverDock = false
  let hoverShelf = false
  const syncHover = () => setShelfHover(hoverDock || hoverShelf)
  dock.addEventListener('pointerenter', () => { hoverDock = true; syncHover() })
  dock.addEventListener('pointerleave', () => { hoverDock = false; syncHover() })
  shelfEl.addEventListener('pointerenter', () => { hoverShelf = true; syncHover() })
  shelfEl.addEventListener('pointerleave', () => { hoverShelf = false; syncHover() })

  // --- The popover ---------------------------------------------------------

  // Only what changed is written: an unchanged string written again still
  // replaces the node's text node, and every state push (each feed refetch)
  // would repaint the head.
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text }

  function renderHead () {
    const bot = botById(layout.botId)
    if (!bot) return
    paintAvatar($('[data-role="head-avatar"]', popover), bot)
    setText($('[data-role="head-name"]', popover), bot.name)
    setText($('[data-role="head-state"]', popover), bot.label)
    const placeholder = `Message ${bot.name}…`
    placeholderTyping.setHints([placeholder, `Ask ${bot.name} anything…`, `Reply to ${bot.name} or give a new task…`])
    if (compose.getAttribute('aria-label') !== placeholder) compose.setAttribute('aria-label', placeholder)
  }

  // The thread is patched, never rebuilt. Main re-sends the conversation on
  // every poll (5 s), every feed refetch and every reply; rebuilding the list
  // each time replayed every bubble's fade-in (.message's message-in), so the
  // whole thread blinked out and back as if the popover had reloaded. Now:
  //   * the rows (bubbles, time separators, the delivery line; their shape
  //     from chat-format.js) keep their nodes, keyed;
  //   * a new message is appended; nothing else is touched but the grouping
  //     classes of its neighbour and the delivery line;
  //   * a reply that grows (streams) patches its one text node in place;
  //   * an unchanged thread writes nothing at all;
  //   * messages the server's 20-message window slid past stay above it (up
  //     to MAX_THREAD), since they are still the thread — only a message
  //     gone from inside the window is removed;
  //   * the view sticks to the bottom when it was there, and otherwise
  //     stays put.
  const MAX_THREAD = 200
  // A screenshot sent with no text: the bubble's words (widget-chat.js gives
  // the server's copy of such a message the same body, so they match up).
  const SCREENSHOT_ONLY_BODY = 'Shared my screen'
  const rows = new Map() // row key -> <li>
  let rowsBot = null // whose thread the rows are
  let thread = [] // the messages on screen, oldest first
  let outbox = [] // the user's sends not yet confirmed: { key, body, failed }
  let outboxSeq = 0
  let toBottom = true // the next render scrolls to the bottom regardless
  let statusRow = null

  const nearBottom = () => messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40

  function clearRows () {
    rows.clear()
    rowsBot = null
    thread = []
    outbox = []
    statusRow = null
    messagesEl.textContent = ''
    toBottom = true
  }

  // "Loading…" and the like, in place of the thread.
  function showStatus (text) {
    if (rows.size) {
      for (const row of rows.values()) row.remove()
      rows.clear()
    }
    if (!statusRow) {
      statusRow = el('li', 'messages-empty')
      messagesEl.append(statusRow)
    }
    setText(statusRow, text)
  }

  // A row's only child is its text: patch the text node itself, so a
  // streaming reply is one characterData change, not a node swap.
  function setRowText (row, text) {
    const node = row.firstChild
    if (node && node.nodeType === 3 && !node.nextSibling) {
      if (node.data !== text) node.data = text
    } else {
      row.textContent = text
    }
  }

  const setClass = (row, className) => { if (row.className !== className) row.className = className }

  function paintRow (row, item) {
    if (item.kind === 'typing') {
      if (row.className !== 'typing') {
        row.className = 'typing'
        row.setAttribute('aria-label', 'Typing')
        row.textContent = ''
        for (let i = 0; i < 3; i++) row.append(document.createElement('i'))
      }
      return
    }
    if (item.kind === 'separator') {
      setClass(row, 'time-sep')
      return setRowText(row, item.text)
    }
    if (item.kind === 'status') {
      setClass(row, `delivery is-${item.state}`)
      const retry = item.state === 'failed'
      const label = row.firstChild
      if (label && label.nodeType === 3 && label.data === item.text && Boolean(row.querySelector('button')) === retry) return
      row.textContent = item.text
      if (retry) {
        const button = el('button', '', 'Retry')
        button.type = 'button'
        button.addEventListener('click', retrySend)
        row.append(button)
      }
      return
    }
    setClass(row, ['message', `is-${item.role}`, item.groupStart && 'is-group-start', item.groupEnd && 'is-group-end', item.local && `is-${item.local}`, item.screenshot && 'has-screenshot'].filter(Boolean).join(' '))
    setRowText(row, item.body)
  }

  // The server's window of messages, joined onto what is on screen: what it
  // slid past stays, everything from its first message on is the server's.
  function mergeThread (messages) {
    const at = messages.length ? thread.findIndex((m) => m.id === messages[0].id) : -1
    thread = (at > 0 ? thread.slice(0, at).concat(messages) : messages.slice()).slice(-MAX_THREAD)
  }

  // An outbox row whose message the server now has takes that message's
  // key: the same bubble stays, it just stops being "sending".
  function adoptOutbox (messages) {
    if (!outbox.length) return
    const known = new Set(thread.map((m) => m.id))
    for (const m of messages) {
      if (m.role !== 'user' || known.has(m.id) || rows.has(m.id)) continue
      const i = outbox.findIndex((o) => !o.failed && o.body === m.body)
      if (i < 0) continue
      const row = rows.get(outbox[i].key)
      if (row) {
        rows.delete(outbox[i].key)
        rows.set(m.id, row)
        row.dataset.key = m.id
      }
      outbox.splice(i, 1)
    }
  }

  function renderMessages () {
    if (!conversation) {
      // Reopening the bot whose thread is still here: keep it on screen
      // until the fresh copy arrives, rather than flash "Loading…".
      if (rowsBot === layout.botId && rows.size) {
        if (toBottom) messagesEl.scrollTop = messagesEl.scrollHeight
        return
      }
      return showStatus('Loading…')
    }
    if (rowsBot !== conversation.bot_id) {
      clearRows()
      rowsBot = conversation.bot_id
    }
    if (!conversation.history) return showStatus('Open in app to see the full conversation.')
    adoptOutbox(conversation.messages)
    mergeThread(conversation.messages)
    if (!thread.length && !outbox.length) return showStatus('No messages yet.')
    if (statusRow) {
      statusRow.remove()
      statusRow = null
    }

    const atBottom = toBottom || nearBottom()
    const items = format.threadItems(thread, { outbox })
    // The bot is working on an answer: its typing dots, last.
    if (botById(layout.botId)?.mood === 'working') items.push({ key: 'typing', kind: 'typing' })
    const keys = new Set(items.map((item) => item.key))

    // Something kept on screen, to hold the view still if rows above it go.
    const anchor = atBottom ? null : [...messagesEl.children].find((row) => keys.has(row.dataset.key) && row.offsetTop + row.offsetHeight > messagesEl.scrollTop)
    const anchorTop = anchor ? anchor.offsetTop : 0

    for (const row of [...messagesEl.children]) {
      if (keys.has(row.dataset.key)) continue
      rows.delete(row.dataset.key)
      row.remove()
    }

    // In order; a row moves only when it is out of place.
    let cursor = messagesEl.firstChild
    for (const item of items) {
      let row = rows.get(item.key)
      if (!row) {
        row = el('li')
        row.dataset.key = item.key
        if (item.kind === 'message' && !item.local) row.dataset.messageId = item.key
        rows.set(item.key, row)
      }
      if (item.kind === 'message' && !item.local && row.dataset.messageId !== item.key) row.dataset.messageId = item.key
      paintRow(row, item)
      if (row === cursor) cursor = cursor.nextSibling
      else messagesEl.insertBefore(row, cursor)
    }

    if (atBottom) messagesEl.scrollTop = messagesEl.scrollHeight
    else if (anchor && anchor.offsetTop !== anchorTop) messagesEl.scrollTop += anchor.offsetTop - anchorTop
    toBottom = false
  }

  const letter = (i) => String.fromCharCode(65 + i)

  function renderPending () {
    const pending = conversation ? conversation.pending : null
    const key = pending ? `${pending.kind}:${pending.id}:${pending.actionable}` : null
    // Re-rendering on every poll would wipe a half-made choice.
    if (key === pendingKey) return
    pendingKey = key
    selected = new Set()
    pendingEl.textContent = ''
    pendingEl.hidden = !pending
    if (!pending) return reportLayout()

    pendingEl.append(el('div', 'pending-prompt', pending.prompt))
    if (pending.detail) pendingEl.append(el('div', 'pending-detail', pending.detail))
    const actions = el('div', 'pending-actions')

    // Waiting on something the widget can't answer itself (the manager's
    // runs, or a card without the ids): say what, and hand over to the app.
    if (!pending.actionable) {
      const open = el('button', 'btn btn-primary', pending.kind === 'approval' ? 'Review in app' : 'Answer in app')
      open.type = 'button'
      open.addEventListener('click', () => api.openInApp(layout.botId))
      actions.append(open)
      pendingEl.append(actions)
      return reportLayout()
    }

    if (pending.kind === 'approval') {
      const decline = el('button', 'btn', 'Decline')
      const approve = el('button', 'btn btn-primary', 'Approve')
      decline.type = approve.type = 'button'
      decline.addEventListener('click', () => decide('decline'))
      approve.addEventListener('click', () => decide('approve'))
      actions.append(decline, approve)
      pendingEl.append(actions)
      return reportLayout()
    }

    const options = el('div', 'pending-options')
    pending.options.forEach((option, index) => {
      const button = el('button', 'option')
      button.type = 'button'
      button.dataset.optionId = option.id
      button.append(el('span', 'option-key', letter(index)), el('span', '', option.label))
      button.addEventListener('click', () => toggleOption(option.id))
      options.append(button)
    })
    pendingEl.append(options)

    let other = null
    if (pending.allow_other) {
      other = el('input', 'pending-other')
      other.type = 'text'
      other.placeholder = 'Something else…'
      other.dataset.role = 'other'
      other.addEventListener('input', updateDone)
      other.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          submitAnswer()
        }
      })
      pendingEl.append(other)
    }

    const skip = el('button', 'btn', 'Skip')
    const done = el('button', 'btn btn-primary', 'Done')
    skip.type = done.type = 'button'
    done.dataset.role = 'done'
    skip.addEventListener('click', () => submitAnswer({ skip: true }))
    done.addEventListener('click', () => submitAnswer())
    actions.append(skip, done)
    pendingEl.append(actions)
    updateDone()
    reportLayout()
  }

  function toggleOption (id) {
    const pending = conversation?.pending
    if (!pending || pending.kind !== 'question' || !pending.actionable) return
    if (selected.has(id)) {
      selected.delete(id)
    } else {
      if (!pending.multiple) selected.clear()
      selected.add(id)
    }
    for (const button of pendingEl.querySelectorAll('.option')) {
      button.classList.toggle('is-selected', selected.has(button.dataset.optionId))
    }
    updateDone()
    // A single-choice question with no free text: one press answers it.
    if (!pending.multiple && !otherText()) submitAnswer()
  }

  const otherText = () => ($('[data-role="other"]', pendingEl)?.value || '').trim()

  function updateDone () {
    const done = $('[data-role="done"]', pendingEl)
    if (done) done.disabled = busy || (selected.size === 0 && !otherText())
  }

  // Send is live with text, or with a screenshot attached.
  const canSend = () => Boolean(compose.value.trim() || attached)

  function setBusy (on) {
    busy = on
    sendButton.disabled = on || !canSend()
    screenButton.disabled = on || capturingHere
    for (const button of pendingEl.querySelectorAll('button')) button.disabled = on
    if (!on) updateDone()
  }

  function showError (text) {
    let line = $('.error-line', popover)
    if (!text) return line?.remove()
    if (!line) {
      line = el('div', 'error-line')
      composer.before(line)
    }
    line.textContent = text
  }

  function takeConversation (result, failure) {
    setBusy(false)
    if (!result) return showError(failure)
    showError(null)
    conversation = result
    pendingKey = undefined
    renderMessages()
    renderPending()
  }

  async function submitAnswer ({ skip = false } = {}) {
    const pending = conversation?.pending
    if (!pending || busy) return
    const text = otherText()
    if (!skip && selected.size === 0 && !text) return
    setBusy(true)
    const result = await api.answer({ bot_id: layout.botId, pending_id: pending.id, option_ids: [...selected], text, skip })
    takeConversation(result, 'Couldn’t send your answer. Try again, or open in app.')
  }

  async function decide (decision) {
    const pending = conversation?.pending
    if (!pending || busy) return
    setBusy(true)
    const result = await api.decide({ bot_id: layout.botId, pending_id: pending.id, decision })
    takeConversation(result, 'Couldn’t send that. Try again, or open in app.')
  }

  // A send shows at once, as a "Sending…" bubble (the outbox); the
  // server's reply confirms it (the same bubble, now "Delivered") or it
  // stays as "Not delivered", with Retry.
  async function deliver (entry) {
    const botId = layout.botId
    entry.failed = false
    renderMessages()
    setBusy(true)
    // `text` is what the user typed (empty for a screenshot alone); `body`
    // is the bubble's words.
    const result = await api.sendMessage(botId, entry.text ?? entry.body)
    setBusy(false)
    if (botId !== layout.botId || !outbox.includes(entry)) return
    if (result && result.screen && result.screen.status !== 'ok') takeScreenResult(result.screen)
    if (!result || result.failed) {
      entry.failed = true
      return renderMessages()
    }
    takeConversation(result)
  }

  async function sendMessage () {
    const body = compose.value.trim()
    if ((!body && !attached) || busy || !layout.botId) return
    // Main attaches the held screenshot, or takes one first when the
    // message asks about the screen and the switch is on (screen-share.js).
    // A failed send keeps it in main for the retry.
    const screenshot = Boolean(attached)
    attached = null
    renderScreen()
    // No thread on screen to show it in (still loading, or no history
    // endpoint): send it plainly, and keep the text until it has gone.
    if (!conversation || !conversation.history) {
      setBusy(true)
      const result = await api.sendMessage(layout.botId, body)
      if (result && result.screen && result.screen.status !== 'ok') takeScreenResult(result.screen)
      if (result && !result.failed) {
        compose.value = ''
        autosize()
      }
      return takeConversation(result && !result.failed ? result : null, 'Couldn’t send your message. Try again, or open in app.')
    }
    compose.value = ''
    autosize()
    toBottom = true
    const entry = { key: `out:${++outboxSeq}`, body: body || SCREENSHOT_ONLY_BODY, text: body, screenshot, failed: false }
    outbox.push(entry)
    deliver(entry)
  }

  function retrySend () {
    const entry = outbox.find((o) => o.failed)
    if (!entry || busy) return
    // Retried, it goes to the end, as a fresh send would.
    outbox.splice(outbox.indexOf(entry), 1)
    outbox.push(entry)
    toBottom = true
    deliver(entry)
  }

  // --- Share screen ----------------------------------------------------------

  function renderScreen () {
    const offered = screenState.available && Boolean(layout.botId)
    if (offered && screenButton.parentNode !== toolsSlot) toolsSlot.append(screenButton)
    if (!offered && screenButton.parentNode) screenButton.remove()
    screenButton.disabled = busy || capturingHere
    screenButton.classList.toggle('is-attached', Boolean(attached))
    screenButton.setAttribute('aria-pressed', attached ? 'true' : 'false')
    const capturing = capturingHere || capturingMain
    const nodes = []
    screenEl.classList.toggle('is-capturing', capturing)
    if (capturing) {
      nodes.push(el('span', 'rec'), el('span', 'grow', 'Viewing your screen…'))
    } else if (notice) {
      nodes.push(el('span', 'grow', notice.text))
      for (const action of notice.actions || []) {
        const button = el('button', action.primary ? 'btn btn-primary' : 'btn', action.label)
        button.type = 'button'
        button.addEventListener('click', action.run)
        nodes.push(button)
      }
    } else if (attached) {
      if (attached.preview && /^data:image\/(png|jpeg);base64,/.test(attached.preview)) {
        const img = el('img')
        img.alt = 'Your screen'
        img.src = attached.preview
        nodes.push(img)
      }
      nodes.push(el('span', 'grow', 'Screenshot attached — it goes with your next message.'))
      const remove = el('button', 'btn', 'Remove')
      remove.type = 'button'
      remove.addEventListener('click', () => {
        if (layout.botId) api.discardScreen(layout.botId)
        attached = null
        renderScreen()
      })
      nodes.push(remove)
    }
    screenEl.replaceChildren(...nodes)
    screenEl.hidden = nodes.length === 0
    sendButton.disabled = busy || !canSend()
    // The placeholder types only into an empty composer with nothing attached.
    syncPlaceholder()
  }

  function setNotice (next) {
    notice = next
    renderScreen()
  }

  function takeScreenResult (result) {
    if (!result) return setNotice({ text: 'Couldn’t capture your screen. Try again.' })
    if (result.status === 'ok') {
      attached = { preview: result.preview }
      notice = null
      renderScreen()
      compose.focus()
      return
    }
    // A refusal: the message is main's (screen-share.js MESSAGES); the
    // settings button opens a fixed pane in main, never a URL from here.
    const actions = result.settingsUrl ? [{ label: 'Open System Settings', primary: true, run: () => api.openScreenSettings() }] : []
    setNotice({ text: String(result.message || 'Couldn’t capture your screen.'), actions })
  }

  async function shareScreen () {
    if (busy || capturingHere || !layout.botId || !screenState.available) return
    if (!screenState.enabled) {
      return setNotice({
        text: 'Let Manager see your screen? It’s captured only when you ask.',
        actions: [
          { label: 'Turn on', primary: true, run: () => { api.setShareScreen(true); screenState = { ...screenState, enabled: true }; shareScreen() } },
          { label: 'Not now', run: () => setNotice(null) },
        ],
      })
    }
    notice = null
    capturingHere = true
    renderScreen()
    const botId = layout.botId
    const result = await api.shareScreen(botId, 'button').catch(() => null)
    capturingHere = false
    if (botId !== layout.botId) return renderScreen()
    takeScreenResult(result)
  }

  screenButton.addEventListener('click', () => shareScreen())

  // The field grows with its text up to --composer-max-height (the CSS
  // caps it, and scrolls past that); send is live once there is text.
  // A growing field shrinks the thread above it: one that was at the
  // bottom stays there.
  function autosize () {
    const stick = nearBottom()
    compose.style.height = 'auto'
    compose.style.height = `${compose.scrollHeight}px`
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight
    sendButton.disabled = busy || !canSend()
    syncPlaceholder()
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault()
    sendMessage()
  })
  compose.addEventListener('input', autosize)
  compose.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault()
      sendMessage()
    }
  })

  picker.addEventListener('click', (event) => {
    if (event.target.closest('[data-action="collapse"]')) api.collapse()
  })

  popover.addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action
    if (action === 'collapse') api.collapse()
    if (action === 'open-in-app' && layout.botId) api.openInApp(layout.botId)
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      api.collapse()
      return
    }
    // A–H pick a question's options, unless the user is typing.
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName || '')
    const pending = conversation?.pending
    if (typing || !pending || pending.kind !== 'question' || !pending.actionable || event.metaKey || event.ctrlKey || event.altKey) return
    const index = event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) - 65 : -1
    if (index >= 0 && index < pending.options.length) {
      event.preventDefault()
      toggleOption(pending.options[index].id)
    }
  })

  // --- From main -----------------------------------------------------------

  api.onState((next) => {
    if (!next || !Array.isArray(next.bots)) return
    view = next
    if (next.screen_share && typeof next.screen_share === 'object') {
      screenState = { available: next.screen_share.available === true, enabled: next.screen_share.enabled === true }
      renderScreen()
    }
    renderWorkspace()
    renderDock()
    if (layout.expanded && layout.mode === 'chat') {
      renderHead()
      renderMessages() // the typing dots follow the bot's mood
    }
    if (layout.expanded && layout.mode === 'picker') renderPicker()
  })

  // A bot's answer arrived (main, arrivals.js): its seat nudges, and — with
  // "Show finished work" on — a pill drips out beside the dock.
  if (typeof api.onArrival === 'function') {
    api.onArrival((arrival) => {
      if (!arrival || typeof arrival.bot_id !== 'string') return
      nudgeSeat(arrival.bot_id)
      if (arrival.shelf) shelfArrive(arrival)
    })
  }

  api.onLayout((next) => {
    if (!next) return
    const opened = next.expanded && next.mode === 'chat' && next.botId !== layout.botId
    const pickerOpened = next.expanded && next.mode === 'picker' && !(layout.expanded && layout.mode === 'picker')
    layout = next
    document.documentElement.dataset.side = next.side === 'left' ? 'left' : 'right'
    document.documentElement.toggleAttribute('data-no-drag', next.draggable === false)
    document.documentElement.toggleAttribute('data-expanded', Boolean(next.expanded))
    dock.style.top = `${next.dockTop + SHADOW_TOP}px`
    shelfEl.style.top = `${next.dockTop + SHADOW_TOP + SHELF_INSET}px`
    if (next.tuck) tuck()
    if (next.budIn) budIn(next.side)
    const wantChat = next.expanded && next.mode === 'chat'
    const wantPicker = next.expanded && next.mode === 'picker'
    for (const [panel, want] of [[popover, wantChat], [picker, wantPicker]]) {
      if (want) {
        delete panel.dataset.closing
        if (panel.hidden && next.opening) armPanel(panel)
        panel.hidden = false
      } else if (next.closing && !panel.hidden) {
        closePanel(panel)
      } else if (!('closing' in panel.dataset)) {
        panel.hidden = true
      }
    }
    for (const panel of [popover, picker]) {
      if (panel.hidden || 'closing' in panel.dataset) continue
      panel.style.top = `${next.popoverTop}px`
      panel.style.height = `${next.popoverHeight}px`
    }
    if (pickerOpened) {
      pickerQuery.value = ''
      renderPicker()
      pickerQuery.focus()
    }
    if (opened) {
      conversation = null
      pendingKey = undefined
      if (rowsBot !== next.botId) clearRows()
      toBottom = true
      showError(null)
      // Main drops a held screenshot when the chat closes.
      attached = null
      notice = null
      renderScreen()
      renderHead()
      renderMessages()
      renderPending()
      compose.focus()
    }
    if (!next.expanded || next.mode !== 'chat') {
      conversation = null
      pendingKey = undefined
    }
    syncPlaceholder()
    reportLayout()
  })

  api.onConversation((next) => {
    if (!next || next.bot_id !== layout.botId) return
    conversation = next
    renderMessages()
    renderPending()
  })

  // The indicator from main: up for the whole capture (and a moment after),
  // the same as the island's chip.
  if (typeof api.onScreen === 'function') {
    api.onScreen((payload) => {
      capturingMain = Boolean(payload && payload.capturing)
      renderScreen()
    })
  }

  api.ready()
})()
