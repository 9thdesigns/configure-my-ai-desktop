// Quick chat's look in a real browser (Playwright Chromium), with a stub
// where the preload bridge would be: the pill composer grows with its text
// while its placeholder stays on one line, bubble spacing and grouped
// corners come from the shared tokens (and the web app's sheet overrides
// them), light and dark, time separators, the delivery line (Delivered,
// Sending…, Not delivered with Retry), the composer-tools slot, and the
// bundled Inter. Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [], sends: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp'].map((n) => [n, call(n)])),
    onState: on('state'),
    onLayout: on('layout'),
    onConversation: on('conversation'),
    onAvatarCss: on('css'),
    onChatCss: on('chatCss'),
    reportHitRects () {},
    sendMessage: (botId, body) => new Promise((resolve) => cma.sends.push({ botId, body, resolve })),
    answer: async () => null,
    decide: async () => null,
  }
}

const BOT = { id: 'bot-1', name: 'Ada', avatar_color: '#f2c94c', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: false }
const T0 = Date.now() - 60 * 60 * 1000
const msg = (id, role, minutes, body = `${role} ${id}`) => ({ id, role, body, created_at: new Date(T0 + minutes * 60_000).toISOString() })
const conv = (messages) => ({ bot_id: 'bot-1', history: true, pending: null, messages })
const THREAD = [msg('a', 'user', 0), msg('b', 'user', 1), msg('c', 'assistant', 2), msg('d', 'assistant', 3), msg('e', 'assistant', 30), msg('f', 'user', 31)]

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { colorScheme = 'light' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 520, height: 560 }, colorScheme })
  const page = await context.newPage()
  await page.addInitScript(stubBridge)
  try {
    await fn(page)
  } finally {
    await context.close()
  }
})

async function openChat (page, conversation = conv(THREAD), bot = BOT) {
  await page.goto(WIDGET_URL)
  await page.evaluate((bot) => {
    window.__cma.state({ bots: [bot], candidates: [], focused_bot_id: bot.id, dock_full: false, max_pinned: 12, workspace: null })
    window.__cma.layout({ expanded: true, mode: 'chat', botId: bot.id, dockTop: 0, popoverTop: 0, popoverHeight: 520, side: 'right', draggable: true })
  }, bot)
  if (conversation) await page.evaluate((c) => window.__cma.conversation(c), conversation)
  await page.evaluate(() => document.getAnimations().forEach((a) => { if (a.effect.getComputedTiming().endTime !== Infinity) a.finish() }))
}

const box = (page, sel) => page.locator(sel).first().evaluate((n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height, width: r.width } })
const style = (page, sel, props) => page.locator(sel).first().evaluate((n, props) => { const s = getComputedStyle(n); return Object.fromEntries(props.map((p) => [p, s.getPropertyValue(p)])) }, props)
const gap = async (page, a, b) => (await box(page, b)).top - (await box(page, a)).bottom
const rowTexts = (page) => page.$$eval('[data-role="messages"] > li', (n) => n.map((li) => `${li.className.split(' ')[0]}:${li.textContent}`))

