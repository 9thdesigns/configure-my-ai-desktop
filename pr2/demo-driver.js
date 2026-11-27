// Drives the demo with real X pointer events (xdotool).
const { execSync } = require('child_process')
const fs = require('fs')
const x = (args) => execSync(`xdotool ${args}`)
const sleep = (ms) => execSync(`sleep ${ms / 1000}`)
const bounds = () => JSON.parse(fs.readFileSync(process.env.BOUNDS_FILE, 'utf8'))
const move = (px, py) => x(`mousemove ${Math.round(px)} ${Math.round(py)}`)
function tap (px, py) { move(px, py); sleep(250); x('mousedown 1'); sleep(70); x('mouseup 1'); sleep(900) }
function drag (from, to, ms = 900, steps = 30) {
  move(from.x, from.y); sleep(300); x('mousedown 1'); sleep(120)
  for (let i = 1; i <= steps; i++) {
    const t = i / steps; const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
    move(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e); sleep(ms / steps)
  }
  sleep(120); x('mouseup 1'); sleep(1000)
}
sleep(3000)
const bot = (i) => bounds().widget.targets[i]
const bar = () => bounds().island.targets[0]
// 1. tap a bot: quick chat opens; tap it again: closes
let p = bot(1); tap(p.x, p.y); sleep(900); p = bot(1); tap(p.x, p.y)
// 2. drag the dock from the right edge to the left half: snaps to the left edge
drag(bot(0), { x: 380, y: 330 }, 1400)
// 3. tap a bot on the left: quick chat opens to its right; close
p = bot(1); tap(p.x, p.y); sleep(900); p = bot(1); tap(p.x, p.y)
// 4. drag the island off top-centre: stays where dropped
let g = bar(); g = { x: g.x - 80, y: g.y }
drag(g, { x: g.x + 330, y: g.y + 250 }, 1200)
// 5. drag it back to within 48px of top-centre: snaps home
g = bar(); g = { x: g.x - 80, y: g.y }
drag(g, { x: g.x - 330 + 26, y: g.y - 250 + 22 }, 1200)
// 6. tap the island bar: the card opens (a click still works)
g = bar(); tap(g.x + 40, g.y)
sleep(1800)
