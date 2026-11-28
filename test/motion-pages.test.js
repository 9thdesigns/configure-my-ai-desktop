// The motion module and the tokens, live in the widget and island pages
// (Playwright Chromium): both pages load widget-tokens.css and motion.js
// under their CSP; the --spring-* tokens they compute are the springs
// motion.js knows; a live spring runs on real animation frames to its
// target; under reduced motion a sampled spring sets its end state and runs
// no animation. Skipped where Playwright (or its Chromium) is not installed.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

let pw = null
try { pw = require('playwright') } catch {}

const PAGES = {
  widget: pathToFileURL(path.join(__dirname, '../src/widget.html')).href,
  island: pathToFileURL(path.join(__dirname, '../src/island.html')).href,
}

let browser = null
let launchError = null
test.before(async () => {
  if (!pw) return
  try { browser = await pw.chromium.launch() } catch (err) { launchError = err }
})
test.after(async () => { if (browser) await browser.close() })

const pageTest = (name, fn, { reducedMotion = 'no-preference' } = {}) => test(name, { skip: !pw && 'Playwright is not installed', timeout: 60_000 }, async (t) => {
  if (launchError) return t.skip(`Chromium did not launch: ${launchError.message}`)
  const context = await browser.newContext({ viewport: { width: 400, height: 300 }, reducedMotion })
  const page = await context.newPage()
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  try {
    await fn(page, errors)
  } finally {
    await context.close()
  }
})

for (const [name, url] of Object.entries(PAGES)) {
  pageTest(`${name}: the tokens and motion.js load under the page CSP, and agree`, async (page, errors) => {
    await page.goto(url)
    const r = await page.evaluate(() => {
      const css = getComputedStyle(document.documentElement)
      return {
        motion: typeof window.Motion === 'object',
        springs: Object.fromEntries(Object.keys(window.Motion.SPRINGS).map((k) => [k, window.Motion.springFromToken(css.getPropertyValue(`--spring-${k}`))])),
        known: window.Motion.SPRINGS,
        face: css.getPropertyValue('--dock-face').trim(),
        dur: css.getPropertyValue('--dur-160').trim(),
      }
    })
    assert.ok(r.motion, 'window.Motion')
    assert.deepEqual(r.springs, r.known, 'every --spring-* token is the spring motion.js has')
    assert.equal(r.face, '28px')
    assert.equal(r.dur, '160ms')
    assert.deepEqual(errors.filter((e) => /Content Security Policy|motion|tokens/i.test(e)), [])
  })
}

pageTest('a live spring runs on real animation frames and lands on its target', async (page) => {
  await page.goto(PAGES.widget)
  const r = await page.evaluate(() => new Promise((resolve) => {
    const seen = []
    const s = window.Motion.createSpring({ value: 0, spring: 'snappy', onUpdate: (v) => seen.push(v), onRest: (v) => resolve({ v, frames: seen.length, mid: seen[3] }) })
    s.setTarget(100)
  }))
  assert.equal(r.v, 100)
  assert.ok(r.frames > 5, `${r.frames} frames`)
  assert.ok(r.mid > 0 && r.mid < 100, 'moved through the middle')
})

pageTest('reduced motion: a live spring jumps and a sampled one only sets its end state', async (page) => {
  await page.goto(PAGES.widget)
  const r = await page.evaluate(() => {
    const seen = []
    const s = window.Motion.createSpring({ value: 0, spring: 'wobbly', onUpdate: (v) => seen.push(v) })
    s.setTarget(50)
    const el = document.createElement('div')
    document.body.append(el)
    const anim = window.Motion.animateSpring(el, 'wobbly', { from: 0.6, to: 1, format: (v) => `scale(${v})` })
    return { seen, value: s.value, anim: anim === null, transform: el.style.transform, running: document.getAnimations().filter((a) => a.effect && a.effect.target === el).length }
  })
  assert.deepEqual(r.seen, [50])
  assert.equal(r.value, 50)
  assert.ok(r.anim)
  assert.equal(r.transform, 'scale(1)')
  assert.equal(r.running, 0)
}, { reducedMotion: 'reduce' })
