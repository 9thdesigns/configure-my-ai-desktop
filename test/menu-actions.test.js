'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { PAGE_BACK_SCRIPT, PAGE_BACK_SELECTOR, homeVisitScript, homePathFor, goBack, goHome } = require('../src/menu-actions')

function fakeContents ({ handled = true, throws = false, canGoBack = true } = {}) {
  const calls = { scripts: [], back: 0, loads: [] }
  return {
    calls,
    executeJavaScript: (script) => {
      calls.scripts.push(script)
      return throws ? Promise.reject(new Error('page gone')) : Promise.resolve(handled)
    },
    navigationHistory: { canGoBack: () => canGoBack, goBack: () => { calls.back += 1 } },
    loadURL: (url) => { calls.loads.push(url) },
  }
}

test('Back clicks the page\'s own route-map Back control first', async () => {
  const wc = fakeContents({ handled: true })
  assert.equal(await goBack(wc), true)
  assert.deepEqual(wc.calls.scripts, [PAGE_BACK_SCRIPT])
  assert.equal(wc.calls.back, 0, 'no window-history back when the page handled it')
  assert.match(PAGE_BACK_SELECTOR, /desktop-history-target="back"/)
  assert.match(PAGE_BACK_SELECTOR, /data-nav-top-back/)
})

test('Back falls back to window history when the page has no Back control or errors', async () => {
  const none = fakeContents({ handled: false })
  await goBack(none)
  assert.equal(none.calls.back, 1)

  const broken = fakeContents({ throws: true })
  await goBack(broken)
  assert.equal(broken.calls.back, 1)

  const nowhere = fakeContents({ handled: false, canGoBack: false })
  await goBack(nowhere)
  assert.equal(nowhere.calls.back, 0, 'nothing to go back to: do nothing')
})

test('Home is a Turbo visit to the in-app path, with a URL load only as a fallback', async () => {
  const wc = fakeContents({ handled: true })
  assert.equal(await goHome(wc, 'https://configuremyai.com/home', 'https://configuremyai.com'), true)
  assert.deepEqual(wc.calls.scripts, [homeVisitScript('/home')])
  assert.deepEqual(wc.calls.loads, [])

  const noTurbo = fakeContents({ handled: false })
  await goHome(noTurbo, 'https://configuremyai.com/home', 'https://configuremyai.com')
  assert.deepEqual(noTurbo.calls.loads, ['https://configuremyai.com/home'])
})

test('a home URL on another origin is loaded, never Turbo-visited', async () => {
  assert.equal(homePathFor('https://elsewhere.example/home', 'https://configuremyai.com'), null)
  assert.equal(homePathFor('https://configuremyai.com/users/sign_in?x=1', 'https://configuremyai.com'), '/users/sign_in?x=1')
  const wc = fakeContents()
  await goHome(wc, 'https://elsewhere.example/home', 'https://configuremyai.com')
  assert.deepEqual(wc.calls.scripts, [])
  assert.deepEqual(wc.calls.loads, ['https://elsewhere.example/home'])
})

test('the page scripts only report handled when they acted', () => {
  assert.match(PAGE_BACK_SCRIPT, /return false/)
  assert.match(PAGE_BACK_SCRIPT, /el\.click\(\)/)
  assert.match(homeVisitScript('/home'), /window\.Turbo\.visit\("\/home"\)/)
})
