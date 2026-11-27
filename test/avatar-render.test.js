const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { validAvatar } = require('../src/cfa-avatar')
const CfaAvatar = require('../src/avatar-render')

const CFA_HTML = fs.readFileSync(path.join(__dirname, 'fixtures/cfa-avatar.html'), 'utf8')

// Just enough DOM for avatar-render.js: elements, attributes, classList,
// dataset, a CSSOM style, and a record of every node ever created.
function fakeDocument ({ reducedMotion = false } = {}) {
  const created = []
  const listeners = {}
  class Node {
    constructor (doc, tag, ns) {
      this.ownerDocument = doc
      this.tagName = tag
      this.namespaceURI = ns
      this.attributes = {}
      this.children = []
      this.dataset = {}
      this.props = {}
      const self = this
      this.style = {
        background: '',
        color: '',
        setProperty (k, v) { self.props[k] = v },
      }
      this.classList = {
        add: (t) => { const set = this.classSet(); set.add(t); this.attributes.class = [...set].join(' ') },
        remove: (t) => { const set = this.classSet(); set.delete(t); this.attributes.class = [...set].join(' ') },
        contains: (t) => this.classSet().has(t),
      }
      this.isConnected = true
      created.push(this)
    }

    classSet () { return new Set((this.attributes.class || '').split(/\s+/).filter(Boolean)) }
    setAttribute (k, v) {
      if (k === 'style') throw new Error('CSP: no style attributes')
      this.attributes[k] = String(v)
    }

    getAttribute (k) { return this.attributes[k] ?? null }
    removeAttribute (k) { delete this.attributes[k] }
    toggleAttribute (k, on) { if (on) this.attributes[k] = ''; else delete this.attributes[k]; return on }
    append (...nodes) { this.children.push(...nodes) }
    replaceChildren () { this.children = [] }
    set textContent (v) { this.children = v ? [{ text: String(v) }] : [] }
    get textContent () { return this.children.map((c) => c.text ?? c.textContent ?? '').join('') }
    set innerHTML (_v) { throw new Error('innerHTML must never be used') }
  }
  const doc = {
    created,
    documentElement: null,
    visibilityState: 'visible',
    createElement: (tag) => new Node(doc, tag, 'html'),
    createElementNS: (ns, tag) => new Node(doc, tag, ns),
    createTextNode: (text) => ({ text }),
    addEventListener: (type, fn) => { listeners[type] = fn },
    fire: (type) => listeners[type] && listeners[type](),
  }
  doc.documentElement = new Node(doc, 'html', 'html')
  const win = {
    matchMedia: (q) => ({ matches: q === CfaAvatar.REDUCED_MOTION && reducedMotion, addEventListener () {} }),
  }
  return { doc, win, box: () => new Node(doc, 'span', 'html') }
}

const bot = (avatarInput, extra = {}) => ({
  id: 'b1',
  name: 'Ada Lovelace',
  avatar_url: null,
  avatar_color: '#30a46c',
  avatar_shape: 'circle',
  avatar: avatarInput === undefined ? undefined : validAvatar(avatarInput, { trusted: true }),
  ...extra,
})
const face = (state, extra = {}) => ({ html: CFA_HTML.replaceAll('working', state), color: '#7c5cff', shape: 'circle', state, image_url: null, initials: 'AL', ...extra })

test('precedence: image beats the CFA face, which beats initials', () => {
  assert.equal(CfaAvatar.plan(bot(face('idle', { image_url: 'https://cdn.test/a.png' }))).mode, 'image')
  assert.equal(CfaAvatar.plan(bot(face('idle'))).mode, 'cfa')
  const none = CfaAvatar.plan(bot({ color: '#7c5cff', initials: 'AL', state: 'idle' }))
  assert.equal(none.mode, 'initials')
  assert.equal(none.initials, 'AL')
  assert.equal(none.color, '#7c5cff')
  // With an `avatar`, the legacy avatar_url (the manager's workspace logo)
  // does not hide the face.
  assert.equal(CfaAvatar.plan(bot(face('idle'), { avatar_url: 'https://cdn.test/logo.png' })).mode, 'cfa')
})

test('an older feed (no avatar) keeps the picture-or-initials path', () => {
  assert.deepEqual(
    (({ mode, initials, color, shape }) => ({ mode, initials, color, shape }))(CfaAvatar.plan(bot(undefined))),
    { mode: 'initials', initials: 'AL', color: '#30a46c', shape: 'circle' },
  )
  assert.equal(CfaAvatar.plan(bot(undefined, { avatar_url: 'https://cdn.test/a.png' })).mode, 'image')
  assert.equal(CfaAvatar.plan(bot(null)).mode, 'initials')

  const { box } = fakeDocument()
  const node = box()
  CfaAvatar.paint(node, bot(undefined))
  assert.equal(node.dataset.mode, 'initials')
  assert.equal(node.textContent, 'AL')
  assert.equal(node.style.background, '#30a46c')
})

test('the face is built from the tree with the CSSOM, never innerHTML or style attributes', () => {
  const { doc, box } = fakeDocument()
  const node = box()
  CfaAvatar.paint(node, bot(face('working')))
  assert.equal(node.dataset.mode, 'cfa')
  assert.equal(node.dataset.state, 'working')
  const [span] = node.children
  assert.equal(span.attributes['data-state'], 'working')
  assert.ok(span.classList.contains('cfa-avatar--working'))
  assert.equal(span.props['--cfa-color'], '#7c5cff')
  const svg = span.children.find((c) => c.tagName === 'svg')
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg')
  assert.equal(svg.attributes.viewBox, '0 0 100 100')
  assert.ok(doc.created.length > 5)
})

