const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/widget.json')
const { createWidgetStore, createWidgetFeed, workspaceSwitchPath, WIDGET_JSON_PATH, WIDGET_PATH, POLL_MS } = require('../src/widget-feed')

function fakeServer (responses = {}) {
  const calls = []
  const request = async (req) => {
    calls.push(req)
    const key = `${req.method} ${req.path}`
    const res = responses[key]
    if (typeof res === 'function') return res(req)
    return res || { status: 200, json: fixture }
  }
  return { calls, request }
}

test('refresh fetches widget.json and stores the validated state', async () => {
  const store = createWidgetStore()
  const server = fakeServer()
  const feed = createWidgetFeed({ store, request: server.request })
  assert.equal(await feed.refresh(), true)
  assert.deepEqual(server.calls, [{ method: 'GET', path: WIDGET_JSON_PATH }])
  assert.equal(store.get().manager.name, 'Max')
  assert.equal(feed.isSignedIn(), true)
})

test('signed out (redirect → 401) clears the store', async () => {
  const store = createWidgetStore()
  store.apply(fixture, 'page')
  const feed = createWidgetFeed({ store, request: fakeServer({ [`GET ${WIDGET_JSON_PATH}`]: { status: 401 } }).request })
  assert.equal(await feed.refresh(), false)
  assert.equal(store.get(), null)
  assert.equal(feed.isSignedIn(), false)
})

test('garbage from the server or the page is ignored', async () => {
  const store = createWidgetStore()
  assert.equal(store.apply({ nope: 1 }, 'page'), false)
  const feed = createWidgetFeed({ store, request: fakeServer({ [`GET ${WIDGET_JSON_PATH}`]: { status: 200, json: ['x'] } }).request })
  assert.equal(await feed.refresh(), false)
  assert.equal(store.get(), null)
})

test('focus is applied at once and PATCHed with the CSRF token from widget.json', async () => {
  const store = createWidgetStore()
  const seen = []
  store.onChange((s) => seen.push(s && s.focused_bot_id))
  const server = fakeServer({ [`PATCH ${WIDGET_PATH}`]: (req) => ({ status: 200, json: { ...fixture, focused_bot_id: req.body.focused_bot_id } }) })
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  await feed.setFocus(22)
  assert.deepEqual(server.calls[1], { method: 'PATCH', path: WIDGET_PATH, body: { focused_bot_id: '22' }, csrfToken: fixture.csrf_token })
  assert.deepEqual(seen, ['11', '22', '22'], 'optimistic, then confirmed')
})

test('pinning sends the full ordered list of pinned seats', async () => {
  const store = createWidgetStore()
  const server = fakeServer({
    [`PATCH ${WIDGET_PATH}`]: (req) => ({ status: 200, json: { ...fixture, seats: fixture.seats.map((s) => ({ ...s, pinned: req.body.seats.includes(String(s.bot_id)) })) } }),
  })
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  await feed.setPinned('23', true)
  assert.deepEqual(server.calls.at(-1).body, { seats: ['21', '22', '23'] })
  await feed.setPinned('21', false)
  assert.deepEqual(server.calls.at(-1).body, { seats: ['22', '23'] })
})

test('a stale CSRF token (422) is refreshed and the write retried once', async () => {
  const store = createWidgetStore()
  let patches = 0
  const server = fakeServer({ [`PATCH ${WIDGET_PATH}`]: () => (++patches === 1 ? { status: 422 } : { status: 200, json: fixture }) })
  const feed = createWidgetFeed({ store, request: server.request })
  assert.equal(await feed.setEnabled(false), true)
  assert.deepEqual(server.calls.map((c) => `${c.method} ${c.path}`), [`GET ${WIDGET_JSON_PATH}`, `PATCH ${WIDGET_PATH}`, `GET ${WIDGET_JSON_PATH}`, `PATCH ${WIDGET_PATH}`])
  assert.deepEqual(server.calls[1].body, { enabled: false })
})

test('switching workspace POSTs the switch and refetches', async () => {
  const store = createWidgetStore()
  const server = fakeServer({ 'POST /workspaces/8/switch': { status: 204 } })
  const feed = createWidgetFeed({ store, request: server.request })
  assert.equal(await feed.switchWorkspace(8), true)
  assert.deepEqual(server.calls.map((c) => `${c.method} ${c.path}`), [`GET ${WIDGET_JSON_PATH}`, 'POST /workspaces/8/switch', `GET ${WIDGET_JSON_PATH}`])
  assert.equal(await feed.switchWorkspace('../admin'), false)
  assert.equal(workspaceSwitchPath('a/b'), null)
})

test('polling every 30s, skipped while the page is publishing', async () => {
  let t = 0
  const store = createWidgetStore({ now: () => t })
  const server = fakeServer()
  let tick = null
  const feed = createWidgetFeed({ store, request: server.request, setIntervalFn: (fn, ms) => { assert.equal(ms, POLL_MS); tick = fn; return 1 }, clearIntervalFn: () => { tick = null } })
  feed.start()
  await new Promise((r) => setImmediate(r))
  assert.equal(server.calls.length, 1, 'fetched at start')
  t = 1000
  store.apply(fixture, 'page')
  t = 20_000
  tick()
  assert.equal(server.calls.length, 1, 'page is fresh: no poll')
  t = 60_000
  tick()
  assert.equal(server.calls.length, 2, 'page quiet: poll')
  feed.stop()
  assert.equal(tick, null)
})

test('the popover conversation: GET, and writes that refresh the widget state', async () => {
  const store = createWidgetStore()
  const conversation = { bot_id: 22, messages: [{ id: 1, role: 'user', body: 'hi' }], pending: null }
  const server = fakeServer({
    'GET /desktop/widget/bots/22/messages?limit=20': { status: 200, json: conversation },
    'POST /desktop/widget/bots/22/messages': { status: 201, json: conversation },
    'POST /desktop/widget/bots/22/approval': { status: 200, json: conversation },
    'POST /desktop/widget/bots/22/answer': { status: 500 },
  })
  const feed = createWidgetFeed({ store, request: server.request })
  assert.equal((await feed.conversation(22)).messages[0].body, 'hi')
  assert.equal((await feed.sendMessage({ bot_id: '22', body: 'hi' })).bot_id, '22')
  const post = server.calls.find((c) => c.method === 'POST')
  assert.deepEqual(post, { method: 'POST', path: '/desktop/widget/bots/22/messages', body: { body: 'hi' }, csrfToken: fixture.csrf_token })
  assert.ok((await feed.decide({ bot_id: 22, pending_id: 9, decision: 'decline' })))
  assert.equal(await feed.answer({ bot_id: 22, pending_id: 9, skip: true }), null, 'a server error is null, not a throw')
  assert.equal(await feed.sendMessage({ bot_id: 22, body: '' }), null, 'invalid input never reaches the network')
  assert.equal(await feed.conversation('../x'), null)
})
