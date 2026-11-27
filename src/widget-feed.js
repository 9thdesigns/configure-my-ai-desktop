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

  const takeResponse = (res) => {
    if (!res || res.status !== 200 || !res.json || typeof res.json !== 'object') return false
    if (typeof res.json.csrf_token === 'string' && CSRF.test(res.json.csrf_token)) csrfToken = res.json.csrf_token
    return store.apply(res.json, 'server')
  }

  async function refresh () {
    const res = await request({ method: 'GET', path: WIDGET_JSON_PATH })
    if (res.status === 401 || res.status === 403) {
      signedIn = false
      csrfToken = null
      store.clear()
    }
    const ok = takeResponse(res)
    if (ok) signedIn = true
    return ok
  }

  async function send (method, path, body) {
    if (!csrfToken) await refresh()
    const res = await request({ method, path, body, csrfToken })
    if (res.status === 422) {
      // A stale token (the session rotated it): fetch a fresh one, once.
      await refresh()
      return takeResponse(await request({ method, path, body, csrfToken }))
    }
    return takeResponse(res)
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

    // seats: the full ordered list of pinned bot ids (the manager is always
    // shown first and is never in it).
    async setPinned (botId, pinned) {
      const id = validId(botId)
      const state = store.get()
      if (!id || !state) return false
      store.update((s) => {
        for (const seat of s.seats) if (seat.bot_id === id) seat.pinned = Boolean(pinned)
        return s
      })
      const seats = store.get().seats.filter((s) => s.pinned).map((s) => s.bot_id)
      return send('PATCH', WIDGET_PATH, { seats })
    },

    async setEnabled (enabled) {
      return send('PATCH', WIDGET_PATH, { enabled: Boolean(enabled) })
    },

    async switchWorkspace (workspaceId) {
      const path = workspaceSwitchPath(workspaceId)
      if (!path) return false
      if (!csrfToken) await refresh()
      const res = await request({ method: 'POST', path, body: {}, csrfToken })
      if (res.status < 200 || res.status >= 300) return false
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
    if (method !== 'GET') {
      req.setHeader('Content-Type', 'application/json')
      req.setHeader('Origin', APP_URL)
      if (csrfToken) req.setHeader('X-CSRF-Token', csrfToken)
    }

    req.on('redirect', () => {
      try { req.abort() } catch {}
      done({ status: 401 })
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
  createWidgetStore,
  createWidgetFeed,
  electronRequest,
}