pageTest('composer: a pill that grows with multiline text up to its cap; the composer height never moves for the placeholder', async (page) => {
  await openChat(page, conv(THREAD), { ...BOT, name: 'A bot with a really remarkably long name that will not fit on one line' })
  const ph = '[data-role="compose-placeholder"]'
  const one = await box(page, 'textarea')
  const p = await page.$eval(ph, (n) => ({ h: n.getBoundingClientRect().height, vis: getComputedStyle(n).visibility, ws: getComputedStyle(n).whiteSpace }))
  assert.equal(p.vis, 'visible', 'shown while empty')
  assert.equal(p.ws, 'nowrap')
  assert.equal(p.h, 20, 'one 20px line')
  assert.match(await page.$eval('textarea', (n) => n.getAttribute('aria-label')), /^Message A bot with/, 'the field is labelled with the first hint')
  const pill = await style(page, '.composer-pill', ['border-top-left-radius'])
  assert.equal(pill['border-top-left-radius'], '22px')

  await page.locator('textarea').fill('one\ntwo\nthree')
  await page.locator('textarea').dispatchEvent('input')
  const three = await box(page, 'textarea')
  assert.ok(three.height >= one.height + 30, `grew: ${one.height} → ${three.height}`)
  assert.equal(await page.$eval(ph, (n) => getComputedStyle(n).visibility), 'hidden', 'hidden once there is text')
  assert.equal(await page.$eval('.btn-send', (n) => n.disabled), false, 'send is live')
  // The send button stays on the bottom line as the pill grows.
  assert.ok(Math.abs((await box(page, '.btn-send')).bottom - (await box(page, '.composer-pill')).bottom) <= 6)
  const list = await page.$eval('[data-role="messages"]', (n) => n.scrollHeight - n.scrollTop - n.clientHeight)
  assert.ok(list < 2, 'the thread, shrunk by the taller composer, is still at the bottom')

  await page.locator('textarea').fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'))
  await page.locator('textarea').dispatchEvent('input')
  const capped = await box(page, 'textarea')
  assert.equal(capped.height, 128, 'capped at --composer-max-height (140px) less the pill padding')
  assert.ok((await box(page, '.composer-pill')).height <= 140)

  await page.locator('textarea').fill('')
  await page.locator('textarea').dispatchEvent('input')
  assert.equal((await box(page, 'textarea')).height, one.height, 'back to one line')
  assert.equal(await page.$eval('.btn-send', (n) => n.disabled), true, 'nothing to send')
})

// The placeholder, frame by frame, on Playwright's fake clock.
const LONG = { ...BOT, name: 'Ada the very thorough research assistant for growth' }
const TYPE_MS = 45
const REST_MS = 2600
const frame = (page) => page.evaluate(() => {
  const box = document.querySelector('[data-role="compose-placeholder"]')
  const inner = box.querySelector('.compose-placeholder-text')
  const b = box.getBoundingClientRect()
  const i = inner.getBoundingClientRect()
  return {
    state: box.dataset.phState,
    offset: Number(box.dataset.phOffset || 0),
    text: inner.textContent,
    lineHeight: b.height,
    innerHeight: i.height,
    typedWidth: i.width,
    room: box.clientWidth,
    caretRight: i.right - b.left, // where the caret is, inside the box
    pill: document.querySelector('.composer-pill').getBoundingClientRect().height,
  }
})

async function openOnClock (page, bot) {
  await page.clock.install()
  await openChat(page, conv(THREAD), bot)
}

pageTest('placeholder: types its hint on one line, the window following the caret; the offset never decreases; the height never moves', async (page) => {
  await openOnClock(page, LONG)
  const hint = `Message ${LONG.name}…`
  const frames = []
  for (let n = 0; n < hint.length + 2; n++) {
    await page.clock.runFor(TYPE_MS)
    frames.push(await frame(page))
  }
  const typing = frames.filter((f) => f.state === 'typing')
  assert.ok(typing.length >= hint.length - 1, 'one character per frame')
  typing.forEach((f, k) => {
    assert.ok(hint.startsWith(f.text), `frame ${k} types a head of the hint`)
    assert.equal(f.lineHeight, 20, 'one line')
    assert.equal(f.innerHeight, 20, 'never wraps')
    assert.equal(f.pill, frames[0].pill, 'the composer height stays put')
    if (k) assert.ok(f.offset >= typing[k - 1].offset, `offset never decreases (${typing[k - 1].offset} → ${f.offset})`)
    assert.equal(f.offset, Math.max(0, ...typing.slice(0, k + 1).map((g) => Math.ceil(g.typedWidth - g.room))), 'offset = typed width past the room')
    assert.ok(f.caretRight - f.offset <= f.room + 1, 'the caret is in view')
  })
  assert.ok(typing.at(-1).offset > 0, 'the long hint did outgrow the line')
  assert.equal(typing.at(-1).text, hint)

  const rest = frames.at(-1)
  assert.equal(rest.state, 'rest')
  assert.equal(rest.offset, 0)
  assert.ok(rest.text.endsWith('…'))
  const head = rest.text.slice(0, -1)
  assert.ok(hint.startsWith(head) && /\s/.test(hint[head.length]), `cut at a word: "${rest.text}"`)
  assert.ok(rest.typedWidth <= rest.room + 0.5, 'fits the line')
  assert.equal(rest.pill, frames[0].pill)
})