test('a state swap changes the live nodes without re-mounting them', () => {
  const { doc, box } = fakeDocument()
  const node = box()
  CfaAvatar.paint(node, bot(face('idle')))
  const span = node.children[0]
  const count = doc.created.length
  span.classList.add('added-by-css-hover')

  CfaAvatar.paint(node, bot(face('working')))
  assert.equal(node.children[0], span, 'same element: the animation keeps running')
  assert.equal(doc.created.length, count, 'nothing new was created')
  assert.equal(node.dataset.state, 'working')
  assert.equal(span.attributes['data-state'], 'working')
  assert.ok(span.classList.contains('cfa-avatar--working'))
  assert.ok(!span.classList.contains('cfa-avatar--idle'))
  assert.ok(span.classList.contains('cfa-avatar--circle'))
  assert.ok(span.classList.contains('added-by-css-hover'), 'other classes are left alone')

  // Repainting the same state is a no-op.
  CfaAvatar.paint(node, bot(face('working')))
  assert.equal(doc.created.length, count)

  // A different face does re-mount.
  CfaAvatar.paint(node, bot(face('working', { html: CFA_HTML.replace('cx="50" cy="50" r="46"', 'cx="50" cy="52" r="44"') })))
  assert.notEqual(node.children[0], span)
})

test('a picture that fails falls back to the face, then initials', () => {
  const { box } = fakeDocument()
  const node = box()
  CfaAvatar.paint(node, bot(face('idle', { image_url: 'https://cdn.test/broken.png' })))
  assert.equal(node.dataset.mode, 'image')
  node.children[0].onerror()
  assert.equal(node.dataset.mode, 'cfa')

  const other = box()
  CfaAvatar.paint(other, bot({ initials: 'AL', image_url: 'https://cdn.test/broken.png', state: 'idle' }))
  other.children[0].onerror()
  assert.equal(other.dataset.mode, 'initials')
  assert.equal(other.textContent, 'AL')
})

test('reduced motion marks the page static; hidden windows pause', () => {
  const reduced = fakeDocument({ reducedMotion: true })
  CfaAvatar.watch(reduced.win, reduced.doc)
  assert.equal(reduced.doc.documentElement.dataset.motion, 'reduce')
  assert.equal(CfaAvatar.prefersReducedMotion(reduced.win), true)

  const full = fakeDocument()
  CfaAvatar.watch(full.win, full.doc)
  assert.equal(full.doc.documentElement.dataset.motion, 'full')
  assert.equal('data-cfa-paused' in full.doc.documentElement.attributes, false)
  full.doc.visibilityState = 'hidden'
  full.doc.fire('visibilitychange')
  assert.equal('data-cfa-paused' in full.doc.documentElement.attributes, true)
  full.doc.visibilityState = 'visible'
  full.doc.fire('visibilitychange')
  assert.equal('data-cfa-paused' in full.doc.documentElement.attributes, false)
})

test('the CSS turns the reduced-motion and paused flags into a static face', () => {
  for (const file of ['widget.css', 'island.css']) {
    const css = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    assert.match(css, /:root\[data-motion="reduce"\] \.avatar\[data-mode="cfa"\] \* \{ animation: none !important/, file)
    assert.match(css, /:root\[data-cfa-paused\] \.avatar\[data-mode="cfa"\] \*/, file)
    assert.match(css, /\[data-offscreen\] \* \{ animation-play-state: paused !important; \}/, file)
    // A whole-pixel size, or the slot variable that holds one (avatar-geometry.test.js).
    assert.match(css, /--cfa-size: (\d+px|var\(--[a-z-]+\))/, file)
  }
})

test('the pages load the renderer, keep their strict CSP, and never use innerHTML', () => {
  for (const [html, view] of [['widget.html', 'widget-view.js'], ['island.html', 'island-view.js']]) {
    const page = fs.readFileSync(path.join(__dirname, '../src', html), 'utf8')
    assert.match(page, /<script src="avatar-render.js"><\/script>\s*<script src="[a-z-]+\.js"><\/script>/)
    assert.match(page, /default-src 'none'; script-src 'self'; style-src 'self';/)
    assert.doesNotMatch(page, /unsafe-inline|unsafe-eval/)
    const js = fs.readFileSync(path.join(__dirname, '../src', view), 'utf8')
    assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|outerHTML/)
  }
  const renderer = fs.readFileSync(path.join(__dirname, '../src/avatar-render.js'), 'utf8')
  assert.doesNotMatch(renderer.replace(/\/\/.*$/gm, ''), /innerHTML|insertAdjacentHTML|outerHTML|eval\(/)
})

// The live CFA sheet sets --cfa-size: 72px on .cfa-avatar itself, which beats
// an inherited value; the slot's size has to be handed to the face directly.
test('each slot hands its size to the face, over the sheet default', () => {
  for (const file of ['widget.css', 'island.css']) {
    const css = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8')
    assert.match(css, /\.avatar\[data-mode="cfa"\] > \.cfa-avatar \{ --cfa-size: inherit; \}/, file)
  }
})
