// Quick chat's thread shape (src/chat-format.js): time separators and their
// labels, grouping, and the delivery line — the web app's shared rules.

const test = require('node:test')
const assert = require('node:assert/strict')
const { timeLabel, threadItems } = require('../src/chat-format')

// Local times, so the labels don't depend on the machine's zone.
const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime()
const NOW = at(2026, 11, 28, 20, 0) // Saturday
const iso = (t) => new Date(t).toISOString()
const m = (id, role, t, body = id) => ({ id, role, body, created_at: t === null ? null : iso(t) })

test('separator labels: today, yesterday, this week, this year, other years', () => {
  assert.equal(timeLabel(at(2026, 11, 28, 19, 53), NOW), 'Today 7:53 PM')
  assert.equal(timeLabel(at(2026, 11, 28, 0, 5), NOW), 'Today 12:05 AM')
  assert.equal(timeLabel(at(2026, 11, 27, 15, 10), NOW), 'Yesterday 3:10 PM')
  assert.equal(timeLabel(at(2026, 11, 24, 9, 4), NOW), 'Tuesday 9:04 AM')
  assert.equal(timeLabel(at(2026, 11, 22, 12, 0), NOW), 'Sunday 12:00 PM')
  assert.equal(timeLabel(at(2026, 11, 21, 16, 15), NOW), 'Nov 21, 4:15 PM')
  assert.equal(timeLabel(at(2025, 11, 20, 16, 15), NOW), 'Nov 20, 2025, 4:15 PM')
})

const shape = (items) => items.map((i) => i.kind === 'separator' ? `| ${i.text}` : i.kind === 'status' ? `> ${i.text}` : `${i.key}${i.groupStart ? '[' : ''}${i.groupEnd ? ']' : ''}`)

test('a separator before the first message and after any gap over 15 minutes; it breaks the group', () => {
  const t0 = at(2026, 11, 28, 9, 0)
  const items = threadItems([
    m('a', 'user', t0),
    m('b', 'user', t0 + 60_000),
    m('c', 'assistant', t0 + 2 * 60_000),
    m('d', 'assistant', t0 + 17 * 60_000), // exactly 15 min after c: no break
    m('e', 'assistant', t0 + 33 * 60_000), // 16 min after d: separator, new group
    m('f', 'user', t0 + 34 * 60_000),
  ], { now: NOW })
  assert.deepEqual(shape(items), ['| Today 9:00 AM', 'a[', 'b]', 'c[', 'd]', '| Today 9:33 AM', 'e[]', 'f[]', '> Delivered'])
})

test('Delivered: under the latest user message, until the bot replies after it', () => {
  const t0 = at(2026, 11, 28, 9, 0)
  const asked = [m('a', 'assistant', t0), m('b', 'user', t0 + 1000)]
  assert.deepEqual(shape(threadItems(asked, { now: NOW })).slice(-2), ['b[]', '> Delivered'])
  const answered = [...asked, m('c', 'assistant', t0 + 2000)]
  assert.ok(!threadItems(answered, { now: NOW }).some((i) => i.kind === 'status'), 'the bot replied: no line')
  const systemAfter = [...asked, m('s', 'system', t0 + 2000)]
  assert.deepEqual(shape(threadItems(systemAfter, { now: NOW })).slice(-3), ['b[]', '> Delivered', 's[]'], 'a system note is not a reply')
  assert.ok(!threadItems([m('x', 'user', null)], { now: NOW }).some((i) => i.kind === 'status'), 'not echoed with a time: no line')
})

test('the outbox: sending and failed bubbles at the end, the line under the last', () => {
  const t0 = at(2026, 11, 28, 9, 0)
  const thread = [m('a', 'user', t0)]
  let items = threadItems(thread, { now: NOW, outbox: [{ key: 'out:1', body: 'hi' }] })
  assert.deepEqual(shape(items), ['| Today 9:00 AM', 'a[', 'out:1]', '> Sending…'])
  assert.equal(items[2].local, 'sending')
  items = threadItems(thread, { now: NOW, outbox: [{ key: 'out:1', body: 'hi', failed: true }] })
  assert.deepEqual(shape(items).slice(-1), ['> Not delivered'])
  assert.equal(items.find((i) => i.kind === 'status').state, 'failed')
})

test('keys are stable: the same thread gives the same keys', () => {
  const t0 = at(2026, 11, 28, 9, 0)
  const a = threadItems([m('a', 'user', t0), m('b', 'assistant', t0 + 1000)], { now: NOW }).map((i) => i.key)
  assert.deepEqual(a, ['sep:a', 'a', 'b'])
})
