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
  const composePlaceholder = $('[data-role="compose-placeholder"]', popover)
  const format = window.ChatFormat

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

  // --- Dragging the dock anywhere ------------------------------------------
  // Press anywhere on the dock and move: main moves the window and snaps it
  // to the nearer side edge on release. A tap stays a click on the bot, the
  // "+" or the workspace mark (drag-gesture.js tells them apart).

  window.DragGesture.attach(dock, (phase, x, y) => api.drag(phase, x, y), {
    onDragChange: (on) => document.documentElement.toggleAttribute('data-dragging', on),
  })

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
    setText(composePlaceholder, placeholder)
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
    setClass(row, ['message', `is-${item.role}`, item.groupStart && 'is-group-start', item.groupEnd && 'is-group-end', item.local && `is-${item.local}`].filter(Boolean).join(' '))
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

  function setBusy (on) {
    busy = on
    sendButton.disabled = on || !compose.value.trim()
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
    const result = await api.sendMessage(botId, entry.body)
    setBusy(false)
    if (botId !== layout.botId || !outbox.includes(entry)) return
    if (!result) {
      entry.failed = true
      return renderMessages()
    }
    takeConversation(result)
  }

  async function sendMessage () {
    const body = compose.value.trim()
    if (!body || busy || !layout.botId) return
    // No thread on screen to show it in (still loading, or no history
    // endpoint): send it plainly, and keep the text until it has gone.
    if (!conversation || !conversation.history) {
      setBusy(true)
      const result = await api.sendMessage(layout.botId, body)
      if (result) {
        compose.value = ''
        autosize()
      }
      return takeConversation(result, 'Couldn’t send your message. Try again, or open in app.')
    }
    compose.value = ''
    autosize()
    toBottom = true
    const entry = { key: `out:${++outboxSeq}`, body, failed: false }
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

  // The field grows with its text up to --composer-max-height (the CSS
  // caps it, and scrolls past that); send is live once there is text.
  // A growing field shrinks the thread above it: one that was at the
  // bottom stays there.
  function autosize () {
    const stick = nearBottom()
    compose.style.height = 'auto'
    compose.style.height = `${compose.scrollHeight}px`
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight
    sendButton.disabled = busy || !compose.value.trim()
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
    document.documentElement.dataset.side = next.side === 'left' ? 'left' : 'right'
    document.documentElement.toggleAttribute('data-no-drag', next.draggable === false)
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
      if (rowsBot !== next.botId) clearRows()
      toBottom = true
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
