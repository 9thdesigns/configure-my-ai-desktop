// The Share screen button in a real browser (Playwright Chromium), with a
// stub where the preload bridge would be: it mounts into the composer's
// tools slot only when offered, asks to turn the switch on first, shows the
// indicator while main captures, then the attached preview, and a refusal
// with its System Settings button. Skipped where Playwright is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [], shares: [], sends: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp', 'discardScreen', 'openScreenSettings', 'setShareScreen'].map((n) => [n, call(n)])),
    onState: on('state'),
    onLayout: on('layout'),
    onConversation: on('conversation'),
    onAvatarCss: on('css'),
    onChatCss: on('chatCss'),
    onScreen: on('screen'),
    reportHitRects () {},
    sendMessage: (botId, body) => new Promise((resolve) => cma.sends.push({ botId, body, resolve })),
    shareScreen: (botId, reason) => new Promise((resolve) => cma.shares.push({ botId, reason, resolve })),
    answer: async () => null,
    decide: async () => null,
  }
}

const BOT = { id: 'manager', name: 'Max', avatar_color: '#231d1b', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: true }
const PREVIEW = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

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
  try { await fn(page) } finally { await context.close() }
})

async function openChat (page, screenShare) {
  await page.goto(WIDGET_URL)
  await page.evaluate(({ bot, screenShare }) => {
    window.__cma.state({ bots: [bot], candidates: [], focused_bot_id: bot.id, dock_full: false, max_pinned: 12, workspace: null, ...(screenShare ? { screen_share: screenShare } : {}) })
    window.__cma.layout({ expanded: true, mode: 'chat', botId: bot.id, dockTop: 0, popoverTop: 0, popoverHeight: 520, side: 'right', draggable: true })
    window.__cma.conversation({ bot_id: bot.id, history: true, pending: null, messages: [{ id: 'a', role: 'assistant', body: 'Hi', created_at: new Date().toISOString() }] })
  }, { bot: BOT, screenShare })
}

const SLOT = '[data-slot="composer-tools"]'
const BUTTON = `${SLOT} [data-action="share-screen"]`

pageTest('not offered (no server support): the slot stays empty and takes no room', async (page) => {
  await openChat(page, { available: false, enabled: true })
  assert.equal(await page.$(BUTTON), null)
  assert.equal(await page.$eval(SLOT, (n) => getComputedStyle(n).display), 'none')
  await openChat(page, null)
  assert.equal(await page.$(BUTTON), null, 'an older main sends no screen_share at all')
})

pageTest('offered: the button mounts into the slot, left of the field', async (page) => {
  await openChat(page, { available: true, enabled: true })
  assert.ok(await page.$(BUTTON))
  assert.equal(await page.$eval(BUTTON, (b) => b.getAttribute('aria-label')), 'Share screen')
  const [b, f] = await Promise.all([BUTTON, 'textarea'].map((s) => page.$eval(s, (n) => n.getBoundingClientRect().toJSON())))
  assert.ok(b.right <= f.left)
})

pageTest('switch off: the button asks first; "Turn on" sets the switch and captures', async (page) => {
  await openChat(page, { available: true, enabled: false })
  await page.click(BUTTON)
  assert.equal(await page.evaluate(() => window.__cma.shares.length), 0, 'nothing captured before the user agrees')
  assert.match(await page.textContent('[data-role="screen"]'), /Let Manager see your screen\?/)
  await page.click('[data-role="screen"] button.btn-primary')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'setShareScreen')), [['setShareScreen', true]])
  assert.deepEqual(await page.evaluate(() => window.__cma.shares.map((s) => [s.botId, s.reason])), [['manager', 'button']])
})

