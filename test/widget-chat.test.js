const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../src/widget-chat')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { ADA, LIN, LIN_SESSION, OPS, OPS_SESSION, OPS_MESSAGE } = require('./ids')

const sample = {
  bot_id: 22,
  url: 'https://configuremyai.com/bots/22',
  messages: [
    { id: 1, role: 'user', body: 'Ship it?', created_at: '2026-11-27T05:00:00Z' },
    { id: 2, role: 'assistant', body: 'Line one\r\nLine two\u0007', created_at: 'nope' },
    { id: 3, role: 'robot', body: 'x' },
    { id: 4, body: '' },
    { id: 'bad id', body: 'y' },
  ],
  pending: { id: 9, kind: 'question', prompt: 'Which repo?', options: [{ id: 'a', label: 'Web' }, { id: 'b', label: 'Desktop' }, { id: 'a', label: 'dup' }, { label: 'no id' }] },
}

test('paths are built from validated ids', () => {
  assert.equal(C.messagesPath(22), '/desktop/widget/bots/22/messages?limit=20')
  assert.equal(C.botPath('22', 'answer'), '/desktop/widget/bots/22/answer')
  assert.equal(C.messagesPath('../x'), null)
})

test('a conversation is rebuilt: messages cleaned, roles known, pending options de-duplicated', () => {
  const c = C.conversationFrom(sample, '22')
  assert.equal(c.bot_id, '22')
  assert.equal(c.url, 'https://configuremyai.com/bots/22')
  assert.deepEqual(c.messages.map((m) => [m.id, m.role, m.body, m.created_at]), [
    ['1', 'user', 'Ship it?', '2026-11-27T05:00:00.000Z'],
    ['2', 'assistant', 'Line one\nLine two', null],
    ['3', 'assistant', 'x', null],
  ])
  assert.deepEqual(c.pending, { id: '9', kind: 'question', prompt: 'Which repo?', detail: '', options: [{ id: 'a', label: 'Web' }, { id: 'b', label: 'Desktop' }], allow_other: true, multiple: false })
})

test('the wrong bot, junk, or a foreign url is refused', () => {
  assert.equal(C.conversationFrom(sample, '23'), null)
  assert.equal(C.conversationFrom(null), null)
  assert.equal(C.conversationFrom([]), null)
  assert.equal(C.conversationFrom({ ...sample, url: 'https://evil.com' }, 22).url, null)
})

test('only the last 20 messages are kept', () => {
  const messages = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, body: `m${i + 1}` }))
  const c = C.conversationFrom({ bot_id: 1, messages })
  assert.equal(c.messages.length, 20)
  assert.equal(c.messages[0].body, 'm41')
  assert.equal(c.messages.at(-1).body, 'm60')
})

test('approvals carry no options; unknown pending kinds are dropped', () => {
  assert.deepEqual(C.conversationFrom({ bot_id: 1, pending: { id: 2, kind: 'approval', prompt: 'Deploy?', options: [{ id: 'a', label: 'x' }] } }).pending,
    { id: '2', kind: 'approval', prompt: 'Deploy?', detail: '', options: [], allow_other: false, multiple: false })
  assert.equal(C.conversationFrom({ bot_id: 1, pending: { id: 2, kind: 'payment' } }).pending, null)
})

test('a message from the renderer is rebuilt', () => {
  assert.deepEqual(C.composeFrom({ bot_id: '22', body: '  hi  ' }), { botId: '22', path: '/desktop/widget/bots/22/messages', body: { body: 'hi' } })
  assert.equal(C.composeFrom({ bot_id: '22', body: '   ' }), null)
  assert.equal(C.composeFrom({ bot_id: '../x', body: 'hi' }), null)
})

test('answers go to the web question card endpoint, addressed from the widget state', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(C.answerFrom({ bot_id: OPS, option_ids: ['a', 'a', 'bad id', 'b'], text: '' }, state), {
    botId: OPS,
    path: `/autopilot/bots/${OPS}/sessions/${OPS_SESSION}/messages/${OPS_MESSAGE}/answer`,
    body: { option_ids: ['a', 'b'], text: '' },
  })
  assert.deepEqual(C.answerFrom({ bot_id: OPS, text: ' eu-west ' }, state).body, { option_ids: [], text: 'eu-west' })
  assert.deepEqual(C.answerFrom({ bot_id: OPS, skip: true }, state).body, { skip: true })
  assert.equal(C.answerFrom({ bot_id: OPS }, state), null, 'nothing chosen, nothing typed, not a skip')
  assert.equal(C.answerFrom({ bot_id: LIN, text: 'x' }, state), null, 'Lin is waiting on an approval, not a question')
  assert.equal(C.answerFrom({ bot_id: 'manager', text: 'x' }, state), null, "the manager's runs are answered in the app")
  assert.equal(C.answerFrom({ bot_id: OPS, text: 'x', session_id: 'forged' }, null), null)
})

test('approvals go to approve_plan / decline_plan for the waiting session', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(C.decisionFrom({ bot_id: LIN, decision: 'approve' }, state), { botId: LIN, path: `/autopilot/bots/${LIN}/sessions/${LIN_SESSION}/approve_plan`, body: {} })
  assert.equal(C.decisionFrom({ bot_id: LIN, decision: 'decline' }, state).path, `/autopilot/bots/${LIN}/sessions/${LIN_SESSION}/decline_plan`)
  assert.equal(C.decisionFrom({ bot_id: LIN, decision: 'delete-everything' }, state), null)
  assert.equal(C.decisionFrom({ bot_id: OPS, decision: 'approve' }, state), null, 'Ops is waiting on a question')
  assert.equal(C.decisionFrom({ bot_id: ADA, decision: 'approve' }, state), null, 'Ada is not waiting')
})

test('the popover: server history when there is one, the pending card from the state either way', () => {
  const state = widgetStateFrom(fixture)
  const lin = C.popoverConversation(LIN, null, state)
  assert.deepEqual(lin, { bot_id: LIN, messages: [], history: false, pending: { id: LIN_SESSION, kind: 'approval', prompt: 'Deploy to production?', detail: '', options: [], allow_other: false, multiple: false, actionable: true } })
  const manager = C.popoverConversation('manager', null, state)
  assert.equal(manager.pending.kind, 'question')
  assert.equal(manager.pending.actionable, false, 'manager questions hand over to the app')
  assert.equal(C.popoverConversation(ADA, null, state).pending, null)

  const conversation = C.conversationFrom({ ...sample, bot_id: OPS })
  const ops = C.popoverConversation(OPS, conversation, state)
  assert.equal(ops.history, true)
  assert.equal(ops.messages.length, 3)
  assert.deepEqual(ops.pending.options.map((o) => o.label), ['Web', 'Desktop'], 'the richer server card wins')
  assert.equal(ops.pending.actionable, true)
})

test('option letters', () => {
  assert.deepEqual([0, 1, 2, 3].map(C.optionLetter), ['A', 'B', 'C', 'D'])
  assert.equal(C.optionLetter(30), '')
})
