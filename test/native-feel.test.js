const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { contextMenuTemplate, lockVisualZoom, installNativeFeel } = require('../src/native-feel')

const allFlags = { canUndo: true, canRedo: true, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
const roles = (t) => t.filter((i) => i.role).map((i) => i.role)

test('no menu on plain page content', () => {
  assert.equal(contextMenuTemplate({ isEditable: false, selectionText: '', editFlags: allFlags }), null)
  assert.equal(contextMenuTemplate({ isEditable: false, selectionText: '   ' }), null)
  assert.equal(contextMenuTemplate(null), null)
})

test('selected text outside a field gets Copy only', () => {
  const t = contextMenuTemplate({ isEditable: false, selectionText: 'hello', editFlags: allFlags })
  assert.deepEqual(roles(t), ['copy'])
})

test('a text field gets the edit roles, enabled from Chromium edit flags', () => {
  const t = contextMenuTemplate({ isEditable: true, editFlags: { ...allFlags, canCut: false, canPaste: false } })
  assert.deepEqual(roles(t), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
  const byRole = Object.fromEntries(t.filter((i) => i.role).map((i) => [i.role, i.enabled]))
  assert.equal(byRole.cut, false)
  assert.equal(byRole.paste, false)
  assert.equal(byRole.copy, true)
  assert.ok(!t.some((i) => i.label === 'Add to Dictionary'), 'no spelling items without a misspelling')
})

test('a misspelled word puts suggestions and Add to Dictionary first, and they act', () => {
  const calls = []
  const t = contextMenuTemplate(
    { isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea', 'ten', 'tech', 'tel', 'toe'], editFlags: allFlags },
    { replaceMisspelling: (s) => calls.push(['replace', s]), addToDictionary: (w) => calls.push(['add', w]) },
  )
  assert.deepEqual(t.slice(0, 5).map((i) => i.label), ['the', 'tea', 'ten', 'tech', 'tel'], 'at most five suggestions')
  assert.equal(t[5].type, 'separator')
  assert.equal(t[6].label, 'Add to Dictionary')
  t[0].click()
  t[6].click()
  assert.deepEqual(calls, [['replace', 'the'], ['add', 'teh']])
  assert.deepEqual(roles(t), ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'])
})

test('a misspelling with no suggestions says so, disabled', () => {
  const t = contextMenuTemplate({ isEditable: true, misspelledWord: 'qzx', dictionarySuggestions: [], editFlags: allFlags })
  assert.deepEqual(t[0], { label: 'No Guesses Found', enabled: false })
  assert.equal(t.find((i) => i.label === 'Add to Dictionary') != null, true)
})

function fakeContents (type = 'window') {
  const c = new EventEmitter()
  c.limits = []
  c.getType = () => type
  c.isDestroyed = () => false
  c.setVisualZoomLevelLimits = (min, max) => { c.limits.push([min, max]); return Promise.resolve() }
  c.replaceMisspelling = () => {}
  c.session = { addWordToSpellCheckerDictionary: () => {} }
  return c
}

test('pinch zoom is pinned at 1x now and after every load', () => {
  const c = fakeContents()
  lockVisualZoom(c)
  c.emit('did-finish-load')
  assert.deepEqual(c.limits, [[1, 1], [1, 1]])
})

test('every new window gets the zoom lock and the menu; webviews do not', () => {
  const app = new EventEmitter()
  const popups = []
  const electron = {
    Menu: { buildFromTemplate: (t) => ({ popup: (o) => popups.push({ t, o }) }) },
    BrowserWindow: { fromWebContents: () => 'WIN' },
  }
  installNativeFeel(app, electron)
  const win = fakeContents('window')
  const view = fakeContents('webview')
  app.emit('web-contents-created', {}, win)
  app.emit('web-contents-created', {}, view)
  assert.deepEqual(win.limits, [[1, 1]])
  assert.deepEqual(view.limits, [])
  win.emit('context-menu', {}, { isEditable: false, selectionText: '' })
  assert.equal(popups.length, 0, 'no menu on plain content')
  win.emit('context-menu', {}, { isEditable: true, editFlags: allFlags })
  assert.equal(popups.length, 1)
  assert.equal(popups[0].o.window, 'WIN')
})

test('main installs native feel before any window, and never turns on scroll bounce', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  const install = main.indexOf('installNativeFeel(app)')
  assert.ok(install > 0)
  assert.ok(install < main.indexOf('app.whenReady()'), 'installed before windows can be created')
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((f) => f.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), /scrollBounce:\s*true/, f)
  }
})
