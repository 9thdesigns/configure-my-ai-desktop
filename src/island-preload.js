// The island window's bridge (src/island-window.js). Like the dock's, the
// page is a local file with no network and no cookies; this is all it can
// do. Main checks every message comes from the island page in the island
// window and validates every argument again.

const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel) => (fn) => {
  if (typeof fn !== 'function') return
  ipcRenderer.on(channel, (_event, payload) => fn(payload))
}

contextBridge.exposeInMainWorld('cmaIsland', {
  onView: listen('cma-island:view'),
  onLayout: listen('cma-island:layout'),
  onAvatarCss: listen('cma-island:avatar-css'),
  ready: () => ipcRenderer.send('cma-island:ready'),
  reportHeight: (height) => ipcRenderer.send('cma-island:height', height),
  hover: (inside) => ipcRenderer.send('cma-island:hover', inside === true),
  activate: () => ipcRenderer.send('cma-island:activate'),
  collapse: () => ipcRenderer.send('cma-island:collapse'),
  openInApp: (botId) => ipcRenderer.send('cma-island:open-in-app', botId),
  answer: (payload) => ipcRenderer.invoke('cma-island:answer', payload),
  decide: (payload) => ipcRenderer.invoke('cma-island:decide', payload),
})
