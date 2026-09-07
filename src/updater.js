// In-app auto-update.
//
// electron-updater checks the GitHub release channel (the latest-mac.yml the
// release workflow publishes), downloads a newer signed build in the
// background, and — when it's ready — this shows a modal offering to restart
// into it. "Restart Now" calls quitAndInstall, so the user updates without
// re-downloading the DMG by hand. A menu item ("Check for Updates…") routes
// here too for an on-demand check.
//
// Only packaged, Developer ID-signed builds can self-update on macOS, so
// everything no-ops in development and fails quietly if the updater can't
// load. Background checks never surface an error dialog; a user-initiated
// check does, so a deliberate click is never met with silence.

const { app, dialog } = require('electron')

let updater = null // null = not yet loaded, false = unavailable
let wired = false
let checking = false
let interactive = false // the in-flight check was user-initiated
let promptedVersion = null // guard against a second restart prompt

function box (getWindow, options) {
  const win = getWindow && getWindow()
  return (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options))
    .catch(() => ({}))
}

function load () {
  if (updater !== null) return updater
  try {
    updater = require('electron-updater').autoUpdater
    updater.autoDownload = true
    updater.autoInstallOnAppQuit = true
    updater.logger = null
  } catch {
    updater = false
  }
  return updater
}

function wire (getWindow) {
  if (wired || !updater) return
  wired = true

  updater.on('error', () => {
    if (interactive) {
      interactive = false
      box(getWindow, {
        type: 'warning',
        buttons: ['OK'],
        title: 'Update Check Failed',
        message: 'Couldn’t check for updates.',
        detail: 'Please try again in a little while.',
      })
    }
    checking = false
  })

  updater.on('update-not-available', () => {
    checking = false
    if (interactive) {
      interactive = false
      box(getWindow, {
        type: 'info',
        buttons: ['OK'],
        title: 'You’re Up to Date',
        message: 'Configure My AI is up to date.',
        detail: `You’re on version ${app.getVersion()}, the latest release.`,
      })
    }
  })

  updater.on('update-available', () => {
    checking = false
    // The build downloads in the background (autoDownload). Only acknowledge
    // for a manual check, so an on-demand click isn't silent while it fetches.
    if (interactive) {
      interactive = false
      box(getWindow, {
        type: 'info',
        buttons: ['OK'],
        title: 'Update Available',
        message: 'A new version is downloading.',
        detail: 'You’ll be prompted to restart as soon as it’s ready.',
      })
    }
  })

  updater.on('update-downloaded', (info) => {
    checking = false
    interactive = false
    const version = info && info.version
    if (version && version === promptedVersion) return
    promptedVersion = version
    box(getWindow, {
      type: 'info',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update Ready',
      message: 'A new version of Configure My AI is ready.',
      detail: `Version ${version || ''} has been downloaded. Restart to install it — it only takes a moment.`.replace('  ', ' '),
    }).then((res) => {
      if (res && res.response === 0) {
        // Defer so the dialog fully closes before the app quits.
        setImmediate(() => updater.quitAndInstall())
      }
    })
  })
}

function runCheck () {
  if (checking) return
  checking = true
  Promise.resolve(updater.checkForUpdates()).catch(() => { checking = false })
}

// Background: quiet periodic checks; the modal only appears once a build is
// downloaded and ready to install.
function initAutoUpdates ({ getWindow } = {}) {
  if (!app.isPackaged || !load()) return
  wire(getWindow)
  runCheck()
  setInterval(runCheck, 4 * 60 * 60 * 1000)
}

// Menu-triggered. Gives feedback either way (up to date / downloading /
// couldn't check), and in an unpackaged or unsupported build says so plainly
// rather than doing nothing.
function checkForUpdates ({ getWindow } = {}) {
  if (!app.isPackaged || !load()) {
    box(getWindow, {
      type: 'info',
      buttons: ['OK'],
      title: 'Updates',
      message: 'Automatic updates aren’t available in this build.',
      detail: 'Install a released version from configuremyai.com/download to get in-app updates.',
    })
    return
  }
  wire(getWindow)
  interactive = true
  runCheck()
}

module.exports = { initAutoUpdates, checkForUpdates }
