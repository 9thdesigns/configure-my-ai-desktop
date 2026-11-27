const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom, focusedBot, stateLabel, validId, cleanText, validImageUrl, MAX_SEATS } = require('../src/widget-state')

// The widget state arrives from a web page or the network and goes on to the
// OS (menu bar title, native menus) — so it is rebuilt, never passed through.

test('the fixture (the /desktop/widget.json contract) validates into the known shape', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(state.workspace, { id: '3', name: '9th Designs' })
  assert.deepEqual(state.workspaces.map((w) => [w.id, w.mark]), [['3', '9D'], ['8', 'SP']])
  assert.equal(state.manager.id, '11')
  assert.equal(state.manager.mood, 'waiting', 'a manager with a pending question reads as waiting')
  assert.deepEqual(state.manager.state, { waiting: 'question', detail: 'Which repo should I ship first?' })
  assert.deepEqual(state.seats.map((s) => [s.bot_id, s.mood, s.pinned]), [['21', 'working', true], ['22', 'waiting', true], ['23', 'idle', false]])
  assert.deepEqual(state.seats[2].state, { waiting: null, detail: '' })
  assert.equal(state.needs_you, 2)
  assert.equal(state.focused_bot_id, '11')
  assert.equal('csrf_token' in state, false, 'the CSRF token never travels with the state')
})

test('anything that is not a widget state is refused', () => {
  for (const bad of [null, undefined, 'x', 42, [], {}, { workspace: {} }, { workspace: { id: '../etc' } }, { workspace: { id: -1 } }]) {
    assert.equal(widgetStateFrom(bad), null, JSON.stringify(bad))
  }
})

test('ids are positive integers or short slugs, always strings', () => {
  assert.equal(validId(7), '7')
  assert.equal(validId('a1b2-c3_d'), 'a1b2-c3_d')
  for (const bad of [0, -3, 1.5, '', 'a b', '../x', 'x'.repeat(65), null, {}, NaN, 2 ** 60]) assert.equal(validId(bad), null)
})

test('text is one line, trimmed and capped', () => {
  assert.equal(cleanText('  Max\n\tthe manager  ', 80), 'Max the manager')
  assert.equal(cleanText('a'.repeat(100), 10), 'aaaaaaaaa…')
  assert.equal(cleanText(42, 10), '')
})

test('avatars are https only, without credentials', () => {
  assert.equal(validImageUrl('https://configuremyai.com/a.png'), 'https://configuremyai.com/a.png')
  for (const bad of ['http://x.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'https://u:p@x.com/a.png', 'file:///etc/passwd', 7]) {
    assert.equal(validImageUrl(bad), null, bad)
  }
})

test('unknown moods and waits fall back, unknown keys are dropped, counts are clamped', () => {
  const state = widgetStateFrom({
    workspace: { id: 1, name: 'W', evil: true },
    seats: [{ bot_id: 5, name: 'B', mood: 'exploding', state: { waiting: 'bribe', detail: 'x' }, needs_count: -4, pinned: 'yes', extra: 1 }],
    needs_you: 'lots',
  })
  assert.deepEqual(state.seats[0], { bot_id: '5', name: 'B', avatar_url: null, mood: 'idle', state: { waiting: null, detail: 'x' }, needs_count: 0, pinned: false })
  assert.equal(state.needs_you, 0)
  assert.equal(state.manager, null)
  assert.deepEqual(state.workspace, { id: '1', name: 'W' })
  assert.deepEqual(state.workspaces, [{ id: '1', name: 'W', mark: '' }], 'the current workspace is always in the list')
})

test('seats are de-duplicated, never repeat the manager, and are capped', () => {
  const seats = Array.from({ length: 200 }, (_, i) => ({ bot_id: (i % 120) + 1, name: `B${i}` }))
  const state = widgetStateFrom({ workspace: { id: 1 }, manager: { id: 1, name: 'M' }, seats })
  assert.equal(state.seats.length, MAX_SEATS)
  assert.equal(state.seats.some((s) => s.bot_id === '1'), false)
  assert.equal(new Set(state.seats.map((s) => s.bot_id)).size, state.seats.length)
})

test('the focus must be a known bot, else the manager', () => {
  assert.equal(widgetStateFrom({ ...fixture, focused_bot_id: 22 }).focused_bot_id, '22')
  assert.equal(widgetStateFrom({ ...fixture, focused_bot_id: 999 }).focused_bot_id, '11')
  assert.equal(widgetStateFrom({ ...fixture, focused_bot_id: undefined }).focused_bot_id, '11')
  assert.equal(widgetStateFrom({ workspace: { id: 1 }, focused_bot_id: 5 }).focused_bot_id, null)
})

test('focusedBot resolves the manager or a seat', () => {
  const state = widgetStateFrom(fixture)
  assert.equal(focusedBot(state).name, 'Max')
  assert.equal(focusedBot(state).isManager, true)
  const lin = focusedBot({ ...state, focused_bot_id: '22' })
  assert.equal(lin.name, 'Lin')
  assert.equal(lin.id, '22')
  assert.equal(focusedBot(null), null)
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
