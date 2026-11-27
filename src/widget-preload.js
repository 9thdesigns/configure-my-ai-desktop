// The widget window's bridge (src/widget-window.js). The page is a local
// file with no network access and no cookies; this is all it can do — read
// the validated state main sends, report its layout, and ask main to act.
// Main checks that every message comes from the widget page in the widget
// window, and validates every argument again.

const { contextBridge, ipcRenderer } = require('electron')

const listen = (channel) => (fn) => {
  if (typeof fn !== 'function') return
  ipcRenderer.on(channel, (_event, payload) => fn(payload))
}

contextBridge.exposeInMainWorld('cmaWidget', {
  onState: listen('cma-widget:state'),
  onLayout: listen('cma-widget:layout'),
  onConversation: listen('cma-widget:conversation'),
  onAvatarCss: listen('cma-widget:avatar-css'),
  ready: () => ipcRenderer.send('cma-widget:ready'),
  reportHitRects: (rects, dockHeight) => ipcRenderer.send('cma-widget:hit-rects', { rects, dockHeight }),
  drag: (phase, screenY) => ipcRenderer.send('cma-widget:drag', { phase, screenY }),
  open: (botId) => ipcRenderer.send('cma-widget:open', botId),
  collapse: () => ipcRenderer.send('cma-widget:collapse'),
  contextMenu: (botId) => ipcRenderer.send('cma-widget:context-menu', botId),
  picker: () => ipcRenderer.send('cma-widget:picker'),
  workspaceMenu: () => ipcRenderer.send('cma-widget:workspace-menu'),
  pin: (botId) => ipcRenderer.send('cma-widget:pin', botId),
  openInApp: (botId) => ipcRenderer.send('cma-widget:open-in-app', botId),
  sendMessage: (botId, body) => ipcRenderer.invoke('cma-widget:send', { bot_id: botId, body }),
  answer: (payload) => ipcRenderer.invoke('cma-widget:answer', payload),
  decide: (payload) => ipcRenderer.invoke('cma-widget:decide', payload),
})
