const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { ADA, LIN, OPS, OPS_MESSAGE } = require('./ids')
const { widgetStateFrom } = require('../src/widget-state')
const I = require('../src/island-window')

const state = widgetStateFrom(fixture)
const withState = (patch) => widgetStateFrom({ ...fixture, ...patch })
const idleManager = { ...fixture.manager, mood: 'idle', state: { ...fixture.manager.state, waiting: null, detail: '' } }

test('the island is the dock\'s panel, in its own cookie-less session', () => {
  const o = I.islandWindowOptions({ platform: 'darwin', preload: '/i.js' })
  assert.equal(o.type, 'panel')
  for (const key of ['transparent', 'alwaysOnTop', 'skipTaskbar', 'hiddenInMissionControl']) assert.equal(o[key], true, key)
  for (const key of ['frame', 'hasShadow', 'resizable', 'movable', 'focusable', 'show', 'fullscreenable']) assert.equal(o[key], false, key)
  assert.ok(o.width >= I.ISLAND_WIDTH, 'room for the open card')
  assert.ok(o.height > I.COMPACT_HEIGHT, 'room to grow on hover')
  assert.deepEqual({ ...o.webPreferences, preload: undefined }, { preload: undefined, contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'cma-island', spellcheck: true, backgroundThrottling: false })
})

test('the chip says what the bot is doing; idle and paused say nothing', () => {
  const chip = (bot) => I.islandChip(bot)?.label ?? null
  assert.equal(chip({ mood: 'waiting', state: { waiting: 'question' } }), 'Questions')
  assert.equal(chip({ mood: 'waiting', state: { waiting: 'approval' } }), 'Needs approval')
  assert.equal(chip({ mood: 'working', state: {} }), 'Working…')
  assert.equal(chip({ mood: 'responded', state: {} }), 'New message')
  assert.equal(chip({ mood: 'failed', state: {} }), 'Failed')
  assert.equal(chip({ mood: 'idle', state: {} }), null)
  assert.equal(chip({ mood: 'working', state: { status: 'paused' } }), null)
  assert.equal(chip(null), null)
})

test('the island shows the focused bot when it has something to say', () => {
  assert.equal(I.islandBot(state).id, 'manager')
  assert.equal(I.islandBot({ ...state, focused_bot_id: ADA }).id, ADA, 'working counts')
})

test('an idle focus gives way to the first bot waiting on the user, docked first', () => {
  const s = withState({ manager: idleManager })
  assert.equal(I.islandBot(s).id, LIN, 'Lin (docked, approval) before Ops (not docked)')
  const onlyOps = withState({ manager: idleManager, seats: fixture.seats.filter((x) => x.name !== 'Lin') })
  assert.equal(I.islandBot({ ...onlyOps, focused_bot_id: 'manager' }).id, OPS)
})

test('nothing to say anywhere: the island shows the calm idle pill, not nothing', () => {
  const quiet = withState({ manager: idleManager, seats: [] })
  assert.equal(I.islandBot(quiet), null)
  const idle = I.islandView(quiet)
  assert.equal(idle.idle, true)
  assert.equal(idle.bot.id, 'manager', "the manager's mark")
  assert.deepEqual(idle.chip, { kind: 'idle', label: 'All quiet' })
  assert.equal(idle.pending, null)
  assert.deepEqual(I.islandView(null).chip, { kind: 'offline', label: 'Connecting…' })
  assert.deepEqual(I.islandView(null, { signedIn: false }).chip, { kind: 'offline', label: 'Signed out' })
  assert.equal(I.islandView(null).bot.name, 'Configure My AI')
  assert.equal(I.islandView(state).idle, false)
})

test('the view: bot, chip, and the pending card with lettered options from the feed', () => {
  const ops = I.islandView({ ...state, focused_bot_id: OPS })
  assert.deepEqual(ops.bot, { id: OPS, name: 'Ops', avatar_url: null, avatar_color: '#30a46c', avatar_shape: 'circle' })
  assert.deepEqual(ops.chip, { kind: 'question', label: 'Questions' })
  assert.equal(ops.pending.id, OPS_MESSAGE)
  assert.deepEqual(ops.pending.options.map((o) => o.label), ['US East', 'EU West'])
  assert.equal(ops.pending.allow_other, true)
  assert.equal(ops.pending.actionable, true)
  assert.equal(I.islandView(state).pending.actionable, false, "the manager's questions are answered in the app")
  assert.equal(I.islandView({ ...state, focused_bot_id: LIN }).pending.kind, 'approval')
  assert.equal(I.islandView({ ...state, focused_bot_id: ADA }).pending, null)
  assert.ok(!JSON.stringify(ops).includes('session_id'))
})

test('islandPlace: the saved place on its display, the envelope and the pill', () => {
  const mbp = { id: 1, internal: true, bounds: { x: 0, y: 0, width: 1512, height: 982 }, workArea: { x: 0, y: 37, width: 1512, height: 945 } }
  const home = I.islandPlace({ saved: null, displays: [mbp], fallback: mbp, platform: 'darwin' })
  assert.equal(home.pill.wrap, true)
  assert.equal(home.window.y, 0)
  const low = I.islandPlace({ saved: { edge: 'bottom', offsetX: 0.25, displayId: 1 }, displays: [mbp], fallback: mbp, platform: 'darwin', height: 200 })
  assert.equal(low.window.y + low.window.height, 982)
  assert.equal(low.window.x + low.pill.centre, 378)
  // Linux, a simulated notch.
  const sim = I.islandPlace({ saved: null, displays: [{ ...mbp, internal: false }], fallback: null, platform: 'linux', simulateNotch: { width: 185, height: 32 } })
  assert.equal(sim.pill.wrap, true)
  assert.equal(sim.pill.height, 32)
  assert.equal(I.islandPlace({ saved: null, displays: [], fallback: null }), null)
})

test('every island IPC is gated to the island page in the island window; the page is offline', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/island-window.js'), 'utf8')
  const ipc = src.slice(src.indexOf('function registerIpc'))
  assert.equal(ipc.match(/ipcMain\.(on|handle)\('cma-island:[a-z-]+'/g).length, 18)
  for (const handler of ipc.split(/ipcMain\.(?:on|handle)\(/).slice(1)) {
    assert.match(handler.slice(0, 220), /fromIsland\(event\)|, reply\(/, handler.slice(0, 40))
  }
  assert.match(ipc, /const reply = \(run\) => async \(event, input\) => \{\n\s+if \(!fromIsland\(event\)\) return false/)
  assert.match(src, /return url === HTML_URL/)
  assert.match(src, /win\.setAlwaysOnTop\(true, 'status'\)/)
  const html = fs.readFileSync(path.join(__dirname, '../src/island.html'), 'utf8')
  assert.match(html, /default-src 'none'.*connect-src 'none'/)
  const view = fs.readFileSync(path.join(__dirname, '../src/island-view.js'), 'utf8')
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest/)
})

test('a multi-question card hands over to the app; without questions_count, the first question is answered here', () => {
  const opsSeat = fixture.seats.find((x) => x.name === 'Ops')
  const multi = widgetStateFrom({ ...fixture, focused_bot_id: OPS, seats: fixture.seats.map((x) => (x === opsSeat ? { ...x, state: { ...x.state, questions_count: 3 } } : x)) })
  const view = I.islandView(multi)
  assert.equal(view.pending.questions_count, 3)
  assert.equal(view.pending.actionable, false)
  assert.equal(I.islandView({ ...state, focused_bot_id: OPS }).pending.actionable, true, 'absent: one question')
})
