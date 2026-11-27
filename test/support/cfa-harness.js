'use strict'

// A real-browser harness for the widget and island pages: loads
// src/widget.html and src/island.html in Chromium (Playwright) with a stub
// in place of the preload bridge, hands them the avatar stylesheet the way
// main does (sanitised, as a constructed sheet), and feeds them bots whose
// `avatar` is the web app's real CFA markup run through the same sanitiser
// main uses. Used by test/avatar-geometry.test.js; skipped when Playwright
// (or its browser) is not installed.

const fs = require('node:fs')
const zlib = require('node:zlib')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const { validAvatar, SHAPES } = require('../../src/cfa-avatar')
const { sanitizeAvatarCss } = require('../../src/avatar-css')

const ROOT = path.join(__dirname, '..', '..')
const WIDGET_URL = pathToFileURL(path.join(ROOT, 'src', 'widget.html')).href
const ISLAND_URL = pathToFileURL(path.join(ROOT, 'src', 'island.html')).href
const REAL_HTML = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'cfa-avatar-real.html'), 'utf8')
// A snapshot of the live stylesheet
// (https://configuremyai.com/desktop/cfa_avatar-<digest>.css). Set
// CMA_AVATAR_CSS to a file to measure against a fresher copy.
const LIVE_CSS_FILE = process.env.CMA_AVATAR_CSS || path.join(ROOT, 'test', 'fixtures', 'cfa-avatar-live.css')

const TINTS = { circle: '#5b8def', square: '#e5484d', triangle: '#30a46c', cloud: '#f5d90a', samurai: '#7c5cff', astronaut: '#f08a24' }

function loadPlaywright () {
  try {
    return require('playwright')
  } catch {
    return null
  }
}

function avatarCss () {
  return sanitizeAvatarCss(fs.readFileSync(LIVE_CSS_FILE, 'utf8'))
}

// The real markup with another shape, state and tint, made safe by main's
// sanitiser — what the feed's `avatar` becomes on its way to a page.
function avatarFor (shape, state = 'idle', tint = TINTS[shape]) {
  const html = REAL_HTML
    .replace(/data-cfa-shape="[a-z]+"/, `data-cfa-shape="${shape}"`)
    .replace(/data-cfa-state="[a-z]+"/, `data-cfa-state="${state}"`)
    .replace(/--cfa-tint: #[0-9a-f]{3,6}/i, `--cfa-tint: ${tint}`)
    .replace(/data-cfa-tone="[a-z]+"/, `data-cfa-tone="${shape === 'cloud' ? 'light' : 'dark'}"`)
  const avatar = validAvatar({ html, state, shape, color: tint }, { trusted: true })
  if (!avatar || !avatar.tree) throw new Error(`the ${shape} markup did not survive the sanitiser`)
  return avatar
}

const NAMES = { circle: 'Manager', square: 'Researcher', triangle: 'Writer', cloud: 'Planner', samurai: 'Reviewer', astronaut: 'Explorer' }

function botFor (shape, state = 'idle', extra = {}) {
  return {
    id: shape === 'circle' ? 'manager' : `bot-${shape}`,
    name: NAMES[shape],
    avatar_color: TINTS[shape],
    avatar_shape: 'circle',
    avatar: avatarFor(shape, state),
    mood: state === 'working' ? 'working' : 'idle',
    waiting: null,
    needs_count: 0,
    label: state === 'working' ? 'Working…' : 'Idle',
    paused: false,
    isManager: shape === 'circle',
    ...extra,
  }
}

// Stands in for widget-preload.js / island-preload.js: records what the page
// reports and exposes the page's listeners to the test as window.__cma.
function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    onState: on('state'),
    onLayout: on('layout'),
    onConversation: on('conversation'),
    onAvatarCss: on('css'),
    ready: call('ready'),
    reportHitRects: (rects, dockHeight) => { cma.rects = rects; cma.dockHeight = dockHeight },
    drag: call('drag'),
    open: call('open'),
    collapse: call('collapse'),
    contextMenu: call('contextMenu'),
    picker: call('picker'),
    workspaceMenu: call('workspaceMenu'),
    pin: call('pin'),
    openInApp: call('openInApp'),
    sendMessage: async () => true,
    answer: async () => true,
    decide: async () => true,
  }
  window.cmaIsland = {
    onView: on('view'),
    onLayout: on('islandLayout'),
    onAvatarCss: on('css'),
    ready: call('ready'),
    reportHeight: (h) => { cma.height = h },
    hover: call('hover'),
    activate: call('activate'),
    collapse: call('collapse'),
    openInApp: call('openInApp'),
    openApp: call('openApp'),
    answer: async () => true,
    decide: async () => true,
  }
}

