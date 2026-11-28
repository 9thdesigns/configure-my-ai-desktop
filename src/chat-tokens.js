'use strict'

// The web app's chat design tokens (the feed's chat_css_url): the quick-chat
// popover's colours, type, bubble spacing and composer, owned by the web app
// so a change there reaches the widget without a desktop release. The widget
// keeps its own component rules (widget.css) written against these names,
// with the same tokens bundled as the fallback; this sheet only overrides
// their values.
//
// Contract (configure-my-ai web, /desktop/chat_tokens-<digest>.css):
//   * fingerprinted, on our own origin, at most MAX_BYTES;
//   * custom properties only, in these blocks and no others:
//       :root { … }
//       :root[data-theme="light"] { … }   :root[data-theme="dark"] { … }
//       @media (prefers-color-scheme: light|dark) { :root { … } }
//
// What comes in is rebuilt, not filtered in place: comments go, then only
// the blocks above survive, and inside them only `--name: value` pairs whose
// value names no resource (no url(), image-set(), @, braces, backslashes or
// markup). A sheet with none of the known tokens is refused, so a wrong
// file can't blank the popover. Pure; test/chat-tokens.test.js.

const { isAppUrl } = require('./url-policy')

const MAX_BYTES = 16 * 1024
const MAX_URL = 300
const PATH = /^\/desktop\/chat_tokens-[0-9a-f]{8,64}\.css$/

// The names the widget's rules read (widget.css), and so the ones the web
// sheet sets. Others are kept (harmless, and forward-compatible) but at
// least one of these must be present.
const TOKENS = Object.freeze([
  '--chat-font-family', '--chat-font-size', '--chat-line-height', '--chat-meta-size',
  '--chat-surface', '--chat-surface-2', '--chat-ink', '--chat-muted', '--chat-line',
  '--bubble-radius', '--bubble-radius-grouped', '--bubble-pad-x', '--bubble-pad-y', '--bubble-max-width',
  '--bubble-gap-same', '--bubble-gap-change',
  '--bubble-user-bg', '--bubble-user-ink', '--bubble-bot-bg', '--bubble-bot-ink', '--bubble-system-ink',
  '--chat-time-sep-ink', '--chat-delivered-ink',
  '--composer-bg', '--composer-border', '--composer-border-focus', '--composer-radius',
  '--composer-min-height', '--composer-max-height', '--composer-placeholder-ink', '--composer-icon-ink',
  '--composer-send-bg', '--composer-send-ink', '--composer-send-disabled-bg',
])

const SELECTORS = new Map([
  [':root', ':root'],
  [':root[data-theme="light"]', ':root[data-theme="light"]'],
  [":root[data-theme='light']", ':root[data-theme="light"]'],
  [':root[data-theme="dark"]', ':root[data-theme="dark"]'],
  [":root[data-theme='dark']", ':root[data-theme="dark"]'],
])
const MEDIA = /^@media\s*\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)$/i
const NAME = /^--[a-z][a-z0-9-]{0,63}$/
const BAD_VALUE = /url\s*\(|image-set|image\s*\(|element\s*\(|expression|src\s*\(|[@{}<>\\;]|\/\*|\*\//i

function validChatCssUrl (value) {
  if (typeof value !== 'string' || value.length > MAX_URL || !isAppUrl(value)) return null
  const url = new URL(value)
  if (url.username || url.password || url.search || url.hash || !PATH.test(url.pathname)) return null
  return url.toString()
}

// "--a: 1; --b: 2" → [['--a', '1'], ['--b', '2']], the bad ones dropped.
function declarations (body) {
  const out = []
  for (const part of body.split(';')) {
    const colon = part.indexOf(':')
    if (colon < 0) continue
    const name = part.slice(0, colon).trim().toLowerCase()
    const value = part.slice(colon + 1).trim()
    if (!NAME.test(name) || !value || value.length > 200 || BAD_VALUE.test(value)) continue
    out.push([name, value])
  }
  return out
}

// Top-level "prelude { body }" pairs, one level of nesting for @media.
// null when the braces don't balance.
function blocks (css) {
  const out = []
  let i = 0
  while (i < css.length) {
    const open = css.indexOf('{', i)
    if (open < 0) return css.slice(i).trim() ? null : out
    let depth = 1
    let j = open + 1
    while (j < css.length && depth) {
      if (css[j] === '{') depth++
      else if (css[j] === '}') depth--
      j++
    }
    if (depth) return null
    out.push({ prelude: css.slice(i, open).trim(), body: css.slice(open + 1, j - 1) })
    i = j
  }
  return out
}

function sanitizeChatTokens (text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > MAX_BYTES) return null
  // eslint-disable-next-line no-control-regex
  const css = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  const top = blocks(css)
  if (!top) return null

  const rules = [] // { media, selector, decls }
  for (const { prelude, body } of top) {
    const selector = SELECTORS.get(prelude.replace(/\s+/g, ' '))
    if (selector) {
      rules.push({ media: null, selector, decls: declarations(body) })
      continue
    }
    const media = MEDIA.exec(prelude.replace(/\s+/g, ' '))
    if (!media) continue
    for (const inner of blocks(body) || []) {
      const sel = SELECTORS.get(inner.prelude.replace(/\s+/g, ' '))
      if (sel === ':root') rules.push({ media: media[1].toLowerCase(), selector: sel, decls: declarations(inner.body) })
    }
  }

  const known = new Set(TOKENS)
  if (!rules.some((r) => r.decls.some(([name]) => known.has(name)))) return null
  return rules
    .filter((r) => r.decls.length)
    .map((r) => {
      const rule = `${r.selector} { ${r.decls.map(([n, v]) => `${n}: ${v};`).join(' ')} }`
      return r.media ? `@media (prefers-color-scheme: ${r.media}) { ${rule} }` : rule
    })
    .join('\n')
}

module.exports = { MAX_BYTES, TOKENS, validChatCssUrl, sanitizeChatTokens }
