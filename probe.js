const path = require('node:path')
const REPO = '/home/user/configure-my-ai-desktop'
const { chromium } = require('playwright')
const { widgetStateFrom } = require(`${REPO}/src/widget-state`)
const { widgetView } = require(`${REPO}/src/widget-window`)
const { cfaHtml, CSS } = require('./stub-cfa')
const fixture = require(`${REPO}/test/fixtures/widget.json`)
const looks = { Max: ['astronaut', '#7c5cff'], Ada: ['cloud', '#f2c94c'], Lin: ['triangle', '#6e56cf'] }
function view (state) {
  const f = structuredClone(fixture)
  f.avatar_css_url = 'https://configuremyai.com/assets/cfa-avatar-3f2a9c.css'
  const av = (n) => ({ html: cfaHtml({ shape: looks[n][0], color: looks[n][1], state }), color: looks[n][1], shape: looks[n][0], state, image_url: null, initials: n.slice(0, 2) })
  f.manager.avatar = av('Max')
  for (const s of f.seats) if (looks[s.name] && s.name !== 'Max') s.avatar = av(s.name)
  return widgetView(widgetStateFrom(f, { trusted: true }))
}
const stub = () => { window.__cb = {}; const on = (k) => (fn) => { window.__cb[k] = fn }; const n = () => {}; window.cmaWidget = { onState: on('state'), onLayout: on('layout'), onConversation: on('conversation'), onAvatarCss: on('css'), ready: n, reportHitRects: n, drag: n, open: n, collapse: n, contextMenu: n, picker: n, workspaceMenu: n, pin: n, openInApp: n } }
;(async () => {
  const browser = await chromium.launch()
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const ctx = await browser.newContext({ viewport: { width: 80, height: 300 }, reducedMotion, recordVideo: reducedMotion === 'no-preference' ? { dir: path.join(__dirname, 'shots'), size: { width: 240, height: 600 } } : undefined, deviceScaleFactor: 1 })
    const page = await ctx.newPage()
    await page.route(/^https?:/, (r) => r.abort())
    const csp = []
    page.on('console', (m) => { if (/Content Security Policy/i.test(m.text())) csp.push(m.text()) })
    await page.addInitScript(stub)
    await page.goto(`file://${REPO}/src/widget.html`)
    await page.evaluate(({ v, css }) => { window.__cb.css({ css }); window.__cb.state(v); window.__cb.layout({ expanded: false, dockTop: 0, popoverTop: 0, popoverHeight: 0, botId: null, mode: 'chat' }) }, { v: view('idle'), css: CSS })
    await page.evaluate(() => { window.__face = document.querySelector('.dock-bot .avatar > span') })
    await page.waitForTimeout(1500)
    await page.evaluate((v) => window.__cb.state(v), view('working'))
    await page.waitForTimeout(2500)
    const r = await page.evaluate(() => {
      const face = document.querySelector('.dock-bot .avatar > span')
      const bob = face.querySelector('.cfa-avatar__bob')
      return { sameNode: face === window.__face, state: face.dataset.state, cls: face.className, motion: document.documentElement.dataset.motion, bobAnimation: getComputedStyle(bob).animationName, running: document.getAnimations().length }
    })
    await page.evaluate((v) => window.__cb.state(v), view('idle'))
    await page.waitForTimeout(1500)
    console.log(reducedMotion, JSON.stringify(r), 'csp violations:', csp.length)
    await ctx.close()
  }
  await browser.close()
})()
