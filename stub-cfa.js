// A stand-in for the web app's CFA partial and stylesheet, for screenshots
// only: the real markup and CSS arrive from GET /desktop/widget.json.
const bodies = {
  circle: '<circle class="cfa-avatar__body" cx="50" cy="52" r="42" fill="var(--cfa-color)"/>',
  square: '<rect class="cfa-avatar__body" x="10" y="12" width="80" height="80" rx="20" fill="var(--cfa-color)"/>',
  triangle: '<path class="cfa-avatar__body" d="M50 8 L93 86 Q95 92 88 92 L12 92 Q5 92 7 86 Z" fill="var(--cfa-color)"/>',
  cloud: '<path class="cfa-avatar__body" d="M28 88 Q8 88 8 70 Q8 54 24 52 Q24 30 46 28 Q62 14 78 30 Q94 34 92 54 Q96 88 74 88 Z" fill="var(--cfa-color)"/>',
  samurai: '<circle class="cfa-avatar__body" cx="50" cy="56" r="38" fill="var(--cfa-color)"/><ellipse cx="50" cy="14" rx="9" ry="7" fill="#231d1b"/><rect x="12" y="38" width="76" height="9" rx="4" fill="#e5484d"/>',
  astronaut: '<circle cx="50" cy="52" r="44" fill="#f5f4f2" stroke="#d6d3cf" stroke-width="3"/><rect class="cfa-avatar__body" x="18" y="26" width="64" height="50" rx="24" fill="var(--cfa-color)"/>',
}
function cfaHtml ({ shape = 'circle', color = '#7c5cff', state = 'idle' }) {
  return `<span class="cfa-avatar cfa-avatar--${shape} cfa-avatar--${state}" data-state="${state}" style="--cfa-color: ${color}" aria-hidden="true">
  <svg class="cfa-avatar__svg" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" focusable="false">
    <g class="cfa-avatar__bob">${bodies[shape]}
      <g class="cfa-avatar__eyes"><ellipse class="cfa-avatar__eye" cx="38" cy="54" rx="5.5" ry="7" fill="#231d1b"/><ellipse class="cfa-avatar__eye" cx="62" cy="54" rx="5.5" ry="7" fill="#231d1b"/>
      <circle cx="40" cy="51" r="1.8" fill="#fff"/><circle cx="64" cy="51" r="1.8" fill="#fff"/></g>
      <path class="cfa-avatar__mouth" d="M41 68 Q50 75 59 68" fill="none" stroke="#231d1b" stroke-width="3.5" stroke-linecap="round"/>
      <g class="cfa-avatar__spark"><circle cx="84" cy="18" r="4" fill="#f08a24"/><circle cx="92" cy="30" r="2.5" fill="#f08a24"/></g>
    </g>
  </svg>
</span>`
}
const CSS = `.cfa-avatar { display: inline-grid; place-items: center; width: var(--cfa-size, 40px); height: var(--cfa-size, 40px); }
.cfa-avatar__svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 1px 1.5px rgba(0,0,0,.22)); }
.cfa-avatar__bob, .cfa-avatar__eye, .cfa-avatar__eyes { transform-box: fill-box; transform-origin: center; }
.cfa-avatar__spark { opacity: 0; }
.cfa-avatar--idle .cfa-avatar__eye { animation: cfa-blink 5s infinite; }
.cfa-avatar--working .cfa-avatar__bob { animation: cfa-bob 1.6s ease-in-out infinite; }
.cfa-avatar--working .cfa-avatar__eyes { transform: translateX(3px); animation: cfa-look 2.4s ease-in-out infinite; }
.cfa-avatar--working .cfa-avatar__mouth { d: path("M43 69 L57 69"); }
.cfa-avatar--working .cfa-avatar__spark { opacity: 1; animation: cfa-spark 1.2s ease-in-out infinite; }
@keyframes cfa-blink { 0%, 94%, 100% { transform: scaleY(1); } 97% { transform: scaleY(.1); } }
@keyframes cfa-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes cfa-look { 0%, 100% { transform: translateX(3px); } 50% { transform: translateX(-3px); } }
@keyframes cfa-spark { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .cfa-avatar, .cfa-avatar * { animation: none !important; } }`
module.exports = { cfaHtml, CSS }
