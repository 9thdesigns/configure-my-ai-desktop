const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../src/widget-cable')
const { createWidgetStore, createWidgetFeed } = require('../src/widget-feed')
const fixture = require('./fixtures/widget.json')

const STREAM = 'ImRlc2t0b3Bfd2lkZ2V0OjEyMyI=--0123456789abcdef0123456789abcdef01234567'
const OTHER = 'ImRlc2t0b3Bfd2lkZ2V0OjQ1NiI=--fedcba9876543210fedcba9876543210fedcba98'

test('stream names are signed Turbo names or nothing', () => {
  assert.equal(C.validStreamName(STREAM), STREAM)
  assert.equal(C.validStreamName([STREAM]), STREAM)
  for (const bad of ['', 'plain', 'abc--', '--abcdef0123456789', 'a b--0123456789abcdef', `${STREAM}\r\nX: y`, null, 7]) assert.equal(C.validStreamName(bad), null, String(bad))
})

test('the subscribe command is Turbo::StreamsChannel with the signed name', () => {
  const cmd = JSON.parse(C.subscribeCommand(STREAM))
  assert.equal(cmd.command, 'subscribe')
  assert.deepEqual(JSON.parse(cmd.identifier), { channel: 'Turbo::StreamsChannel', signed_stream_name: STREAM })
})

test('a "threads" ping on our identifier (an object or JSON text) refetches the open recents card, not widget.json', () => {
  const frame = (message) => JSON.stringify({ identifier: C.identifierFor(STREAM), message })
  assert.deepEqual(C.classify(frame({ type: 'threads' }), STREAM), { kind: 'threads' })
  assert.deepEqual(C.classify(frame('{"type":"threads","bot_id":"x"}'), STREAM), { kind: 'threads' })
  assert.deepEqual(C.classify(frame({ type: 'other' }), STREAM), { kind: 'ignore' })
  assert.deepEqual(C.classify(JSON.stringify({ identifier: 'someone else', message: { type: 'threads' } }), STREAM), { kind: 'ignore' })
})

test('frames are classified; only a desktop_widget stream on our identifier refetches', () => {
  const id = C.identifierFor(STREAM)
  assert.deepEqual(C.classify('{"type":"welcome"}', STREAM), { kind: 'welcome' })
  assert.deepEqual(C.classify('{"type":"ping","message":1}', STREAM), { kind: 'ping' })
  assert.deepEqual(C.classify('{"type":"confirm_subscription"}', STREAM), { kind: 'confirm' })
  assert.deepEqual(C.classify('{"type":"reject_subscription"}', STREAM), { kind: 'reject' })
  assert.deepEqual(C.classify('{"type":"disconnect","reconnect":false}', STREAM), { kind: 'disconnect', reconnect: false })
  const msg = (message, identifier = id) => JSON.stringify({ identifier, message })
  assert.deepEqual(C.classify(msg('<turbo-stream action="replace" target="desktop_widget"><template></template></turbo-stream>'), STREAM), { kind: 'refetch' })
  assert.deepEqual(C.classify(msg('<turbo-stream action="refresh" targets=".x desktop_widget"></turbo-stream>'), STREAM), { kind: 'refetch' })
  assert.deepEqual(C.classify(msg('<turbo-stream action="replace" target="badge"></turbo-stream>'), STREAM), { kind: 'ignore' })
  assert.deepEqual(C.classify(msg('<turbo-stream target="desktop_widget_x"></turbo-stream>'), STREAM), { kind: 'ignore' })
  assert.deepEqual(C.classify(msg('<turbo-stream target="desktop_widget"></turbo-stream>', C.identifierFor(OTHER)), STREAM), { kind: 'ignore' }, 'another stream')
  assert.deepEqual(C.classify('not json', STREAM), { kind: 'ignore' })
})

test('backoff doubles to 30s with jitter', () => {
  const mid = () => 0.5
  assert.deepEqual([0, 1, 2, 3, 4, 5, 10].map((a) => C.backoff(a, mid)), [1000, 2000, 4000, 8000, 16000, 30000, 30000])
  assert.equal(C.backoff(0, () => 0), 800)
  assert.equal(C.backoff(0, () => 1), 1200)
})

