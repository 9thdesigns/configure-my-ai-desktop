// The dock and island pages in a real browser (Playwright Chromium), with a
// stub where the preload bridge would be: real pointer events, so a tap on a
// bot or the island bar still clicks, a press-and-move drags (and its drop
// does not click), selecting text in quick chat never drags, and a page told
// it cannot drag (Wayland) only clicks. Skipped where Playwright (or its
// Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href
const ISLAND_URL = pathToFileURL(path.join(__dirname, '../src/island.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  const api = (names) => Object.fromEntries(names.map((n) => [n, call(n)]))
  window.cmaWidget = {
    ...api(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp']),
    onState: on('state'),
    onLayout: on('layout'),
    onConversation: on('conversation'),
    onAvatarCss: on('css'),
    reportHitRects () {},
    sendMessage: async () => null,
    answer: async () => null,
    decide: async () => null,
  }
  window.cmaIsland = {
    ...api(['ready', 'drag', 'hover', 'activate', 'collapse', 'openInApp', 'openApp']),
    onView: on('view'),
    onLayout: on('islandLayout'),
    onAvatarCss: on('css'),
    reportHeight () {},
    answer: async () => false,
    decide: async () => false,
  }
}

const BOTS = ['Max', 'Ada', 'Lin'].map((name, i) => ({ id: i ? `bot-${i}` : 'manager', name, avatar_color: ['#231d1b', '#f2c94c', '#6e56cf'][i], avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: !i }))

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 520, height: 560 } })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  try {
    await fn(page)
  } finally {
    await context.close()
  }
})

async function showDock (page, layout = {}) {
  await page.goto(WIDGET_URL)
  await page.evaluate(({ bots, layout }) => {
    window.__cma.state({ bots, candidates: [], focused_bot_id: null, dock_full: false, max_pinned: 12, workspace: null })
    window.__cma.layout({ expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true, ...layout })
  }, { bots: BOTS, layout })
}

const calls = (page, name) => page.evaluate((name) => window.__cma.calls.filter((c) => !name || c[0] === name), name)
const reset = (page) => page.evaluate(() => { window.__cma.calls = [] })
const centre = async (page, selector) => {
  const b = await page.locator(selector).first().boundingBox()
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

// A real press: down, a few moves over `ms`, up.
async function press (page, from, to = from, { steps = 8, ms = 200 } = {}) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) {
    await page.waitForTimeout(ms / steps)
    await page.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
  }
  await page.mouse.up()
  await page.waitForTimeout(50)
}

pageTest('dock: a tap opens the bot, even with a 2px wobble; no drag is sent', async (page) => {
  await showDock(page)
  const at = await centre(page, '.dock-bot[data-bot-id="bot-1"]')
  await press(page, at, { x: at.x + 2, y: at.y + 1 })
  assert.deepEqual(await calls(page, 'drag'), [])
  assert.deepEqual(await calls(page, 'open'), [['open', 'bot-1']])
})

pageTest('dock: press-and-move drags from anywhere on it; the drop does not click; the next tap does', async (page) => {
  await showDock(page)
  const at = await centre(page, '.dock-bot[data-bot-id="bot-1"]')
  await press(page, at, { x: at.x - 260, y: at.y + 120 }, { steps: 12, ms: 300 })
  const drag = await calls(page, 'drag')
  assert.equal(drag[0][1], 'start')
  assert.deepEqual(drag[0].slice(2), [at.x, at.y], 'starts where it was pressed (screen coords)')
  assert.ok(drag.filter((c) => c[1] === 'move').length >= 2, 'moves sent (one per frame at most)')
  assert.deepEqual(drag.at(-1), ['drag', 'end', at.x - 260, at.y + 120])
  assert.deepEqual(await calls(page, 'open'), [], 'the drop did not open the bot')
  await reset(page)
  await press(page, at)
  assert.deepEqual(await calls(page, 'open'), [['open', 'bot-1']], 'a tap after a drag still clicks')
  // The grip, the "+" and the gaps drag too.
  for (const sel of ['.dock-grip', '.dock-add']) {
    await reset(page)
    const p = await centre(page, sel)
    await press(page, p, { x: p.x - 100, y: p.y })
    assert.equal((await calls(page, 'drag'))[0][1], 'start', sel)
    assert.deepEqual(await calls(page, 'picker'), [], `${sel}: no click`)
  }
})

pageTest('dock: a quick jitter is still a click; a right-click never drags', async (page) => {
  await showDock(page)
  const at = await centre(page, '.dock-bot[data-bot-id="manager"]')
  // 7px in one instant (a trackpad press): under the throw distance, before the delay.
  await page.mouse.move(at.x, at.y)
  await page.mouse.down()
  await page.mouse.move(at.x + 7, at.y)
  await page.mouse.up()
  assert.deepEqual(await calls(page, 'drag'), [])
  assert.deepEqual(await calls(page, 'open'), [['open', 'manager']])
  await reset(page)
  await page.mouse.move(at.x, at.y)
  await page.mouse.down({ button: 'right' })
  await page.mouse.move(at.x - 80, at.y, { steps: 5 })
  await page.mouse.up({ button: 'right' })
  assert.deepEqual(await calls(page, 'drag'), [])
})

