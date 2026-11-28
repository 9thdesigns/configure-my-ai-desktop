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
  haptic: (kind, botId) => ipcRenderer.send('cma-widget:haptic', { kind: String(kind), bot_id: botId }),
  onState: listen('cma-widget:state'),
  onLayout: listen('cma-widget:layout'),
  onConversation: listen('cma-widget:conversation'),
  onAvatarCss: listen('cma-widget:avatar-css'),
  onScreen: listen('cma-widget:screen'),
  onChatCss: listen('cma-widget:chat-css'),
  onArrival: listen('cma-widget:arrival'),
  onThreads: listen('cma-widget:threads'),
  ready: () => ipcRenderer.send('cma-widget:ready'),
  reportHitRects: (rects, dockHeight) => ipcRenderer.send('cma-widget:hit-rects', { rects, dockHeight }),
  drag: (phase, screenX, screenY) => ipcRenderer.send('cma-widget:drag', { phase, screenX, screenY }),
  open: (botId) => ipcRenderer.send('cma-widget:open', botId),
  openThread: (botId, threadId) => ipcRenderer.send('cma-widget:open-thread', { bot_id: botId, thread_id: threadId }),
  back: () => ipcRenderer.send('cma-widget:back'),
  recents: (botId, seatY) => ipcRenderer.send('cma-widget:recents', { bot_id: botId, seat_y: seatY }),
  collapse: () => ipcRenderer.send('cma-widget:collapse'),
  shelf: (open) => ipcRenderer.send('cma-widget:shelf', open === true),
  contextMenu: (botId) => ipcRenderer.send('cma-widget:context-menu', botId),
  picker: () => ipcRenderer.send('cma-widget:picker'),
  workspaceMenu: () => ipcRenderer.send('cma-widget:workspace-menu'),
  pin: (botId) => ipcRenderer.send('cma-widget:pin', botId),
  openInApp: (botId) => ipcRenderer.send('cma-widget:open-in-app', botId),
  sendMessage: (botId, body) => ipcRenderer.invoke('cma-widget:send', { bot_id: botId, body }),
  answer: (payload) => ipcRenderer.invoke('cma-widget:answer', payload),
  decide: (payload) => ipcRenderer.invoke('cma-widget:decide', payload),
  shareScreen: (botId, reason) => ipcRenderer.invoke('cma-widget:share-screen', { bot_id: botId, reason }),
  discardScreen: (botId) => ipcRenderer.send('cma-widget:discard-screen', botId),
  openScreenSettings: () => ipcRenderer.send('cma-widget:screen-settings'),
  setShareScreen: (on) => ipcRenderer.send('cma-widget:set-share-screen', on === true),
})
