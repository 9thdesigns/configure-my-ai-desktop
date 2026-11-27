const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { sanitizeAvatarHtml, validAvatar, validTree, validAvatarCssUrl, safeValue, cleanStyle, STATE_TOKEN } = require('../src/cfa-avatar')
const { widgetStateFrom, dockBots } = require('../src/widget-state')
const { createWidgetStore, createWidgetFeed } = require('../src/widget-feed')
const { widgetView } = require('../src/widget-window')
const { pickerBots } = require('../src/widget-seats')

const CFA_HTML = fs.readFileSync(path.join(__dirname, 'fixtures/cfa-avatar.html'), 'utf8')

// Every node of a tree, depth first.
function * walk (nodes) {
  for (const n of nodes) {
    if (typeof n === 'string') continue
    yield n
    yield * walk(n.c)
  }
}

const avatarFor = (state = 'working', extra = {}) => ({ html: CFA_HTML.replaceAll('working', state), color: '#7c5cff', shape: 'circle', state, image_url: null, initials: 'MX', ...extra })

function feedWithAvatars (extra = {}) {
  const f = structuredClone(fixture)
  f.avatar_css_url = 'https://configuremyai.com/assets/cfa-avatar-3f2a9c.css'
  f.manager.avatar = avatarFor('working')
  for (const seat of f.seats) seat.avatar = avatarFor('idle', { initials: seat.name.slice(0, 2) })
  return Object.assign(f, extra)
}

test('the CFA partial becomes a tree of allowlisted nodes, state lifted out', () => {
  const { tree, stateful } = sanitizeAvatarHtml(CFA_HTML)
  assert.equal(stateful, true)
  const [root] = tree
  assert.equal(root.t, 'span')
  assert.equal(root.ns, 'html')
  assert.equal(root.a['data-state'], STATE_TOKEN)
  assert.equal(root.a.class, `cfa-avatar cfa-avatar--circle cfa-avatar--${STATE_TOKEN}`)
  assert.equal(root.a['aria-hidden'], 'true')
  assert.deepEqual(root.s, { '--cfa-color': '#7c5cff', '--cfa-blink-delay': '-1.4s' })
  assert.equal(root.a.style, undefined, 'style never travels as an attribute')
  const svg = root.c.find((n) => n.t === 'svg')
  assert.equal(svg.ns, 'svg')
  assert.equal(svg.a.viewBox, '0 0 100 100', 'SVG attribute case is kept')
  const names = [...walk(tree)].map((n) => n.t)
  assert.ok(names.includes('radialGradient'))
  assert.ok(names.includes('ellipse'))
  const shine = [...walk(tree)].find((n) => n.a.class === 'cfa-avatar__shine')
  assert.equal(shine.a.fill, 'url(#cfa-glow)', 'same-document url(#…) is fine')
})

test('the sanitizer strips scripts, event handlers and external URLs', () => {
  const evil = `
    <span class="cfa-avatar" onclick="alert(1)" onmouseover=alert(2) style="--a: red; background: url(https://evil.test/x.png); --b: url(https://evil.test/y); --c: expression(alert(1)); color: blue">
      <script>alert('x')</script>
      <img src="https://evil.test/p.png" onerror="alert(3)">
      <iframe src="https://evil.test"></iframe>
      <a href="javascript:alert(4)">link</a>
      <svg viewBox="0 0 10 10" onload="alert(5)">
        <script type="text/javascript">alert(6)</script>
        <use href="https://evil.test/sprite.svg#face"/>
        <use xlink:href="#local-face"/>
        <image href="https://evil.test/i.png"/>
        <foreignObject><div onclick="x()">hi</div></foreignObject>
        <path d="M0 0" fill="url(https://evil.test/f)" stroke="url(#ok)" style="--d: 1"/>
        <animate attributeName="href" to="javascript:alert(7)"/>
        <circle r="2" filter="url(//evil.test/f)" fill="javascript:alert(8)"/>
      </svg>
      <style>@import url(https://evil.test/a.css)</style>
      Hi &lt;b&gt;
    </span>`
  const { tree } = sanitizeAvatarHtml(evil)
  const json = JSON.stringify(tree)
  assert.doesNotMatch(json, /evil\.test/)
  assert.doesNotMatch(json, /javascript/i)
  assert.doesNotMatch(json, /alert/)
  assert.doesNotMatch(json, /"on[a-z]+"/)
  const names = [...walk(tree)].map((n) => n.t)
  for (const bad of ['script', 'img', 'iframe', 'a', 'image', 'foreignObject', 'div', 'animate', 'style']) assert.ok(!names.includes(bad), bad)
  const [span] = tree
  assert.deepEqual(span.s, { '--a': 'red', color: 'blue' })
  const uses = [...walk(tree)].filter((n) => n.t === 'use')
  assert.deepEqual(uses.map((u) => u.a.href), [undefined, '#local-face'])
  const p = [...walk(tree)].find((n) => n.t === 'path')
  assert.equal(p.a.fill, undefined)
  assert.equal(p.a.stroke, 'url(#ok)')
  const circle = [...walk(tree)].find((n) => n.t === 'circle')
  assert.equal(circle.a.filter, undefined)
  assert.equal(circle.a.fill, undefined)
  assert.ok(span.c.some((c) => typeof c === 'string' && c.includes('Hi <b>')), 'text stays text')
})

