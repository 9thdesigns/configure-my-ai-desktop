'use strict'

// The offline page is the one screen the desktop app draws itself, so its
// button has to follow the web app's button system (t419u): a solid-ink
// primary at size md (32px, 14px medium, rounded-lg, 10px like the web md button), soft press, a visible
// keyboard focus ring, and no emoji or pill/brand-blue leftovers.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'offline.html'), 'utf8')
const buttonRule = html.match(/\n\s*button \{([^}]*)\}/)[1]

test('the retry button is the primary md button', () => {
  assert.match(buttonRule, /height:\s*32px/)
  assert.match(buttonRule, /font-size:\s*14px/)
  assert.match(buttonRule, /font-weight:\s*500/)
  assert.match(buttonRule, /border-radius:\s*10px/)
  assert.match(buttonRule, /background:\s*var\(--btn-bg\)/)
  assert.doesNotMatch(html, /999px|#2563eb|#1d4ed8/, 'no pill or brand-blue leftovers')
})

test('it presses softly and shows a keyboard focus ring', () => {
  assert.match(html, /button:active \{[^}]*scale\(0\.98\)/)
  assert.match(html, /button:focus-visible \{[^}]*outline:/)
  assert.match(html, /prefers-reduced-motion: reduce/)
})

test('the page uses the web app body colours and no emoji in controls', () => {
  assert.match(html, /background:\s*#ffffff/)
  assert.match(html, /background:\s*#0a0a0a/)
  const button = html.match(/<button[^>]*>([^<]*)<\/button>/)[1]
  assert.doesNotMatch(button, /\p{Extended_Pictographic}/u)
})
