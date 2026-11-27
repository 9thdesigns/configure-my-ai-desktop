const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const fixture = require('./fixtures/widget.json')
const { WS, WS2 } = require('./ids')
const { widgetStateFrom } = require('../src/widget-state')
const { workspaceMenuItems, currentWorkspace, afterSwitch } = require('../src/workspaces')

const state = widgetStateFrom(fixture)

test('the workspaces menu: radio items, the current checked, another switches', () => {
  const calls = []
  const items = workspaceMenuItems(state, { switchWorkspace: (id) => calls.push(id) })
  assert.deepEqual(items.map((i) => [i.label, i.type, i.checked]), [['9D  9th Designs', 'radio', true], ['SP  Side Project', 'radio', false]])
  items[0].click()
  items[1].click()
  assert.deepEqual(calls, [WS2])
  assert.deepEqual(workspaceMenuItems(null, {}), [])
})

test('the dock shows the current workspace mark', () => {
  assert.deepEqual(currentWorkspace(state), {
    id: WS,
    name: '9th Designs',
    mark: { initials: '9D', color: '#2f6feb', shape: 'squircle', logo_url: 'https://configuremyai.com/rails/active_storage/logo.png' },
    count: 2,
  })
  const lone = widgetStateFrom({ workspace: { id: 'w', name: 'Solo' } })
  assert.equal(currentWorkspace(lone).count, 1)
  assert.equal(currentWorkspace(lone).mark.initials, 'S')
  assert.equal(currentWorkspace(null), null)
})

test('after a switch the app window follows: home from a record page, reload elsewhere, nothing off the app', () => {
  assert.deepEqual(afterSwitch('https://configuremyai.com/autopilot/bots/abc'), { action: 'load', url: 'https://configuremyai.com/home' })
  assert.deepEqual(afterSwitch('https://configuremyai.com/autopilot/bots/abc/sessions/1'), { action: 'load', url: 'https://configuremyai.com/home' })
  for (const page of ['/manager/threads/t1', '/chats/c1', '/workspaces/w1/ai_configurations/a1/chats/c1', '/workspaces/w1/settings']) {
    assert.deepEqual(afterSwitch(`https://configuremyai.com${page}`), { action: 'load', url: 'https://configuremyai.com/home' }, page)
  }
  assert.deepEqual(afterSwitch('https://configuremyai.com/chats'), { action: 'reload' }, 'the chats index is not one record')
  assert.deepEqual(afterSwitch('https://configuremyai.com/home'), { action: 'reload' })
  assert.deepEqual(afterSwitch('https://configuremyai.com/settings'), { action: 'reload' })
  assert.deepEqual(afterSwitch('https://accounts.google.com/o/oauth2'), { action: 'none' })
  assert.deepEqual(afterSwitch('file:///app/offline.html'), { action: 'none' })
  assert.deepEqual(afterSwitch(''), { action: 'none' })
})

test('tray and dock share one switch path in main', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
  assert.match(main, /async function switchWorkspace \(id\) \{\n\s+widget\?\.collapse\(\)\n\s+const ok = await widgetFeed\.switchWorkspace\(id\)/)
  assert.match(main, /const next = afterSwitch\(mainWindow\.webContents\.getURL\(\)\)/)
  const tray = fs.readFileSync(path.join(__dirname, '../src/tray.js'), 'utf8')
  assert.match(tray, /submenu: workspaceMenuItems\(state, actions, \{ iconFor: options\?\.iconFor, header: true, platform \}\)/)
  const widget = fs.readFileSync(path.join(__dirname, '../src/widget-window.js'), 'utf8')
  assert.match(widget, /workspaceMenuItems\(store\.get\(\), \{ switchWorkspace: \(id\) => switchWorkspace\(id\) \}, \{ iconFor: logos\?\.iconFor, header: true, platform \}\)/)
})
