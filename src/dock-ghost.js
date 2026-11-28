// The dock's ghost (dock-ghost.html): draws the dock's outline for the edge
// and height in its URL (?edge=left|right&h=<window height>). Inert: no
// bridge, no network, nothing to click.
(() => {
  'use strict'
  const params = new URLSearchParams(location.search)
  const edge = params.get('edge') === 'left' ? 'left' : 'right'
  const windowHeight = Math.max(0, Math.min(4000, Number(params.get('h')) || 0))
  // The window holds the dock plus room for its shadow (24 above, 40 below:
  // widget-window.js), as the dock's own window does.
  const h = Math.max(0, windowHeight - 24 - 40)
  const w = 56
  document.documentElement.dataset.edge = edge
  const svg = document.querySelector('.ghost')
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`)
  svg.style.height = `${h}px`
  svg.querySelector('.ghost-outline').setAttribute('d', window.DockShape.dockPath(w, h, { fillet: 14, corner: 22 }))
})()
