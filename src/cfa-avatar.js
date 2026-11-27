'use strict'

// The animated CFA avatars, as the web app renders them, made safe for the
// widget windows (the dock, its seats and quick chat, and the island).
//
// GET /desktop/widget.json (and the page's own publish) gives the manager and
// every bot an `avatar`:
//
//   { html, color, shape, state, image_url, initials }
//
// where html is the CFA avatar partial exactly as the web app renders it,
// sized by --cfa-size, and avatar_css_url (top level) is the stylesheet with
// its styles and animations (avatar-css.js loads that).
//
// The markup is never inserted as HTML. Here, in main, it is parsed into a
// small tree of { t, ns, a, s, c } nodes, keeping only the elements and
// attributes the CFA partial uses (span, div, svg and its shapes; class,
// data-*, aria-hidden, viewBox, the SVG geometry and paint attributes) and
// only custom properties (plus a few harmless ones) from style. Scripts,
// event handlers, foreign content and every URL but a same-document
// "#fragment" are dropped. The renderer (avatar-render.js) builds DOM nodes
// from that tree with createElement / setAttribute / style.setProperty, so
// the windows' CSP (no inline style, no inline script) stays as strict as it
// was.
//
// The markup is only kept when the state came from our own origin (the
// configured APP_URL, src/url-policy.js): the server's feed, or a publish
// from the app's own page. Anything else gets the picture or the initials.
//
// The bot's state (idle, working, …) is lifted out of the tree: attributes
// and class names that carry it are marked, so the renderer can swap the
// state on the live nodes without re-mounting them (and without restarting
// the animation), and so the same face in two states has the same key.
//
// Pure, so it is unit-tested without Electron (test/cfa-avatar.test.js).

const crypto = require('node:crypto')
const { isAppUrl } = require('./url-policy')

const STATES = Object.freeze(['idle', 'ack', 'thinking', 'working', 'waiting', 'blocked', 'done', 'sleeping'])
const SHAPES = Object.freeze(['circle', 'square', 'triangle', 'cloud', 'samurai', 'astronaut'])

const MAX_HTML = 32 * 1024
const MAX_NODES = 400
const MAX_DEPTH = 16
const MAX_TEXT = 200
const MAX_ATTR = 2000
const MAX_URL = 2048

// The marker the renderer replaces with the live state.
const STATE_TOKEN = '{state}'

// Element allowlist: lowercase name → canonical name and namespace.
const HTML_ELEMENTS = ['span', 'div', 'i', 'b', 'em', 'strong', 'small']
const SVG_ELEMENTS = [
  'svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use', 'symbol', 'title', 'desc',
]
const ELEMENTS = new Map([
  ...HTML_ELEMENTS.map((name) => [name, { name, ns: 'html' }]),
  ...SVG_ELEMENTS.map((name) => [name.toLowerCase(), { name, ns: 'svg' }]),
])

// Attribute allowlist (beyond class, style, data-* and aria-*): lowercase →
// canonical (SVG attributes are case-sensitive in the DOM).
const ATTRIBUTES = new Map([
  'id', 'role', 'focusable', 'tabindex', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'pathLength', 'viewBox', 'preserveAspectRatio',
  'fill', 'fill-opacity', 'fill-rule', 'clip-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit',
  'opacity', 'transform', 'transform-origin', 'offset', 'stop-color', 'stop-opacity',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'fx', 'fy', 'fr',
  'clip-path', 'mask', 'clipPathUnits', 'maskUnits', 'maskContentUnits', 'vector-effect',
  'shape-rendering', 'href', 'xmlns', 'version', 'title', 'dir', 'lang',
].map((name) => [name.toLowerCase(), name]))

// Style: custom properties (how the partial sizes and colours itself), and a
// handful of plain properties that cannot reach the network.
const STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'opacity', 'width', 'height', 'transform', 'transform-origin',
  'animation-delay', 'animation-duration', 'fill', 'stroke', 'display',
])
const CUSTOM_PROPERTY = /^--[A-Za-z0-9_-]{1,64}$/
const DATA_ATTR = /^data-[a-z0-9_-]{1,40}$/
const ARIA_ATTR = /^aria-(hidden|label|labelledby)$/
const FRAGMENT = /^#[A-Za-z_][\w.-]{0,63}$/

