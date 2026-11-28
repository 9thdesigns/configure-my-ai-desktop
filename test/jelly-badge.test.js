// The jelly badge's pure parts (src/jelly-badge.js): the count text (capped
// at 99), which kind a mode shows (ours and the island's modes), the glyph,
// a dock seat's bot → mode, and the burst rule. The tray title uses the same
// count text.

const test = require('node:test')
const assert = require('node:assert/strict')
const J = require('../src/jelly-badge')
const { trayTitle } = require('../src/tray')

test('the count: 1..99, then "99+"; nothing for zero or junk', () => {
  assert.deepEqual([0, -3, NaN, 'x', 1, 9, 10, 99, 100, 5000].map(J.formatCount), ['', '', '', '', '1', '9', '10', '99', '99+', '99+'])
  assert.equal(J.formatCount('7'), '7')
})

test('kinds: unread / waiting / failed / working, from our modes and the island\'s', () => {
  const k = (mode, count = 0) => J.kindFor({ mode, count })
  assert.equal(k('message', 2), 'unread')
  assert.equal(k('responded'), 'unread')
  assert.equal(k('question'), 'waiting')
  assert.equal(k('approval'), 'waiting')
  assert.equal(k('waiting', 3), 'waiting')
  assert.equal(k('failed'), 'failed')
  assert.equal(k('working'), 'working')
  assert.equal(k('idle', 0), null)
  assert.equal(k('idle', 4), 'unread', 'a count with no mode is unread')
  assert.equal(k('recording', 0), null)
})

test('glyphs: the count for unread, "?" waiting, "!" failed', () => {
  assert.equal(J.glyphFor('unread', 3), '3')
  assert.equal(J.glyphFor('unread', 0), '', 'the dot')
  assert.equal(J.glyphFor('unread', 250), '99+')
  assert.equal(J.glyphFor('waiting', 5), '?')
  assert.equal(J.glyphFor('failed', 1), '!')
  assert.equal(J.glyphFor('working', 1), '')
})

test('a dock seat\'s bot: paused shows nothing; a question outranks the mood', () => {
  assert.deepEqual(J.forBot({ mood: 'idle', waiting: 'question', needs_count: 2 }), { mode: 'waiting', count: 2 })
  assert.deepEqual(J.forBot({ mood: 'waiting', needs_count: 1 }), { mode: 'waiting', count: 1 })
  assert.deepEqual(J.forBot({ mood: 'failed' }), { mode: 'failed', count: 0 })
  assert.deepEqual(J.forBot({ mood: 'responded', needs_count: 0 }), { mode: 'unread', count: 0 })
  assert.deepEqual(J.forBot({ mood: 'working' }), { mode: 'working', count: 0 })
  assert.deepEqual(J.forBot({ mood: 'idle' }), { mode: null, count: 0 })
  assert.deepEqual(J.forBot({ mood: 'waiting', waiting: 'question', paused: true, needs_count: 3 }), { mode: null, count: 0 })
  assert.deepEqual(J.forBot(null), { mode: null, count: 0 })
})

test('bursts: a change within 400ms of the last waits for the window to end', () => {
  assert.deepEqual(J.burstStep(null, 1000), { animate: true, waitUntil: null })
  assert.deepEqual(J.burstStep(1000, 1399), { animate: false, waitUntil: 1400 })
  assert.deepEqual(J.burstStep(1000, 1400), { animate: true, waitUntil: null })
  assert.equal(J.BURST_MS, 400)
})

test('the tray title counts the same way', () => {
  assert.equal(trayTitle({ needs_you: 3 }), 'Config My AI · 3')
  assert.equal(trayTitle({ needs_you: 250 }), 'Config My AI · 99+')
  assert.equal(trayTitle({ needs_you: 0 }), 'Config My AI')
})