test('values and styles: only what cannot load or run', () => {
  assert.equal(safeValue('url(#grad)'), true)
  assert.equal(safeValue('var(--cfa-size, 40px)'), true)
  for (const bad of ['url(x.png)', 'url( "https://e.test" )', 'javascript:x', 'data:text/html,1', 'a\\75rl(x)', '<b>', 'expression(1)']) {
    assert.equal(safeValue(bad), false, bad)
  }
  assert.deepEqual(cleanStyle('--x: 1px; position: fixed; --y: url(https://e.test); animation-delay: -2s !important'), { '--x': '1px', 'animation-delay': '-2s' })
})

test('a re-checked tree keeps only what the sanitizer could have made', () => {
  const tree = [{ t: 'span', ns: 'html', a: { class: 'x', onclick: 'a()', href: 'https://e.test' }, s: { '--k': '1', position: 'fixed' }, c: [{ t: 'script', ns: 'html', a: {}, s: {}, c: [] }, { t: 'path', ns: 'html', a: {}, s: {}, c: [] }, 'hi'] }]
  assert.deepEqual(validTree(tree), [{ t: 'span', ns: 'html', a: { class: 'x' }, s: { '--k': '1' }, c: ['hi'] }])
})

test('avatar markup is only kept from our own origin', () => {
  const f = feedWithAvatars()
  const trusted = widgetStateFrom(f, { trusted: true })
  assert.ok(trusted.manager.avatar.tree)
  assert.equal(trusted.manager.avatar.state, 'working')
  assert.equal(trusted.avatar_css_url, 'https://configuremyai.com/assets/cfa-avatar-3f2a9c.css')

  const untrusted = widgetStateFrom(f)
  assert.equal(untrusted.manager.avatar.tree, null, 'no markup from elsewhere')
  assert.equal(untrusted.manager.avatar.initials, 'MX', 'but the initials and colour still come through')
  assert.equal(untrusted.avatar_css_url, null)

  const store = createWidgetStore()
  store.apply(f, 'page', { origin: 'https://evil.test/page' })
  assert.equal(store.get().manager.avatar.tree, null)
  store.apply(f, 'page', { origin: 'http://configuremyai.com/home' })
  assert.equal(store.get().manager.avatar.tree, null, 'plain http is not our origin')
  store.apply(f, 'page', { origin: 'https://configuremyai.com/home' })
  assert.ok(store.get().manager.avatar.tree)
  // An optimistic edit keeps the (re-checked) tree.
  store.update((s) => ({ ...s, focused_bot_id: s.seats[0].bot_id }))
  assert.ok(store.get().manager.avatar.tree)
})

test('the feed trusts its own responses from APP_URL', async () => {
  const store = createWidgetStore()
  const feed = createWidgetFeed({ store, request: async () => ({ status: 200, json: feedWithAvatars(), url: 'https://configuremyai.com/desktop/widget.json' }) })
  assert.equal(await feed.refresh(), true)
  assert.ok(store.get().manager.avatar.tree)
  assert.ok(store.get().avatar_css_url)
})

test('the stylesheet URL must be https on our origin', () => {
  assert.equal(validAvatarCssUrl('https://configuremyai.com/assets/a-1.css'), 'https://configuremyai.com/assets/a-1.css')
  assert.equal(validAvatarCssUrl('https://cdn.configuremyai.com/assets/a-1.css'), 'https://cdn.configuremyai.com/assets/a-1.css')
  for (const bad of ['http://configuremyai.com/a.css', 'https://evil.test/a.css', 'https://configuremyai.com.evil.test/a.css', 'https://u:p@configuremyai.com/a.css', null, 42]) {
    assert.equal(validAvatarCssUrl(bad), null, String(bad))
  }
})

