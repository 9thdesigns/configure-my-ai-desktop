'use strict'

// The CFA faces at their slot sizes, measured in a real browser: the widget
// and island pages (src/widget.html, src/island.html) with the live avatar
// stylesheet (a snapshot, test/fixtures/cfa-avatar-live.css) and the web
// app's real markup for every shape, idle and working.
//
//   * each slot's --cfa-size is its box, in whole pixels, at the target size
//     (dock and seat rows 28px; quick chat header and island 22px);
//   * where a face actually puts ink — diffed from screenshots, sampled
//     through its animation so a bob or a sway counts at its extreme — stays
//     inside whatever would clip it, clear of its neighbours and the text
//     beside it, for every shape: the aura, rim, eyes, brows and the samurai
//     and astronaut costumes included;
//   * nothing transforms the slot (a scaled face blurs), the faces still move,
//     and with reduced motion they hold still.
//
// Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const H = require('./support/cfa-harness')
const { COMPACT_HEIGHT } = require('../src/island-window')
const { DOCK_WIDTH, EDGE_MARGIN } = require('../src/widget-window')

const WIDGET_CSS = fs.readFileSync(path.join(__dirname, '../src/widget.css'), 'utf8')
const ISLAND_CSS = fs.readFileSync(path.join(__dirname, '../src/island.css'), 'utf8')

const TARGET = { dock: 28, seat: 28, chat: 22, island: 22 }
const SLOTS = {
  dock: '.dock-bot .avatar',
  seat: '.picker-item .avatar',
  chat: '.popover-head .avatar',
  island: '.island-bar .avatar',
}
const STATES = ['idle', 'working']
// A face that rendered at all fills most of its box (not a 72px face, not 0).
const MIN_FILL = 0.6
const EPS = 0.01

// --- Without a browser: the CSS says one size for the box and the face ------

