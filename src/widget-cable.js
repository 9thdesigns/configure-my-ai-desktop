'use strict'

// Push for the widget state: the server's "something changed" pings, so the
// menu bar, dock and island update within a second instead of on the next
// poll — even with the main window closed.
//
// Every widget.json response carries X-CMA-Widget-Stream, a signed Turbo
// stream name for this user's widget (docs/desktop-widget.md in the Rails
// app). Main subscribes to it over ActionCable at wss://configuremyai.com/
// cable (Turbo::StreamsChannel { signed_stream_name }) and, on any message
// that targets "desktop_widget", refetches widget.json. The message itself is
// never parsed beyond that and its reason — it is a ping, not data:
//
//   <turbo-stream action="replace" target="desktop_widget"><template>
//     <meta name="desktop_widget" content="refresh" data-reason="threads" …>
//   </template></turbo-stream>
//
// data-reason is needs | seats | threads. "threads" says a bot's recent
// chats changed: the dock refetches the recents card that is open, if one
// is, and widget.json is left alone. Any other reason, or none, refetches
// widget.json as before. The ≤30s poll stays as the fallback for when the
// socket is down.
//
// The socket runs in the main process with the default session's cookies
// (ActionCable authenticates the connection from them) and our own Origin;
// nothing here ever reaches a renderer. The protocol handling is pure and
// the socket is injected, so it is unit-tested without a network
// (test/widget-cable.test.js).

const { APP_HOST } = require('./url-policy')

const CABLE_URL = `wss://${APP_HOST}/cable`
const ORIGIN = `https://${APP_HOST}`
const PROTOCOL = 'actioncable-v1-json'
const CHANNEL = 'Turbo::StreamsChannel'
const TARGET = 'desktop_widget'
// ActionCable pings every 3s; this long without one means a dead socket.
const STALE_MS = 10_000
const REFETCH_DEBOUNCE_MS = 250
const MAX_BACKOFF_MS = 30_000

// Signed stream names are "<base64 payload>--<digest>".
const STREAM_NAME = /^[A-Za-z0-9+/=_-]{8,2048}--[A-Za-z0-9]{16,256}$/

function validStreamName (value) {
  const name = Array.isArray(value) ? value[0] : value
  return typeof name === 'string' && STREAM_NAME.test(name) ? name : null
}

function identifierFor (streamName) {
  return JSON.stringify({ channel: CHANNEL, signed_stream_name: streamName })
}

function subscribeCommand (streamName) {
  return JSON.stringify({ command: 'subscribe', identifier: identifierFor(streamName) })
}

// A <turbo-stream> aimed at desktop_widget (target=, or targets= with it),
// and the data-reason inside it when there is one.
const WIDGET_PING = /\btargets?=["'][^"']*\bdesktop_widget\b[^>]*>(?:[\s\S]*?\bdata-reason=["']([a-z_]{1,32})["'])?/

// One frame from the server → what to do about it.
//   welcome | ping | confirm | reject | refetch | disconnect | ignore
function classify (data, streamName) {
  let frame
  try {
    frame = JSON.parse(typeof data === 'string' ? data : String(data))
  } catch {
    return { kind: 'ignore' }
  }
  if (!frame || typeof frame !== 'object') return { kind: 'ignore' }
  switch (frame.type) {
    case 'welcome': return { kind: 'welcome' }
    case 'ping': return { kind: 'ping' }
    case 'confirm_subscription': return { kind: 'confirm' }
    case 'reject_subscription': return { kind: 'reject' }
    case 'disconnect': return { kind: 'disconnect', reconnect: frame.reconnect !== false }
  }
  if (frame.identifier !== identifierFor(streamName)) return { kind: 'ignore' }
  const message = typeof frame.message === 'string' ? frame.message : ''
  const ping = WIDGET_PING.exec(message)
  if (!ping) return { kind: 'ignore' }
  if (ping[1] === 'threads') return { kind: 'threads' }
  return ping[1] ? { kind: 'refetch', reason: ping[1] } : { kind: 'refetch' }
}

// 1s, 2s, 4s … capped at 30s, with ±20% jitter so a fleet of desktops
// doesn't reconnect in step after a deploy.
function backoff (attempt, random = Math.random) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.max(0, attempt))
  return Math.round(base * (0.8 + random() * 0.4))
}

