const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/widget.json')
const { ADA, LIN, LIN_SESSION, OPS, OPS_SESSION, OPS_MESSAGE, WS2 } = require('./ids')
const { createWidgetStore, redirectsToSignIn, createWidgetFeed, workspaceSwitchPath, WIDGET_JSON_PATH, WIDGET_PATH, POLL_MS } = require('../src/widget-feed')

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
  await feed.setFocus(LIN)
  assert.deepEqual(server.calls[1], { method: 'PATCH', path: WIDGET_PATH, body: { focused_bot_id: LIN }, csrfToken: fixture.csrf_token })
  assert.deepEqual(seen, ['manager', LIN, LIN], 'optimistic, then confirmed')
})

test('pinning is add_seat / remove_seat; the manager cannot be unpinned; order is the full seats list', async () => {
  const store = createWidgetStore()
  const server = fakeServer()
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  await feed.setPinned(OPS, true)
  assert.deepEqual(server.calls.at(-1).body, { add_seat: OPS })
  await feed.setPinned(ADA, false)
  assert.deepEqual(server.calls.at(-1).body, { remove_seat: ADA })
  const before = server.calls.length
  assert.equal(await feed.setPinned('manager', false), false)
  assert.equal(server.calls.length, before)
  await feed.setSeatOrder(['manager', LIN, LIN, '../x', ADA])
  assert.deepEqual(server.calls.at(-1).body, { seats: ['manager', LIN, ADA] })
})

test('a stale CSRF token (422) is refreshed and the write retried once', async () => {
  const store = createWidgetStore()
  let patches = 0
  const server = fakeServer({ [`PATCH ${WIDGET_PATH}`]: () => (++patches === 1 ? { status: 422 } : { status: 200, json: fixture }) })
  const feed = createWidgetFeed({ store, request: server.request })
  assert.equal(await feed.setEnabled(false), true)
  assert.deepEqual(server.calls.map((c) => `${c.method} ${c.path}`), [`PATCH ${WIDGET_PATH}`, `GET ${WIDGET_JSON_PATH}`, `PATCH ${WIDGET_PATH}`],
    'no token fetch first (X-CMA-Desktop covers it); a 422 refreshes and retries once')
  assert.deepEqual(server.calls[0].body, { enabled: false })
  assert.equal(server.calls[0].csrfToken, null)
  assert.equal(server.calls[2].csrfToken, fixture.csrf_token)
})

test('switching workspace POSTs the switch and refetches', async () => {
  const store = createWidgetStore()
  const server = fakeServer({ [`POST /workspaces/${WS2}/switch`]: { status: 200, json: { ok: true, workspace: { id: WS2, name: 'Side Project' } } } })
  const feed = createWidgetFeed({ store, request: server.request })
  assert.equal(await feed.switchWorkspace(WS2), true)
  assert.deepEqual(server.calls.map((c) => `${c.method} ${c.path}`), [`POST /workspaces/${WS2}/switch`, `GET ${WIDGET_JSON_PATH}`])
  const refused = createWidgetFeed({ store, request: fakeServer({ [`POST /workspaces/${WS2}/switch`]: { status: 422, json: { error: 'no' } } }).request })
  assert.equal(await refused.switchWorkspace(WS2), false)
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

test('the popover conversation: GET and compose through the wrappers', async () => {
  const store = createWidgetStore()
  const conversation = { bot_id: LIN, messages: [{ id: 'm1', role: 'user', body: 'hi' }], pending: null }
  const server = fakeServer({
    [`GET /desktop/widget/bots/${LIN}/messages?limit=20`]: { status: 200, json: conversation },
    [`POST /desktop/widget/bots/${LIN}/messages`]: { status: 201, json: conversation },
  })
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  assert.equal((await feed.conversation(LIN)).messages[0].body, 'hi')
  assert.equal((await feed.sendMessage({ bot_id: LIN, body: 'hi' })).bot_id, LIN)
  const post = server.calls.find((c) => c.method === 'POST')
  assert.deepEqual(post, { method: 'POST', path: `/desktop/widget/bots/${LIN}/messages`, body: { body: 'hi' }, csrfToken: fixture.csrf_token })
  assert.equal(await feed.sendMessage({ bot_id: LIN, body: '' }), null, 'invalid input never reaches the network')
  assert.equal(await feed.conversation('../x'), null)
  assert.equal(await createWidgetFeed({ store, request: fakeServer({ [`GET /desktop/widget/bots/${ADA}/messages?limit=20`]: { status: 404 } }).request }).conversation(ADA), null, 'no wrapper yet: null')
})

test('answers and approvals post to the wrappers and come back as the conversation', async () => {
  const store = createWidgetStore()
  const after = { bot_id: OPS, messages: [{ id: 'm9', role: 'user', body: 'EU West' }], pending: null }
  const server = fakeServer({
    [`POST /desktop/widget/bots/${OPS}/answer`]: { status: 200, json: after },
    [`POST /desktop/widget/bots/${LIN}/approval`]: { status: 422, json: { error: 'Nothing to approve', code: 'not_awaiting' } },
  })
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  assert.deepEqual(await feed.answer({ bot_id: OPS, pending_id: OPS_MESSAGE, option_ids: ['eu-west-1'] }), { bot_id: OPS, url: null, messages: [{ id: 'm9', role: 'user', body: 'EU West', created_at: null }], pending: null })
  assert.deepEqual(server.calls.find((c) => c.path.endsWith('/answer')).body, { pending_id: OPS_MESSAGE, option_ids: ['eu-west-1'], text: '' })
  assert.equal(await feed.decide({ bot_id: LIN, decision: 'approve' }), null, 'a refusal is null')
  assert.equal(server.calls.some((c) => c.path.includes('/autopilot/')), false, 'never the web form routes')
  assert.equal(await feed.decide({ bot_id: OPS, decision: 'approve' }), null)
  assert.equal(redirectsToSignIn('/users/sign_in?x=1'), true)
  assert.equal(redirectsToSignIn('https://configuremyai.com/login'), true)
  assert.equal(redirectsToSignIn('/autopilot/bots/1'), false)
})

test('pause / resume: optimistic status, POST to the wrapper, then refresh', async () => {
  const store = createWidgetStore()
  const server = fakeServer({ [`POST /desktop/widget/bots/${ADA}/pause`]: { status: 204 }, [`POST /desktop/widget/bots/${ADA}/resume`]: { status: 500 } })
  const feed = createWidgetFeed({ store, request: server.request })
  await feed.refresh()
  const seen = []
  store.onChange((s) => seen.push(s.seats[0].state.status))
  assert.equal(await feed.setActive(ADA, false), true)
  assert.equal(seen[0], 'paused', 'flipped at once')
  assert.deepEqual(server.calls.find((c) => c.path.endsWith('/pause')).body, {})
  assert.equal(await feed.setActive(ADA, true), false, 'a server error is false')
  assert.equal(await feed.setActive('../x', true), false)
})
