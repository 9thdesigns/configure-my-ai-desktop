const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { sanitizeAvatarCss, createAvatarCssCache, cacheName } = require('../src/avatar-css')

const URL_A = 'https://configuremyai.com/assets/cfa-avatar-3f2a9c.css'
const CSS = `.cfa-avatar { width: var(--cfa-size, 40px); height: var(--cfa-size, 40px); }
@keyframes cfa-blink { 0%, 96%, 100% { transform: scaleY(1); } 98% { transform: scaleY(0.1); } }
.cfa-avatar--working .cfa-avatar__eye { animation: cfa-blink 4s infinite; }
@media (prefers-reduced-motion: reduce) { .cfa-avatar * { animation: none !important; } }`

test('the stylesheet keeps its rules and loses anything that could fetch', () => {
  assert.equal(sanitizeAvatarCss(CSS), CSS)
  const evil = `@import url("https://evil.test/a.css");
@import 'https://evil.test/b.css';
@font-face { font-family: x; src: url(https://evil.test/f.woff2); }
.a { background: url(https://evil.test/bg.png); mask: url('#ok'); }
.b { background-image: image-set("https://evil.test/i.png" 1x); }
.c { list-style: url(data:image/png;base64,AAAA); }
</style><script>alert(1)</script>`
  const out = sanitizeAvatarCss(evil)
  assert.doesNotMatch(out, /evil\.test/)
  assert.doesNotMatch(out, /@import|@font-face|<\/?(style|script)/i)
  assert.match(out, /url\('#ok'\)/)
  assert.match(out, /url\(data:image\/png/)
  assert.equal(sanitizeAvatarCss(''), null)
  assert.equal(sanitizeAvatarCss('x'.repeat(300 * 1024)), null)
})

test('fetched once per URL, cached on disk, and read back offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-css-'))
  let fetches = 0
  const cache = createAvatarCssCache({ dir, fetchText: async () => { fetches++; return CSS } })
  assert.equal(await cache.get(URL_A), CSS)
  assert.equal(await cache.get(URL_A), CSS)
  assert.equal(fetches, 1)
  assert.ok(fs.existsSync(path.join(dir, cacheName(URL_A))))

  // A later launch, offline: the disk copy, no fetch.
  const offline = createAvatarCssCache({ dir, fetchText: async () => { throw new Error('offline') } })
  assert.equal(await offline.get(URL_A), CSS)
})

test('a failed fetch is not remembered, and foreign URLs are never fetched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfa-css-'))
  let ok = false
  const asked = []
  const cache = createAvatarCssCache({ dir, fetchText: async (url) => { asked.push(url); return ok ? CSS : null } })
  assert.equal(await cache.get(URL_A), null)
  ok = true
  assert.equal(await cache.get(URL_A), CSS)
  assert.equal(await cache.get('https://evil.test/a.css'), null)
  assert.equal(await cache.get('http://configuremyai.com/a.css'), null)
  assert.deepEqual(asked, [URL_A, URL_A])
})