// createCable({ WebSocketImpl, getCookieHeader, onRefetch, onThreads }) → { setStream,
// stop, state }. setStream(name) (re)subscribes when the name changes — a
// workspace switch or a new session — and null closes the socket.
function createCable ({ WebSocketImpl, getCookieHeader, onRefetch, onThreads = () => {}, timers = { setTimeout, clearTimeout }, random = Math.random }) {
  let streamName = null
  let socket = null
  let attempt = 0
  let reconnectTimer = null
  let staleTimer = null
  let refetchTimer = null
  let stopped = false
  let status = 'idle'

  const clear = (t) => { if (t) timers.clearTimeout(t) }

  function close () {
    clear(staleTimer)
    clear(reconnectTimer)
    staleTimer = reconnectTimer = null
    if (socket) {
      const s = socket
      socket = null
      try { s.close() } catch {}
    }
  }

  function scheduleReconnect () {
    if (stopped || !streamName || reconnectTimer) return
    status = 'waiting'
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null
      connect()
    }, backoff(attempt++, random))
  }

  function armStale () {
    clear(staleTimer)
    staleTimer = timers.setTimeout(() => {
      // No ping for too long: the socket is dead even if it never closed.
      close()
      scheduleReconnect()
    }, STALE_MS)
  }

  function refetchSoon () {
    clear(refetchTimer)
    refetchTimer = timers.setTimeout(() => {
      refetchTimer = null
      onRefetch()
    }, REFETCH_DEBOUNCE_MS)
  }

  async function connect () {
    if (stopped || !streamName) return
    close()
    status = 'connecting'
    const name = streamName
    let cookie = ''
    try { cookie = await getCookieHeader() } catch {}
    if (stopped || name !== streamName) return
    let ws
    try {
      ws = new WebSocketImpl(CABLE_URL, { protocols: [PROTOCOL], headers: { Origin: ORIGIN, Cookie: cookie } })
    } catch {
      scheduleReconnect()
      return
    }
    socket = ws
    ws.onopen = () => { if (socket === ws) armStale() }
    ws.onmessage = (event) => {
      if (socket !== ws) return
      const action = classify(event.data, name)
      if (action.kind !== 'ignore') armStale()
      if (action.kind === 'welcome') ws.send(subscribeCommand(name))
      if (action.kind === 'confirm') {
        attempt = 0
        status = 'live'
        // Whatever changed while we were away.
        refetchSoon()
      }
      if (action.kind === 'refetch') refetchSoon()
      if (action.kind === 'threads') onThreads()
      if (action.kind === 'reject') {
        // A stream name the server no longer accepts (signed out, rotated):
        // wait for the next widget.json to bring a fresh one.
        status = 'rejected'
        close()
      }
      if (action.kind === 'disconnect') {
        close()
        if (action.reconnect) scheduleReconnect()
        else status = 'closed'
      }
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      clear(staleTimer)
      scheduleReconnect()
    }
    ws.onerror = () => {}
  }

  return {
    setStream (value) {
      const name = value === null ? null : validStreamName(value)
      if (value !== null && !name) return
      if (name === streamName && (socket || reconnectTimer)) return
      streamName = name
      attempt = 0
      if (!name) {
        close()
        status = 'idle'
        return
      }
      connect()
    },
    stop () {
      stopped = true
      clear(refetchTimer)
      close()
      status = 'stopped'
    },
    state: () => status,
  }
}

// The Cookie header for the cable handshake, from the default session.
async function electronCookieHeader () {
  const { session } = require('electron')
  const cookies = await session.defaultSession.cookies.get({ url: ORIGIN })
  return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

module.exports = {
  CABLE_URL,
  PROTOCOL,
  TARGET,
  STALE_MS,
  validStreamName,
  identifierFor,
  subscribeCommand,
  classify,
  backoff,
  createCable,
  electronCookieHeader,
}
