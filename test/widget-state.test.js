const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/widget.json')
const { WS, WS2, ADA, LIN, LIN_SESSION, OPS } = require('./ids')
const { widgetStateFrom, dockBots, botById, focusedBot, stateLabel, validId, cleanText, validImageUrl, validAppUrl, validColor, validShape, MAX_SEATS } = require('../src/widget-state')

// The widget state arrives from a web page or the network and goes on to the
// OS (menu bar title, native menus) — so it is rebuilt, never passed through.

test('the fixture (the /desktop/widget.json contract) validates into the known shape', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(state.workspace, { id: WS, name: '9th Designs' })
  assert.deepEqual(state.workspaces[0].mark, { initials: '9D', color: '#2f6feb', shape: 'squircle', logo_url: 'https://configuremyai.com/rails/active_storage/logo.png' })
  assert.deepEqual(state.workspaces[1].mark, { initials: 'SP', color: '#e5484d', shape: 'circle', logo_url: null })
  assert.equal(state.manager.id, 'manager')
  assert.equal(state.manager.url, 'https://configuremyai.com/home', 'paths become absolute app URLs')
  assert.equal(state.manager.avatar_url, 'https://configuremyai.com/rails/active_storage/logo.png')
  assert.equal(state.manager.state.run_id, '0d1e2f3a-4b5c-4d6e-8f7a-8b9c0d1e2f3a')
  assert.equal(state.manager.state.waiting, 'question')
  assert.deepEqual(state.seats.map((s) => [s.bot_id, s.mood, s.pinned]), [[ADA, 'working', true], [LIN, 'waiting', true], [OPS, 'waiting', false]],
    'the manager seat is not repeated; everyone else keeps their order')
  const lin = state.seats[1]
  assert.equal(lin.avatar_url, null)
  assert.equal(lin.avatar_color, '#6e56cf')
  assert.equal(lin.avatar_shape, 'hexagon')
  assert.equal(lin.url, `https://configuremyai.com/autopilot/bots/${LIN}`)
  assert.equal(lin.state.session_id, LIN_SESSION)
  assert.equal(lin.state.status, 'awaiting_approval')
  assert.equal(state.needs_you, 3)
  assert.equal(state.focused_bot_id, 'manager')
  assert.equal(state.enabled, true)
  assert.equal('csrf_token' in state, false, 'the CSRF token never travels with the state')
})

test('anything that is not a widget state is refused', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { workspace: {} }, { workspace: { id: '../etc' } }, { workspace: { id: -1 } }]) {
    assert.equal(widgetStateFrom(bad), null, JSON.stringify(bad))
  }
})

test('ids are UUIDs, "manager", or short slugs — always strings', () => {
  assert.equal(validId(ADA), ADA)
  assert.equal(validId('manager'), 'manager')
  assert.equal(validId(7), '7')
  for (const bad of [0, -3, 1.5, '', 'a b', '../x', 'x'.repeat(65), null, {}, NaN, 2 ** 60]) assert.equal(validId(bad), null)
})

test('text is one line, trimmed and capped', () => {
  assert.equal(cleanText('  Max\n\tthe manager  ', 80), 'Max the manager')
  assert.equal(cleanText('a'.repeat(100), 10), 'aaaaaaaaa…')
  assert.equal(cleanText(42, 10), '')
})

test('images are https only, without credentials', () => {
  assert.equal(validImageUrl('https://configuremyai.com/a.png'), 'https://configuremyai.com/a.png')
  for (const bad of ['http://x.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://u:p@x.com/a.png', 'file:///etc/passwd', '/a.png', 7]) {
    assert.equal(validImageUrl(bad), null, bad)
  }
})

test('a bot url is a path on our origin, or our origin, or nothing', () => {
  assert.equal(validAppUrl('/home'), 'https://configuremyai.com/home')
  assert.equal(validAppUrl(`/autopilot/bots/${ADA}`), `https://configuremyai.com/autopilot/bots/${ADA}`)
  assert.equal(validAppUrl('https://configuremyai.com/x'), 'https://configuremyai.com/x')
  for (const bad of ['//evil.com/x', '/\\evil.com', 'https://evil.com/bots/1', 'http://configuremyai.com/x', 'javascript:1', 'https://a:b@configuremyai.com/', 'home', 3]) {
    assert.equal(validAppUrl(bad), null, String(bad))
  }
})

test('avatar colours are hex and shapes are bare words', () => {
  assert.equal(validColor('#6E56CF'), '#6e56cf')
  assert.equal(validColor('#abc'), '#abc')
  for (const bad of ['red', '#abcd', 'url(x)', '#6e56cf;x', null]) assert.equal(validColor(bad), null)
  assert.equal(validShape('squircle'), 'squircle')
  for (const bad of ['Square', 'a b', 'x"y', '', 5]) assert.equal(validShape(bad), null)
})

