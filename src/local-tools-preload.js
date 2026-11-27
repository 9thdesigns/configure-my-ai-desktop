// Bridge for the two local-tools windows (the approval card and the Local
// Computer Access settings). They load bundled files only (file://), never the
// website; main additionally checks every message comes from the window it
// expects, so the site's window cannot drive these channels.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cmaLocal', {
  onCard: (fn) => ipcRenderer.on('lt:card', (_e, card) => fn(card)),
  decide: (id, answer) => ipcRenderer.send('lt:decide', String(id), String(answer)),
  settings: () => ipcRenderer.invoke('lt:settings'),
  revoke: (id) => ipcRenderer.invoke('lt:revoke', String(id)),
  setEnabled: (on) => ipcRenderer.invoke('lt:set-enabled', Boolean(on)),
})
