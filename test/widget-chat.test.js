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
  assert.deepEqual(c.pending, { id: '9', kind: 'question', prompt: 'Which repo?', detail: '', options: [{ id: 'a', label: 'Web' }, { id: 'b', label: 'Desktop' }], allow_other: true, multiple: false, questions_count: 1 })
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
    { id: '2', kind: 'approval', prompt: 'Deploy?', detail: '', options: [], allow_other: false, multiple: false, questions_count: 1 })
  assert.equal(C.conversationFrom({ bot_id: 1, pending: { id: 2, kind: 'payment' } }).pending, null)
})

test('a message from the renderer is rebuilt', () => {
  assert.deepEqual(C.composeFrom({ bot_id: '22', body: '  hi  ' }), { botId: '22', path: '/desktop/widget/bots/22/messages', body: { body: 'hi' } })
  assert.equal(C.composeFrom({ bot_id: '22', body: '   ' }), null)
  assert.equal(C.composeFrom({ bot_id: '../x', body: 'hi' }), null)
})

test('answers go to the /desktop/widget answer wrapper, for bots waiting on a question', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(C.answerFrom({ bot_id: OPS, pending_id: OPS_MESSAGE, option_ids: ['eu-west-1', 'eu-west-1', 'us east 1', 7], text: '' }, state), {
    botId: OPS,
    path: `/desktop/widget/bots/${OPS}/answer`,
    body: { pending_id: OPS_MESSAGE, option_ids: ['eu-west-1', 'us east 1'], text: '' },
  })
  assert.deepEqual(C.answerFrom({ bot_id: OPS, text: ' eu-west ' }, state).body, { option_ids: [], text: 'eu-west' }, 'pending_id is optional')
  assert.deepEqual(C.answerFrom({ bot_id: OPS, skip: true, pending_id: '../x' }, state).body, { skip: true })
  assert.equal(C.answerFrom({ bot_id: OPS }, state), null, 'nothing chosen, nothing typed, not a skip')
  assert.equal(C.answerFrom({ bot_id: LIN, text: 'x' }, state), null, 'Lin is waiting on an approval, not a question')
  assert.equal(C.answerFrom({ bot_id: 'manager', text: 'x' }, state), null, 'the manager asks in replies, not cards')
  assert.equal(C.answerFrom({ bot_id: OPS, text: 'x' }, null), null)
})

test('approvals go to the approval wrapper, the manager\'s proposals included', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(C.decisionFrom({ bot_id: LIN, decision: 'approve' }, state), { botId: LIN, path: `/desktop/widget/bots/${LIN}/approval`, body: { decision: 'approve' } })
  assert.deepEqual(C.decisionFrom({ bot_id: LIN, decision: 'decline', pending_id: LIN_SESSION }, state).body, { pending_id: LIN_SESSION, decision: 'decline' })
  const proposing = widgetStateFrom({ ...fixture, manager: { ...fixture.manager, state: { ...fixture.manager.state, waiting: 'approval' } } })
  assert.equal(C.decisionFrom({ bot_id: 'manager', decision: 'approve' }, proposing).path, '/desktop/widget/bots/manager/approval')
  assert.equal(C.decisionFrom({ bot_id: LIN, decision: 'delete-everything' }, state), null)
  assert.equal(C.decisionFrom({ bot_id: OPS, decision: 'approve' }, state), null, 'Ops is waiting on a question')
  assert.equal(C.decisionFrom({ bot_id: ADA, decision: 'approve' }, state), null, 'Ada is not waiting')
})

test('the popover: server history and card when there is one, the card from the state otherwise', () => {
  const state = widgetStateFrom(fixture)
  assert.deepEqual(C.popoverConversation(OPS, null, state).pending, {
    id: OPS_MESSAGE, kind: 'question', prompt: 'Which region?', detail: '',
    options: [{ id: 'us-east-1', label: 'US East' }, { id: 'eu-west-1', label: 'EU West' }],
    allow_other: true, multiple: false, questions_count: 1, actionable: true,
  }, 'lettered options straight from the feed')
  const lin = C.popoverConversation(LIN, null, state)
  assert.equal(lin.history, false)
  assert.equal(lin.pending.kind, 'approval')
  assert.deepEqual(lin.pending.options, [])
  assert.equal(lin.pending.actionable, true)
  assert.equal(C.popoverConversation('manager', null, state).pending.actionable, false, 'manager questions hand over to the app')
  assert.equal(C.popoverConversation(ADA, null, state).pending, null)

  const ops = C.popoverConversation(OPS, C.conversationFrom({ ...sample, bot_id: OPS }), state)
  assert.equal(ops.history, true)
  assert.equal(ops.messages.length, 3)
  assert.deepEqual(ops.pending.options.map((o) => o.label), ['Web', 'Desktop'], 'the server conversation wins')
  assert.equal(ops.pending.actionable, true)
  const multi = C.popoverConversation(OPS, C.conversationFrom({ ...sample, bot_id: OPS, pending: { ...sample.pending, questions_count: 3 } }), state)
  assert.equal(multi.pending.actionable, false, 'several questions: answered in the app')
  assert.equal(C.popoverConversation(OPS, C.conversationFrom({ bot_id: OPS, messages: [] }), state).pending, null, 'the server says nothing is pending')
})

test('option letters', () => {
  assert.deepEqual([0, 1, 2, 3].map(C.optionLetter), ['A', 'B', 'C', 'D'])
  assert.equal(C.optionLetter(30), '')
})
