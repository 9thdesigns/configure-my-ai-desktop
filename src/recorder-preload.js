// The hidden recorder page's bridge (src/recorder.js): main says start and
// stop; the page sends the recorded chunks and says when it is done.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('cmaRecorder', {
  onStart: (fn) => { if (typeof fn === 'function') ipcRenderer.on('cma-recorder:start', (_e, payload) => fn(payload)) },
  onStop: (fn) => { if (typeof fn === 'function') ipcRenderer.on('cma-recorder:stop', () => fn()) },
  chunk: (bytes) => { if (bytes instanceof Uint8Array) ipcRenderer.send('cma-recorder:chunk', bytes) },
  done: () => ipcRenderer.send('cma-recorder:done'),
  error: (code) => ipcRenderer.send('cma-recorder:error', code === 'permission' ? 'permission' : 'failed'),
})