pageTest('placeholder: a hint that fits rests whole; then the next hint types', async (page) => {
  await openOnClock(page, BOT)
  await page.clock.runFor(TYPE_MS * 20)
  let f = await frame(page)
  assert.deepEqual([f.state, f.text, f.offset], ['rest', 'Message Ada…', 0])
  await page.clock.runFor(REST_MS + TYPE_MS * 3)
  f = await frame(page)
  assert.equal(f.state, 'typing')
  assert.ok('Ask Ada anything…'.startsWith(f.text) && f.text.length >= 2, f.text)
})

pageTest('placeholder: typing stops while the field has text, and starts again once it is empty', async (page) => {
  await openOnClock(page, BOT)
  await page.clock.runFor(TYPE_MS * 3)
  await page.locator('textarea').fill('hi')
  await page.locator('textarea').dispatchEvent('input')
  const still = await frame(page)
  assert.equal(still.state, 'rest')
  await page.clock.runFor(REST_MS * 3)
  assert.deepEqual(await frame(page), still, 'nothing moves underneath the text')
  await page.locator('textarea').fill('')
  await page.locator('textarea').dispatchEvent('input')
  await page.clock.runFor(TYPE_MS * 2)
  assert.equal((await frame(page)).state, 'typing')
})

pageTest('placeholder, reduced motion: one still, fitted line with "…"; no typing, no rotation', async (page) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openOnClock(page, LONG)
  const first = await frame(page)
  assert.equal(first.state, 'still')
  assert.equal(first.offset, 0)
  assert.ok(first.text.endsWith('…') && `Message ${LONG.name}…`.startsWith(first.text.slice(0, -1)))
  assert.ok(first.typedWidth <= first.room + 0.5)
  await page.clock.runFor(REST_MS * 4)
  assert.deepEqual(await frame(page), first, 'it never changes')
})

pageTest('bubbles: tight within a run, roomy on a change of sender, inner corners squared off', async (page) => {
  await openChat(page)
  const sel = (id) => `[data-message-id="${id}"]`
  assert.equal(await gap(page, sel('a'), sel('b')), 4, 'same sender: --bubble-gap-same')
  assert.equal(await gap(page, sel('b'), sel('c')), 14, 'sender change: --bubble-gap-change')
  assert.equal(await gap(page, sel('c'), sel('d')), 4)
  const a = await style(page, sel('a'), ['border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'])
  const b = await style(page, sel('b'), ['border-top-right-radius', 'border-bottom-right-radius'])
  assert.deepEqual(a, { 'border-top-right-radius': '18px', 'border-bottom-right-radius': '6px', 'border-bottom-left-radius': '18px' })
  assert.deepEqual(b, { 'border-top-right-radius': '6px', 'border-bottom-right-radius': '18px' })
  const c = await style(page, sel('c'), ['border-top-left-radius', 'border-bottom-left-radius'])
  assert.deepEqual(c, { 'border-top-left-radius': '18px', 'border-bottom-left-radius': '6px' })
  const font = await style(page, sel('c'), ['font-family', 'font-size', 'line-height'])
  assert.match(font['font-family'], /^Inter/)
  assert.equal(font['font-size'], '14px')
})

pageTest('the web app\'s token sheet overrides the bundled values', async (page) => {
  await openChat(page)
  await page.evaluate(() => window.__cma.chatCss({ url: 'x', css: ':root { --bubble-gap-same: 6px; --bubble-gap-change: 16px; --bubble-radius: 20px; }' }))
  assert.equal(await gap(page, '[data-message-id="a"]', '[data-message-id="b"]'), 6)
  assert.equal(await gap(page, '[data-message-id="b"]', '[data-message-id="c"]'), 16)
  assert.equal((await style(page, '[data-message-id="a"]', ['border-top-right-radius']))['border-top-right-radius'], '20px')
})

