// The macOS menu bar. Standard roles everywhere they exist; the few custom
// items are navigation (a web app in a window still deserves Back/Forward)
// and Help links into the site itself.

const { Menu, shell } = require('electron')

const RELEASES_URL = 'https://github.com/9thdesigns/configure-my-ai-desktop/releases'

function installMenu ({ appUrl, startUrl, getWindow }) {
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
          click: () => contents()?.loadURL(homeUrl),
        },
        {
          label: 'Back',
          accelerator: 'CmdOrCtrl+[',
          click: () => {
            const wc = contents()
            if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
          },
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
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
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
