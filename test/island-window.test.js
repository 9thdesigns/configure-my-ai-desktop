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
  assert.equal(o.width, I.ISLAND_WIDTH + I.SHADOW * 2)
  assert.equal(o.height, I.COMPACT_HEIGHT + I.SHADOW * 2)
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

test('nothing to say anywhere: the island hides', () => {
  const quiet = withState({ manager: idleManager, seats: [] })
  assert.equal(I.islandBot(quiet), null)
  assert.equal(I.islandView(quiet), null)
  assert.equal(I.islandView(null), null)
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

test('the island sits centred at the top of the work area, growing downward', () => {
  const wa = { x: 0, y: 37, width: 1512, height: 945 }
  const compact = I.islandBounds(wa, I.COMPACT_HEIGHT)
  assert.equal(compact.x + compact.width / 2, 756, 'centred')
  assert.equal(compact.y, 37 + I.TOP_MARGIN - I.SHADOW)
  assert.equal(compact.height, I.COMPACT_HEIGHT + I.SHADOW * 2)
  const open = I.islandBounds(wa, 260)
  assert.equal(open.y, compact.y, 'the top stays put')
  assert.equal(open.height, 260 + I.SHADOW * 2)
  assert.equal(I.islandBounds(wa, 9999).height, I.MAX_HEIGHT + I.SHADOW * 2)
  assert.equal(I.islandBounds(wa, 'x').height, I.COMPACT_HEIGHT + I.SHADOW * 2)
  const second = I.islandBounds({ x: 1512, y: 0, width: 1920, height: 1050 }, 44)
  assert.equal(second.x + second.width / 2, 1512 + 960)
})

test('every island IPC is gated to the island page in the island window; the page is offline', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/island-window.js'), 'utf8')
  const ipc = src.slice(src.indexOf('function registerIpc'))
  assert.equal(ipc.match(/ipcMain\.(on|handle)\('cma-island:[a-z-]+'/g).length, 8)
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
