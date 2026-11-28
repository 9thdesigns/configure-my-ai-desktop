// The Select-area overlay page (src/area-select.html): draw the frozen
// picture, let the user drag out a rectangle, answer with it (or a cancel).

(() => {
  'use strict'
  const api = window.cmaArea
  if (!api) return
  const shot = document.querySelector('[data-role="shot"]')
  const sel = document.querySelector('[data-role="sel"]')
  let start = null
  let rect = null
  const MIN = 8

  api.onImage((payload) => {
    const url = payload && payload.dataUrl
    if (typeof url === 'string' && url.startsWith('data:image/')) shot.src = url
  })

  const dragRect = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) })
  function draw () {
    sel.hidden = !rect
    document.body.classList.toggle('is-selecting', Boolean(rect))
    if (!rect) return
    Object.assign(sel.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }
  const finish = () => api.done(rect && rect.width >= MIN && rect.height >= MIN ? rect : null)

  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    start = { x: e.clientX, y: e.clientY }
    rect = null
    draw()
  })
  document.addEventListener('pointermove', (e) => {
    if (!start) return
    rect = dragRect(start, { x: e.clientX, y: e.clientY })
    draw()
  })
  document.addEventListener('pointerup', () => {
    if (!start) return
    start = null
    finish()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); rect = null; finish() }
    if (e.key === 'Enter' && rect) { e.preventDefault(); finish() }
  })
  api.ready()
})()
