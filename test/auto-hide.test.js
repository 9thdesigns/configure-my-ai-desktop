// "Hide when not in use" (src/auto-hide.js): its rules, the pref (off by
// default), the tray item and the flag main hands the dock page.

const test = require('node:test')
const assert = require('node:assert/strict')
const AH = require('../src/auto-hide')
const Motion = require('../src/motion')
const { defaults, sanitize } = require('../src/prefs')
const { trayMenuTemplate } = require('../src/tray')
const { widgetView } = require('../src/widget-window')
const { widgetStateFrom } = require('../src/widget-state')
const fixture = require('./fixtures/widget.json')

test('the numbers: 900ms unused, 90px into the edge on the 260 / 22 spring, a 3px strip', () => {
  assert.equal(AH.HIDE_DELAY_MS, 900)
  assert.equal(AH.TUCK_PX, 90)
  assert.equal(AH.STRIP_PX, 3)
  assert.deepEqual(Motion.SPRINGS[AH.SPRING], { stiffness: 260, damping: 22 })
})

test('in use: the pointer on it, a panel open, a drag, finished-work pills, keyboard focus', () => {
  assert.equal(AH.inUse({}), false)
  for (const key of ['hover', 'expanded', 'dragging', 'shelf', 'focused']) assert.equal(AH.inUse({ [key]: true }), true, key)
  assert.equal(AH.shouldHide({ enabled: false }), false, 'the pref off: never')
  assert.equal(AH.shouldHide({ enabled: true }), true)
  assert.equal(AH.shouldHide({ enabled: true, hover: true }), false)
})

test('a new question: a bot that now waits on the user and did not before; never a paused one, never on the first state', () => {
  const idle = [{ id: 'a', mood: 'idle' }, { id: 'b', mood: 'working' }]
  const asks = [{ id: 'a', mood: 'waiting', waiting: 'question' }, { id: 'b', mood: 'working' }]
  assert.deepEqual(AH.newQuestions(null, asks), [], 'first state: nothing')
  assert.deepEqual(AH.newQuestions(AH.waitingIds(idle), asks), ['a'])
  assert.deepEqual(AH.newQuestions(AH.waitingIds(asks), asks), [], 'still waiting: not new')
  assert.deepEqual(AH.newQuestions(AH.waitingIds(idle), [{ id: 'b', waiting: 'approval', paused: true }]), [], 'paused')
  assert.deepEqual(AH.newQuestions(AH.waitingIds(idle), [{ id: 'b', waiting: 'approval' }]), ['b'], 'an approval counts')
})

test('the pref is off by default and only a real boolean turns it on', () => {
  assert.equal(defaults('darwin').hideWhenNotInUse, false)
  assert.equal(sanitize({ hideWhenNotInUse: 'yes' }, 'darwin').hideWhenNotInUse, false)
  assert.equal(sanitize({ hideWhenNotInUse: true }, 'darwin').hideWhenNotInUse, true)
})

test('the tray item "Hide When Not in Use": a checkbox under the dock\'s items, greyed while the dock is off', () => {
  const calls = []
  const actions = { setHideWhenNotInUse: (on) => calls.push(on) }
  const item = (prefs) => trayMenuTemplate(null, { prefs, platform: 'linux' }, actions).find((i) => i.id === 'hide-when-not-in-use')
  const off = item({ showWidget: true, hideWhenNotInUse: false })
  assert.equal(off.label, 'Hide When Not in Use')
  assert.equal(off.type, 'checkbox')
  assert.equal(off.checked, false)
  assert.equal(off.enabled, true)
  off.click({ checked: true })
  off.click()
  assert.deepEqual(calls, [true, true], 'the checkbox state, else the flip of the snapshot')
  assert.equal(item({ showWidget: false }).enabled, false)
  assert.equal(item({ showWidget: true, hideWhenNotInUse: true }).checked, true)
})

test('main hands the page the pref as view.auto_hide', () => {
  const state = widgetStateFrom(fixture)
  assert.equal(widgetView(state).auto_hide, false)
  assert.equal(widgetView(state, { autoHide: true }).auto_hide, true)
})
