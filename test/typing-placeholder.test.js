// The composer placeholder's pure rules (src/typing-placeholder.js): the
// word-boundary cut at rest, and the caret-following offset that never
// goes back down.

const test = require('node:test')
const assert = require('node:assert/strict')
const { fitAtWord, nextOffset } = require('../src/typing-placeholder')

// A monospace stand-in: each character is 1 unit wide.
const fitsIn = (n) => (text) => text.length <= n

test('at rest: the whole hint when it fits', () => {
  assert.equal(fitAtWord('Message Ada…', fitsIn(40)), 'Message Ada…')
  assert.equal(fitAtWord('Ask anything', fitsIn(12)), 'Ask anything')
})

test('at rest: else the head cut at a word, with one trailing ellipsis', () => {
  const hint = 'Reply to Ada or give a new task…'
  assert.equal(fitAtWord(hint, fitsIn(20)), 'Reply to Ada or…')
  assert.equal(fitAtWord(hint, fitsIn(13)), 'Reply to Ada…')
  assert.equal(fitAtWord(hint, fitsIn(9)), 'Reply to…')
  // Never mid-word: 15 units would allow "Reply to Ada or" + "…" = 16 → falls back a word.
  assert.equal(fitAtWord(hint, fitsIn(15)), 'Reply to Ada…')
  // Trailing punctuation goes before the ellipsis.
  assert.equal(fitAtWord('Hello there, friend of mine', fitsIn(14)), 'Hello there…')
  // A hint without its own ellipsis gets one.
  assert.equal(fitAtWord('Ask Ada anything at all', fitsIn(17)), 'Ask Ada anything…')
})

test('at rest: when not even a word fits, the first word and the ellipsis (the box clips it)', () => {
  assert.equal(fitAtWord('Supercalifragilistic word', fitsIn(5)), 'Supercalifragilistic…')
  assert.equal(fitAtWord('Supercalifragilistic', fitsIn(5)), 'Supercalifragilistic…')
})

test('typing: the offset is the typed width past the room, and never decreases', () => {
  assert.equal(nextOffset(0, 120, 200), 0)
  assert.equal(nextOffset(0, 210.2, 200), 11)
  assert.equal(nextOffset(11, 205, 200), 11, 'a narrower glyph never pulls it back')
  assert.equal(nextOffset(11, 260, 200), 60)
  assert.equal(nextOffset(undefined, 10, 200), 0)
})
