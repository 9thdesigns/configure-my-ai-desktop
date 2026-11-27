'use strict'

// Workspace logos for the native workspace switcher: the tray's Workspaces
// submenu and the dock's workspace menu (workspaces.js). Native menus can't
// load a remote image. A menu item's icon has to be a nativeImage, so main
// fetches each logo once, checks it, turns it into a 16px icon (with a 32px
// @2x representation for Retina and HiDPI) and caches it. Until that is done,
// or if it fails, the item shows the mark's initials, as before.
//
//   * Only the app origin and its asset hosts (url-policy.js isAppAssetUrl),
//     for the first URL and for every redirect hop. Anything else is refused,
//     and so are non-images and anything over MAX_BYTES.
//   * No cookies: a logo is a public (signed) asset URL.
//   * A failure is remembered for RETRY_MS, so a broken logo isn't refetched
//     every time a menu is built.
//
// The fetch and the image conversion are injected, so everything here is
// unit-tested without Electron (test/workspace-logos.test.js). The
// electron* helpers at the bottom are the Electron half.

const { isAppAssetUrl } = require('./url-policy')

const MAX_BYTES = 512 * 1024
const MAX_REDIRECTS = 3
const RETRY_MS = 10 * 60 * 1000
const MAX_ENTRIES = 64
const ICON_SIZE = 16
// Formats Chromium's nativeImage decodes. SVG isn't one, so an SVG logo
// falls back to the mark.
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|bmp|x-icon|vnd\.microsoft\.icon)\b/i

// Fetch a logo's bytes, following redirects by hand so that each hop is
// checked against the origin rule. Resolves to a Buffer or rejects.
async function fetchLogo (url, { fetchImpl, isAllowed = isAppAssetUrl } = {}) {
  let current = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isAllowed(current)) throw new Error('logo host not allowed')
    const res = await fetchImpl(current, { redirect: 'manual', credentials: 'omit' })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error('redirect without location')
      current = new URL(location, current).toString()
      continue
    }
    if (!res.ok) throw new Error(`logo HTTP ${res.status}`)
    if (!IMAGE_TYPES.test(res.headers.get('content-type') || '')) throw new Error('not an image')
    if (Number(res.headers.get('content-length')) > MAX_BYTES) throw new Error('logo too large')
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length || buffer.length > MAX_BYTES) throw new Error('logo empty or too large')
    return buffer
  }
  throw new Error('too many redirects')
}

// The cache. iconFor(url) returns the cached icon, or null and starts a load
// (once). Subscribers hear when a new icon lands, so the tray can rebuild its
// menu. A load whose bytes don't decode counts as a failure.
function createLogoCache ({ load, toIcon, now = Date.now, retryMs = RETRY_MS, maxEntries = MAX_ENTRIES }) {
  const entries = new Map()
  const listeners = new Set()

  function remember (url, entry) {
    entries.delete(url)
    entries.set(url, entry)
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value)
  }

  function iconFor (url) {
    if (typeof url !== 'string' || !url) return null
    const entry = entries.get(url)
    if (entry?.icon) return entry.icon
    if (entry?.pending) return null
    if (entry?.failedAt !== undefined && now() - entry.failedAt < retryMs) return null
    remember(url, { pending: true })
    Promise.resolve()
      .then(() => load(url))
      .then((buffer) => {
        const icon = toIcon(buffer)
        if (!icon) throw new Error('undecodable logo')
        remember(url, { icon })
        for (const fn of listeners) fn(url)
      })
      .catch(() => remember(url, { failedAt: now() }))
    return null
  }

  return {
    iconFor,
    // Start loading every logo in the state, so they are ready by the time
    // a menu opens.
    warm (state) {
      for (const w of state?.workspaces || []) if (w.logo_url) iconFor(w.logo_url)
    },
    onChange (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    size: () => entries.size,
  }
}

// ---------------------------------------------------------------------------
// The Electron half
// ---------------------------------------------------------------------------

// A decoded logo as a 16px menu icon with a 32px @2x representation.
function electronMenuIcon (nativeImage, buffer) {
  const image = nativeImage.createFromBuffer(buffer)
  if (image.isEmpty()) return null
  const icon = nativeImage.createEmpty()
  for (const scaleFactor of [1, 2]) {
    const size = ICON_SIZE * scaleFactor
    icon.addRepresentation({ scaleFactor, width: size, height: size, buffer: image.resize({ width: size, height: size, quality: 'best' }).toPNG() })
  }
  return icon
}

// A fetch-shaped wrapper over net.request for fetchLogo. net.fetch can't be
// used here because with redirect: 'manual' it rejects ("Redirect was
// cancelled") instead of returning the 3xx. net.request reports the redirect
// as an event, and this hands it back as a 3xx so fetchLogo checks the hop
// before anything is requested from it. No session cookies. Capped in size
// and time.
const FETCH_TIMEOUT_MS = 15000
function electronFetch (net) {
  return (url) => new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(value)
    }
    const headersOf = (raw) => ({
      get: (name) => {
        const v = raw[String(name).toLowerCase()]
        return v === undefined ? null : Array.isArray(v) ? v.join(', ') : String(v)
      },
    })
    const req = net.request({ url, method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false })
    const timer = setTimeout(() => { req.abort(); finish(reject, new Error('logo timeout')) }, FETCH_TIMEOUT_MS)
    req.on('redirect', (statusCode, _method, redirectUrl) => {
      req.abort()
      finish(resolve, { status: statusCode, ok: false, headers: headersOf({ location: redirectUrl }), arrayBuffer: async () => new ArrayBuffer(0) })
    })
    req.on('response', (res) => {
      const chunks = []
      let size = 0
      res.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BYTES) {
          req.abort()
          finish(reject, new Error('logo too large'))
        } else {
          chunks.push(chunk)
        }
      })
      res.on('end', () => {
        const body = Buffer.concat(chunks)
        finish(resolve, {
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: headersOf(res.headers),
          arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        })
      })
      res.on('error', (err) => finish(reject, err))
    })
    req.on('error', (err) => finish(reject, err))
    req.end()
  })
}

function createElectronLogoCache () {
  const { net, nativeImage } = require('electron')
  return createLogoCache({
    load: (url) => fetchLogo(url, { fetchImpl: electronFetch(net) }),
    toIcon: (buffer) => electronMenuIcon(nativeImage, buffer),
  })
}

module.exports = { MAX_BYTES, MAX_REDIRECTS, RETRY_MS, ICON_SIZE, fetchLogo, createLogoCache, electronMenuIcon, electronFetch, createElectronLogoCache }
