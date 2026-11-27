const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const W = require('../src/widget-window')

const workArea = { x: 0, y: 25, width: 1440, height: 875 }

test('the window is a transparent, non-activating, always-on-top panel in a cookie-less session', () => {
  const mac = W.widgetWindowOptions({ platform: 'darwin', preload: '/p.js' })
  assert.equal(mac.type, 'panel')
  assert.equal(W.widgetWindowOptions({ platform: 'win32', preload: '/p.js' }).type, 'toolbar')
  for (const [key, value] of Object.entries({
    transparent: true, frame: false, backgroundColor: '#00000000', hasShadow: false, resizable: false, movable: false,
    minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: true, hiddenInMissionControl: true,
    focusable: false, alwaysOnTop: true, show: false,
  })) assert.equal(mac[key], value, key)
  assert.deepEqual(
    { ...mac.webPreferences },
    { preload: '/p.js', contextIsolation: true, sandbox: true, nodeIntegration: false, partition: 'cma-widget', spellcheck: true, backgroundThrottling: false },
  )
  assert.ok(!mac.webPreferences.partition.startsWith('persist:'), 'in-memory: nothing written to disk, no site cookies')
})

test('collapsed: the dock hugs the right edge of the work area, centred until dragged', () => {
  const l = W.layoutFor({ workArea, dockHeight: 200, offsetY: null, expanded: false })
  assert.deepEqual(l.bounds, { x: 1440 - W.EDGE_MARGIN - W.DOCK_WIDTH, y: 25 + Math.round((875 - 200) / 2), width: W.DOCK_WIDTH, height: 200 })
  assert.equal(l.expanded, false)
})

test('the dragged offset is kept on screen', () => {
  assert.equal(W.layoutFor({ workArea, dockHeight: 200, offsetY: 100, expanded: false }).bounds.y, 125)
  assert.equal(W.layoutFor({ workArea, dockHeight: 200, offsetY: -50, expanded: false }).bounds.y, 25)
  assert.equal(W.layoutFor({ workArea, dockHeight: 200, offsetY: 5000, expanded: false }).bounds.y, 25 + 875 - 200)
  // A second display to the left, with a different origin.
  const left = { x: -1920, y: 0, width: 1920, height: 1040 }
  assert.deepEqual(W.layoutFor({ workArea: left, dockHeight: 100, offsetY: 10, expanded: false }).bounds, { x: -W.EDGE_MARGIN - W.DOCK_WIDTH, y: 10, width: W.DOCK_WIDTH, height: 100 })
})

test('expanded: the window grows inward to hold the popover; the dock stays put on screen', () => {
  const collapsed = W.layoutFor({ workArea, dockHeight: 200, offsetY: 100, expanded: false })
  const l = W.layoutFor({ workArea, dockHeight: 200, offsetY: 100, expanded: true })
  assert.equal(l.bounds.width, W.EXPANDED_WIDTH)
  assert.equal(l.bounds.x + l.bounds.width, collapsed.bounds.x + collapsed.bounds.width, 'right edges line up')
  assert.equal(l.bounds.y + l.dockTop, collapsed.bounds.y, 'the dock does not jump')
  assert.equal(l.popoverHeight, W.POPOVER_HEIGHT)
  assert.equal(l.popoverTop, 0)
  assert.equal(l.bounds.height, W.POPOVER_HEIGHT)
})

test('expanded near the bottom: the popover lifts to stay on screen', () => {
  const l = W.layoutFor({ workArea, dockHeight: 200, offsetY: 875 - 200, expanded: true })
  const popoverBottom = l.bounds.y + l.popoverTop + l.popoverHeight
  assert.equal(popoverBottom, 25 + 875)
  assert.equal(l.bounds.y + l.dockTop, 25 + 875 - 200)
  assert.equal(l.bounds.y + l.bounds.height, 25 + 875)
})

test('a tiny screen: the popover shrinks to the work area', () => {
  const small = { x: 0, y: 0, width: 800, height: 400 }
  const l = W.layoutFor({ workArea: small, dockHeight: 120, offsetY: 0, expanded: true })
  assert.equal(l.popoverHeight, 400)
  assert.equal(l.bounds.height, 400)
})

test('dock heights from the renderer are clamped', () => {
  assert.equal(W.validDockHeight('junk', workArea), W.MIN_DOCK_HEIGHT)
  assert.equal(W.validDockHeight(10, workArea), W.MIN_DOCK_HEIGHT)
  assert.equal(W.validDockHeight(99999, workArea), 875)
  assert.equal(W.validDockHeight(212.4, workArea), 212)
})

