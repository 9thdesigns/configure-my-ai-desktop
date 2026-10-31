const test = require('node:test')
const assert = require('node:assert/strict')
const { isAppUrl, isAuthUrl, START_URL } = require('../src/url-policy')

test('app URLs are https on the app host or a subdomain only', () => {
  assert.ok(isAppUrl(START_URL))
  assert.ok(isAppUrl('https://www.configuremyai.com/x'))
  assert.ok(!isAppUrl('http://configuremyai.com/'))
  assert.ok(!isAppUrl('https://configuremyai.com.evil.test/'))
  assert.ok(!isAppUrl('https://evilconfiguremyai.com/'))
  assert.ok(!isAppUrl('javascript:alert(1)'))
  assert.ok(!isAppUrl('file:///etc/passwd'))
  assert.ok(!isAppUrl('not a url'))
})

test('auth hops: https only, and only the GitHub sign-in paths', () => {
  assert.ok(isAuthUrl('https://github.com/login/oauth/authorize?client_id=1'))
  assert.ok(isAuthUrl('https://github.com/session'))
  assert.ok(!isAuthUrl('https://github.com/acme/private-repo/pull/1'))
  assert.ok(!isAuthUrl('https://github.com/loginx'))
  assert.ok(!isAuthUrl('http://github.com/login'))
  assert.ok(!isAuthUrl('https://evil.test/login'))
})