async function openPage (browser, url, { colorScheme = 'light', reducedMotion = 'no-preference', width = 800, height = 700, scale = 1 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, colorScheme, reducedMotion })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  await page.goto(url)
  await page.waitForFunction(() => window.__cma && typeof window.__cma.css === 'function')
  await page.evaluate((css) => window.__cma.css({ css }), avatarCss())
  return { context, page }
}

// The dock with the given bots, and (optionally) quick chat open on one of
// them or the "+" picker open with candidates.
async function showWidget (page, { bots, candidates = [], chatWith = null, picker = false }) {
  await page.evaluate(({ bots, candidates, chatWith, picker }) => {
    const cma = window.__cma
    cma.state({ bots, candidates, focused_bot_id: chatWith, dock_full: false, max_pinned: 8, workspace: null })
    const expanded = Boolean(chatWith || picker)
    cma.layout({ expanded, mode: picker ? 'picker' : 'chat', botId: chatWith, dockTop: 0, popoverTop: 0, popoverHeight: expanded ? 520 : 0 })
    if (chatWith) cma.conversation({ bot_id: chatWith, history: true, messages: [{ id: 'm1', role: 'user', body: 'Is the report done?' }, { id: 'm2', role: 'assistant', body: 'All set — the report is in your inbox.' }], pending: null })
  }, { bots, candidates, chatWith, picker })
  await settle(page)
}

async function showIsland (page, { bot, chip = { kind: 'working', label: 'Working…' }, idle = false }) {
  await page.evaluate(({ bot, chip, idle }) => {
    window.__cma.view({ idle, bot, chip, detail: '', pending: null })
    window.__cma.islandLayout({ expanded: false, focused: false })
  }, { bot, chip, idle })
  await settle(page)
}

// Two frames, and the pages' own entrance animations (the popover's and the
// island's scale-in) finished, so boxes are measured at rest.
const settle = (page) => page.evaluate(async () => {
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const entrances = document.getAnimations().filter((a) => !a.effect?.target?.closest?.('.cfa-avatar') && a.effect?.getTiming?.().iterations !== Infinity)
  await Promise.all(entrances.map((a) => a.finished.catch(() => {})))
})

// Every avatar box on the page: the slot box, its --cfa-size, the face's own
// box, and the union of everything the face paints (the face's descendants
// and their ::before / ::after, as laid out, including any transforms) —
// against the boxes that would clip it or that it must not run into.
async function measure (page, selector) {
  return page.evaluate((selector) => {
    const pseudoRects = (el) => {
      // Pseudo-elements have no getBoundingClientRect; approximate each from
      // its computed inset/size inside the element's own box.
      const out = []
      const host = el.getBoundingClientRect()
      for (const which of ['::before', '::after']) {
        const cs = getComputedStyle(el, which)
        if (cs.content === 'none' || cs.display === 'none' || cs.visibility === 'hidden') continue
        const w = parseFloat(cs.width)
        const h = parseFloat(cs.height)
        if (!(w > 0 && h > 0)) continue
        const left = parseFloat(cs.left)
        const top = parseFloat(cs.top)
        const right = parseFloat(cs.right)
        const bottom = parseFloat(cs.bottom)
        const x = Number.isFinite(left) ? host.left + left : Number.isFinite(right) ? host.right - right - w : host.left
        const y = Number.isFinite(top) ? host.top + top : Number.isFinite(bottom) ? host.bottom - bottom - h : host.top
        out.push({ left: x, top: y, right: x + w, bottom: y + h })
      }
      return out
    }
    const visible = (el) => {
      const cs = getComputedStyle(el)
      return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0
    }
    const clipper = (el) => {
      // The nearest ancestor that clips: overflow other than visible, or a clip-path.
      for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
        const cs = getComputedStyle(n)
        if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.clipPath !== 'none') return n
      }
      return null
    }
    const rect = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.right - r.left, height: r.bottom - r.top })
    return [...document.querySelectorAll(selector)].map((box) => {
      const face = box.querySelector(':scope > .cfa-avatar')
      const b = box.getBoundingClientRect()
      const out = {
        slot: rect(b),
        cfaSize: getComputedStyle(box).getPropertyValue('--cfa-size').trim(),
        faceSize: face ? getComputedStyle(face).getPropertyValue('--cfa-size').trim() : null,
        face: face ? rect(face.getBoundingClientRect()) : null,
        shape: face ? face.dataset.cfaShape : null,
        state: face ? face.dataset.cfaState : null,
        paint: null,
        clip: null,
        clipName: null,
        animating: face ? [face, ...face.querySelectorAll('*')].some((n) => getComputedStyle(n).animationName !== 'none' && getComputedStyle(n).animationPlayState === 'running') : false,
        transforms: face ? [...face.querySelectorAll('*')].map((n) => getComputedStyle(n).transform).filter((t) => t !== 'none') : [],
      }
      if (face) {
        const parts = [face, ...face.querySelectorAll('*')].filter(visible)
        let u = null
        for (const n of parts) {
          for (const r of [n.getBoundingClientRect(), ...pseudoRects(n)]) {
            if (r.right - r.left <= 0 || r.bottom - r.top <= 0) continue
            u = u ? { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
          }
        }
        out.paint = u && rect(u)
        const c = clipper(box)
        if (c) {
          out.clip = rect(c.getBoundingClientRect())
          out.clipName = c.className || c.tagName
        }
      }
      return out
    })
  }, selector)
}

