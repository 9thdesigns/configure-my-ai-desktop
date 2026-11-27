'use strict'

// Where the widget state comes from, and how the shell changes it.
//
// Two sources, one store:
//   1. the page — the site calls window.cmaiDesktop.widget.publish(state)
//      whenever the needs-you count or the focus changes (src/preload.js →
//      cfa:widget-publish in main.js). Free, instant, and no second auth.
//   2. the server — main fetches GET /desktop/widget.json itself with the
//      default session's cookies, for when the main window is closed, on
//      another page, or offline-then-back. Polled at most every 30s, and
//      skipped while the page is publishing.
// Both go through widgetStateFrom (widget-state.js) before they are stored.
//
// Changes the shell makes (focus a bot, pin one to the dock, switch
// workspace, hide the widget) are applied to the store at once, so the menu
// bar answers the click, then sent to the server; the server's reply (the
// full widget state) replaces the guess.
//
// The transport is injected, so everything but electronRequest is testable
// without Electron (test/widget-feed.test.js).

const { widgetStateFrom, validId } = require('./widget-state')
const { messagesPath, conversationFrom, composeFrom, answerFrom, decisionFrom } = require('./widget-chat')
const { APP_URL, isAppUrl } = require('./url-policy')

const WIDGET_JSON_PATH = '/desktop/widget.json'
const WIDGET_PATH = '/desktop/widget'
const POLL_MS = 30_000
// A page publish this recent means the page is alive and keeping us current.
const PAGE_FRESH_MS = 25_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 512 * 1024

// The Rails CSRF token the server includes in widget.json (csrf_token) so
// main's own PATCH/POSTs pass forgery protection. Never stored with the
// state, never forwarded to a renderer.
const CSRF = /^[A-Za-z0-9+/=_-]{20,200}$/

// Where a redirect from a write went: sign-in means the session is gone.
function redirectsToSignIn (location) {
  if (typeof location !== 'string' || !location) return false
  try {
    return /^\/(users\/)?(sign_in|login|session)(\/|$|\?)/.test(new URL(location, APP_URL).pathname)
  } catch {
    return true
  }
}

function workspaceSwitchPath (id) {
  const valid = validId(id)
  return valid ? `/workspaces/${encodeURIComponent(valid)}/switch` : null
}

