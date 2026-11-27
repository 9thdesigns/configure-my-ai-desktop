const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../src/widget-chat')

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

test('what the renderer asks main to send is rebuilt too', () => {
  assert.deepEqual(C.composeFrom({ bot_id: '22', body: '  hi  ' }), { botId: '22', path: '/desktop/widget/bots/22/messages', body: { body: 'hi' } })
  assert.equal(C.composeFrom({ bot_id: '22', body: '   ' }), null)
  assert.equal(C.composeFrom({ bot_id: '../x', body: 'hi' }), null)

  assert.deepEqual(C.answerFrom({ bot_id: 22, pending_id: 9, option_ids: ['a', 'a', 'bad id', 'b'], text: '' }),
    { botId: '22', path: '/desktop/widget/bots/22/answer', body: { pending_id: '9', option_ids: ['a', 'b'], text: '' } })
  assert.deepEqual(C.answerFrom({ bot_id: 22, pending_id: 9, skip: true }).body, { pending_id: '9', skip: true })
  assert.equal(C.answerFrom({ bot_id: 22, pending_id: 9 }), null, 'nothing chosen, nothing typed, not a skip')

  assert.deepEqual(C.decisionFrom({ bot_id: 22, pending_id: 9, decision: 'approve' }), { botId: '22', path: '/desktop/widget/bots/22/approval', body: { pending_id: '9', decision: 'approve' } })
  assert.equal(C.decisionFrom({ bot_id: 22, pending_id: 9, decision: 'delete-everything' }), null)
})

test('option letters', () => {
  assert.deepEqual([0, 1, 2, 3].map(C.optionLetter), ['A', 'B', 'C', 'D'])
  assert.equal(C.optionLetter(30), '')
})
