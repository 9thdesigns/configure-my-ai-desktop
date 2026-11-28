// Quick chat's message list in a real browser (Playwright Chromium), with a
// stub where the preload bridge would be, and a MutationObserver counting
// what each conversation push does to the DOM. The list must patch in place:
// a new message is appended (no existing message node removed), a growing
// (streaming) reply patches its text node, an unchanged thread (a poll, or a
// feed refetch) changes nothing at all, and the scroll stays where the user
// left it, or at the bottom when they were there. Skipped where Playwright
// (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const WIDGET_URL = pathToFileURL(path.join(__dirname, '../src/widget.html')).href

function stubBridge () {
  const cma = (window.__cma = { calls: [] })
  const on = (name) => (fn) => { cma[name] = fn }
  const call = (name) => (...args) => { cma.calls.push([name, ...args]) }
  window.cmaWidget = {
    ...Object.fromEntries(['ready', 'drag', 'open', 'collapse', 'contextMenu', 'picker', 'workspaceMenu', 'pin', 'openInApp'].map((n) => [n, call(n)])),
    onState: on('state'),
    onLayout: on('layout'),
    onConversation: on('conversation'),
    onAvatarCss: on('css'),
    reportHitRects () {},
    sendMessage: async (botId, body) => (cma.sendResult ? cma.sendResult(botId, body) : null),
    answer: async () => null,
    decide: async () => null,
  }
  // Every mutation under the popover, by kind; message-node removals apart.
  cma.counts = { removed: 0, removedMessages: 0, removedDelivery: 0, added: 0, characterData: 0, attributes: 0 }
  cma.observe = () => {
    const popover = document.getElementById('popover')
    new MutationObserver((records) => {
      for (const r of records) {
        // The composer's typing placeholder animates on its own; the thread
        // is what is counted here.
        const target = r.target.nodeType === 1 ? r.target : r.target.parentElement
        if (target && target.closest('.compose-placeholder')) continue
        if (r.type === 'characterData') cma.counts.characterData++
        if (r.type === 'attributes') cma.counts.attributes++
        if (r.type !== 'childList') continue
        cma.counts.added += r.addedNodes.length
        cma.counts.removed += r.removedNodes.length
        for (const n of r.removedNodes) if (n.nodeType === 1 && n.classList.contains('message')) cma.counts.removedMessages++
        for (const n of r.removedNodes) if (n.nodeType === 1 && n.classList.contains('delivery')) cma.counts.removedDelivery++
        // A message's text node replaced (textContent = …) is a removal too.
        if (r.target.nodeType === 1 && r.target.classList.contains('message')) cma.counts.removedMessages += r.removedNodes.length
      }
    }).observe(popover, { subtree: true, childList: true, characterData: true, attributes: true })
  }
  cma.reset = () => { for (const k of Object.keys(cma.counts)) cma.counts[k] = 0 }
}

const BOT = { id: 'bot-1', name: 'Ada', avatar_color: '#f2c94c', avatar_shape: 'circle', mood: 'idle', waiting: null, needs_count: 0, label: 'Idle', paused: false, isManager: false }

const msg = (i, role = i % 2 ? 'assistant' : 'user', body = `Message ${i} ${'lorem ipsum dolor sit amet '.repeat(1 + (i % 3))}`) => ({ id: `m${i}`, role, body, created_at: new Date(Date.UTC(2026, 10, 28, 9, i)).toISOString() })
const thread = (from, to, extra = {}) => ({ bot_id: 'bot-1', history: true, pending: null, messages: Array.from({ length: to - from + 1 }, (_, k) => msg(from + k)), ...extra })

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

async function openChat (page, conversation) {
  await page.goto(WIDGET_URL)
  await page.evaluate((bot) => {
    window.__cma.state({ bots: [bot], candidates: [], focused_bot_id: bot.id, dock_full: false, max_pinned: 12, workspace: null })
    window.__cma.layout({ expanded: true, mode: 'chat', botId: bot.id, dockTop: 0, popoverTop: 0, popoverHeight: 480, side: 'right', draggable: true })
  }, BOT)
  if (conversation) await push(page, conversation)
  await page.evaluate(() => { window.__cma.observe() })
}