test('every slot sizes its box and its --cfa-size from the same whole-pixel value', () => {
  const px = (css, name) => {
    const m = css.match(new RegExp(`${name}:\\s*(\\d+)px;`))
    return m && Number(m[1])
  }
  assert.equal(px(WIDGET_CSS, '--dock-face'), TARGET.dock)
  assert.equal(px(WIDGET_CSS, '--chat-face'), TARGET.chat)
  assert.equal(px(ISLAND_CSS, '--face'), TARGET.island)
  // The box and the face read the same variable, slot by slot.
  assert.match(WIDGET_CSS, /\.avatar \{\n  width: var\(--dock-face\);\n  height: var\(--dock-face\);/)
  assert.match(WIDGET_CSS, /\.avatar \{ --cfa-size: var\(--dock-face\); \}/)
  assert.match(WIDGET_CSS, /\.avatar-sm \{ width: var\(--chat-face\); height: var\(--chat-face\);/)
  assert.match(WIDGET_CSS, /\.avatar-sm \{ --cfa-size: var\(--chat-face\); \}/)
  assert.match(WIDGET_CSS, /\.picker-item \.avatar \{ width: var\(--dock-face\); height: var\(--dock-face\);/)
  assert.match(WIDGET_CSS, /\.picker-item \.avatar \{ --cfa-size: var\(--dock-face\); \}/)
  assert.match(ISLAND_CSS, /\.avatar \{\n  width: var\(--face\);\n  height: var\(--face\);/)
  assert.match(ISLAND_CSS, /\.avatar \{ --cfa-size: var\(--face\); \}/)
  // The face never keeps the sheet's own 72px.
  for (const css of [WIDGET_CSS, ISLAND_CSS]) assert.match(css, /\.avatar\[data-mode="cfa"\] > \.cfa-avatar \{ --cfa-size: inherit; \}/)
})

test('the windows fit the smaller pill and dock', () => {
  assert.equal(COMPACT_HEIGHT, Number(ISLAND_CSS.match(/--pill-h:\s*(\d+)px/)[1]), 'the island window is the pill')
  const dockWidth = Number(WIDGET_CSS.match(/\.dock \{[^}]*?\n  width: (\d+)px;/)[1])
  const dockRight = Number(WIDGET_CSS.match(/\.dock \{[^}]*?\n  right: (\d+)px;/)[1])
  assert.ok(DOCK_WIDTH >= dockWidth + dockRight + 4, 'the dock column holds the dock and a little shadow')
  assert.ok(EDGE_MARGIN >= 0)
})

test('hovering a dock face does not scale it (a scaled face blurs)', () => {
  const hover = WIDGET_CSS.match(/\.dock-bot:hover \{[^}]*\}/)[0]
  assert.doesNotMatch(hover, /transform|scale/)
  assert.doesNotMatch(WIDGET_CSS, /\.dock-bot:active \{[^}]*scale/)
})

// --- In a real browser ------------------------------------------------------

const pw = H.loadPlaywright()
let browser = null
let launchError = null

test.before(async () => {
  if (!pw) return
  try {
    browser = await pw.chromium.launch()
  } catch (err) {
    launchError = err
  }
})
test.after(async () => { if (browser) await browser.close() })

const skip = () => (!pw ? 'Playwright is not installed' : launchError ? `Chromium did not launch: ${launchError.message}` : false)
const browserTest = (name, fn) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 180_000 }, async (t) => {
  const why = skip()
  if (why) return t.skip(why)
  return fn(t)
})

const inside = (inner, outer, pad = 0) =>
  inner.left >= outer.left + pad - EPS && inner.top >= outer.top + pad - EPS &&
  inner.right <= outer.right - pad + EPS && inner.bottom <= outer.bottom - pad + EPS
const fmt = (r) => r && `[${['left', 'top', 'right', 'bottom'].map((k) => r[k].toFixed(2)).join(', ')}]`
const box = (b) => ({ left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height })

// Slot box = --cfa-size = the face's own box, whole pixels, the target size;
// the slot sits on the pixel grid and nothing above it is transformed.
async function checkSlots (page, slot, count) {
  const rows = await H.measure(page, SLOTS[slot])
  assert.equal(rows.length, count, `${slot}: ${count} faces`)
  for (const r of rows) {
    const where = `${slot} ${r.shape}`
    assert.equal(r.cfaSize, `${TARGET[slot]}px`, `${where}: the slot's --cfa-size`)
    assert.equal(r.faceSize, `${TARGET[slot]}px`, `${where}: the face's --cfa-size`)
    assert.equal(r.slot.width, TARGET[slot], `${where}: box width`)
    assert.equal(r.slot.height, TARGET[slot], `${where}: box height`)
    assert.equal(r.face.width, TARGET[slot], `${where}: face width`)
    assert.equal(r.face.height, TARGET[slot], `${where}: face height`)
    assert.ok(Number.isInteger(r.slot.left) && Number.isInteger(r.slot.top), `${where}: on the pixel grid (${r.slot.left}, ${r.slot.top})`)
  }
  const transformed = await page.evaluate((sel) => [...document.querySelectorAll(sel)].flatMap((n) => {
    const out = []
    for (let a = n; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.transform !== 'none' || cs.scale !== 'none' || cs.zoom !== '1') out.push(a.className || a.tagName)
    }
    return out
  }), SLOTS[slot])
  assert.deepEqual(transformed, [], `${slot}: no transform on the slot or above it`)
  return rows
}

async function inks (page, slot, count) {
  const out = []
  for (let i = 0; i < count; i++) {
    const { slot: s, ink } = await H.inkBox(page, SLOTS[slot], i, { samples: 6 })
    out.push({ slot: box(s), ink })
  }
  return out
}

function checkFill (slot, shape, state, { slot: s, ink }) {
  const where = `${slot} ${shape} ${state}`
  assert.ok(ink, `${where}: the face drew something`)
  const w = ink.right - ink.left
  const h = ink.bottom - ink.top
  assert.ok(w >= TARGET[slot] * MIN_FILL && h >= TARGET[slot] * MIN_FILL, `${where}: the face fills its box (${w.toFixed(1)}×${h.toFixed(1)})`)
  // A face may move a little past its box (the bob), never far.
  assert.ok(inside(ink, s, -TARGET[slot] * 0.2), `${where}: ink ${fmt(ink)} stays near its box ${fmt(s)}`)
}

