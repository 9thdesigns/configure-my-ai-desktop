// The Select-area overlay's bridge (src/area-select.js): it is handed the
// frozen picture to draw, and answers with the rectangle or a cancel.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cmaArea', {
  onImage: (fn) => { if (typeof fn === 'function') ipcRenderer.on('cma-area:image', (_e, payload) => fn(payload)) },
  ready: () => ipcRenderer.send('cma-area:ready'),
  done: (rect) => ipcRenderer.send('cma-area:done', rect && typeof rect === 'object' ? { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) } : null),
})