pageTest('capturing → "Viewing your screen", then the preview; sending clears it', async (page) => {
  await openChat(page, { available: true, enabled: true })
  await page.click(BUTTON)
  assert.match(await page.textContent('[data-role="screen"]'), /Viewing your screen/)
  assert.equal(await page.$eval(BUTTON, (b) => b.disabled), true, 'one capture at a time')
  await page.evaluate((preview) => window.__cma.shares[0].resolve({ status: 'ok', botId: 'manager', preview }), PREVIEW)
  await page.waitForSelector('[data-role="screen"] img')
  assert.match(await page.textContent('[data-role="screen"]'), /Screenshot attached/)
  assert.equal(await page.$eval('.btn-send', (b) => b.disabled), false, 'a screenshot alone can be sent')
  await page.click('.btn-send')
  assert.equal(await page.evaluate(() => window.__cma.sends[0].body), '')
  assert.equal(await page.$eval('[data-role="screen"]', (n) => n.hidden), true)
  assert.ok(await page.$('.message.has-screenshot.is-sending'), 'the sending bubble is marked')
})

pageTest('main\'s indicator shows even for a capture the composer did not start', async (page) => {
  await openChat(page, { available: true, enabled: true })
  await page.evaluate(() => window.__cma.screen({ capturing: true }))
  assert.match(await page.textContent('[data-role="screen"]'), /Viewing your screen/)
  await page.evaluate(() => window.__cma.screen({ capturing: false }))
  assert.equal(await page.$eval('[data-role="screen"]', (n) => n.hidden), true)
})

pageTest('permission denied: the message and an Open System Settings button (main opens it)', async (page) => {
  await openChat(page, { available: true, enabled: true })
  await page.click(BUTTON)
  await page.evaluate(() => window.__cma.shares[0].resolve({ status: 'refused', code: 'permission_denied', message: 'No Screen Recording permission.', settingsUrl: 'x-apple.systempreferences:whatever' }))
  await page.click('[data-role="screen"] button.btn-primary')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'openScreenSettings')), [['openScreenSettings']], 'no URL from the renderer')
})

pageTest('Remove drops the held screenshot in main', async (page) => {
  await openChat(page, { available: true, enabled: true })
  await page.click(BUTTON)
  await page.evaluate((preview) => window.__cma.shares[0].resolve({ status: 'ok', botId: 'manager', preview }), PREVIEW)
  await page.click('[data-role="screen"] button.btn')
  assert.deepEqual(await page.evaluate(() => window.__cma.calls.filter((c) => c[0] === 'discardScreen')), [['discardScreen', 'manager']])
})

pageTest('the typing placeholder rests while a screenshot is attached, and the screen line sits outside the pill', async (page) => {
  // Playwright's fake clock: the placeholder's timers run only when told,
  // so this checks behaviour, not how busy the machine is.
  // Paused: install() alone lets fake time flow with the real clock.
  const t = Date.now()
  await page.clock.install({ time: t })
  await page.clock.pauseAt(t + 1000)
  await openChat(page, { available: true, enabled: true })
  await page.click(BUTTON)
  const line = await page.$eval('[data-role="screen"]', (n) => n.getBoundingClientRect().toJSON())
  const pill = await page.$eval('.composer-pill', (n) => n.getBoundingClientRect().toJSON())
  assert.ok(line.bottom <= pill.top, '"Viewing your screen" is above the pill, clear of the placeholder overlay')
  await page.evaluate((preview) => window.__cma.shares[0].resolve({ status: 'ok', botId: 'manager', preview }), PREVIEW)
  await page.waitForSelector('[data-role="screen"] img')
  const read = () => page.$eval('[data-role="compose-placeholder"]', (n) => `${n.dataset.phState}|${n.textContent}`)
  const first = await read()
  assert.match(first, /^rest\|/)
  // Well past a full type, rest and retype cycle (TYPE_MS 45, REST_MS 2600):
  // an active placeholder would have cleared and retyped the line.
  for (let i = 0; i < 6; i++) {
    await page.clock.runFor(1000)
    assert.equal(await read(), first, `still resting after ${i + 1} s`)
  }
  // Removing the screenshot lets it type again.
  await page.click('[data-role="screen"] button.btn')
  await page.clock.runFor(45 * 3)
  assert.match(await read(), /^typing\|/, 'typing again once nothing is attached')
})