// A minimal PNG reader for Playwright's screenshots (8-bit RGB / RGBA, not
// interlaced): enough to diff two shots pixel by pixel.
function decodePng (buf) {
  let pos = 8
  let width = 0
  let height = 0
  let channels = 4
  const idat = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[12] !== 0) throw new Error('unsupported PNG')
      channels = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0
      if (!channels) throw new Error('unsupported PNG colour type')
    } else if (type === 'IDAT') idat.push(data)
    pos += 12 + len
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0
      let v = line[x]
      if (filter === 1) v += a
      else if (filter === 2) v += b
      else if (filter === 3) v += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      out[y * stride + x] = v & 255
    }
  }
  return { width, height, channels, data: out }
}

// Where a face actually puts ink, in page CSS px: the slot's neighbourhood
// shot with the face shown and with it hidden, diffed. The face's loops are
// paused and seeked to several points through their cycle (so a bob or a
// sway counts at its extreme), and the union is returned with the slot box.
// A pixel counts when any channel moves by more than `threshold`.
async function inkBox (page, selector, index = 0, { margin = 16, samples = 8, threshold = 24 } = {}) {
  const box = page.locator(selector).nth(index)
  const slot = await box.boundingBox()
  const vp = page.viewportSize()
  const clip = {
    x: Math.max(0, Math.floor(slot.x - margin)),
    y: Math.max(0, Math.floor(slot.y - margin)),
  }
  clip.width = Math.min(vp.width - clip.x, Math.ceil(slot.width + margin * 2))
  clip.height = Math.min(vp.height - clip.y, Math.ceil(slot.height + margin * 2))
  const scale = await page.evaluate(() => window.devicePixelRatio)
  let union = null
  for (let i = 0; i < samples; i++) {
    const shown = await page.evaluate(({ selector, index, i, samples }) => {
      const el = document.querySelectorAll(selector)[index]
      const face = el.querySelector('.cfa-avatar')
      if (!face) return false
      face.style.visibility = ''
      // Everything else on the page holds still between the two shots.
      for (const a of document.getAnimations()) a.pause()
      for (const a of face.getAnimations({ subtree: true })) {
        const t = a.effect.getComputedTiming()
        a.pause()
        const period = Number.isFinite(t.duration) ? t.duration : 0
        a.currentTime = (t.delay || 0) + (period * i) / samples
      }
      return true
    }, { selector, index, i, samples })
    if (!shown) return { slot, ink: null }
    const on = decodePng(await page.screenshot({ clip, animations: 'allow' }))
    await page.evaluate(({ selector, index }) => { document.querySelectorAll(selector)[index].querySelector('.cfa-avatar').style.visibility = 'hidden' }, { selector, index })
    const off = decodePng(await page.screenshot({ clip, animations: 'allow' }))
    await page.evaluate(({ selector, index }) => { document.querySelectorAll(selector)[index].querySelector('.cfa-avatar').style.visibility = '' }, { selector, index })
    for (let y = 0; y < on.height; y++) {
      for (let x = 0; x < on.width; x++) {
        const k = (y * on.width + x) * on.channels
        let moved = false
        for (let ch = 0; ch < on.channels; ch++) if (Math.abs(on.data[k + ch] - off.data[k + ch]) > threshold) moved = true
        if (!moved) continue
        const px = clip.x + x / scale
        const py = clip.y + y / scale
        union = union
          ? { left: Math.min(union.left, px), top: Math.min(union.top, py), right: Math.max(union.right, px + 1 / scale), bottom: Math.max(union.bottom, py + 1 / scale) }
          : { left: px, top: py, right: px + 1 / scale, bottom: py + 1 / scale }
      }
    }
  }
  await page.evaluate(({ selector, index }) => {
    for (const a of document.getAnimations()) a.play()
  }, { selector, index })
  return { slot, ink: union, clip }
}

// The page box an element occupies, in CSS px.
const rectOf = (page, selector, index = 0) => page.locator(selector).nth(index).evaluate((n) => {
  const r = n.getBoundingClientRect()
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
})

module.exports = {
  decodePng,
  inkBox,
  rectOf,
  SHAPES,
  TINTS,
  WIDGET_URL,
  ISLAND_URL,
  LIVE_CSS_FILE,
  loadPlaywright,
  avatarCss,
  avatarFor,
  botFor,
  openPage,
  showWidget,
  showIsland,
  settle,
  measure,
}
