'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { MAX_BADGE, badgeCount, applyBadge } = require('../src/badge')

test('the count is a whole number in range', () => {
  assert.equal(badgeCount(3), 3)
  assert.equal(badgeCount(3.7), 3)
  assert.equal(badgeCount(-2), 0)
  assert.equal(badgeCount('junk'), 0)
  assert.equal(badgeCount(undefined), 0)
  assert.equal(badgeCount(1e9), MAX_BADGE)
})

test('applyBadge sets the clamped count and tolerates a missing API', () => {
  const calls = []
  assert.equal(applyBadge({ setBadgeCount: (n) => calls.push(n) }, '5'), 5)
  assert.equal(applyBadge({ setBadgeCount: (n) => calls.push(n) }, -1), 0)
  assert.deepEqual(calls, [5, 0])
  assert.equal(applyBadge({}, 2), 2)
})

test('the bridge sends the badge over IPC and main gates it to app frames', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8')
  assert.match(preload, /setBadge: \(n\) => ipcRenderer\.send\('cfa:set-badge', Number\(n\) \|\| 0\)/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8')
  assert.match(main, /ipcMain\.on\('cfa:set-badge', \(event, n\) => \{\n\s+if \(!fromAppFrame\(event\)\) return\n\s+applyBadge\(app, n\)/)
})
