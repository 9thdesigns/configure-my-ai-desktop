const test = require('node:test')
const assert = require('node:assert')
const Module = require('node:module')
const orig = Module._load
Module._load = function (req, ...a) { return req === 'electron' ? { app: {}, screen: {} } : orig.call(this, req, ...a) }
const { fitToWorkArea } = require('../src/window-state.js')
Module._load = orig

const laptop = { x: 0, y: 25, width: 1366, height: 728 }

test('default size is shrunk and centred on a small laptop', () => {
  assert.deepStrictEqual(fitToWorkArea({ width: 1280, height: 820 }, laptop), { x: 43, y: 25, width: 1280, height: 728 })
})
test('fits comfortably on a large display unchanged', () => {
  const big = { x: 0, y: 0, width: 2560, height: 1400 }
  assert.deepStrictEqual(fitToWorkArea({ x: 100, y: 100, width: 1280, height: 820 }, big), { x: 100, y: 100, width: 1280, height: 820 })
})
test('size saved on a big monitor is clamped and pulled back on screen', () => {
  assert.deepStrictEqual(fitToWorkArea({ x: 900, y: 400, width: 2400, height: 1300 }, laptop), { x: 0, y: 25, width: 1366, height: 728 })
})
test('never below the minimum size when the screen allows it', () => {
  assert.deepStrictEqual(fitToWorkArea({ x: 0, y: 25, width: 400, height: 300 }, laptop).width, 960)
})
test('a work area smaller than the minimum wins', () => {
  const tiny = { x: 0, y: 0, width: 800, height: 560 }
  const r = fitToWorkArea({ width: 1280, height: 820 }, tiny)
  assert.deepStrictEqual([r.width, r.height], [800, 560])
})
