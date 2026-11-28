'use strict'

// Select area (the island's Screenshot menu): a full-screen overlay on the
// display that was just captured, showing that frozen capture dimmed. The
// user drags out a rectangle; releasing (or Enter) takes it, Esc or a
// click without a drag cancels. Main crops the capture to it
// (screen-share.js cropRect), so the overlay page only ever sees a preview
// of the picture, never sends it anywhere, and has no network (its CSP).
//
// The rectangle maths are pure (test/area-select.test.js); the window is
// the Electron half.

const path = require('node:path')
const { pathToFileURL } = require('node:url')

const HTML_PATH = path.join(__dirname, 'area-select.html')
const HTML_URL = pathToFileURL(HTML_PATH).href
const PARTITION = 'cma-area-select'
const PREVIEW_MAX_WIDTH = 2560 // the picture the overlay shows (JPEG)
const TIMEOUT_MS = 2 * 60 * 1000 // an overlay nobody answers is a cancel

// A rectangle in the overlay's CSS pixels → the capture's pixels.
//   view   — { width, height } of the overlay (the display, in DIPs)
//   image  — { width, height } of the capture
function toImageRect (rect, view, image) {
  if (!rect || typeof rect !== 'object' || !view || !image) return null
  const nums = [rect.x, rect.y, rect.width, rect.height].map(Number)
  if (!nums.every(Number.isFinite) || !(view.width > 0) || !(view.height > 0)) return null
  const sx = image.width / view.width
  const sy = image.height / view.height
  return { x: nums[0] * sx, y: nums[1] * sy, width: nums[2] * sx, height: nums[3] * sy }
}

// The rectangle between two pointer positions, either way round.
function dragRect (a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) }
}

// One overlay at a time. resolve(rect | null).
function createAreaSelect ({ electron = require('electron') } = {}) {
  const { BrowserWindow, screen, session, ipcMain } = electron
  let current = null

  const overlaySession = () => {
    const s = session.fromPartition(PARTITION)
    s.setPermissionRequestHandler((_c, _p, callback) => callback(false))
    s.setPermissionCheckHandler(() => false)
    return s
  }

  function select (image) {
    if (current) return Promise.resolve(null)
    const size = image?.getSize?.()
    if (!size || !size.width) return Promise.resolve(null)
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const preview = image.getSize().width > PREVIEW_MAX_WIDTH ? image.resize({ width: PREVIEW_MAX_WIDTH, quality: 'good' }) : image
    const dataUrl = `data:image/jpeg;base64,${preview.toJPEG(82).toString('base64')}`
    return new Promise((resolve) => {
      overlaySession()
      const win = new BrowserWindow({
        ...display.bounds,
        frame: false,
        transparent: false,
        backgroundColor: '#000000',
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        show: false,
        webPreferences: { preload: path.join(__dirname, 'area-select-preload.js'), contextIsolation: true, sandbox: true, nodeIntegration: false, partition: PARTITION, spellcheck: false },
      })
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
      win.webContents.on('will-navigate', (e) => e.preventDefault())
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
      const fromOverlay = (event) => event.sender === win.webContents && ((event.senderFrame && event.senderFrame.url) || event.sender.getURL()) === HTML_URL
      let done = false
      const finish = (rect) => {
        if (done) return
        done = true
        clearTimeout(timer)
        ipcMain.removeListener('cma-area:ready', onReady)
        ipcMain.removeListener('cma-area:done', onDone)
        current = null
        if (!win.isDestroyed()) win.destroy()
        resolve(rect)
      }
      const onReady = (event) => {
        if (!fromOverlay(event)) return
        event.sender.send('cma-area:image', { dataUrl })
      }
      const onDone = (event, input) => {
        if (!fromOverlay(event)) return
        finish(input ? toImageRect(input, display.bounds, size) : null)
      }
      ipcMain.on('cma-area:ready', onReady)
      ipcMain.on('cma-area:done', onDone)
      const timer = setTimeout(() => finish(null), TIMEOUT_MS)
      win.on('closed', () => finish(null))
      win.on('blur', () => finish(null))
      win.once('ready-to-show', () => { if (!win.isDestroyed()) { win.show(); win.focus() } })
      win.loadFile(HTML_PATH)
      current = { win, finish }
    })
  }

  return { select, cancel: () => current && current.finish(null), get active () { return Boolean(current) } }
}

module.exports = { HTML_URL, PARTITION, toImageRect, dragRect, createAreaSelect }
