// Demo harness for the PR 2 recording: the real widget and island
// controllers (src/widget-window.js, src/island-window.js) in real Electron,
// fed the test fixture instead of the server, over a plain "desktop" window
// that logs what happens (taps, drags, drops, what got saved).
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const REPO = process.env.REPO
const { widgetStateFrom } = require(path.join(REPO, 'src/widget-state'))
const { createPrefs } = require(path.join(REPO, 'src/prefs'))
const W = require(path.join(REPO, 'src/widget-window'))
const I = require(path.join(REPO, 'src/island-window'))
const fixture = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/widget.json'), 'utf8'))
fixture.seats.forEach((s) => { s.avatar_url = null })

app.whenReady().then(() => {
  const { width, height } = screen.getPrimaryDisplay().bounds
  const bg = new BrowserWindow({ x: 0, y: 0, width, height, frame: false, focusable: false, show: true, backgroundColor: '#2b3440' })
  bg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(`<meta charset=utf-8><body style="margin:0;height:100vh;background:linear-gradient(135deg,#334155,#1e293b 60%,#0f172a);font:15px system-ui;color:#e2e8f0">
    <div style="position:absolute;left:24px;bottom:20px;width:620px"><b>PR 2 demo · real Electron under Xvfb</b><ol id="log" style="padding-left:20px;margin:6px 0 0;line-height:1.5"></ol></div>
    <script>function log(m){const li=document.createElement('li');li.textContent=m;const l=document.getElementById('log');l.append(li);while(l.children.length>9)l.firstChild.remove()}</script></body>`))
  const log = (m) => { console.log('[demo]', m); bg.webContents.executeJavaScript(`log(${JSON.stringify(m)})`).catch(() => {}) }

  const state = widgetStateFrom(fixture)
  const store = { get: () => state, onChange: () => () => {} }
  const prefs = createPrefs({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-demo-')), 'prefs.json') })
  const feed = { isSignedIn: () => true, conversation: async () => null, setFocus: async () => {}, sendMessage: async () => null, answer: async () => null, decide: async () => null }
  const widget = W.createWidgetController({ store, prefs, feed, getMainWindow: () => null, openBot: (id) => log(`open in app: ${id}`) })
  const island = I.createIslandController({ store, prefs, feed, getMainWindow: () => null, openBot: (id) => log(`open in app: ${id}`) })
  widget.registerIpc(ipcMain)
  island.registerIpc(ipcMain)

  // Narrate (extra listeners next to the controllers' own).
  const name = (id) => (id === 'manager' ? state.manager.name : state.seats.find((s) => s.bot_id === id)?.name || id)
  ipcMain.on('cma-widget:open', (_e, id) => log(`dock tap → quick chat for ${name(id)}`))
  ipcMain.on('cma-widget:drag', (_e, d) => { if (d.phase !== 'move') log(`dock drag ${d.phase} at (${Math.round(d.screenX)}, ${Math.round(d.screenY)})`) })
  ipcMain.on('cma-island:drag', (_e, d) => { if (d.phase !== 'move') log(`island drag ${d.phase} at (${Math.round(d.screenX)}, ${Math.round(d.screenY)})`) })
  ipcMain.on('cma-island:activate', () => log('island tap → card opens'))
  let last = ''
  prefs.onChange((p) => {
    const s = JSON.stringify({ dock: p.widgetPositions[0]?.pos, island: p.islandPositions[0]?.pos })
    if (s !== last) log(`saved for display ${p.widgetPositions[0]?.id ?? p.islandPositions[0]?.id}: ${s}`)
    last = s
  })

  widget.sync()
  island.sync()

  // Window bounds for the driver script.
  setInterval(async () => {
    const wins = BrowserWindow.getAllWindows().filter((w) => w !== bg && !w.isDestroyed())
    const out = {}
    for (const w of wins) {
      const key = w.webContents.getURL().includes('island') ? 'island' : 'widget'
      const sel = key === 'island' ? '.island-bar' : '.dock-bot'
      const rects = await w.webContents.executeJavaScript(`[...document.querySelectorAll('${sel}')].map((n) => { const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })`).catch(() => [])
      const b = w.getBounds()
      out[key] = { ...b, targets: rects.map((r) => ({ x: b.x + r.x, y: b.y + r.y })) }
    }
    fs.writeFileSync(process.env.BOUNDS_FILE, JSON.stringify(out))
  }, 100)
})
