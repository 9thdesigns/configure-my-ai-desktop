const test = require('node:test')
const assert = require('node:assert/strict')
const { WEB_REFRESH_STORAGES, webRefreshClearOptions, senderAllowed } = require('../src/web-refresh')
const { START_URL } = require('../src/url-policy')

// The one rule that must never regress: a web-deploy refresh clears caches,
// not people's data. Drafts live in localStorage + IndexedDB
// (lib/composer_drafts.js in the main repo), the remember-me session in
// cookies — clearing any of them turns "refresh onto the new release" into
// "sign in again and retype your message".
test('the refresh clears service workers and CacheStorage, and nothing that holds data', () => {
  assert.deepEqual([...WEB_REFRESH_STORAGES].sort(), ['cachestorage', 'serviceworkers'])
  for (const forbidden of ['localstorage', 'indexdb', 'cookies', 'filesystem', 'shadercache', 'websql']) {
    assert.ok(!WEB_REFRESH_STORAGES.includes(forbidden), `${forbidden} must never be cleared by a web refresh`)
  }
})

test('the clear options hand Electron a fresh copy, never the shared constant', () => {
  const options = webRefreshClearOptions()
  assert.deepEqual(options, { storages: ['serviceworkers', 'cachestorage'] })
  options.storages.push('localstorage') // a caller mutating its copy
  assert.ok(!WEB_REFRESH_STORAGES.includes('localstorage'), 'the policy itself is frozen')
  assert.ok(!webRefreshClearOptions().storages.includes('localstorage'), 'the next caller starts clean')
})

// Same gate as the cfa:update-* IPC: our origin or nothing. An OAuth
// provider's page shares the preload mid-round-trip; it gets no refresh and
// no relaunch.
test('only frames on the app origin may ask for a refresh or relaunch', () => {
  assert.ok(senderAllowed(START_URL))
  assert.ok(senderAllowed('https://configuremyai.com/autopilot'))
  assert.ok(senderAllowed('https://www.configuremyai.com/chats/1'))
  assert.ok(!senderAllowed('https://accounts.google.com/o/oauth2/auth'))
  assert.ok(!senderAllowed('https://github.com/login/oauth/authorize'))
  assert.ok(!senderAllowed('https://configuremyai.com.evil.test/'))
  assert.ok(!senderAllowed('http://configuremyai.com/'))
  assert.ok(!senderAllowed('file:///etc/passwd'))
  assert.ok(!senderAllowed(''))
  assert.ok(!senderAllowed(null))
  assert.ok(!senderAllowed(undefined))
})