for (const scheme of ['light', 'dark']) {
  for (const state of STATES) {
    browserTest(`dock (${scheme}, ${state}): 28px faces, every shape inside the dock and clear of each other`, async () => {
      const { page, context } = await H.openPage(browser, H.WIDGET_URL, { colorScheme: scheme, width: 520, height: 560 })
      try {
        await H.showWidget(page, { bots: H.SHAPES.map((s) => H.botFor(s, state)) })
        const rows = await checkSlots(page, 'dock', H.SHAPES.length)
        const dock = await H.rectOf(page, '.dock')
        const found = await inks(page, 'dock', H.SHAPES.length)
        found.forEach((f, i) => {
          checkFill('dock', rows[i].shape, state, f)
          // Inside the dock's border (the window edge is further out still).
          assert.ok(inside(f.ink, dock, 1), `dock ${rows[i].shape} ${state}: ink ${fmt(f.ink)} inside the dock ${fmt(dock)}`)
          const next = found[i + 1]
          if (next) assert.ok(f.ink.bottom <= next.ink.top - 1, `dock ${rows[i].shape}/${rows[i + 1].shape} ${state}: faces do not touch (${f.ink.bottom.toFixed(2)} vs ${next.ink.top.toFixed(2)})`)
        })
        const add = await H.rectOf(page, '.dock-add')
        assert.ok(found[found.length - 1].ink.bottom <= add.top - 1, 'the last face clears the "+" button')
      } finally {
        await context.close()
      }
    })

    browserTest(`seat rows (${scheme}, ${state}): 28px faces inside their rows, clear of the names`, async () => {
      const { page, context } = await H.openPage(browser, H.WIDGET_URL, { colorScheme: scheme, width: 520, height: 560 })
      try {
        const candidates = H.SHAPES.map((s) => H.botFor(s, state, { id: `cand-${s}` }))
        await H.showWidget(page, { bots: [H.botFor('circle')], candidates, picker: true })
        const rows = await checkSlots(page, 'seat', H.SHAPES.length)
        const list = await H.rectOf(page, '.picker-list')
        const found = await inks(page, 'seat', H.SHAPES.length)
        for (const [i, f] of found.entries()) {
          const where = `seat ${rows[i].shape} ${state}`
          checkFill('seat', rows[i].shape, state, f)
          const row = await H.rectOf(page, '.picker-item', i)
          const name = await H.rectOf(page, '.picker-name', i)
          assert.ok(inside(f.ink, row, 1), `${where}: ink ${fmt(f.ink)} inside its row ${fmt(row)}`)
          assert.ok(inside(f.ink, list), `${where}: not clipped by the list`)
          assert.ok(f.ink.right <= name.left - 2, `${where}: clear of the name`)
        }
      } finally {
        await context.close()
      }
    })

    browserTest(`quick chat header (${scheme}, ${state}): 22px faces inside the header, clear of the title`, async () => {
      for (const shape of H.SHAPES) {
        const { page, context } = await H.openPage(browser, H.WIDGET_URL, { colorScheme: scheme, width: 520, height: 560 })
        try {
          const bots = H.SHAPES.map((s) => H.botFor(s, state))
          const bot = bots[H.SHAPES.indexOf(shape)]
          await H.showWidget(page, { bots, chatWith: bot.id })
          const [row] = await checkSlots(page, 'chat', 1)
          assert.equal(row.shape, shape)
          const [f] = await inks(page, 'chat', 1)
          checkFill('chat', shape, state, f)
          const head = await H.rectOf(page, '.popover-head')
          const title = await H.rectOf(page, '.popover-title')
          // The popover clips (overflow: hidden); the header's border is its bottom.
          assert.ok(inside(f.ink, { ...head, bottom: head.bottom - 1 }, 1), `chat ${shape} ${state}: ink ${fmt(f.ink)} inside the header ${fmt(head)}`)
          assert.ok(f.ink.right <= title.left - 2, `chat ${shape} ${state}: clear of the title`)
        } finally {
          await context.close()
        }
      }
    })
  }

  browserTest(`island (${scheme}): a 22px face inside the pill for every shape, idle and working`, async () => {
    for (const state of STATES) {
      for (const shape of H.SHAPES) {
        const { page, context } = await H.openPage(browser, H.ISLAND_URL, { colorScheme: scheme, width: 380, height: 64 })
        try {
          await H.showIsland(page, { bot: H.botFor(shape, state), chip: state === 'working' ? { kind: 'working', label: 'Working…' } : { kind: 'question', label: 'Questions' } })
          const [row] = await checkSlots(page, 'island', 1)
          assert.equal(row.shape, shape)
          const [f] = await inks(page, 'island', 1)
          checkFill('island', shape, state, f)
          const pill = await H.rectOf(page, '.island')
          const name = await H.rectOf(page, '.island-name')
          assert.equal(pill.bottom - pill.top, COMPACT_HEIGHT, 'the compact pill is the window height')
          // The pill clips (overflow: hidden, rounded ends): keep the ink off
          // its top and bottom edges and inside the rounded end.
          assert.ok(inside(f.ink, pill, 1), `island ${shape} ${state}: ink ${fmt(f.ink)} inside the pill ${fmt(pill)}`)
          const r = (pill.bottom - pill.top) / 2
          const cx = pill.left + r
          const cy = pill.top + r
          for (const [x, y] of [[f.ink.left, f.ink.top], [f.ink.left, f.ink.bottom]]) {
            if (x < cx) assert.ok(Math.hypot(cx - x, cy - y) <= r + 1.5, `island ${shape} ${state}: inside the rounded end`)
          }
          assert.ok(f.ink.right <= name.left - 2, `island ${shape} ${state}: clear of the name`)
        } finally {
          await context.close()
        }
      }
    }
  })
}

