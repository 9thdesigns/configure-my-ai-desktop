const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const yaml = fs.readFileSync(path.join(__dirname, '..', 'electron-builder.yml'), 'utf8')
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')

test('macOS gets a Screen Recording usage string', () => {
  assert.match(yaml, /NSScreenCaptureUsageDescription: \S/)
})

test('the screen-recording helper opens the Privacy_ScreenCapture pane', () => {
  // One URL, kept in screen-share.js and used by both screen paths.
  assert.match(read('screen-share.js'), /x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ScreenCapture/)
  assert.match(read('local-tools-main.js'), /SCREEN_SETTINGS_URL } = require\('\.\/screen-share'\)/)
})

test('the local-tools windows are sandboxed, isolated and load no remote content', () => {
  const main = read('local-tools-main.js')
  assert.match(main, /sandbox: true/)
  assert.match(main, /contextIsolation: true/)
  assert.match(main, /nodeIntegration: false/)
  assert.doesNotMatch(main, /loadURL\(/)
  for (const f of ['local-tools-card.html', 'local-tools-settings.html']) {
    assert.match(read(f), /default-src 'none'; script-src 'self'/)
  }
})

test('the card and settings renderers never write HTML from data', () => {
  for (const f of ['local-tools-card.js', 'local-tools-settings.js']) {
    assert.doesNotMatch(read(f), /innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  }
})

test('local-tools IPC is answered only for its own windows', () => {
  const main = read('local-tools-main.js')
  for (const ch of ['lt:decide', 'lt:settings', 'lt:revoke', 'lt:set-enabled']) {
    const at = main.indexOf(`'${ch}'`)
    assert.ok(at > 0, ch)
    assert.match(main.slice(at, at + 200), /fromWindow\(event, (approvalWindow|settingsWindow)\)/, ch)
  }
})
