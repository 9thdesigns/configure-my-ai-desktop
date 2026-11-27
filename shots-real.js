const path = require('node:path')
const fs = require('node:fs')
const REPO = '/home/user/configure-my-ai-desktop'
const { chromium } = require('playwright')
const { widgetStateFrom } = require(`${REPO}/src/widget-state`)
const { widgetView, EXPANDED_WIDTH, POPOVER_HEIGHT } = require(`${REPO}/src/widget-window`)
const { islandView } = require(`${REPO}/src/island-window`)
const { html: realHtml } = require('./gen-fixture'); const CSS = fs.readFileSync(REPO + '/test/fixtures/cfa-avatar-real.css', 'utf8'); const cfaHtml = ({ shape, color, state }) => realHtml(shape, state).replace('--cfa-tint: #5b8def', '--cfa-tint: ' + color)
const fixture = require(`${REPO}/test/fixtures/widget.json`)
const OUT = path.join(__dirname, 'shots-real')

const looks = {
  manager: { shape: 'samurai', color: '#5b8def' },
  Ada: { shape: 'cloud', color: '#f2c94c' },
  Lin: { shape: 'triangle', color: '#6e56cf' },
  Ops: { shape: 'square', color: '#30a46c' },
  Rio: { shape: 'samurai', color: '#f08a24' },
  Kai: { shape: 'circle', color: '#2f9bd6' },
}

function baseFeed () {
  const f = structuredClone(fixture)
  f.seats.push(
    { bot_id: 'e5f6a7b8-c9d0-4e1f-8a2b-4c5d6e7f8a9b', name: 'Rio', avatar_color: '#f08a24', avatar_shape: 'circle', mood: 'idle', needs_count: 0, pinned: false, state: null },
    { bot_id: 'f6a7b8c9-d0e1-4f2a-9b3c-5d6e7f8a9b0c', name: 'Kai', avatar_color: '#2f9bd6', avatar_shape: 'circle', mood: 'idle', needs_count: 0, pinned: false, state: null },
  )
  return f
}
function newFeed (state) {
  const f = baseFeed()
  f.avatar_css_url = 'https://configuremyai.com/assets/cfa-avatar-3f2a9c.css'
  const av = (look, name) => ({ html: cfaHtml({ ...look, state }), color: look.color, shape: look.shape, state, image_url: null, initials: name.slice(0, 2).toUpperCase() })
  f.manager.avatar = av(looks.manager, 'Max')
  for (const s of f.seats) if (looks[s.name]) s.avatar = av(looks[s.name], s.name)
  return f
}

const stubApi = () => {
  window.__cb = {}
  const on = (k) => (fn) => { window.__cb[k] = fn }
  const noop = () => {}
  window.cmaWidget = { onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), ready: noop, reportHitRects: noop, drag: noop, open: noop, collapse: noop, contextMenu: noop, picker: noop, workspaceMenu: noop, pin: noop, openInApp: noop, sendMessage: async () => null, answer: async () => null, decide: async () => null }
  window.cmaIsland = { onView: on('view'), onLayout: on('layout'), onAvatarCss: on('css'), ready: noop, reportHeight: noop, hover: noop, activate: noop, collapse: noop, openInApp: noop, answer: async () => null, decide: async () => null }
}

async function shoot (browser, { scheme, name, kind, state, mode }) {
  const ctx = await browser.newContext({ viewport: { width: kind === 'island' ? 380 : EXPANDED_WIDTH + 8, height: kind === 'island' ? 64 : 560 }, deviceScaleFactor: 2, colorScheme: scheme })
  const page = await ctx.newPage()
  await page.route(/^https?:/, (r) => r.abort())
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.addInitScript(stubApi)
  await page.goto(`file://${REPO}/src/${kind === 'island' ? 'island' : 'widget'}.html`)
  const s = widgetStateFrom(state === 'before' ? baseFeed() : newFeed(state), { trusted: true })
  if (kind === 'island') {
    // The island shows the bot that needs you; show Ada working for the shot.
    s.focused_bot_id = s.seats.find((x) => x.name === 'Ada').bot_id
    const v = islandView(s)
    await page.evaluate(({ v, css }) => { if (css) window.__cb.css({ css }); window.__cb.view(v); window.__cb.layout({ expanded: false, focused: false }) }, { v, css: state === 'before' ? null : CSS })
  } else {
    const view = widgetView(s)
    const ada = view.bots.find((b) => b.name === 'Ada')
    await page.evaluate(({ view, css, layout, conv }) => {
      if (css) window.__cb.css({ css })
      window.__cb.state(view)
      window.__cb.layout(layout)
      if (conv) window.__cb.conversation(conv)
    }, {
      view,
      css: state === 'before' ? null : CSS,
      layout: { expanded: true, dockTop: 0, popoverTop: 0, popoverHeight: Math.min(POPOVER_HEIGHT, 540), botId: mode === 'chat' ? ada.id : null, mode },
      conv: mode === 'chat' ? { bot_id: ada.id, history: true, messages: [{ role: 'user', body: 'How is the landing page coming along?' }, { role: 'bot', body: 'Hero and pricing sections are done. Wiring up the signup form now.' }], pending: null } : null,
    })
  }
  await page.waitForTimeout(state === 'working' ? 500 : 300)
  const file = `${kind}-${mode || 'pill'}-${name}-${scheme}.png`
  await page.screenshot({ path: path.join(OUT, file), omitBackground: false })
  // Proof the constructed stylesheet got past the CSP and the face is live.
  const probe = await page.evaluate(() => {
    const box = document.querySelector('.avatar[data-mode]')
    const svg = document.querySelector('.cfa-avatar__svg')
    return { mode: box && box.dataset.mode, state: box && box.dataset.state, sheets: document.adoptedStyleSheets.length, svgWidth: svg ? getComputedStyle(svg).width : null, motion: document.documentElement.dataset.motion }
  })
  await ctx.close()
  return { file, probe, errors }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const results = []
  for (const scheme of ['light', 'dark']) {
    for (const [name, state] of [['real-cfa-idle', 'idle'], ['real-cfa-working', 'working']]) {
      results.push(await shoot(browser, { scheme, name, kind: 'widget', state, mode: 'chat' }))
      results.push(await shoot(browser, { scheme, name, kind: 'widget', state, mode: 'picker' }))
      results.push(await shoot(browser, { scheme, name, kind: 'island', state }))
    }
  }
  await browser.close()
  console.log(JSON.stringify(results, null, 1))
})()