function createWidgetStore ({ now = Date.now } = {}) {
  let state = null
  let lastPagePublish = 0
  const listeners = new Set()

  const emit = () => { for (const fn of listeners) fn(state) }

  return {
    get: () => state,
    // input from the page or the server; false (and nothing changes) when it
    // fails validation.
    apply (input, source) {
      const next = widgetStateFrom(input)
      if (!next) return false
      if (source === 'page') lastPagePublish = now()
      state = next
      emit()
      return true
    },
    // An optimistic local edit; the function gets a copy and returns the new
    // state, which is re-validated like any other input.
    update (fn) {
      if (!state) return false
      const next = widgetStateFrom(fn(structuredClone(state)))
      if (!next) return false
      state = next
      emit()
      return true
    },
    // Signed out: nothing stale stays in the menu bar.
    clear () {
      if (state === null) return
      state = null
      emit()
    },
    pageIsFresh: () => now() - lastPagePublish < PAGE_FRESH_MS,
    onChange (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

// request({ method, path, body, csrfToken }) → Promise<{ status, json }>;
// status 0 means it never got an answer.
function createWidgetFeed ({ store, request, setIntervalFn = setInterval, clearIntervalFn = clearInterval }) {
  let csrfToken = null
  let timer = null
  let signedIn = null

  // A write's answer: the endpoints that reply with a redirect (the plan and
  // question forms) succeeded unless the redirect is to sign-in.
  const writeOk = (res) => (res.status >= 200 && res.status < 300) || (res.status >= 300 && res.status < 400 && !redirectsToSignIn(res.location))

  const takeResponse = (res) => {
    if (!res || res.status !== 200 || !res.json || typeof res.json !== 'object') return false
    if (typeof res.json.csrf_token === 'string' && CSRF.test(res.json.csrf_token)) csrfToken = res.json.csrf_token
    return store.apply(res.json, 'server')
  }

  async function refresh () {
    const res = await request({ method: 'GET', path: WIDGET_JSON_PATH })
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      signedIn = false
      csrfToken = null
      store.clear()
    }
    const ok = takeResponse(res)
    if (ok) signedIn = true
    return ok
  }

  // A write. Every request carries X-CMA-Desktop: 1, which the server
  // accepts in place of a CSRF token (electronRequest), so there is nothing
  // to fetch first; the token from widget.json rides along when we have one.
  // A 422 may still be a stale token: refresh and retry, once.
  async function write (method, path, body) {
    const res = await request({ method, path, body, csrfToken })
    if (res.status !== 422) return res
    await refresh()
    return request({ method, path, body, csrfToken })
  }

  async function send (method, path, body) {
    return takeResponse(await write(method, path, body))
  }

  // The popover's conversation calls answer with the conversation, not the
  // widget state; null when the request or its answer is no good. A reply
  // usually changes the bot's mood and the needs-you count, so the widget
  // state is refreshed after every write.
  async function conversationWrite (command) {
    if (!command) return null
    const res = await write('POST', command.path, command.body)
    refresh().catch(() => {})
    return res.status >= 200 && res.status < 300 ? conversationFrom(res.json, command.botId) : null
  }

  // An answer or a plan decision: true when the server took it.
  async function actionWrite (command) {
    if (!command) return false
    const res = await write('POST', command.path, command.body)
    refresh().catch(() => {})
    return writeOk(res)
  }

  return {
    refresh,
    isSignedIn: () => signedIn,
    start () {
      if (timer) return
      refresh().catch(() => {})
      timer = setIntervalFn(() => {
        if (store.pageIsFresh()) return
        refresh().catch(() => {})
      }, POLL_MS)
    },
    stop () {
      if (timer) clearIntervalFn(timer)
      timer = null
    },

    async setFocus (botId) {
      const id = validId(botId)
      if (!id) return false
      store.update((s) => ({ ...s, focused_bot_id: id }))
      return send('PATCH', WIDGET_PATH, { focused_bot_id: id })
    },

    // Pin a bot to the dock (add_seat) or take it off (remove_seat); the
    // manager's seat is not the shell's to remove.
    async setPinned (botId, pinned) {
      const id = validId(botId)
      const state = store.get()
      if (!id || !state || id === state.manager?.id) return false
      store.update((s) => {
        for (const seat of s.seats) if (seat.bot_id === id) seat.pinned = Boolean(pinned)
        return s
      })
      return send('PATCH', WIDGET_PATH, pinned ? { add_seat: id } : { remove_seat: id })
    },

    // The dock's full order: seats is every pinned id, manager included.
    async setSeatOrder (ids) {
      const state = store.get()
      if (!state || !Array.isArray(ids)) return false
      const seats = [...new Set(ids.map(validId).filter(Boolean))].slice(0, 50)
      return send('PATCH', WIDGET_PATH, { seats })
    },

    async setEnabled (enabled) {
      return send('PATCH', WIDGET_PATH, { enabled: Boolean(enabled) })
    },

    async conversation (botId) {
      const path = messagesPath(botId)
      if (!path) return null
      const res = await request({ method: 'GET', path })
      return res.status === 200 ? conversationFrom(res.json, botId) : null
    },
    sendMessage: (input) => conversationWrite(composeFrom(input)),
    answer: (input) => actionWrite(answerFrom(input, store.get())),
    decide: (input) => actionWrite(decisionFrom(input, store.get())),

    async switchWorkspace (workspaceId) {
      const path = workspaceSwitchPath(workspaceId)
      if (!path) return false
      const res = await request({ method: 'POST', path, body: {}, csrfToken })
      if (res.status !== 200 || res.json?.ok !== true) return false
      return refresh()
    },
  }
}

// The real transport: Electron's net module on the default session, so the
// signed-in cookies go with it and nothing ever passes through a renderer.
// Redirects are not followed — an expired session redirects to sign-in, and
// that is "signed out", not a page to parse.
function electronRequest ({ method, path, body, csrfToken }) {
  const { net, session } = require('electron')
  const url = `${APP_URL}${path}`
  if (!isAppUrl(url)) return Promise.resolve({ status: 0 })

  return new Promise((resolve) => {
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    let req
    try {
      req = net.request({ method, url, session: session.defaultSession, useSessionCookies: true, redirect: 'manual' })
    } catch {
      done({ status: 0 })
      return
    }
    const timer = setTimeout(() => { try { req.abort() } catch {} done({ status: 0 }) }, REQUEST_TIMEOUT_MS)

    req.setHeader('Accept', 'application/json')
    req.setHeader('X-Requested-With', 'XMLHttpRequest')
    // The server's desktop-widget marker; with Origin absent or ours it is
    // also accepted in place of the CSRF token (docs/desktop-widget.md).
    req.setHeader('X-CMA-Desktop', '1')
    if (method !== 'GET') {
      req.setHeader('Content-Type', 'application/json')
      req.setHeader('Origin', APP_URL)
      if (csrfToken) req.setHeader('X-CSRF-Token', csrfToken)
    }

    req.on('redirect', (statusCode, _method, location) => {
      try { req.abort() } catch {}
      done({ status: statusCode, location })
    })
    req.on('error', () => done({ status: 0 }))
    req.on('abort', () => done({ status: 0 }))
    req.on('response', (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          try { req.abort() } catch {}
          done({ status: 0 })
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        done({ status: res.statusCode, json })
      })
      res.on('error', () => done({ status: 0 }))
    })

    req.end(method === 'GET' || body === undefined ? undefined : JSON.stringify(body))
  })
}

module.exports = {
  WIDGET_JSON_PATH,
  WIDGET_PATH,
  POLL_MS,
  PAGE_FRESH_MS,
  workspaceSwitchPath,
  redirectsToSignIn,
  createWidgetStore,
  createWidgetFeed,
  electronRequest,
}
