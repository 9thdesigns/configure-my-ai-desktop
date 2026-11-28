const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { widgetStateFrom } = require('../src/widget-state')
const { WS2, ADA, LIN, OPS } = require('./ids')
const { trayTitle, trayTooltip, trayMenuTemplate, trayIconPath } = require('../src/tray')

const state = widgetStateFrom(fixture)

function recorder () {
  const calls = []
  const handler = { get: (_t, name) => (...args) => calls.push([name, ...args]) }
  return { calls, actions: new Proxy({}, handler) }
}

const byId = (template, id) => template.find((item) => item.id === id)

test('the menu bar title is the focused bot and the needs-you count', () => {
  assert.equal(trayTitle(state), 'Config My AI · 3')
  assert.equal(trayTitle({ ...state, focused_bot_id: LIN }), 'Config My AI · 3', 'the label is the app, whichever bot is focused')
  assert.equal(trayTitle({ ...state, needs_you: 0 }), 'Config My AI', 'nothing waiting: just the name')
  assert.equal(trayTitle({ ...state, needs_you: 250 }), 'Config My AI · 99+')
  assert.equal(trayTitle(null), '', 'no state (signed out): icon only')
  const long = widgetStateFrom({ ...fixture, manager: { ...fixture.manager, name: 'Maximilian the Magnificent' } })
  assert.equal(trayTitle(long), 'Config My AI · 3', 'a long bot name never changes the label')
})

test('the tooltip says it in words', () => {
  assert.equal(trayTooltip(state), 'Configure My AI — Max: Questions — 3 need you')
  assert.equal(trayTooltip({ ...state, needs_you: 1 }), 'Configure My AI — Max: Questions — 1 needs you')
  assert.equal(trayTooltip(null), 'Configure My AI')
})

test('the menu: open, focused bot, workspaces, bots, switches, quit — in that order', () => {
  const { actions } = recorder()
  const template = trayMenuTemplate(state, { prefs: { showWidget: true, keepRunningInBackground: true }, openAtLogin: false, platform: 'darwin' }, actions)
  const ids = template.map((i) => i.id || i.type)
  assert.deepEqual(ids, ['open', 'separator', 'focused-bot', 'workspaces', 'bots', 'separator', 'show-widget', 'show-island', 'island-shortcut', 'share-screen', 'keep-running', 'open-at-login', 'separator', 'quit'])
  assert.equal(byId(template, 'focused-bot').label, 'Max — Questions')
  assert.equal(byId(template, 'show-widget').checked, true)
  assert.equal(byId(template, 'keep-running').checked, true)
  assert.equal(byId(template, 'open-at-login').checked, false)
})

test('workspaces are radio items; clicking another switches, clicking the current does nothing', () => {
  const { calls, actions } = recorder()
  const submenu = byId(trayMenuTemplate(state, {}, actions), 'workspaces').submenu
  assert.deepEqual(submenu.map((i) => [i.label, i.type, i.checked]), [['Workspaces', undefined, undefined], [undefined, 'separator', undefined], ['9D  9th Designs', 'radio', true], ['SP  Side Project', 'radio', false]])
  assert.equal(submenu[0].enabled, false, 'the "Workspaces" label is not clickable')
  submenu[2].click()
  submenu[3].click()
  assert.deepEqual(calls, [['switchWorkspace', WS2]])
})

test('bots are checkboxes for "shown in the widget"; the manager is always on', () => {
  const { calls, actions } = recorder()
  const submenu = byId(trayMenuTemplate(state, {}, actions), 'bots').submenu
  assert.deepEqual(submenu.map((i) => [i.label, i.type, i.checked, i.enabled]), [
    ['Max (1)', 'checkbox', true, false],
    [undefined, 'separator', undefined, undefined],
    ['Ada', 'checkbox', true, undefined],
    ['Lin (1)', 'checkbox', true, undefined],
    ['Ops (1)', 'checkbox', false, undefined],
  ])
  submenu[2].click()
  submenu[4].click()
  assert.deepEqual(calls, [['setPinned', ADA, false], ['setPinned', OPS, true]])
})

test('the items call their actions', () => {
  const { calls, actions } = recorder()
  const template = trayMenuTemplate(state, { prefs: { showWidget: true, showIsland: false, keepRunningInBackground: false }, openAtLogin: true, platform: 'win32' }, actions)
  for (const id of ['open', 'focused-bot', 'show-widget', 'show-island', 'keep-running', 'open-at-login', 'quit']) byId(template, id).click()
  assert.deepEqual(calls, [['openApp'], ['openBot', 'manager'], ['setShowWidget', false], ['setShowIsland', true], ['setKeepRunning', true], ['setOpenAtLogin', false], ['quit']])
})

test('signed out: no workspaces or bots, a sign-in prompt instead of a bot', () => {
  const { calls, actions } = recorder()
  const template = trayMenuTemplate(null, { platform: 'linux' }, actions)
  assert.equal(byId(template, 'workspaces'), undefined)
  assert.equal(byId(template, 'bots'), undefined)
  assert.equal(byId(template, 'open-at-login'), undefined, 'no login items on Linux')
  byId(template, 'focused-bot').click()
  assert.deepEqual(calls, [['openApp']])
})

test('the macOS icon is a template image; others get the colour icon; both ship', () => {
  assert.match(trayIconPath('darwin'), /trayTemplate\.png$/)
  assert.match(trayIconPath('win32'), /tray\.png$/)
  for (const platform of ['darwin', 'linux']) {
    const file = trayIconPath(platform)
    assert.ok(fs.existsSync(file), file)
    assert.ok(fs.existsSync(file.replace('.png', '@2x.png')))
  }
})

// The wiring, read from the sources: the bridge exists only behind the
// preload's origin gate, and main checks the sender's frame and validates the
// shape before anything reaches the store.
test('publish is origin-gated in main and validated before it is stored', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8')
  assert.match(preload, /publish: \(state\) => ipcRenderer\.send\('cfa:widget-publish', state\)/)
  const gated = preload.slice(preload.indexOf('if (info && info.chromeless && onAppOrigin())'))
  assert.ok(gated.includes("ipcRenderer.send('cfa:widget-publish'"), 'publish is inside the origin gate')
  const handler = main.slice(main.indexOf("ipcMain.on('cfa:widget-publish'"))
  assert.match(handler.slice(0, 200), /if \(!fromAppFrame\(event\) \|\| !widgetStore\) return\n\s+widgetStore\.apply\(input, 'page', \{ origin: /)
  const unhandled = main.slice(main.indexOf("ipcMain.on('cfa:widget-command-unhandled'"))
  assert.match(unhandled.slice(0, 200), /if \(!fromAppFrame\(event\)/)
})