browserTest('the faces keep their motion, and hold still with reduced motion', async () => {
  for (const [motion, url, slot, show] of [
    ['no-preference', H.WIDGET_URL, 'dock', (p) => H.showWidget(p, { bots: H.SHAPES.map((s) => H.botFor(s, 'working')) })],
    ['reduce', H.WIDGET_URL, 'dock', (p) => H.showWidget(p, { bots: H.SHAPES.map((s) => H.botFor(s, 'working')) })],
    ['no-preference', H.ISLAND_URL, 'island', (p) => H.showIsland(p, { bot: H.botFor('samurai', 'working') })],
    ['reduce', H.ISLAND_URL, 'island', (p) => H.showIsland(p, { bot: H.botFor('samurai', 'working') })],
  ]) {
    const { page, context } = await H.openPage(browser, url, { reducedMotion: motion, width: url === H.ISLAND_URL ? 380 : 520, height: url === H.ISLAND_URL ? 64 : 560 })
    try {
      await show(page)
      const running = await page.evaluate((sel) => [...document.querySelectorAll(sel)].map((n) =>
        n.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length), SLOTS[slot])
      const root = await page.evaluate(() => document.documentElement.dataset.motion)
      if (motion === 'reduce') {
        assert.equal(root, 'reduce')
        assert.deepEqual(running, running.map(() => 0), `${slot}: no face animates with reduced motion`)
        const shot = async () => page.locator(SLOTS[slot]).first().screenshot({ animations: 'allow' })
        const a = await shot()
        await page.waitForTimeout(700)
        assert.ok(a.equals(await shot()), `${slot}: the face is static`)
        // Still the face, at its size.
        await checkSlots(page, slot, slot === 'dock' ? H.SHAPES.length : 1)
      } else {
        assert.equal(root, 'full')
        assert.ok(running.every((n) => n > 0), `${slot}: every face keeps its motion (${running})`)
      }
    } finally {
      await context.close()
    }
  }
})
