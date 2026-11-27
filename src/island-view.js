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
    requestAnimationFrame(() => api.reportHeight(Math.ceil(island.offsetHeight)))
  }
  if (typeof ResizeObserver === 'function') new ResizeObserver(reportHeight).observe(island)

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
  island.addEventListener('mouseenter', () => api.hover(true))
  island.addEventListener('mouseleave', () => api.hover(false))
  bar.addEventListener('click', () => {
    if (layout.focused) api.collapse()
    else api.activate()
  })
  card.addEventListener('mousedown', () => { if (!layout.focused) api.activate() })

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
    paintAvatar(next.bot)
    nameEl.textContent = next.bot.name
    chipEl.textContent = next.chip.label
    bar.setAttribute('aria-label', `${next.bot.name}: ${next.chip.label}`)
    renderCard()
  })

  api.onLayout((next) => {
    if (!next) return
    layout = next
    island.classList.toggle('is-expanded', next.expanded)
    card.hidden = !next.expanded
    reportHeight()
  })

  api.ready()
})()
