const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../src/widget-threads')

test('the threads path: a valid bot id or the manager, limit 5; nothing else', () => {
  assert.equal(T.threadsPath('manager'), '/desktop/widget/bots/manager/threads?limit=5')
  assert.equal(T.threadsPath('a1b2-c3'), '/desktop/widget/bots/a1b2-c3/threads?limit=5')
  assert.equal(T.threadsPath(42), '/desktop/widget/bots/42/threads?limit=5')
  for (const bad of ['../x', 'a/b', '', null, undefined, {}, 'x'.repeat(65), -1]) assert.equal(T.threadsPath(bad), null, String(bad))
})

test('a list is checked row by row: one-line text, capped; a real time or none; unread a boolean; at most five; no duplicates', () => {
  const rows = T.threadsFrom([
    { id: 't1', title: '  Plan\nfor\tQ1 ', preview: 'line one\nline two', updated_at: '2026-11-28T10:00:00+01:00', unread: true },
    { id: 't1', title: 'duplicate' },
    { id: '../evil', title: 'bad id' },
    null,
    'nope',
    { id: 't2', title: '', preview: 7, updated_at: 'yesterday', unread: 'yes' },
    { id: 3, title: 'x'.repeat(500), preview: 'y'.repeat(500), updated_at: '2026-11-27T10:00:00Z', unread: 2 },
    { id: 't4' }, { id: 't5' }, { id: 't6' },
  ])
  assert.equal(rows.length, 5)
  assert.deepEqual(rows[0], { id: 't1', title: 'Plan for Q1', preview: 'line one line two', updated_at: '2026-11-28T09:00:00.000Z', unread: true })
  assert.deepEqual(rows[1], { id: 't2', title: T.UNTITLED, preview: '', updated_at: null, unread: false })
  assert.equal(rows[2].id, '3')
  assert.equal(rows[2].title.length, T.MAX_TITLE)
  assert.ok(rows[2].title.endsWith('…'))
  assert.equal(rows[2].preview.length, T.MAX_PREVIEW)
  assert.equal(rows[2].unread, true, 'an unread count counts')
  assert.deepEqual(rows.map((r) => r.id), ['t1', 't2', '3', 't4', 't5'])
})

test('the body may be a bare array or { threads }; anything else is no list', () => {
  assert.deepEqual(T.threadsFrom({ threads: [{ id: 'a' }] }).map((r) => r.id), ['a'])
  assert.deepEqual(T.threadsFrom([]), [])
  for (const bad of [null, {}, 'x', 1, { threads: 'x' }]) assert.equal(T.threadsFrom(bad), null)
})

test('a response: 200 with a list is ok, 404 is an older server, anything else fails soft', () => {
  assert.deepEqual(T.threadsResult({ status: 200, json: [{ id: 'a' }] }).status, 'ok')
  assert.deepEqual(T.threadsResult({ status: 404 }), { status: 'unsupported' })
  for (const res of [null, { status: 0 }, { status: 401 }, { status: 500 }, { status: 302 }, { status: 200, json: 'html' }]) assert.equal(T.threadsResult(res), null, JSON.stringify(res))
})
