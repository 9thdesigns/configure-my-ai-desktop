// The web app's chat tokens sheet (src/chat-tokens.js): only its own
// fingerprinted URL, only custom properties in the agreed blocks, nothing
// that names a resource, and a sheet without the known tokens refused. The
// state keeps chat_css_url from our own origin only.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sanitizeChatTokens, validChatCssUrl, TOKENS, MAX_BYTES } = require('../src/chat-tokens')
const { createAvatarCssCache } = require('../src/avatar-css')
const { widgetStateFrom } = require('../src/widget-state')
const fixture = require('./fixtures/widget.json')

const URL_OK = 'https://configuremyai.com/desktop/chat_tokens-3f2a9c0d.css'
const SHEET = `/* chat tokens */
:root { --bubble-gap-same: 5px; --bubble-gap-change: 16px; --bubble-user-bg: #111; --chat-font-family: "Inter", system-ui, sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bubble-user-bg: #eee; --composer-bg: rgb(30 30 30 / 90%); } }
:root[data-theme="dark"] { --bubble-user-bg: #eee; }`

test('chat_css_url: our origin, the fingerprinted path, nothing else', () => {
  assert.equal(validChatCssUrl(URL_OK), URL_OK)
  for (const bad of [
    'https://evil.test/desktop/chat_tokens-3f2a9c0d.css',
    'http://configuremyai.com/desktop/chat_tokens-3f2a9c0d.css',
    'https://configuremyai.com/desktop/chat_tokens.css',
    'https://configuremyai.com/desktop/chat_tokens-XYZ.css',
    'https://configuremyai.com/desktop/chat_tokens-3f2a9c0d.css?x=1',
    'https://configuremyai.com/assets/chat_tokens-3f2a9c0d.css',
    'https://u:p@configuremyai.com/desktop/chat_tokens-3f2a9c0d.css',
    42, null, '',
  ]) assert.equal(validChatCssUrl(bad), null, String(bad))
})

test('the sheet is rebuilt from its custom properties, in the agreed blocks', () => {
  const out = sanitizeChatTokens(SHEET)
  assert.equal(out, [
    ':root { --bubble-gap-same: 5px; --bubble-gap-change: 16px; --bubble-user-bg: #111; --chat-font-family: "Inter", system-ui, sans-serif; }',
    '@media (prefers-color-scheme: dark) { :root { --bubble-user-bg: #eee; --composer-bg: rgb(30 30 30 / 90%); } }',
    ':root[data-theme="dark"] { --bubble-user-bg: #eee; }',
  ].join('\n'))
})

test('anything else goes: other selectors and properties, resources, at-rules, markup', () => {
  const out = sanitizeChatTokens(`@import url(https://evil.test/a.css);
@font-face { font-family: x; src: url(https://evil.test/f.woff2); }
body { background: red; }
.message { --bubble-radius: 0; }
:root { color: red; --bubble-radius: 20px; --x-bg: url(https://evil.test/i.png); --y: image-set("a.png" 1x); --z: \\75rl(x); --w: </style><script>; }
@media print { :root { --bubble-pad-x: 99px; } }
@media (prefers-color-scheme: dark) { .x { --bubble-pad-x: 1px; } :root { --bubble-pad-y: 7px; } }
@supports (display: grid) { :root { --bubble-pad-x: 2px; } }`)
  assert.equal(out, ':root { --bubble-radius: 20px; }\n@media (prefers-color-scheme: dark) { :root { --bubble-pad-y: 7px; } }')
  assert.doesNotMatch(out, /evil|url|import|font-face|script|99px|color: red/)
})

test('a sheet without a known token, unbalanced, empty or too big is refused', () => {
  assert.equal(sanitizeChatTokens(':root { --something-else: 1px; }'), null)
  assert.equal(sanitizeChatTokens(':root { --bubble-radius: 20px;'), null)
  assert.equal(sanitizeChatTokens('body { color: red }'), null)
  assert.equal(sanitizeChatTokens(''), null)
  assert.equal(sanitizeChatTokens(null), null)
  assert.equal(sanitizeChatTokens(`:root { --bubble-radius: 20px; } /* ${'x'.repeat(MAX_BYTES)} */`), null)
  // Unknown tokens ride along once a known one is there (forward-compatible).
  assert.match(sanitizeChatTokens(':root { --bubble-radius: 20px; --new-token: 3px; }'), /--new-token: 3px/)
})

test('every token the widget reads is set in widget.css (the bundled fallback)', () => {
  const css = fs.readFileSync(path.join(__dirname, '../src/widget.css'), 'utf8')
  for (const name of TOKENS) assert.match(css, new RegExp(`${name}:`), name)
})

test('the shared cache takes the chat pair: our URL only, sanitised, kept on disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-css-'))
  const fetched = []
  const cache = createAvatarCssCache({ dir, fetchText: async (url) => { fetched.push(url); return SHEET }, sanitize: sanitizeChatTokens, validUrl: validChatCssUrl })
  assert.equal(await cache.get('https://configuremyai.com/assets/cfa-avatar-3f2a9c.css'), null, 'an avatar-sheet URL is not a chat URL')
  assert.equal(await cache.get(URL_OK), sanitizeChatTokens(SHEET))
  const again = createAvatarCssCache({ dir, fetchText: async () => { throw new Error('offline') }, sanitize: sanitizeChatTokens, validUrl: validChatCssUrl })
  assert.equal(await again.get(URL_OK), sanitizeChatTokens(SHEET), 'from disk, offline')
  assert.deepEqual(fetched, [URL_OK])
})

test('the state keeps chat_css_url from our own origin only', () => {
  const f = { ...structuredClone(fixture), chat_css_url: URL_OK }
  assert.equal(widgetStateFrom(f, { trusted: true }).chat_css_url, URL_OK)
  assert.equal(widgetStateFrom(f).chat_css_url, null)
  assert.equal(widgetStateFrom({ ...f, chat_css_url: 'https://evil.test/x.css' }, { trusted: true }).chat_css_url, null)
  assert.equal(widgetStateFrom(structuredClone(fixture), { trusted: true }).chat_css_url, null, 'an older server: none')
})
