'use strict'

// Electron side of screen capture, shared by the widget's Share screen
// (screen-share.js) and the local tools' take_screenshot (local-tools-main.js):
// one capture function, one macOS permission path, one indicator.
//
// The decisions (is this an explicit request, is the switch on, what does the
// permission state mean) are in screen-share.js; this file only talks to the
// OS: desktopCapturer, systemPreferences, the explainer dialog, and opening
// the fixed Screen Recording pane.

const { SCREEN_SETTINGS_URL, EXPLAINER, createIndicator, createScreenShare } = require('./screen-share')

// The display to capture: the one under the pointer (where the user is
// looking when they press Share screen), else the primary.
function targetDisplay (screen) {
  try {
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  } catch {
    return screen.getPrimaryDisplay()
  }
}

// A NativeImage of one display, at most maxWidth wide. `ownWindows` are kept
// out of the picture where the OS allows (setContentProtection: macOS and
// Windows), so the dock's popover doesn't cover what the user asked about.
async function captureDisplay ({ maxWidth, ownWindows = [], electron = require('electron') }) {
  const { desktopCapturer, screen } = electron
  const display = targetDisplay(screen)
  const scale = display.scaleFactor || 1
  let width = Math.round(display.size.width * scale)
  let height = Math.round(display.size.height * scale)
  if (width > maxWidth) {
    height = Math.round(height * (maxWidth / width))
    width = maxWidth
  }
  const hidden = ownWindows.filter((w) => w && !w.isDestroyed())
  for (const w of hidden) { try { w.setContentProtection(true) } catch {} }
  try {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } })
    const match = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]
    return match ? match.thumbnail : null
  } finally {
    for (const w of hidden) { try { if (!w.isDestroyed()) w.setContentProtection(false) } catch {} }
  }
}

// Open macOS's Screen Recording pane. A fixed URL; nothing from a renderer
// is ever opened here.
function openScreenSettings ({ platform = process.platform, electron = require('electron') } = {}) {
  if (platform !== 'darwin') return false
  electron.shell.openExternal(SCREEN_SETTINGS_URL).catch(() => {})
  return true
}

// The widget's screen share, wired to Electron. `isEnabled` reads the
// "Let Manager see your screen" pref; `onIndicator(on)` drives the island and
// the widget; `ownWindows()` lists our floating windows to keep out of shot.
function createElectronScreenShare ({ isEnabled, onIndicator = () => {}, ownWindows = () => [], platform = process.platform, env = process.env, electron = require('electron') }) {
  const { dialog, systemPreferences } = electron
  return createScreenShare({
    isEnabled,
    platform,
    env,
    getMediaAccessStatus: (type) => systemPreferences.getMediaAccessStatus(type),
    explain: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        buttons: ['Continue', 'Not Now'],
        defaultId: 0,
        cancelId: 1,
        message: EXPLAINER.message,
        detail: EXPLAINER.detail,
      })
      return response === 0
    },
    capture: ({ maxWidth }) => captureDisplay({ maxWidth, ownWindows: ownWindows(), electron }),
    indicator: createIndicator({ onChange: onIndicator }),
  })
}

module.exports = { targetDisplay, captureDisplay, openScreenSettings, createElectronScreenShare }