// A fake socket and fake timers, to drive the client step by step.
function harness () {
  const sockets = []
  class FakeSocket {
    constructor (url, opts) {
      this.url = url
      this.opts = opts
      this.sent = []
      this.closed = false
      sockets.push(this)
    }
    send (data) { this.sent.push(data) }
    close () { this.closed = true }
    server (frame) { this.onmessage({ data: JSON.stringify(frame) }) }
  }
  let now = 0
  let queue = []
  const timers = {
    setTimeout: (fn, ms) => { const t = { fn, at: now + ms }; queue.push(t); return t },
    clearTimeout: (t) => { queue = queue.filter((q) => q !== t) },
  }
  const advance = (ms) => {
    now += ms
    for (;;) {
      const due = queue.filter((t) => t.at <= now).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      queue = queue.filter((t) => t !== due)
      due.fn()
    }
  }
  const refetches = []
  const cable = C.createCable({ WebSocketImpl: FakeSocket, getCookieHeader: async () => 'remember_user_token=abc; _session=xyz', onRefetch: () => refetches.push(now), timers, random: () => 0.5 })
  const tick = () => new Promise((resolve) => setImmediate(resolve))
  return { sockets, cable, advance, refetches, tick }
}

test('connects with cookies, our Origin and the cable protocol; subscribes on welcome; refetches on a ping', async () => {
  const h = harness()
  h.cable.setStream(STREAM)
  await h.tick()
  const ws = h.sockets[0]
  assert.equal(ws.url, 'wss://configuremyai.com/cable')
  assert.deepEqual(ws.opts, { protocols: ['actioncable-v1-json'], headers: { Origin: 'https://configuremyai.com', Cookie: 'remember_user_token=abc; _session=xyz' } })
  ws.onopen()
  ws.server({ type: 'welcome' })
  assert.deepEqual(ws.sent, [C.subscribeCommand(STREAM)])
  ws.server({ identifier: C.identifierFor(STREAM), type: 'confirm_subscription' })
  assert.equal(h.cable.state(), 'live')
  h.advance(300)
  assert.equal(h.refetches.length, 1, 'catch up on confirm')
  ws.server({ identifier: C.identifierFor(STREAM), message: '<turbo-stream action="replace" target="desktop_widget"></turbo-stream>' })
  ws.server({ identifier: C.identifierFor(STREAM), message: '<turbo-stream action="replace" target="desktop_widget"></turbo-stream>' })
  h.advance(300)
  assert.equal(h.refetches.length, 2, 'a burst of pings is one refetch')
})

test('a dropped socket reconnects with backoff; a silent one is treated as dropped', async () => {
  const h = harness()
  h.cable.setStream(STREAM)
  await h.tick()
  h.sockets[0].onopen()
  h.sockets[0].onclose()
  assert.equal(h.cable.state(), 'waiting')
  h.advance(1000)
  await h.tick()
  assert.equal(h.sockets.length, 2)
  h.sockets[1].onopen()
  h.advance(C.STALE_MS + 1)
  assert.equal(h.sockets[1].closed, true, 'no pings for 10s: closed')
  h.advance(2000)
  await h.tick()
  assert.equal(h.sockets.length, 3, 'and reconnected after the next backoff')
})

test('a new stream name resubscribes; null and stop close; a rejected or bad name waits', async () => {
  const h = harness()
  h.cable.setStream(STREAM)
  await h.tick()
  h.cable.setStream(STREAM)
  await h.tick()
  assert.equal(h.sockets.length, 1, 'same name: no reconnect')
  h.cable.setStream(OTHER)
  await h.tick()
  assert.equal(h.sockets[0].closed, true)
  assert.equal(h.sockets.length, 2)
  h.sockets[1].onopen()
  h.sockets[1].server({ type: 'reject_subscription' })
  assert.equal(h.cable.state(), 'rejected')
  h.advance(60_000)
  assert.equal(h.sockets.length, 2, 'rejected: no retry until a fresh name arrives')
  h.cable.setStream('garbage')
  await h.tick()
  assert.equal(h.sockets.length, 2, 'invalid names are ignored')
  h.cable.setStream(STREAM)
  await h.tick()
  assert.equal(h.sockets.length, 3)
  h.cable.setStream(null)
  assert.equal(h.sockets[2].closed, true)
  assert.equal(h.cable.state(), 'idle')
  h.cable.stop()
  h.cable.setStream(OTHER)
  await h.tick()
  assert.equal(h.sockets.length, 3, 'stopped for good')
})

test('the feed hands the X-CMA-Widget-Stream name over, and null on sign-out', async () => {
  const names = []
  const store = createWidgetStore()
  let res = { status: 200, json: fixture, stream: STREAM }
  const feed = createWidgetFeed({ store, request: async () => res, onStream: (n) => names.push(n) })
  await feed.refresh()
  res = { status: 302, location: '/users/sign_in' }
  await feed.refresh()
  assert.deepEqual(names, [STREAM, null])
})