test('an older server (no avatar) keeps the old fields and no avatar', () => {
  const state = widgetStateFrom(fixture, { trusted: true })
  assert.equal(state.manager.avatar, null)
  assert.equal(state.avatar_css_url, null)
  const view = widgetView(state)
  assert.equal(view.bots[0].avatar, null)
  assert.equal(view.bots[0].avatar_color, state.manager.avatar_color)
})

test('the avatar reaches the dock, the seats picker and the island', () => {
  const state = widgetStateFrom(feedWithAvatars(), { trusted: true })
  const view = widgetView(state)
  assert.ok(view.bots.every((b) => b.avatar && b.avatar.tree))
  assert.ok(pickerBots(state).every((b) => b.avatar && b.avatar.tree))
  assert.equal(dockBots(state)[0].avatar.state, 'working')
})

test('the same face in two states has the same key; bad fields are dropped', () => {
  const a = validAvatar(avatarFor('idle'), { trusted: true })
  const b = validAvatar(avatarFor('working'), { trusted: true })
  assert.equal(a.key, b.key)
  assert.equal(a.state, 'idle')
  assert.equal(b.state, 'working')
  const odd = validAvatar({ html: CFA_HTML, state: 'exploding', shape: 'hexagon<', color: 'red', image_url: 'http://x.test/a.png', initials: '<b>Ab</b>' }, { trusted: true })
  assert.equal(odd.state, 'idle')
  assert.equal(odd.shape, null)
  assert.equal(odd.color, null)
  assert.equal(odd.image_url, null)
  assert.equal(odd.initials, 'BAB')
  assert.equal(validAvatar('nope'), null)
})

// The real partial's structure (configure-my-ai #1588): spans and <i>s, one
// svg with a ~14KB brand-mark path, role / aria-label, xmlns, fill-rule and
// the state on data-cfa-state.
test('the real CFA partial survives intact, long path and all', () => {
  const real = fs.readFileSync(path.join(__dirname, 'fixtures/cfa-avatar-real.html'), 'utf8')
  const d = /<path d="([^"]+)"/.exec(real)[1]
  assert.ok(d.length > 13000, 'the fixture carries a long path')
  const { tree, stateful } = sanitizeAvatarHtml(real)
  assert.equal(stateful, true)
  const [root] = tree
  assert.equal(root.t, 'span')
  assert.equal(root.a.class, 'cfa-avatar')
  assert.equal(root.a.role, 'img')
  assert.equal(root.a['aria-label'], 'Configure My AI')
  assert.equal(root.a['data-cfa-shape'], 'samurai')
  assert.equal(root.a['data-cfa-tone'], 'light')
  assert.equal(root.a['data-cfa-state'], STATE_TOKEN)
  assert.deepEqual(root.s, { '--cfa-tint': '#5b8def' })
  const nodes = [...walk(tree)]
  const classes = nodes.map((n) => n.a.class)
  for (const part of ['cfa-avatar__aura', 'cfa-avatar__body', 'cfa-avatar__orb', 'cfa-avatar__skin', 'cfa-avatar__circuit', 'cfa-avatar__rim', 'cfa-avatar__face', 'cfa-avatar__brows', 'cfa-avatar__eyes', 'cfa-avatar__mouth']) {
    assert.ok(classes.includes(part), part)
  }
  assert.equal(nodes.filter((n) => n.t === 'i').length, 4, 'two brows and two irises')
  const svg = nodes.find((n) => n.t === 'svg')
  assert.deepEqual(svg.a, { class: 'cfa-avatar__mark', viewBox: '0 0 420.1 512.0', xmlns: 'http://www.w3.org/2000/svg', fill: 'currentColor', 'fill-rule': 'evenodd', role: 'img', 'aria-label': 'Configure My AI' })
  const p = nodes.find((n) => n.t === 'path')
  assert.equal(p.a.d, d, 'the path is not truncated or dropped')
  // The same partial in another state is the same face.
  assert.equal(validAvatar({ html: real, state: 'working' }, { trusted: true }).key, validAvatar({ html: real.replace('data-cfa-state="working"', 'data-cfa-state="idle"'), state: 'idle' }, { trusted: true }).key)
})

test('geometry may be long but only numbers and path commands', () => {
  assert.equal(safeValue('M0 0 '.repeat(5000), 'd'), true)
  assert.equal(safeValue('M0 0 url(https://e.test)', 'd'), false)
  assert.equal(safeValue('x'.repeat(3000), 'fill'), false)
})