test('hit rects are validated and clipped to the window', () => {
  const size = { width: 72, height: 200 }
  assert.deepEqual(W.validRects([{ x: 4, y: 6, width: 60, height: 180 }], size), [{ x: 4, y: 6, width: 60, height: 180 }])
  assert.deepEqual(W.validRects([{ x: -10, y: 190, width: 100, height: 50 }], size), [{ x: 0, y: 190, width: 72, height: 10 }])
  assert.deepEqual(W.validRects([{ x: 'a' }, null, { x: 0, y: 0, width: -5, height: 5 }, { x: 0, y: 0, width: Infinity, height: 2 }], size), [])
  assert.equal(W.validRects(Array.from({ length: 100 }, () => ({ x: 0, y: 0, width: 1, height: 1 })), size).length, W.MAX_RECTS)
  assert.deepEqual(W.validRects('nope', size), [])
})

test('the window takes the mouse only over a live area', () => {
  const bounds = { x: 1364, y: 300, width: 72, height: 200 }
  const rects = [{ x: 4, y: 6, width: 60, height: 180 }]
  assert.equal(W.cursorOverRects({ x: 1364 + 10, y: 300 + 10 }, bounds, rects), true)
  assert.equal(W.cursorOverRects({ x: 1364 + 1, y: 300 + 10 }, bounds, rects), false, 'the transparent margin clicks through')
  assert.equal(W.cursorOverRects({ x: 1364 + 10, y: 300 + 190 }, bounds, rects), false)
  assert.equal(W.cursorOverRects({ x: 0, y: 0 }, bounds, rects), false)
  assert.equal(W.cursorOverRects(null, bounds, rects), false)
})

test('the drag protocol is validated', () => {
  assert.deepEqual(W.validDrag({ phase: 'move', screenY: '412' }), { phase: 'move', screenY: 412 })
  for (const bad of [null, {}, { phase: 'fly', screenY: 1 }, { phase: 'start', screenY: 'x' }, { phase: 'end', screenY: 1e9 }]) assert.equal(W.validDrag(bad), null)
})

test('the offset persists, and a bad file means centred', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-widget-'))
  const file = path.join(dir, 'widget-position.json')
  assert.equal(W.loadOffset(file), null)
  W.saveOffset(file, 240)
  assert.equal(W.loadOffset(file), 240)
  fs.writeFileSync(file, '{"offsetY":"high"}')
  assert.equal(W.loadOffset(file), null)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('the renderer gets the dock bots and their labels, nothing else', () => {
  const view = W.widgetView(widgetStateFrom(fixture))
  assert.deepEqual(Object.keys(view).sort(), ['bots', 'candidates', 'dock_full', 'focused_bot_id', 'max_pinned', 'needs_you', 'workspace'])
  assert.equal(view.dock_full, false)
  assert.equal(view.workspace.mark.initials, '9D')
  assert.deepEqual(view.candidates.map((b) => b.name), ['Ops'])
  assert.equal(view.focused_bot_id, 'manager')
  assert.deepEqual(view.bots.map((b) => [b.name, b.label, b.avatar_color, b.avatar_shape]), [['Max', 'Questions', '#231d1b', 'circle'], ['Ada', 'Working…', '#f2c94c', 'squircle'], ['Lin', 'Needs approval', '#6e56cf', 'hexagon']])
  assert.ok(!JSON.stringify(view).includes('session_id'), 'no session ids in the renderer: main addresses replies itself')
  assert.ok(!JSON.stringify(view).includes(fixture.csrf_token))
  assert.deepEqual(W.widgetView(null), { focused_bot_id: null, needs_you: 0, bots: [], candidates: [], dock_full: false, max_pinned: 12, workspace: null })
})

// The wiring, read from the sources.
test('every widget IPC is gated to the widget page in the widget window', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/widget-window.js'), 'utf8')
  const ipc = src.slice(src.indexOf('function registerIpc'))
  const handlers = ipc.match(/ipcMain\.(on|handle)\('cma-widget:[a-z-]+'/g)
  assert.equal(handlers.length, 13)
  for (const handler of ipc.split(/ipcMain\.(?:on|handle)\(/).slice(1)) {
    assert.match(handler.slice(0, 220), /fromWidget\(event\)|, reply\(/, handler.slice(0, 40))
  }
  assert.match(ipc, /const reply = \(run\) => async \(event, input\) => \{\n\s+if \(!fromWidget\(event\)\) return null/)
  assert.match(src, /return url === HTML_URL/)
  assert.match(W.HTML_URL, /^file:\/\/.*\/src\/widget\.html$/)
})

test('the widget page cannot reach the network or run inline script', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/widget.html'), 'utf8')
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1]
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /connect-src 'none'/)
  assert.match(csp, /script-src 'self'(;|$)/)
  assert.doesNotMatch(html, /<script>(?!<)/)
  const view = fs.readFileSync(path.join(__dirname, '../src/widget-view.js'), 'utf8')
  assert.doesNotMatch(view, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|fetch\(|XMLHttpRequest/)
  const preload = fs.readFileSync(path.join(__dirname, '../src/widget-preload.js'), 'utf8')
  const code = preload.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(code, /cookie|session|\bnet\b|fetch/i)
  assert.match(code, /require\('electron'\)/)
  assert.doesNotMatch(code, /require\('(?!electron')/, 'nothing but contextBridge and ipcRenderer')
})
