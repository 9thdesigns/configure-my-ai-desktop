const test = require('node:test')
const assert = require('node:assert/strict')
const RC = require('../src/recents-card')
const Motion = require('../src/motion')

const geo = { width: 288, height: 256, seat: 38, travel: 58 }

test('the bud starts as a 40px seat circle on the seat and ends as the whole card', () => {
  const start = RC.budState(0, geo)
  assert.equal(start.clipPath, 'inset(18px 0px 198px 248px round 20px)', 'a 40×40 box at radius 20: a circle, at the dock-side edge, level with the seat')
  assert.equal(start.transform, 'translateX(58px)', 'shifted onto the seat')
  assert.equal(start.bridge, 0)
  const end = RC.budState(1, geo)
  assert.equal(end.clipPath, 'inset(0px 0px 0px 0px round 20px)')
  assert.equal(end.transform, 'none')
  assert.equal(end.bridge, 1)
  // A spring's overshoot past 1: the clip stays the box, the shift goes past.
  const over = RC.budState(1.04, geo)
  assert.equal(over.clipPath, end.clipPath)
  assert.match(over.transform, /^translateX\(-2\.3\d*px\)$/)
})

test('on the left edge it is mirrored', () => {
  const start = RC.budState(0, { ...geo, side: 'left' })
  assert.equal(start.clipPath, 'inset(18px 248px 198px 0px round 20px)')
  assert.equal(start.transform, 'translateX(-58px)')
})

test('the seat circle stays inside the card when the seat is near its top or bottom', () => {
  assert.match(RC.budState(0, { ...geo, seat: 5 }).clipPath, /^inset\(0px 0px 216px/)
  assert.match(RC.budState(0, { ...geo, seat: 250 }).clipPath, /^inset\(216px 0px 0px/)
})

test('the frames: SOFT opening, CLOSE closing, sampled from motion.js; reduced motion is a ≤150ms fade', () => {
  const open = RC.budFrames(geo)
  const soft = Motion.sample('soft', { from: 0, to: 1 })
  assert.equal(open.duration, soft.duration)
  assert.equal(open.card.length, soft.values.length)
  assert.equal(open.card[0].transform, 'translateX(58px)')
  assert.equal(open.card.at(-1).transform, 'none')
  assert.equal(open.bridge[0].opacity, '0')
  assert.equal(open.bridge.at(-1).opacity, '1')
  const close = RC.budFrames({ ...geo, closing: true })
  assert.equal(close.duration, Motion.sample('close', { from: 1, to: 0 }).duration)
  assert.equal(close.card[0].transform, 'none')
  assert.equal(close.card.at(-1).transform, 'translateX(58px)')
  const reduced = RC.budFrames({ ...geo, reduced: true })
  assert.ok(reduced.duration <= 150)
  assert.deepEqual(reduced.card, [{ opacity: 0 }, { opacity: 1 }])
  assert.deepEqual(RC.budFrames({ ...geo, reduced: true, closing: true }).card, [{ opacity: 1 }, { opacity: 0 }])
})

test('the rows: 30ms apart, from 10px toward the edge, faded and blurred 2px, 280ms on (.22,1,.36,1); none under reduced motion', () => {
  const r0 = RC.rowEntrance(0)
  const r2 = RC.rowEntrance(2)
  assert.equal(r2.options.delay - r0.options.delay, 60)
  assert.equal(r0.options.duration, 280)
  assert.equal(r0.options.easing, 'cubic-bezier(0.22, 1, 0.36, 1)')
  assert.deepEqual(r0.keyframes[0], { opacity: 0, transform: 'translateX(10px)', filter: 'blur(2px)' })
  assert.equal(RC.rowEntrance(0, { side: 'left' }).keyframes[0].transform, 'translateX(-10px)')
  assert.equal(RC.rowEntrance(0, { reduced: true }), null)
})

test('the bridge: a closed path across the gap, flaring concavely into the card and the dock; kept on the card\'s straight edge', () => {
  const d = RC.bridgePath(10)
  assert.match(d, /^M 0 0 .* Z$/)
  assert.equal((d.match(/A 5 5 0 0 0/g) || []).length, 4, 'four concave quarter circles')
  assert.ok(d.includes('L 12 0') && d.includes('L 12 30'), '12 wide (the gap and a pixel under each side), 30 tall (a 20px neck and two 5px fillets)')
  assert.equal(RC.bridgeCentre(38, 256), 38)
  assert.equal(RC.bridgeCentre(10, 256), 35, 'clear of the top corner')
  assert.equal(RC.bridgeCentre(250, 256), 221, 'clear of the bottom corner')
})

test('relative times: now, minutes and hours today, yesterday, a weekday, a date', () => {
  const now = new Date(2026, 10, 28, 15, 0).getTime() // Sat 28 Nov 2026, 15:00 local
  const at = (...a) => new Date(...a).toISOString()
  assert.equal(RC.relativeTime(at(2026, 10, 28, 14, 59, 40), now), 'now')
  assert.equal(RC.relativeTime(at(2026, 10, 28, 14, 55), now), '5m')
  assert.equal(RC.relativeTime(at(2026, 10, 28, 12, 0), now), '3h')
  assert.equal(RC.relativeTime(at(2026, 10, 27, 23, 0), now), 'Yesterday')
  assert.equal(RC.relativeTime(at(2026, 10, 24, 9, 0), now), 'Tue')
  assert.equal(RC.relativeTime(at(2026, 2, 4, 9, 0), now), 'Mar 4')
  assert.equal(RC.relativeTime(at(2025, 2, 4, 9, 0), now), 'Mar 4, 2025')
  assert.equal(RC.relativeTime(at(2026, 10, 28, 16, 0), now), 'now', 'a clock a little ahead')
  assert.equal(RC.relativeTime(null, now), '')
  assert.equal(RC.relativeTime('garbage', now), '')
})