const push = (page, conversation) => page.evaluate((c) => { window.__cma.conversation(c) }, conversation)
const counts = (page) => page.evaluate(() => { const c = { ...window.__cma.counts }; window.__cma.reset(); return c })
const flush = (page) => page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))))
const texts = (page) => page.$$eval('[data-role="messages"] .message', (nodes) => nodes.map((n) => n.textContent))
const scroll = (page) => page.$eval('[data-role="messages"]', (el) => ({ top: el.scrollTop, max: el.scrollHeight - el.clientHeight }))
// Tag every message node, to tell afterwards which ones are the same nodes.
const tag = (page) => page.$$eval('[data-role="messages"] .message', (nodes) => nodes.forEach((n, i) => { n.__tag = i + 1 }))
const tags = (page) => page.$$eval('[data-role="messages"] .message', (nodes) => nodes.map((n) => n.__tag || 0))

pageTest('chat: a new message is appended; no existing message node is removed or replaced', async (page) => {
  await openChat(page, thread(1, 6))
  await tag(page)
  await counts(page)
  await push(page, thread(1, 7))
  await flush(page)
  const c = await counts(page)
  assert.equal(c.removedMessages, 0, 'no message node removed')
  assert.equal(c.removed - c.removedDelivery, 0, 'nothing removed but the "Delivered" line (the bot replied)')
  assert.equal(c.added, 1, 'one node added: the new message')
  assert.deepEqual(await tags(page), [1, 2, 3, 4, 5, 6, 0], 'the six old nodes are the same nodes; one new one at the end')
  assert.equal((await texts(page)).at(-1), msg(7).body)
})

pageTest('chat: the server window sliding past 20 messages keeps the older nodes (still no removals)', async (page) => {
  await openChat(page, thread(1, 20))
  await tag(page)
  await counts(page)
  await push(page, thread(2, 21))
  await flush(page)
  const c = await counts(page)
  assert.equal(c.removedMessages, 0)
  assert.equal(c.removed - c.removedDelivery, 0)
  assert.equal(c.added, 1)
  assert.equal((await texts(page)).length, 21, 'message 1 stays above the window, not torn down')
  assert.deepEqual((await tags(page)).slice(0, 20), Array.from({ length: 20 }, (_, i) => i + 1))
})

pageTest('chat: a streaming reply patches its text node in place', async (page) => {
  const base = thread(1, 4)
  await openChat(page, base)
  const reply = (body) => ({ ...base, messages: [...base.messages, { id: 'm5', role: 'assistant', body, created_at: base.messages[3].created_at }] })
  await push(page, reply('Thinking'))
  await tag(page)
  const textNode = await page.evaluateHandle(() => document.querySelector('[data-role="messages"] .message:last-child').firstChild)
  await counts(page)
  for (const body of ['Thinking about', 'Thinking about it', 'Thinking about it — done.']) {
    await push(page, reply(body))
    await flush(page)
    const c = await counts(page)
    assert.equal(c.removed, 0, `"${body}": nothing removed`)
    assert.equal(c.added, 0, `"${body}": nothing added`)
    assert.equal(c.characterData, 1, `"${body}": one text patch`)
    assert.equal((await texts(page)).at(-1), body)
  }
  assert.ok(await page.evaluate((n) => n === document.querySelector('[data-role="messages"] .message:last-child').firstChild, textNode), 'the same text node throughout')
  assert.deepEqual(await tags(page), [1, 2, 3, 4, 5])
})

pageTest('chat: an unchanged thread (a poll, a feed refetch, a state push) changes nothing in the DOM', async (page) => {
  await openChat(page, thread(1, 8))
  await counts(page)
  for (let i = 0; i < 5; i++) {
    await push(page, thread(1, 8))
    await page.evaluate((bot) => window.__cma.state({ bots: [bot], candidates: [], focused_bot_id: bot.id, dock_full: false, max_pinned: 12, workspace: null }), BOT)
  }
  await flush(page)
  assert.deepEqual(await counts(page), { removed: 0, removedMessages: 0, removedDelivery: 0, added: 0, characterData: 0, attributes: 0 })
})