// Anything that could load, run or escape: no url() but a #fragment, no
// script-ish schemes, no CSS escapes, no markup.
function safeValue (value) {
  if (typeof value !== 'string' || value.length > MAX_ATTR) return false
  // eslint-disable-next-line no-control-regex
  if (/[<>\\\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return false
  const lower = value.toLowerCase().replace(/\s+/g, '')
  if (/(javascript|vbscript|data|https?|file|ftp):/.test(lower)) return false
  if (/expression\(|@import|image-set\(|image\(|src\(|element\(/.test(lower)) return false
  for (const match of lower.matchAll(/url\(([^)]*)\)/g)) {
    const target = match[1].replace(/^['"]|['"]$/g, '')
    if (!FRAGMENT.test(target)) return false
  }
  return true
}

function cleanStyle (value) {
  const out = {}
  if (typeof value !== 'string' || value.length > MAX_ATTR) return out
  for (const decl of value.split(';')) {
    const at = decl.indexOf(':')
    if (at < 0) continue
    const prop = decl.slice(0, at).trim()
    const val = decl.slice(at + 1).trim().replace(/\s*!important$/i, '')
    if (!val || !safeValue(val)) continue
    if (CUSTOM_PROPERTY.test(prop)) out[prop] = val
    else if (STYLE_PROPERTIES.has(prop.toLowerCase())) out[prop.toLowerCase()] = val
  }
  return out
}

// --- A small HTML tokenizer --------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
function decodeEntities (text) {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi, (all, code) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    return ENTITIES[code.toLowerCase()] ?? all
  })
}

const ATTR = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'wbr', 'source', 'area', 'base', 'col', 'embed', 'param', 'track'])
// Raw-text elements: their content is not markup and is dropped whole.
const RAW = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])

// → [{ type: 'open', name, attrs, selfClosing } | { type: 'close', name } | { type: 'text', text }]
function tokenize (html) {
  const tokens = []
  let i = 0
  while (i < html.length) {
    const lt = html.indexOf('<', i)
    if (lt < 0) {
      tokens.push({ type: 'text', text: html.slice(i) })
      break
    }
    if (lt > i) tokens.push({ type: 'text', text: html.slice(i, lt) })
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4)
      i = end < 0 ? html.length : end + 3
      continue
    }
    if (html[lt + 1] === '!' || html[lt + 1] === '?') {
      const end = html.indexOf('>', lt)
      i = end < 0 ? html.length : end + 1
      continue
    }
    const close = html[lt + 1] === '/'
    const m = /^[A-Za-z][A-Za-z0-9:-]*/.exec(html.slice(lt + (close ? 2 : 1)))
    if (!m) {
      tokens.push({ type: 'text', text: '<' })
      i = lt + 1
      continue
    }
    const name = m[0].toLowerCase()
    // The tag runs to the first '>' outside quotes.
    let j = lt + (close ? 2 : 1) + m[0].length
    let quote = null
    for (; j < html.length; j++) {
      const ch = html[j]
      if (quote) { if (ch === quote) quote = null } else if (ch === '"' || ch === "'") quote = ch
      else if (ch === '>') break
    }
    const inner = html.slice(lt + (close ? 2 : 1) + m[0].length, j)
    i = j + 1
    if (close) {
      tokens.push({ type: 'close', name })
      continue
    }
    const attrs = []
    for (const a of inner.matchAll(ATTR)) {
      if (a[1] === '/') continue
      attrs.push([a[1].toLowerCase(), decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')])
    }
    const selfClosing = /\/\s*$/.test(inner) || VOID.has(name)
    tokens.push({ type: 'open', name, attrs, selfClosing })
    if (RAW.has(name) && !selfClosing) {
      // Skip to the matching close tag, content and all.
      const end = html.toLowerCase().indexOf(`</${name}`, i)
      if (end < 0) { i = html.length } else {
        const gt = html.indexOf('>', end)
        i = gt < 0 ? html.length : gt + 1
      }
      tokens.push({ type: 'close', name })
    }
  }
  return tokens
}

// --- Sanitising ---------------------------------------------------------------

function cleanClass (value) {
  // eslint-disable-next-line no-control-regex
  const tokens = String(value).replace(/[\u0000-\u001f"'<>\\]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 32)
  return tokens.map((t) => t.slice(0, 80))
}

// A class token that carries the state ("cfa-avatar--working", "is-idle"):
// templated so the renderer can swap it.
const STATE_CLASS = new RegExp(`^(.*[-_])(${STATES.join('|')})$`)

function cleanAttrs (attrs, ns, ctx) {
  const a = {}
  let s = {}
  for (const [rawName, value] of attrs) {
    if (rawName.startsWith('on')) continue
    if (rawName === 'style') {
      s = cleanStyle(value)
      continue
    }
    if (rawName === 'class') {
      const tokens = cleanClass(value).map((t) => {
        const m = STATE_CLASS.exec(t)
        if (!m) return t
        ctx.stateful = true
        return `${m[1]}${STATE_TOKEN}`
      })
      if (tokens.length) a.class = tokens.join(' ')
      continue
    }
    if (rawName === 'href' || rawName === 'xlink:href') {
      if (FRAGMENT.test(value.trim())) a.href = value.trim()
      continue
    }
    if (rawName === 'xmlns') {
      if (value === 'http://www.w3.org/2000/svg') a.xmlns = value
      continue
    }
    let name = null
    if (DATA_ATTR.test(rawName) || ARIA_ATTR.test(rawName)) name = rawName
    else if (ATTRIBUTES.has(rawName)) name = ATTRIBUTES.get(rawName)
    if (!name || !safeValue(value)) continue
    // A data attribute that carries the state is templated too.
    if ((name === 'data-state' || name === 'data-cfa-state' || name === 'data-mood') && STATES.includes(value.trim())) {
      ctx.stateful = true
      a[name] = STATE_TOKEN
      continue
    }
    a[name] = value
  }
  // The windows' CSP has no 'unsafe-inline': style is applied through the
  // CSSOM, never as an attribute (see avatar-render.js).
  return { a, s }
}

// The CFA partial's markup → a sanitised tree (an array of root nodes), or
// null when nothing survives.
function sanitizeAvatarHtml (html) {
  if (typeof html !== 'string' || !html.trim() || html.length > MAX_HTML) return null
  const roots = []
  const stack = [] // open allowed nodes
  let skipping = 0 // depth inside a dropped element
  let skipName = null
  const ctx = { nodes: 0, stateful: false }
  const append = (node) => {
    const parent = stack[stack.length - 1]
    if (parent) parent.c.push(node)
    else roots.push(node)
  }

  for (const token of tokenize(html)) {
    if (ctx.nodes >= MAX_NODES) break
    if (skipping) {
      if (token.type === 'open' && !token.selfClosing && token.name === skipName) skipping++
      if (token.type === 'close' && token.name === skipName) skipping--
      continue
    }
    if (token.type === 'text') {
      const text = decodeEntities(token.text).replace(/\s+/g, ' ')
      if (!text.trim() || !stack.length) continue
      const parent = stack[stack.length - 1]
      // Text only where it renders as text, never inside SVG geometry.
      if (parent.ns === 'html' || parent.t === 'title' || parent.t === 'desc') {
        parent.c.push(text.slice(0, MAX_TEXT))
        ctx.nodes++
      }
      continue
    }
    if (token.type === 'close') {
      const at = stack.map((n) => n.t.toLowerCase()).lastIndexOf(token.name)
      if (at >= 0) stack.length = at
      continue
    }
    const known = ELEMENTS.get(token.name)
    const inSvg = stack.some((n) => n.t === 'svg')
    // Unknown elements go, with everything inside them; so do SVG children
    // outside an <svg> and HTML inside one (foreignObject, by another name).
    if (!known || (known.ns === 'svg' && known.name !== 'svg' && !inSvg) || (known.ns === 'html' && inSvg) || stack.length >= MAX_DEPTH) {
      if (!token.selfClosing) {
        skipping = 1
        skipName = token.name
      }
      continue
    }
    const { a, s } = cleanAttrs(token.attrs, known.ns, ctx)
    const node = { t: known.name, ns: known.ns, a, s, c: [] }
    append(node)
    ctx.nodes++
    if (!token.selfClosing) stack.push(node)
  }
  return roots.length ? { tree: roots, stateful: ctx.stateful } : null
}

// A tree that is already sanitised (a state the shell edits optimistically
// goes back through widgetStateFrom): checked again, structurally, so a tree
// is only ever one this module could have made.
function validTree (nodes, depth = 0, budget = { n: 0 }) {
  if (!Array.isArray(nodes) || depth > MAX_DEPTH) return null
  const out = []
  for (const node of nodes) {
    if (budget.n++ >= MAX_NODES) break
    if (typeof node === 'string') {
      out.push(node.slice(0, MAX_TEXT))
      continue
    }
    if (!node || typeof node !== 'object') continue
    const known = ELEMENTS.get(String(node.t).toLowerCase())
    if (!known || known.name !== node.t || known.ns !== node.ns) continue
    const a = {}
    for (const [k, v] of Object.entries(node.a || {})) {
      if (typeof v !== 'string') continue
      if (k === 'class') a.class = cleanClass(v).join(' ')
      else if (k === 'href') { if (FRAGMENT.test(v)) a.href = v } else if (k === 'xmlns') { if (v === 'http://www.w3.org/2000/svg') a.xmlns = v } else if ((DATA_ATTR.test(k) || ARIA_ATTR.test(k) || ATTRIBUTES.get(k.toLowerCase()) === k) && !k.startsWith('on') && safeValue(v)) a[k] = v
    }
    const s = {}
    for (const [k, v] of Object.entries(node.s || {})) {
      if (typeof v === 'string' && (CUSTOM_PROPERTY.test(k) || STYLE_PROPERTIES.has(k)) && safeValue(v)) s[k] = v
    }
    const c = validTree(node.c || [], depth + 1, budget) || []
    out.push({ t: known.name, ns: known.ns, a, s, c })
  }
  return out
}

function treeKey (tree) {
  return crypto.createHash('sha256').update(JSON.stringify(tree)).digest('hex').slice(0, 24)
}

function validImage (value) {
  if (typeof value !== 'string' || value.length > MAX_URL) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    return url.toString()
  } catch {
    return null
  }
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

// The feed's `avatar`, made safe — or null for an older server that sends
// none (the widget keeps its avatar_url / colour / initials path then).
// trusted: the state came from our own origin, so the markup may be used.
function validAvatar (input, { trusted = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const state = STATES.includes(input.state) ? input.state : 'idle'
  let tree = null
  let stateful = false
  if (trusted) {
    if (typeof input.html === 'string') {
      const clean = sanitizeAvatarHtml(input.html)
      if (clean) ({ tree, stateful } = clean)
    } else if (Array.isArray(input.tree)) {
      tree = validTree(input.tree)
      if (tree && !tree.length) tree = null
      stateful = input.stateful === true
    }
  }
  const initials = typeof input.initials === 'string' ? input.initials.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase() : ''
  return {
    tree,
    key: tree ? treeKey(tree) : null,
    stateful,
    state,
    color: typeof input.color === 'string' && HEX.test(input.color) ? input.color.toLowerCase() : null,
    shape: SHAPES.includes(input.shape) ? input.shape : null,
    image_url: validImage(input.image_url),
    initials: initials || null,
  }
}

// The avatar stylesheet: https on our own origin (a CDN subdomain of it
// included), no credentials. Only taken from a trusted state.
function validAvatarCssUrl (value) {
  if (typeof value !== 'string' || value.length > MAX_URL || !isAppUrl(value)) return null
  const url = new URL(value)
  if (url.username || url.password) return null
  return url.toString()
}

module.exports = {
  STATES,
  SHAPES,
  STATE_TOKEN,
  MAX_NODES,
  tokenize,
  safeValue,
  cleanStyle,
  sanitizeAvatarHtml,
  validTree,
  validAvatar,
  validAvatarCssUrl,
}
