const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { defaults, sanitize, createPrefs } = require('../src/prefs')

test('keep running in background is on by default on macOS only', () => {
  assert.equal(defaults('darwin').keepRunningInBackground, true)
  assert.equal(defaults('win32').keepRunningInBackground, false)
  assert.equal(defaults('linux').keepRunningInBackground, false)
  assert.equal(defaults('linux').showWidget, true)
  assert.equal(defaults('darwin').showIsland, true)
})

test('only known keys of the right type are read back', () => {
  assert.deepEqual(sanitize({ showWidget: 'no', keepRunningInBackground: true, evil: 1 }, 'linux'), { keepRunningInBackground: true, showWidget: true, showIsland: true, shareScreen: false, widgetPositions: [], islandEdge: null })
  assert.deepEqual(sanitize(null, 'darwin'), defaults('darwin'))
})

test('"Let Manager see your screen" is off until the user turns it on', () => {
  assert.equal(defaults('darwin').shareScreen, false)
  assert.equal(defaults('linux').shareScreen, false)
  assert.equal(sanitize({ shareScreen: 'yes' }, 'linux').shareScreen, false, 'only a real boolean turns it on')
  assert.equal(sanitize({ shareScreen: true }, 'linux').shareScreen, true)
})

test('dragged positions persist per display; junk in the file is dropped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-prefs-'))
  const file = path.join(dir, 'prefs.json')
  const prefs = createPrefs({ file, platform: 'linux' })
  const seen = []
  prefs.onChange((p) => seen.push(p.widgetPositions.length))
  const entry = { id: 7, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, pos: { side: 'left', offsetY: 120 } }
  prefs.set({ widgetPositions: [entry], islandEdge: { displayId: 7, displayBounds: entry.bounds, edge: 'bottom', offsetX: 0.3 } })
  prefs.set({ widgetPositions: [{ ...entry }] })
  assert.deepEqual(seen, [1], 'the same positions again: no change event')
  const reread = createPrefs({ file, platform: 'linux' }).get()
  assert.deepEqual(reread.widgetPositions, [entry])
  assert.deepEqual(reread.islandEdge, { displayId: 7, displayBounds: entry.bounds, edge: 'bottom', offsetX: 0.3 })
  // get() hands out copies: mutating one does not change the store.
  reread.widgetPositions[0].pos.side = 'right'
  assert.equal(prefs.get().widgetPositions[0].pos.side, 'left')
  fs.writeFileSync(file, JSON.stringify({ showWidget: false, widgetPositions: [{ id: 1, bounds: 'x', pos: {} }, entry], islandEdge: { edge: 'left' } }))
  const cleaned = createPrefs({ file, platform: 'linux' }).get()
  assert.deepEqual(cleaned.widgetPositions, [entry])
  assert.equal(cleaned.islandEdge, null)
  assert.equal(cleaned.showWidget, false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('prefs persist and notify on change only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-prefs-'))
  const file = path.join(dir, 'prefs.json')
  const prefs = createPrefs({ file, platform: 'linux' })
  const seen = []
  prefs.onChange((p) => seen.push(p.showWidget))
  prefs.set({ showWidget: false })
  prefs.set({ showWidget: false })
  assert.deepEqual(seen, [false])
  assert.equal(createPrefs({ file, platform: 'linux' }).get().showWidget, false)
  fs.writeFileSync(file, '{not json')
  assert.deepEqual(createPrefs({ file, platform: 'linux' }).get(), defaults('linux'))
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the island\'s old per-display positions migrate once to an edge, and are dropped on the next save', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-prefs-'))
  const file = path.join(dir, 'prefs.json')
  const bounds = { x: 0, y: 0, width: 1512, height: 982 }
  fs.writeFileSync(file, JSON.stringify({ islandPositions: [{ id: 1, bounds, pos: { dx: 100, dy: 800 } }, { id: 2, bounds, pos: { snap: 'top-center' } }] }))
  const prefs = createPrefs({ file, platform: 'darwin' })
  const edge = prefs.get().islandEdge
  assert.equal(edge.edge, 'bottom', 'the newest entry, low on its display')
  assert.equal(edge.displayId, 1)
  assert.equal('islandPositions' in prefs.get(), false)
  prefs.set({ showWidget: false })
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal('islandPositions' in saved, false, 'gone from the file')
  assert.deepEqual(saved.islandEdge, edge)
  // Already migrated: an islandEdge wins over any leftover positions.
  fs.writeFileSync(file, JSON.stringify({ islandEdge: { edge: 'top', offsetX: 0.1 }, islandPositions: [{ id: 1, bounds, pos: { dx: 100, dy: 800 } }] }))
  assert.deepEqual(createPrefs({ file, platform: 'darwin' }).get().islandEdge, { edge: 'top', offsetX: 0.1 })
  fs.rmSync(dir, { recursive: true, force: true })
})