pageTest('chat: a thread with a pending card, pushed again, leaves the card (and a half-made choice) alone', async (page) => {
  const pending = { id: 'q1', kind: 'question', prompt: 'Which one?', detail: '', options: [{ id: 'a', label: 'Apple' }, { id: 'b', label: 'Banana' }], allow_other: true, multiple: true, questions_count: 1, actionable: true }
  await openChat(page, thread(1, 3, { pending }))
  await page.click('.option[data-option-id="a"]')
  await counts(page)
  await push(page, thread(1, 3, { pending }))
  await flush(page)
  const c = await counts(page)
  assert.equal(c.added + c.removed + c.characterData, 0)
  assert.equal(await page.$$eval('.option.is-selected', (n) => n.length), 1)
})

pageTest('chat: stuck to the bottom, a new message scrolls into view; scrolled up, the view stays put', async (page) => {
  await openChat(page, thread(1, 16))
  let s = await scroll(page)
  assert.ok(s.max > 0, 'the thread overflows')
  assert.ok(s.max - s.top < 2, 'opens at the bottom')
  await push(page, thread(1, 17))
  await flush(page)
  s = await scroll(page)
  assert.ok(s.max - s.top < 2, 'still at the bottom after a new message')

  await page.$eval('[data-role="messages"]', (el) => { el.scrollTop = 40 })
  await push(page, thread(1, 18))
  await flush(page)
  assert.equal((await scroll(page)).top, 40, 'scrolled up: the new message does not yank the view')
  // A streaming reply growing while scrolled up: the view stays put too.
  const t = thread(1, 18)
  t.messages[17] = { ...t.messages[17], body: `${t.messages[17].body} and a much longer tail `.repeat(4) }
  await push(page, t)
  await flush(page)
  assert.equal((await scroll(page)).top, 40)
})

pageTest('chat: reopening the same bot keeps its thread on screen instead of flashing "Loading…"', async (page) => {
  await openChat(page, thread(1, 5))
  await tag(page)
  await page.evaluate(() => window.__cma.layout({ expanded: false, mode: 'chat', botId: null, dockTop: 0, popoverTop: 0, popoverHeight: 0, side: 'right', draggable: true }))
  await counts(page)
  await page.evaluate(() => window.__cma.layout({ expanded: true, mode: 'chat', botId: 'bot-1', dockTop: 0, popoverTop: 0, popoverHeight: 480, side: 'right', draggable: true }))
  await flush(page)
  assert.equal(await page.$$eval('.messages-empty', (n) => n.length), 0, 'no "Loading…" placeholder')
  assert.deepEqual(await tags(page), [1, 2, 3, 4, 5], 'the same nodes')
  await push(page, thread(1, 5))
  await flush(page)
  const c = await counts(page)
  assert.equal(c.removed, 0)
  assert.equal(c.added, 0)
})

pageTest('chat: opening another bot clears the last one’s thread', async (page) => {
  await openChat(page, thread(1, 5))
  await page.evaluate(() => window.__cma.layout({ expanded: true, mode: 'chat', botId: 'bot-2', dockTop: 0, popoverTop: 0, popoverHeight: 480, side: 'right', draggable: true }))
  await flush(page)
  assert.deepEqual(await texts(page), [])
  assert.equal(await page.$eval('.messages-empty', (n) => n.textContent), 'Loading…')
})

pageTest('chat: a message removed from the middle of the thread goes; the rest stay', async (page) => {
  await openChat(page, thread(1, 5))
  await tag(page)
  const t = thread(1, 5)
  t.messages.splice(2, 1)
  await push(page, t)
  await flush(page)
  assert.deepEqual(await tags(page), [1, 2, 4, 5])
})

pageTest('chat: a long-open popover keeps at most 200 rows, dropping the oldest', async (page) => {
  await openChat(page, thread(1, 20))
  for (let to = 21; to <= 215; to++) await push(page, thread(to - 19, to))
  await flush(page)
  const all = await texts(page)
  assert.equal(all.length, 200)
  assert.equal(all[0], msg(16).body)
  assert.equal(all.at(-1), msg(215).body)
})
