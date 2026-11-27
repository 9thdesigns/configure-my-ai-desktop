'use strict'

// The CFA avatar stylesheet (the feed's avatar_css_url): fetched once per
// fingerprinted URL by main, kept on disk under userData so later launches
// (and offline ones) don't fetch it again, and handed to the widget windows
// as text. The windows have no network and a style-src of 'self', so they
// never load it themselves: the renderer adopts it as a constructed
// stylesheet (avatar-render.js), which the CSP does not need loosening for.
//
// What goes in is checked: on our own origin only (cfa-avatar.js), at most
// MAX_CSS_BYTES, and stripped of @import and of every url() but a
// same-document "#fragment" or an inline data: image, so the sheet cannot
// reach the network from a window that has none.
//
// The fetch is injected, so all but electronFetchText is unit-tested
// (test/avatar-css.test.js).

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { validAvatarCssUrl } = require('./cfa-avatar')

const MAX_CSS_BYTES = 256 * 1024
const REQUEST_TIMEOUT_MS = 10_000
const KEEP_FILES = 4

// The sheet with anything that could load something taken out.
function sanitizeAvatarCss (text) {
  if (typeof text !== 'string' || !text || Buffer.byteLength(text) > MAX_CSS_BYTES) return null
  let css = text.replace(/\/\*[\s\S]*?\*\//g, '')
  css = css.replace(/@import[^;]*;?/gi, '')
  css = css.replace(/@namespace[^;]*;?/gi, '')
  // A @font-face can only fetch: none of it is kept.
  css = css.replace(/@font-face\s*\{[^}]*\}/gi, '')
  css = css.replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (all, _q, target) => {
    const t = target.trim()
    if (/^#[\w-]+$/.test(t) || /^data:image\/(png|gif|webp|svg\+xml)[;,]/i.test(t)) return all
    return 'none'
  })
  // Other ways to name a resource, the whole call dropped.
  css = css.replace(/(-webkit-image-set|image-set|image|src|expression|element)\s*\((?:[^()]|\([^()]*\))*\)/gi, 'none')
  // Markup has no business in a stylesheet.
  css = css.replace(/<\/?[a-z][^>]*>/gi, '')
  return css.trim() ? css : null
}

function cacheName (url) {
  return `${crypto.createHash('sha256').update(url).digest('hex').slice(0, 32)}.css`
}

// fetchText(url) → Promise<string|null>. dir: where the sheets are kept.
function createAvatarCssCache ({ dir, fetchText, fsImpl = fs }) {
  const memo = new Map() // url → Promise<string|null>

  function readCached (url) {
    try {
      return sanitizeAvatarCss(fsImpl.readFileSync(path.join(dir, cacheName(url)), 'utf8'))
    } catch {
      return null
    }
  }

  function writeCached (url, css) {
    try {
      fsImpl.mkdirSync(dir, { recursive: true })
      fsImpl.writeFileSync(path.join(dir, cacheName(url)), css)
      // Old fingerprints go: a handful is plenty.
      const files = fsImpl.readdirSync(dir).filter((f) => f.endsWith('.css'))
        .map((f) => ({ f, t: fsImpl.statSync(path.join(dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
      for (const { f } of files.slice(KEEP_FILES)) fsImpl.unlinkSync(path.join(dir, f))
    } catch {
      // No disk cache costs a fetch next launch, nothing more.
    }
  }

  // The sheet for this URL: from memory, then disk, then the network.
  function get (value) {
    const url = validAvatarCssUrl(value)
    if (!url) return Promise.resolve(null)
    if (memo.has(url)) return memo.get(url)
    const job = (async () => {
      const cached = readCached(url)
      if (cached) return cached
      const css = sanitizeAvatarCss(await fetchText(url).catch(() => null))
      if (css) writeCached(url, css)
      return css
    })()
    memo.set(url, job)
    // A failed fetch is retried on the next feed refresh, not memoised.
    job.then((css) => { if (!css) memo.delete(url) })
    return job
  }

  return { get }
}

// The real fetch: Electron's net, no cookies, no redirects, capped.
function electronFetchText (url) {
  const { net } = require('electron')
  if (!validAvatarCssUrl(url)) return Promise.resolve(null)
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    let req
    try {
      req = net.request({ method: 'GET', url, credentials: 'omit', useSessionCookies: false, redirect: 'error' })
    } catch {
      done(null)
      return
    }
    const timer = setTimeout(() => { try { req.abort() } catch {} done(null) }, REQUEST_TIMEOUT_MS)
    req.setHeader('Accept', 'text/css')
    req.on('error', () => done(null))
    req.on('abort', () => done(null))
    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        try { req.abort() } catch {}
        return done(null)
      }
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_CSS_BYTES) {
          try { req.abort() } catch {}
          return done(null)
        }
        chunks.push(chunk)
      })
      res.on('end', () => done(Buffer.concat(chunks).toString('utf8')))
      res.on('error', () => done(null))
    })
    req.end()
  })
}

module.exports = { MAX_CSS_BYTES, sanitizeAvatarCss, cacheName, createAvatarCssCache, electronFetchText }
