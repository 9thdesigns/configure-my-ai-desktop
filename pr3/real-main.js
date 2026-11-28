// electron real-main.js <light|dark> <twoDisplays 0|1>
// The REAL dock controller (src/widget-window.js) in Electron, with a fixture
// store/feed and a temp prefs file. Windows are real; input is the real X
// pointer (xdotool from the recording script). Two harness-only shims:
//   * windows are opaque with the wallpaper colour (Xvfb has no compositor,
//     so a transparent window would render black);
//   * with twoDisplays=1, screen reports the 2560px Xvfb screen as two 1280px
//     displays ("external" on the left, "laptop" on the right), since Xvfb's
//     RandR cannot make virtual monitors. Everything else is the real screen.
const electron = require('electron')
const { app, BrowserWindow, ipcMain, nativeTheme } = electron
const path = require('path'); const fs = require('fs'); const os = require('os')
const [scheme, two] = process.argv.slice(-2)
const SRC = '/home/user/configure-my-ai-desktop/src'
const W = require(path.join(SRC, 'widget-window.js'))
const { widgetStateFrom } = require(path.join(SRC, 'widget-state.js'))
const { createPrefs } = require(path.join(SRC, 'prefs.js'))
const fixture = require('/home/user/configure-my-ai-desktop/test/fixtures/widget.json')
const WALL = scheme === 'dark' ? '#2b3036' : '#d6dae0'
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
console.error('HARNESS boot'); app.whenReady().then(async () => { try { console.error('HARNESS ready')
  nativeTheme.themeSource = scheme
  const real = electron.screen
  const d0 = real.getPrimaryDisplay()
  const displays = two === '1'
    ? [
        { ...d0, id: 2, bounds: { x: 0, y: 0, width: 1280, height: d0.bounds.height }, workArea: { x: 0, y: 0, width: 1280, height: d0.workArea.height }, label: 'external' },
        { ...d0, id: 1, bounds: { x: 1280, y: 0, width: 1280, height: d0.bounds.height }, workArea: { x: 1280, y: 28, width: 1280, height: d0.workArea.height - 28 }, label: 'laptop' },
      ]
    : [{ ...d0, workArea: { ...d0.workArea, y: 28, height: d0.workArea.height - 28 } }]
  const screen = {
    getAllDisplays: () => displays,
    getPrimaryDisplay: () => displays[displays.length - 1],
    getDisplayMatching: () => displays[displays.length - 1],
    getDisplayNearestPoint: (p) => displays.find((d) => p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width) || displays[0],
    getCursorScreenPoint: () => real.getCursorScreenPoint(),
    on: (...a) => real.on(...a),
    removeListener: (...a) => real.removeListener(...a),
  }
  // A factory (subclassing BrowserWindow does not register the window).
  // (Opaque, so no hasShadow:false: without a compositor Chromium paints that frame black.)
  function OpaqueWindow (o) { return new BrowserWindow({ ...o, type: undefined, hasShadow: true, transparent: false, backgroundColor: WALL }) }
  // Wallpaper: each display, its name, its midline.
  const wall = new BrowserWindow({ x: 0, y: 0, width: d0.bounds.width, height: d0.bounds.height, frame: false, backgroundColor: WALL, focusable: false })
  const ink = scheme === 'dark' ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.16)'
  const cells = displays.map((d) => `<div style="position:absolute;left:${d.bounds.x}px;top:0;width:${d.bounds.width}px;height:100%;box-sizing:border-box;border-right:2px solid ${ink}"><div style="position:absolute;left:50%;top:0;bottom:0;border-left:1px dashed ${ink}"></div><div style="position:absolute;left:20px;bottom:16px;font:600 18px system-ui;color:${ink}">${d.label || 'display'} - midline dashed</div><div style="position:absolute;left:0;right:0;top:0;height:${d.workArea.y - d.bounds.y}px;background:${ink}"></div></div>`).join('')
  wall.loadURL('data:text/html,' + encodeURIComponent(`<body style="margin:0;background:${WALL};overflow:hidden">${cells}</body>`))
  await new Promise((r) => setTimeout(r, 300))
  const state = widgetStateFrom(fixture)
  const store = { get: () => state, onChange: () => () => {} }
  const prefs = createPrefs({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-rec-')), 'prefs.json'), platform: 'linux' })
  const feed = { isSignedIn: () => true, conversation: async () => null, setFocus: async () => {}, setPinned: async () => {}, setActive: async () => {}, setSeatOrder: async () => {} }
  const widget = W.createWidgetController({ store, prefs, feed, getMainWindow: () => null, openBot () {}, electron: { BrowserWindow: OpaqueWindow, screen, session: electron.session, Menu: electron.Menu }, platform: 'linux', env: {} })
  widget.registerIpc(ipcMain)
  console.error('HARNESS pre-sync'); widget.sync(); console.error('HARNESS synced', BrowserWindow.getAllWindows().length, prefs.get().showWidget, state.enabled)
  setTimeout(() => console.error('HARNESS windows', JSON.stringify(BrowserWindow.getAllWindows().map((w) => [w.webContents.getURL().slice(-30), w.getBounds(), w.isVisible()]))), 2500)
  // Report where the dock is, for the recording script.
  setInterval(() => {
    const w = BrowserWindow.getAllWindows().find((x) => /widget\.html/.test(x.webContents.getURL()))
    if (w) fs.writeFileSync(process.env.DOCK_FILE, JSON.stringify(w.getBounds()))
  }, 100)
  } catch (err) { console.error('HARNESS ERROR', err && err.stack) }
})
