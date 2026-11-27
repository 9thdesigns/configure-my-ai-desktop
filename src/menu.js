// The macOS menu bar. Standard roles everywhere they exist; the few custom
// items are navigation (a web app in a window still deserves Back/Forward)
// and Help links into the site itself.

const { Menu, shell } = require('electron')
const { goBack, goHome } = require('./menu-actions')

const RELEASES_URL = 'https://github.com/9thdesigns/configure-my-ai-desktop/releases'

function installMenu ({ appUrl, startUrl, getWindow, onCheckForUpdates, localAccess }) {
  const contents = () => getWindow()?.webContents
  // Home goes to the app's entry point (the sign-in screen, which Devise
  // bounces to the app when already signed in) rather than the marketing root.
  const homeUrl = startUrl || appUrl

  const template = [
    { role: 'appMenu' },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        {
          label: 'Home',
          accelerator: 'Shift+CmdOrCtrl+H',
          // A Turbo visit in the page (no reload); a URL load only as a fallback.
          click: () => goHome(contents(), homeUrl, appUrl),
        },
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          // The page's own Back (it follows the app's route map); window
          // history only when the page has none. See menu-actions.js.
          click: () => goBack(contents()),
        },
        {
          label: 'Forward',
          accelerator: 'CmdOrCtrl+]',
          click: () => {
            const wc = contents()
            if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
          },
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    ...(localAccess
      ? [{
          // Bots asking to use this computer (src/local-tools-main.js).
          label: 'Computer',
          submenu: [
            {
              label: 'Allow Bots to Ask to Use This Computer',
              type: 'checkbox',
              checked: localAccess.isEnabled(),
              click: (item) => localAccess.setEnabled(item.checked),
            },
            { label: 'Local Computer Access…', click: () => localAccess.openSettings() },
          ],
        }]
      : []),
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        {
          label: 'Check for Updates…',
          // Guarded: if main didn't wire an updater (older host), the item is
          // simply inert rather than throwing.
          click: () => { if (typeof onCheckForUpdates === 'function') onCheckForUpdates() },
        },
        { type: 'separator' },
        { label: 'How It Works', click: () => shell.openExternal(`${appUrl}/about`) },
        { label: 'Features', click: () => shell.openExternal(`${appUrl}/features`) },
        { type: 'separator' },
        { label: 'Release Notes', click: () => shell.openExternal(RELEASES_URL) },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

module.exports = { installMenu }
