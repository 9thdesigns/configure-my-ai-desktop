// Builds test/fixtures/cfa-avatar-real.html: the real CFA partial's structure
// (as sent by the orchestrator from configure-my-ai #1588), with a generated
// stand-in for the ~14KB brand-mark path (deterministic, same character set).
const fs = require('node:fs')
const out = process.argv[2]
let d = 'M141.7 1.7 c-1 0.9 -5.2 4.8 -9.3 8.6'
let seed = 7
const rnd = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280 }
while (d.length < 14000) {
  const x = (40 + rnd() * 340).toFixed(1)
  const y = (40 + rnd() * 430).toFixed(1)
  const w = (6 + rnd() * 40).toFixed(1)
  const h = (6 + rnd() * 40).toFixed(1)
  d += ` M${x} ${y} h${w} v${h} c-1.2 0.4 -2.1 1.3 -2.6 2.5 l-${(w / 2).toFixed(1)} 0 z`
}
const html = (shape, state) => `<span class="cfa-avatar " style="--cfa-tint: #5b8def" data-controller="avatar-visibility" data-cfa-tone="light" data-cfa-shape="${shape}" data-cfa-state="${state}" role="img" aria-label="Configure My AI"> <span class="cfa-avatar__aura" aria-hidden="true"></span> <span class="cfa-avatar__body" aria-hidden="true"> <span class="cfa-avatar__orb"> <span class="cfa-avatar__skin"> <span class="cfa-avatar__circuit"><svg class="cfa-avatar__mark" viewBox="0 0 420.1 512.0" xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" role="img" aria-label="Configure My AI"><path d="${d}"/></svg></span> <span class="cfa-avatar__rim"></span> </span> <span class="cfa-avatar__face"> <span class="cfa-avatar__brows"><i class="cfa-avatar__brow"></i><i class="cfa-avatar__brow"></i></span> <span class="cfa-avatar__eyes"> <span class="cfa-avatar__eye"><i class="cfa-avatar__iris"></i></span> <span class="cfa-avatar__eye"><i class="cfa-avatar__iris"></i></span> </span> <span class="cfa-avatar__mouth"></span> </span> </span> </span> </span>`
module.exports = { html }
if (out) fs.writeFileSync(out, html('samurai', 'working') + '\n')
