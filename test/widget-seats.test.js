const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/widget.json')
const { ADA, LIN, OPS } = require('./ids')
const { widgetStateFrom } = require('../src/widget-state')
const S = require('../src/widget-seats')

const state = widgetStateFrom(fixture)
const byId = (template, id) => template.find((i) => i.id === id)

function recorder () {
  const calls = []
  return { calls, actions: new Proxy({}, { get: (_t, name) => (...args) => calls.push([name, ...args]) }) }
}

test('the dock order is the manager, then the pinned seats', () => {
  assert.deepEqual(S.seatOrder(state), ['manager', ADA, LIN])
  assert.deepEqual(S.seatOrder(null), [])
})

test('moving a seat keeps the manager first', () => {
  assert.deepEqual(S.reorder(state, LIN, -1), ['manager', LIN, ADA])
  assert.deepEqual(S.reorder(state, ADA, 1), ['manager', LIN, ADA])
  assert.equal(S.reorder(state, ADA, -1), null, 'nothing goes above the manager')
  assert.equal(S.reorder(state, LIN, 1), null, 'already last')
  assert.equal(S.reorder(state, 'manager', 1), null, 'the manager does not move')
  assert.equal(S.reorder(state, OPS, -1), null, 'not in the dock')
  assert.equal(S.reorder(state, LIN, 2), null)
})

test('a seat\'s right-click menu: open, active, move up/down, remove', () => {
  const { calls, actions } = recorder()
  const template = S.seatContextMenuTemplate(state, ADA, actions)
  assert.deepEqual(template.map((i) => i.id || i.type), ['open', 'separator', 'active', 'separator', 'move-up', 'move-down', 'separator', 'remove'])
  assert.equal(byId(template, 'open').label, 'Open Ada')
  assert.equal(byId(template, 'active').checked, true)
  assert.equal(byId(template, 'move-up').enabled, false)
  assert.equal(byId(template, 'move-down').enabled, true)
  for (const id of ['open', 'active', 'move-down', 'remove']) byId(template, id).click()
  assert.deepEqual(calls, [['open', ADA], ['setActive', ADA, false], ['move', ADA, 1], ['remove', ADA]])
})

test("the manager's menu has no move or remove", () => {
  const { actions } = recorder()
  assert.deepEqual(S.seatContextMenuTemplate(state, 'manager', actions).map((i) => i.id || i.type), ['open', 'separator', 'active'])
  assert.deepEqual(S.seatContextMenuTemplate(state, OPS, actions), [], 'not in the dock: no menu')
})

test('a paused bot shows Active unchecked, and clicking resumes it', () => {
  const paused = widgetStateFrom({ ...fixture, seats: fixture.seats.map((s) => (s.bot_id === ADA ? { ...s, state: { ...s.state, status: 'paused' } } : s)) })
  const { calls, actions } = recorder()
  const active = byId(S.seatContextMenuTemplate(paused, ADA, actions), 'active')
  assert.equal(active.checked, false)
  active.click()
  assert.deepEqual(calls, [['setActive', ADA, true]])
})

test('the picker lists bots not in the dock, those needing attention first, filtered by name', () => {
  const many = widgetStateFrom({
    ...fixture,
    seats: [
      ...fixture.seats,
      { bot_id: 'q1', name: 'Quiet', pinned: false, needs_count: 0 },
      { bot_id: 'p1', name: 'Pager', pinned: false, needs_count: 0, state: { status: 'paused' } },
    ],
  })
  assert.deepEqual(S.pickerBots(many).map((b) => [b.name, b.label]), [['Ops', 'Questions'], ['Quiet', 'Idle'], ['Pager', 'Paused']])
  assert.deepEqual(S.pickerBots(many, 'qu').map((b) => b.name), ['Quiet'])
  assert.deepEqual(S.pickerBots(many, 'OPS').map((b) => b.id), [OPS])
  assert.deepEqual(S.pickerBots(null), [])
})

test('only pausing the manager asks first', () => {
  const confirm = S.pauseConfirmation({ isManager: true, name: 'Max' })
  assert.equal(confirm.message, 'Pause Max?')
  assert.deepEqual(confirm.buttons, ['Pause', 'Cancel'])
  assert.equal(confirm.cancelId, 1)
  assert.equal(confirm.defaultId, 1, 'Cancel is the default')
  assert.equal(S.pauseConfirmation({ isManager: false, name: 'Ada' }), null)
})
