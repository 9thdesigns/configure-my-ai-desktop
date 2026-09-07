// Nothing is exposed to the page yet — and that is a statement, not an
// omission. The site's native bridge (app/javascript/turbo/bridge.js in the
// main repo) no-ops when neither window.webkit nor the Android interface
// exists, which is exactly the situation here: the desktop app IS the web
// app, and needs no channel to itself.
//
// When the shell grows native features — a Dock badge count, global
// shortcuts — the contextBridge.exposeInMainWorld call lands in this file,
// behind contextIsolation, matching the message names bridge.js already
// defines.
