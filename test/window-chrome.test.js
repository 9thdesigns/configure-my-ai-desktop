const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { DEFAULTS, defaultColors, validColor, colorsFromPage, symbolFor, overlayOptions } = require('../src/window-chrome')

// The window's own chrome — the band behind the Windows / Linux caption
// buttons, and the window background — in the page's colours, so the title
// strip reads as one piece with the app instead of a bar of its own.

test('before the page has said, the chrome follows the OS theme in the app\'s own colours', () => {
  // The Rails app's main column on each theme (--shell-main-bg) and its ink.
  assert.deepEqual(defaultColors(false), { background: '#ffffff', symbol: '#231d1b' })
  assert.deepEqual(defaultColors(true), { background: '#0a0a0a', symbol: '#ffffff' })
  const copy = defaultColors(true)
  copy.background = '#000000'
  assert.equal(DEFAULTS.dark.background, '#0a0a0a', 'callers get a copy, never the shared default')
})

test('only #rrggbb from the page reaches the OS', () => {
  assert.equal(validColor('#FCFCF9'), '#fcfcf9')
  for (const bad of ['red', '#fff', '#fcfcf9ff', 'rgb(0,0,0)', '#fcfcf9; x', ' #fcfcf9', '', null, undefined, 42, {}]) {
    assert.equal(validColor(bad), null, `refused: ${JSON.stringify(bad)}`)
  }
})

test("the page's ask is used as given, made safe, or refused", () => {
  assert.deepEqual(colorsFromPage({ background: '#f8f7f5', symbol: '#231d1b' }), { background: '#f8f7f5', symbol: '#231d1b' })
  assert.deepEqual(colorsFromPage({ background: '#333331' }), { background: '#333331', symbol: '#ffffff' }, 'missing ink: the one that reads')
  assert.deepEqual(colorsFromPage({ background: '#f8f7f5', symbol: 'javascript:1' }), { background: '#f8f7f5', symbol: '#231d1b' })
  assert.equal(colorsFromPage({ background: 'transparent' }), null)
  assert.equal(colorsFromPage(null), null)
  assert.equal(colorsFromPage('#fcfcf9'), null)
})

test('the caption ink reads on its band', () => {
  assert.equal(symbolFor('#fcfcf9'), '#231d1b')
  assert.equal(symbolFor('#f8f7f5'), '#231d1b')
  assert.equal(symbolFor('#333331'), '#ffffff')
  assert.equal(symbolFor('#262624'), '#ffffff')
})

test('the overlay options are what setTitleBarOverlay takes', () => {
  assert.deepEqual(overlayOptions({ background: '#333331', symbol: '#ffffff' }, 40), { color: '#333331', symbolColor: '#ffffff', height: 40 })
})

// The wiring, read from the sources: the bridge exists only behind the
// origin gate, main checks the sender again, and the old static colours
// (white window, light caption band on every theme) are gone.
test('the bridge is origin-gated twice and the static colours are gone', () => {
  const main = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8')
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8')
  assert.match(preload, /setChromeColors: \(colors\) => ipcRenderer\.invoke\('cfa:chrome-colors', colors\)/)
  const handler = main.slice(main.indexOf("ipcMain.handle('cfa:chrome-colors'"))
  assert.match(handler.slice(0, 400), /if \(!fromAppFrame\(event\)\) return false/)
  assert.match(handler.slice(0, 400), /colorsFromPage\(input\)/)
  assert.doesNotMatch(main, /backgroundColor: '#ffffff'/)
  assert.doesNotMatch(main, /color: '#f6f5f1'/)
})
