// Remembers where the window was, hand-rolled rather than a dependency: the
// whole job is one JSON file in userData and a debounced save.

const { app, screen } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const DEFAULT_BOUNDS = { width: 1280, height: 820 }
const SAVE_DELAY_MS = 500

function stateFile () {
  return path.join(app.getPath('userData'), 'window-state.json')
}

// Saved bounds are only honoured when they still land on a connected display —
// a window restored to an unplugged monitor is a window the user cannot find.
function onSomeDisplay (bounds) {
  return screen.getAllDisplays().some(({ workArea }) => {
    return (
      bounds.x >= workArea.x - bounds.width + 100 &&
      bounds.y >= workArea.y &&
      bounds.x <= workArea.x + workArea.width - 100 &&
      bounds.y <= workArea.y + workArea.height - 100
    )
  })
}

// Shrinks bounds so the window fits inside a work area (and is centred there
// when it has no position yet). A 1280x820 default on a 1366x768 laptop, or a
// size saved on a big monitor and restored on a small one, otherwise opens a
// window whose bottom edge — the composer — sits under the dock/taskbar.
// Never goes below the window's minimum size.
function fitToWorkArea (bounds, workArea, min = { width: 960, height: 600 }) {
  const width = Math.max(Math.min(bounds.width, workArea.width), Math.min(min.width, workArea.width))
  const height = Math.max(Math.min(bounds.height, workArea.height), Math.min(min.height, workArea.height))
  const hasPos = Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
  let x = hasPos ? bounds.x : workArea.x + Math.round((workArea.width - width) / 2)
  let y = hasPos ? bounds.y : workArea.y + Math.round((workArea.height - height) / 2)
  x = Math.min(Math.max(x, workArea.x), workArea.x + workArea.width - width)
  y = Math.min(Math.max(y, workArea.y), workArea.y + workArea.height - height)
  return { x, y, width, height }
}

function workAreaFor (bounds) {
  const display = Number.isFinite(bounds.x) ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay()
  return display.workArea
}

function load () {
  const state = loadRaw()
  return { ...state, bounds: fitToWorkArea(state.bounds, workAreaFor(state.bounds)) }
}

function loadRaw () {
  try {
    const saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8'))
    const bounds = saved.bounds
    if (
      Number.isFinite(bounds?.x) && Number.isFinite(bounds?.y) &&
      Number.isFinite(bounds?.width) && Number.isFinite(bounds?.height) &&
      onSomeDisplay(bounds)
    ) {
      return { bounds, isMaximized: Boolean(saved.isMaximized) }
    }
  } catch {
    // First run, or an unreadable file — either way the defaults are fine.
  }
  return { bounds: { ...DEFAULT_BOUNDS }, isMaximized: false }
}

function track (win) {
  let timer = null

  const save = () => {
    if (win.isDestroyed()) return
    const state = {
      bounds: win.isMaximized() ? loadRaw().bounds : win.getNormalBounds(),
      isMaximized: win.isMaximized(),
    }
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(state))
    } catch {
      // A failed save costs one restore, nothing more.
    }
  }

  const scheduleSave = () => {
    clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }

  win.on('resize', scheduleSave)
  win.on('move', scheduleSave)
  win.on('close', () => {
    clearTimeout(timer)
    save()
  })
}

module.exports = { load, track, fitToWorkArea }