test('unknown moods, waits and keys fall back or drop; counts are clamped', () => {
  const state = widgetStateFrom({
    workspace: { id: 'w1', name: 'W', evil: true },
    seats: [{ bot_id: 'b5', name: 'B', mood: 'exploding', state: { waiting: 'bribe', detail: 'x', status: 'Not A Keyword', session_id: '../s' }, needs_count: -4, pinned: 'yes', extra: 1 }],
    needs_you: 'lots',
    enabled: false,
  })
  const seat = state.seats[0]
  assert.equal(seat.mood, 'idle')
  assert.equal(seat.pinned, false)
  assert.equal(seat.needs_count, 0)
  assert.equal(seat.extra, undefined)
  assert.deepEqual(seat.state, { status: null, face: null, waiting: null, detail: 'x', url: null, session_id: null, message_id: null, run_id: null, thread_id: null, options: [], allow_other: false, multiple: false, questions_count: 1 })
  assert.equal(state.needs_you, 0)
  assert.equal(state.manager, null)
  assert.equal(state.enabled, false)
  assert.deepEqual(state.workspace, { id: 'w1', name: 'W' })
  assert.deepEqual(state.workspaces, [{ id: 'w1', name: 'W', mark: { initials: 'W', color: null, shape: null, logo_url: null } }], 'the current workspace is always in the list')
})

test('seats are de-duplicated, never repeat the manager, and are capped', () => {
  const seats = [{ bot_id: 'manager', manager: true }, ...Array.from({ length: 200 }, (_, i) => ({ bot_id: `b${(i % 120) + 1}`, name: `B${i}` }))]
  const state = widgetStateFrom({ workspace: { id: 'w' }, manager: { id: 'manager', name: 'M' }, seats })
  assert.equal(state.seats.length, MAX_SEATS)
  assert.equal(state.seats.some((s) => s.bot_id === 'manager'), false)
  assert.equal(new Set(state.seats.map((s) => s.bot_id)).size, state.seats.length)
})

test('the focus must be a known bot, else the manager', () => {
  assert.equal(widgetStateFrom({ ...fixture, focused_bot_id: LIN }).focused_bot_id, LIN)
  assert.equal(widgetStateFrom({ ...fixture, focused_bot_id: 'nobody' }).focused_bot_id, 'manager')
  assert.equal(widgetStateFrom({ ...fixture, focused_bot_id: null }).focused_bot_id, 'manager')
  assert.equal(widgetStateFrom({ workspace: { id: 'w' }, focused_bot_id: 'b5' }).focused_bot_id, null)
})

test('focusedBot and botById resolve the manager or a seat', () => {
  const state = widgetStateFrom(fixture)
  assert.equal(focusedBot(state).name, 'Max')
  assert.equal(focusedBot(state).isManager, true)
  const lin = focusedBot({ ...state, focused_bot_id: LIN })
  assert.equal(lin.name, 'Lin')
  assert.equal(lin.id, LIN)
  assert.equal(lin.isManager, false)
  assert.equal(botById(state, OPS).name, 'Ops')
  assert.equal(botById(state, 'nobody'), null)
  assert.equal(focusedBot(null), null)
})

test('the dock shows the manager first, then the pinned seats in order', () => {
  assert.deepEqual(dockBots(widgetStateFrom(fixture)).map((b) => [b.id, b.isManager]), [['manager', true], [ADA, false], [LIN, false]])
  assert.deepEqual(dockBots(null), [])
})

test('the state label: a pending wait outranks the mood', () => {
  assert.equal(stateLabel({ mood: 'working', state: { waiting: 'question' } }), 'Questions')
  assert.equal(stateLabel({ mood: 'idle', state: { waiting: 'approval' } }), 'Needs approval')
  assert.equal(stateLabel({ mood: 'working', state: {} }), 'Working…')
  assert.equal(stateLabel({ mood: 'responded' }), 'New message')
  assert.equal(stateLabel({ mood: 'failed' }), 'Failed')
  assert.equal(stateLabel({ mood: 'idle' }), 'Idle')
  assert.equal(stateLabel(null), '')
})

test('a waiting bot carries its options; nothing waiting carries none', () => {
  const state = widgetStateFrom(fixture)
  const ops = state.seats.find((s) => s.bot_id === OPS)
  assert.deepEqual(ops.state.options, [{ id: 'us-east-1', label: 'US East' }, { id: 'eu-west-1', label: 'EU West' }])
  assert.equal(ops.state.allow_other, true)
  const quiet = widgetStateFrom({ workspace: { id: 'w' }, seats: [{ bot_id: 'b', state: { waiting: null, options: [{ id: 'x', label: 'X' }], allow_other: true } }] })
  assert.deepEqual(quiet.seats[0].state.options, [])
  assert.equal(quiet.seats[0].state.allow_other, false)
})
