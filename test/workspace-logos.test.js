// Workspace logos in the switcher: logo vs fallback, the origin rule (for
// the URL and every redirect hop), the "Workspaces" label, the cache, and
// older feeds without logo_url.

const test = require('node:test')
const assert = require('node:assert/strict')
const fixture = require('./fixtures/widget.json')
const { WS, WS2 } = require('./ids')
const { widgetStateFrom } = require('../src/widget-state')
const { workspaceMenuItems, currentWorkspace, WORKSPACES_HEADER } = require('../src/workspaces')
const { trayMenuTemplate } = require('../src/tray')
const { isAppAssetUrl } = require('../src/url-policy')
const L = require('../src/workspace-logos')

const LOGO = 'https://configuremyai.com/rails/active_storage/blobs/9d.png'
const CDN_LOGO = 'https://assets.configuremyai.com/logos/sp.png'

// The feed as web now sends it: logo_url on each workspace, absolute or null.
const newFeed = {
  ...fixture,
  workspaces: [
    { ...fixture.workspaces[0], logo_url: LOGO, mark: { ...fixture.workspaces[0].mark, logo_url: null } },
    { ...fixture.workspaces[1], logo_url: null },
  ],
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

test('feed: logo_url is read per workspace and mirrored into the mark', () => {
  const s = widgetStateFrom(newFeed)
  assert.equal(s.workspaces[0].logo_url, LOGO)
  assert.equal(s.workspaces[0].mark.logo_url, LOGO, 'the dock mark draws it too')
  assert.equal(s.workspaces[1].logo_url, null)
  assert.equal(currentWorkspace(s).mark.logo_url, LOGO)
})

test('feed: an explicit null wins over an old mark logo', () => {
  const s = widgetStateFrom({ ...fixture, workspaces: [{ ...fixture.workspaces[0], logo_url: null }] })
  assert.equal(s.workspaces[0].logo_url, null)
  assert.equal(s.workspaces[0].mark.logo_url, null)
})

test('older feeds without logo_url still work (the mark logo, under the same rule; or initials)', () => {
  const s = widgetStateFrom(fixture)
  assert.equal(s.workspaces[0].logo_url, 'https://configuremyai.com/rails/active_storage/logo.png')
  assert.equal(s.workspaces[1].logo_url, null)
  const bare = widgetStateFrom({ workspace: { id: 'w', name: 'Solo' }, workspaces: [{ id: 'w', name: 'Solo' }] })
  assert.equal(bare.workspaces[0].logo_url, null)
  assert.deepEqual(workspaceMenuItems(bare, {}).map((i) => i.label), ['S  Solo'])
})

test('origin rule: only the app origin and its asset hosts, https, no credentials', () => {
  for (const ok of [LOGO, CDN_LOGO]) assert.equal(isAppAssetUrl(ok), true, ok)
  for (const bad of [
    'http://configuremyai.com/logo.png',
    'https://evil.example/logo.png',
    'https://configuremyai.com.evil.example/logo.png',
    'https://user:pw@configuremyai.com/logo.png',
    'data:image/png;base64,AAAA',
    'javascript:alert(1)',
    'not a url',
  ]) assert.equal(isAppAssetUrl(bad), false, bad)
  const s = widgetStateFrom({ ...fixture, workspaces: [{ ...fixture.workspaces[0], logo_url: 'https://evil.example/x.png' }] })
  assert.equal(s.workspaces[0].logo_url, null, 'an off-origin logo is dropped: fallback mark')
  const oldOff = widgetStateFrom({ ...fixture, workspaces: [{ ...fixture.workspaces[0], mark: { ...fixture.workspaces[0].mark, logo_url: 'https://evil.example/x.png' } }] })
  assert.equal(oldOff.workspaces[0].mark.logo_url, null, 'old feeds are held to the same rule')
})

test('switcher: a cached logo becomes the item icon; no logo (or not yet loaded) falls back to the mark', () => {
  const s = widgetStateFrom(newFeed)
  const icon = { fake: 'nativeImage' }
  const items = workspaceMenuItems(s, {}, { iconFor: (url) => (url === LOGO ? icon : null) })
  assert.equal(items[0].icon, icon)
  assert.equal(items[0].label, '9th Designs', 'the logo replaces the initials')
  assert.equal(items[1].icon, undefined)
  assert.equal(items[1].label, 'SP  Side Project')
  const loading = workspaceMenuItems(s, {}, { iconFor: () => null })
  assert.equal(loading[0].icon, undefined)
  assert.equal(loading[0].label, '9D  9th Designs', 'until the logo loads (or if it fails): the mark')
})

test('switcher: a small "Workspaces" label at the top when it opens', () => {
  const s = widgetStateFrom(newFeed)
  const calls = []
  const items = workspaceMenuItems(s, { switchWorkspace: (id) => calls.push(id) }, { header: true })
  assert.deepEqual(items[0], WORKSPACES_HEADER)
  assert.deepEqual(items[0], { id: 'workspaces-header', label: 'Workspaces', enabled: false })
  assert.equal(items[1].type, 'separator')
  assert.deepEqual(items.slice(2).map((i) => [i.id, i.checked]), [[`workspace-${WS}`, true], [`workspace-${WS2}`, false]])
  items[3].click()
  assert.deepEqual(calls, [WS2])
  assert.deepEqual(workspaceMenuItems(s, {}).map((i) => i.type), ['radio', 'radio'], 'no label unless asked')
  assert.deepEqual(workspaceMenuItems(null, {}, { header: true }), [])
  // The tray passes its icon lookup through.
  const tray = trayMenuTemplate(s, { iconFor: (url) => (url === LOGO ? 'ICON' : null) }, {})
  const sub = tray.find((x) => x.id === 'workspaces').submenu
  assert.equal(sub[0].label, 'Workspaces')
  assert.equal(sub[2].icon, 'ICON')
})

// A tiny fetch double: url → { status, headers, body }.
function fakeFetch (routes) {
  const seen = []
  const impl = async (url, init) => {
    seen.push([url, init])
    const r = routes[url]
    if (!r) throw new Error('network')
    const headers = new Map(Object.entries(r.headers || {}))
    return {
      status: r.status || 200,
      ok: (r.status || 200) >= 200 && (r.status || 200) < 300,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      arrayBuffer: async () => Uint8Array.from(r.body || [1, 2, 3]).buffer,
    }
  }
  return { impl, seen }
}

test('fetch: an image on the app origin loads, without cookies and with manual redirects', async () => {
  const { impl, seen } = fakeFetch({ [LOGO]: { headers: { 'content-type': 'image/png' } } })
  const buf = await L.fetchLogo(LOGO, { fetchImpl: impl })
  assert.deepEqual([...buf], [1, 2, 3])
  assert.deepEqual(seen[0][1], { redirect: 'manual', credentials: 'omit' })
})

test('fetch: every redirect hop is held to the origin rule', async () => {
  const { impl } = fakeFetch({
    [LOGO]: { status: 302, headers: { location: CDN_LOGO } },
    [CDN_LOGO]: { headers: { 'content-type': 'image/webp' } },
  })
  assert.equal((await L.fetchLogo(LOGO, { fetchImpl: impl })).length, 3)

  const off = fakeFetch({ [LOGO]: { status: 302, headers: { location: 'https://evil.example/x.png' } } })
  await assert.rejects(L.fetchLogo(LOGO, { fetchImpl: off.impl }), /not allowed/)
  assert.equal(off.seen.length, 1, 'the off-origin hop is never requested')

  await assert.rejects(L.fetchLogo('https://evil.example/x.png', { fetchImpl: impl }), /not allowed/)
})

test('fetch: non-images, oversize, errors and redirect loops are refused', async () => {
  const cases = {
    [LOGO]: { headers: { 'content-type': 'text/html' } },
    [CDN_LOGO]: { headers: { 'content-type': 'image/png', 'content-length': String(L.MAX_BYTES + 1) } },
  }
  const { impl } = fakeFetch(cases)
  await assert.rejects(L.fetchLogo(LOGO, { fetchImpl: impl }), /not an image/)
  await assert.rejects(L.fetchLogo(CDN_LOGO, { fetchImpl: impl }), /too large/)
  const svg = fakeFetch({ [LOGO]: { headers: { 'content-type': 'image/svg+xml' } } })
  await assert.rejects(L.fetchLogo(LOGO, { fetchImpl: svg.impl }), /not an image/, 'SVG: nativeImage cannot decode it')
  const err = fakeFetch({ [LOGO]: { status: 404 } })
  await assert.rejects(L.fetchLogo(LOGO, { fetchImpl: err.impl }), /404/)
  const loop = fakeFetch({ [LOGO]: { status: 301, headers: { location: LOGO } } })
  await assert.rejects(L.fetchLogo(LOGO, { fetchImpl: loop.impl }), /too many redirects/)
})

test('cache: loads once, tells subscribers, then serves from memory', async () => {
  let loads = 0
  const cache = L.createLogoCache({ load: async () => { loads++; return Buffer.from([1]) }, toIcon: () => 'ICON' })
  const heard = []
  cache.onChange((url) => heard.push(url))
  assert.equal(cache.iconFor(LOGO), null, 'not yet')
  assert.equal(cache.iconFor(LOGO), null, 'still loading: no second fetch')
  await flush()
  assert.equal(cache.iconFor(LOGO), 'ICON')
  assert.equal(loads, 1)
  assert.deepEqual(heard, [LOGO])
  assert.equal(cache.iconFor(null), null)
})

test('cache: a failure falls back and is not retried until RETRY_MS has passed', async () => {
  let t = 0
  let loads = 0
  let fail = true
  const cache = L.createLogoCache({ load: async () => { loads++; if (fail) throw new Error('x'); return Buffer.from([1]) }, toIcon: () => 'ICON', now: () => t })
  cache.iconFor(LOGO)
  await flush()
  assert.equal(cache.iconFor(LOGO), null)
  assert.equal(loads, 1, 'remembered failure')
  t += L.RETRY_MS
  fail = false
  cache.iconFor(LOGO)
  await flush()
  assert.equal(cache.iconFor(LOGO), 'ICON')
  assert.equal(loads, 2)
})

test('cache: bytes that do not decode count as a failure; warm() preloads the state\'s logos; size is bounded', async () => {
  const cache = L.createLogoCache({ load: async () => Buffer.from([1]), toIcon: () => null })
  cache.iconFor(LOGO)
  await flush()
  assert.equal(cache.iconFor(LOGO), null)

  const urls = []
  const warm = L.createLogoCache({ load: async (u) => { urls.push(u); return Buffer.from([1]) }, toIcon: () => 'I', maxEntries: 2 })
  warm.warm(widgetStateFrom(newFeed))
  await flush()
  assert.deepEqual(urls, [LOGO])
  for (const n of [1, 2, 3]) warm.iconFor(`${LOGO}?${n}`)
  await flush()
  assert.equal(warm.size(), 2)
})

test('electron icon: resized to 16px with a 32px @2x representation; undecodable → null', () => {
  const reps = []
  const fake = {
    createFromBuffer: (buf) => ({
      isEmpty: () => buf.length === 0,
      resize: ({ width, height }) => ({ toPNG: () => `png${width}x${height}` }),
    }),
    createEmpty: () => ({ addRepresentation: (r) => reps.push(r) }),
  }
  assert.ok(L.electronMenuIcon(fake, Buffer.from([1])))
  assert.deepEqual(reps.map((r) => [r.scaleFactor, r.width, r.height, r.buffer]), [[1, 16, 16, 'png16x16'], [2, 32, 32, 'png32x32']])
  assert.equal(L.electronMenuIcon(fake, Buffer.alloc(0)), null)
})
