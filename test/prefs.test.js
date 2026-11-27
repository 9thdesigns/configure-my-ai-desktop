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
})

test('only known keys of the right type are read back', () => {
  assert.deepEqual(sanitize({ showWidget: 'no', keepRunningInBackground: true, evil: 1 }, 'linux'), { keepRunningInBackground: true, showWidget: true })
  assert.deepEqual(sanitize(null, 'darwin'), defaults('darwin'))
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
