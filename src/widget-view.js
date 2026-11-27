// The widget window's page (src/widget.html): the dock of bot avatars and the
// quick-chat popover. It renders only what main sends over window.cmaWidget
// (src/widget-preload.js) and sets every string as text, never as HTML. It has
// no network access and no credentials; every action is a request to main.

(() => {
  'use strict'

  const api = window.cmaWidget
  if (!api) return

  const $ = (sel, root = document) => root.querySelector(sel)
  const dock = $('#dock')
  const botsEl = $('[data-role="bots"]', dock)
  const grip = $('[data-role="grip"]', dock)
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

  let view = { bots: [], candidates: [], focused_bot_id: null }
  let layout = { expanded: false, dockTop: 0, popoverTop: 0, popoverHeight: 0, botId: null }
  let conversation = null
  // The pending card on screen: 'kind:id', null for none, undefined to force a
  // redraw.
  let pendingKey
  let selected = new Set()
  let busy = false

  const el = (tag, className, text) => {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?'

  // Dark ink on a light avatar colour, light ink on a dark one.
  function inkFor (hex) {
    const full = hex.length === 4 ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}` : hex
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(full.slice(i, i + 2), 16))
    return (0.299 * r + 0.587 * g + 0.114 * b) > 160 ? '#231d1b' : '#ffffff'
  }

  // Bots have no picture: initials on their avatar colour, in their avatar
  // shape (the same look as the web app). The manager may carry the
  // workspace logo.
  function paintAvatar (node, bot) {
    const key = [bot.avatar_url, bot.name, bot.avatar_color, bot.avatar_shape].join('|')
    if (node.dataset.key === key) return
    node.dataset.key = key
    node.dataset.shape = bot.avatar_shape || 'circle'
    node.style.background = bot.avatar_color || ''
    node.style.color = bot.avatar_color ? inkFor(bot.avatar_color) : ''
    node.textContent = ''
    if (bot.avatar_url) {
      const img = new Image()
      img.alt = ''
      img.referrerPolicy = 'no-referrer'
      img.draggable = false
      img.onerror = () => { node.textContent = initials(bot.name) }
      img.src = bot.avatar_url
      node.append(img)
    } else {
      node.textContent = initials(bot.name)
    }
  }

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
    reportLayout()
  }

  // Waiting: an orange count (or dot); a fresh reply: a blue dot.
  function paintBadge (button, bot) {
    let badge = button.querySelector('.dock-badge')
    const waiting = bot.mood === 'waiting' || Boolean(bot.waiting)
    const show = !bot.paused && (waiting || bot.mood === 'responded')
    if (!show) return badge?.remove()
    if (!badge) {
      badge = el('span', 'dock-badge')
      badge.setAttribute('aria-hidden', 'true')
      button.append(badge)
    }
    const n = waiting ? bot.needs_count : 0
    badge.textContent = n > 0 ? (n > 9 ? '9+' : String(n)) : ''
    badge.classList.toggle('is-dot', n === 0)
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
      const rects = [dock, popover, picker]
        .filter((node) => !node.hidden)
        .map((node) => {
          const r = node.getBoundingClientRect()
          return { x: r.left, y: r.top, width: r.width, height: r.height }
        })
      // The dock plus its 6px margins top and bottom.
      api.reportHitRects(rects, Math.ceil(dock.offsetHeight + 12))
    })
  }

  if (typeof ResizeObserver === 'function') {
    const observer = new ResizeObserver(reportLayout)
    observer.observe(dock)
    observer.observe(popover)
    observer.observe(picker)
  }

  // --- Dragging the dock up and down ---------------------------------------

  let dragging = false
  let frame = 0
  let lastY = 0
  grip.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    dragging = true
    grip.setPointerCapture(event.pointerId)
    api.drag('start', event.screenY)
    event.preventDefault()
  })
  grip.addEventListener('pointermove', (event) => {
    if (!dragging) return
    lastY = event.screenY
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      api.drag('move', lastY)
    })
  })
  const endDrag = (event) => {
    if (!dragging) return
    dragging = false
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    api.drag('end', event.screenY)
  }
  grip.addEventListener('pointerup', endDrag)
  grip.addEventListener('pointercancel', endDrag)

  // --- The popover ---------------------------------------------------------

  function renderHead () {
    const bot = botById(layout.botId)
    if (!bot) return
    paintAvatar($('[data-role="head-avatar"]', popover), bot)
    $('[data-role="head-name"]', popover).textContent = bot.name
    $('[data-role="head-state"]', popover).textContent = bot.label
    compose.placeholder = `Message ${bot.name}…`
  }

  function renderMessages () {
    const atBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 40
    messagesEl.textContent = ''
    if (!conversation) {
      messagesEl.append(el('li', 'messages-empty', 'Loading…'))
      return
    }
    if (!conversation.history) {
      messagesEl.append(el('li', 'messages-empty', 'Open in app to see the full conversation.'))
      return
    }
    if (!conversation.messages.length) {
      messagesEl.append(el('li', 'messages-empty', 'No messages yet.'))
      return
    }
    for (const message of conversation.messages) {
      messagesEl.append(el('li', `message is-${message.role}`, message.body))
    }
    if (atBottom || !messagesEl.dataset.scrolled) {
      messagesEl.scrollTop = messagesEl.scrollHeight
      messagesEl.dataset.scrolled = '1'
    }
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

  function setBusy (on) {
    busy = on
    sendButton.disabled = on
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

  async function sendMessage () {
    const body = compose.value.trim()
    if (!body || busy || !layout.botId) return
    setBusy(true)
    const result = await api.sendMessage(layout.botId, body)
    if (result) {
      compose.value = ''
      autosize()
    }
    takeConversation(result, 'Couldn’t send your message. Try again, or open in app.')
  }

  function autosize () {
    compose.style.height = 'auto'
    compose.style.height = `${Math.min(compose.scrollHeight, 120)}px`
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
    renderWorkspace()
    renderDock()
    if (layout.expanded && layout.mode === 'chat') renderHead()
    if (layout.expanded && layout.mode === 'picker') renderPicker()
  })

  api.onLayout((next) => {
    if (!next) return
    const opened = next.expanded && next.mode === 'chat' && next.botId !== layout.botId
    const pickerOpened = next.expanded && next.mode === 'picker' && !(layout.expanded && layout.mode === 'picker')
    layout = next
    dock.style.top = `${next.dockTop}px`
    popover.hidden = !(next.expanded && next.mode === 'chat')
    picker.hidden = !(next.expanded && next.mode === 'picker')
    for (const panel of [popover, picker]) {
      if (panel.hidden) continue
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
      delete messagesEl.dataset.scrolled
      showError(null)
      renderHead()
      renderMessages()
      renderPending()
      compose.focus()
    }
    if (!next.expanded || next.mode !== 'chat') {
      conversation = null
      pendingKey = undefined
    }
    reportLayout()
  })

  api.onConversation((next) => {
    if (!next || next.bot_id !== layout.botId) return
    conversation = next
    renderMessages()
    renderPending()
  })

  api.ready()
})()