pageTest('quick chat: selecting text or dragging in the composer never moves the window', async (page) => {
  await showDock(page, { expanded: true, mode: 'chat', botId: 'bot-1', popoverHeight: 520 })
  await page.evaluate(() => window.__cma.conversation({ bot_id: 'bot-1', history: true, messages: [{ id: 'a', role: 'assistant', body: 'Select these words to copy them somewhere else.' }], pending: null }))
  // Let the popover's entrance animation finish before selecting.
  await page.waitForTimeout(400)
  const msg = await page.locator('.message').first().boundingBox()
  // Along the first line of the bubble (its padding is 8px).
  await press(page, { x: msg.x + 8, y: msg.y + 16 }, { x: msg.x + msg.width - 8, y: msg.y + 16 })
  assert.ok((await page.evaluate(() => String(window.getSelection()))).length > 5, 'text got selected')
  const box = await page.locator('textarea').boundingBox()
  await page.locator('textarea').fill('typing here')
  await press(page, { x: box.x + 10, y: box.y + 10 }, { x: box.x + 120, y: box.y + 10 })
  assert.deepEqual(await calls(page, 'drag'), [])
  // With text selected, even a press on the dock does not start a drag.
  await page.evaluate(() => {
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('.message'))
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
  })
  const at = await centre(page, '.dock-bot[data-bot-id="bot-1"]')
  await page.mouse.move(at.x, at.y)
  await page.evaluate(() => {
    // Press without letting the browser clear the selection first.
    const el = document.querySelector('.dock-bot[data-bot-id="bot-1"]')
    const r = el.getBoundingClientRect()
    const o = { bubbles: true, button: 0, isPrimary: true, pointerId: 1, clientX: r.x + 5, clientY: r.y + 5, screenX: r.x + 5, screenY: r.y + 5 }
    el.dispatchEvent(new PointerEvent('pointerdown', o))
    el.dispatchEvent(new PointerEvent('pointermove', { ...o, clientX: r.x - 100, screenX: r.x - 100 }))
    el.dispatchEvent(new PointerEvent('pointerup', { ...o, clientX: r.x - 100, screenX: r.x - 100 }))
  })
  assert.deepEqual(await calls(page, 'drag'), [])
})

pageTest('dock on the left edge: the dock hugs the left and the popover opens to its right', async (page) => {
  await showDock(page, { side: 'left', expanded: true, mode: 'chat', botId: 'bot-1', popoverHeight: 520 })
  const dock = await page.locator('.dock').boundingBox()
  const pop = await page.locator('#popover').boundingBox()
  assert.equal(dock.x, 4)
  assert.ok(pop.x > dock.x + dock.width, 'popover to the right of the dock')
})

pageTest('a page told it cannot drag (Wayland) only clicks', async (page) => {
  await showDock(page, { draggable: false })
  const at = await centre(page, '.dock-bot[data-bot-id="bot-2"]')
  await press(page, at, { x: at.x - 200, y: at.y })
  assert.deepEqual(await calls(page, 'drag'), [])
  await press(page, at)
  assert.deepEqual(await calls(page, 'open'), [['open', 'bot-2']])
})

pageTest('island: a tap on the bar still opens it; a drag moves it and does not', async (page) => {
  await page.setViewportSize({ width: 380, height: 120 })
  await page.goto(ISLAND_URL)
  await page.evaluate(() => {
    window.__cma.view({ idle: false, bot: { id: 'bot-1', name: 'Ada', avatar_color: '#f2c94c', avatar_shape: 'circle' }, chip: { kind: 'question', label: 'Questions' }, detail: '', pending: null })
    window.__cma.islandLayout({ expanded: false, focused: false, draggable: true })
  })
  await page.waitForTimeout(300)
  const bar = await centre(page, '.island-bar')
  await press(page, bar, { x: bar.x + 1, y: bar.y + 1 })
  assert.deepEqual(await calls(page, 'activate'), [['activate']])
  assert.deepEqual(await calls(page, 'drag'), [])
  await reset(page)
  await press(page, { x: bar.x - 60, y: bar.y }, { x: bar.x + 40, y: bar.y + 50 })
  const drag = await calls(page, 'drag')
  assert.equal(drag[0][1], 'start')
  assert.equal(drag.at(-1)[1], 'end')
  assert.deepEqual(await calls(page, 'activate'), [], 'the drop did not toggle the card')
  // The chip is part of the bar: a tap on it is a click too.
  await reset(page)
  await press(page, await centre(page, '.chip'))
  assert.deepEqual(await calls(page, 'activate'), [['activate']])
})