for (const [scheme, user, bot] of [['light', 'rgb(35, 29, 27)', 'rgb(241, 239, 236)'], ['dark', 'rgb(245, 244, 242)', 'rgb(42, 42, 40)']]) {
  pageTest(`${scheme}: bubbles, composer and send take the ${scheme} tokens`, async (page) => {
    await openChat(page)
    assert.equal((await style(page, '.message.is-user', ['background-color']))['background-color'], user)
    assert.equal((await style(page, '.message.is-assistant', ['background-color']))['background-color'], bot)
    const pill = (await style(page, '.composer-pill', ['background-color']))['background-color']
    const surface = (await style(page, '.popover', ['background-color']))['background-color']
    assert.notEqual(pill, surface, 'the pill sits on its own fill')
  }, { colorScheme: scheme })
}

pageTest('time separators before the first message and after a gap; Delivered under the latest outgoing message', async (page) => {
  await openChat(page)
  const rows = await rowTexts(page)
  assert.match(rows[0], /^time-sep:(Today|Yesterday) \d+:\d\d (AM|PM)$/)
  assert.equal(rows.filter((r) => r.startsWith('time-sep')).length, 2, 'the first message, and e (27 minutes after d)')
  assert.match(rows[rows.indexOf('message:assistant e') - 1], /^time-sep:/)
  assert.equal(rows.at(-1), 'delivery:Delivered')
  assert.equal(rows.at(-2), 'message:user f')
  const d = await box(page, '.delivery')
  const f = await box(page, '[data-message-id="f"]')
  assert.ok(Math.abs(d.right - f.right) <= 4, 'right-aligned under the bubble')
})

pageTest('a send shows at once as "Sending…", then the same bubble is "Delivered"; a failure offers Retry', async (page) => {
  await openChat(page)
  await page.locator('textarea').fill('Ship it')
  await page.keyboard.press('Enter')
  let rows = await rowTexts(page)
  assert.deepEqual(rows.slice(-2), ['message:Ship it', 'delivery:Sending…'])
  assert.equal(await page.$eval('textarea', (n) => n.value), '', 'the field clears at once')
  await page.$$eval('[data-role="messages"] .message', (n) => { n.at(-1).__tag = 'mine' })
  // The server confirms it: the bubble stays the same node.
  await page.evaluate((c) => window.__cma.sends[0].resolve(c), conv([...THREAD, msg('g', 'user', 32, 'Ship it')]))
  await page.waitForFunction(() => document.querySelector('.delivery')?.textContent === 'Delivered')
  assert.equal(await page.$$eval('[data-role="messages"] .message', (n) => n.at(-1).__tag), 'mine')
  assert.equal(await page.$$eval('[data-role="messages"] .message', (n) => n.at(-1).dataset.messageId), 'g')

  await page.locator('textarea').fill('Again')
  await page.keyboard.press('Enter')
  await page.evaluate(() => window.__cma.sends[1].resolve(null))
  await page.waitForFunction(() => document.querySelector('.delivery')?.textContent.startsWith('Not delivered'))
  rows = await rowTexts(page)
  assert.deepEqual(rows.slice(-2), ['message:Again', 'delivery:Not deliveredRetry'])
  await page.click('.delivery button')
  assert.equal(await page.evaluate(() => window.__cma.sends.length), 3)
  assert.equal(await page.evaluate(() => window.__cma.sends[2].body), 'Again')
  assert.equal((await rowTexts(page)).at(-1), 'delivery:Sending…')
})

pageTest('composer tools: the slot is there, takes no room empty, and shows what mounts in it; no attach or mic yet', async (page) => {
  await openChat(page)
  const slot = '[data-slot="composer-tools"]'
  assert.equal(await page.$eval(slot, (n) => getComputedStyle(n).display), 'none')
  assert.equal(await page.$$eval('.composer button', (n) => n.length), 1, 'only send')
  await page.$eval(slot, (n) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = 'Share screen'; b.style.width = '32px'; b.style.height = '32px'; n.append(b) })
  assert.equal(await page.$eval(slot, (n) => getComputedStyle(n).display), 'flex')
  assert.ok((await box(page, slot)).right <= (await box(page, 'textarea')).left, 'left of the field')
})

pageTest('the bundled Inter loads under the page CSP', async (page) => {
  await openChat(page)
  const loaded = await page.evaluate(async () => { await document.fonts.load('14px Inter'); await document.fonts.ready; return [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Inter' && f.status === 'loaded') })
  assert.ok(loaded)
})
