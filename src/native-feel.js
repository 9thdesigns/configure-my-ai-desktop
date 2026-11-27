// The small things that make a web page in a window feel like an app:
//
//   * No accidental pinch zoom. A trackpad pinch (or ctrl+wheel on some
//     setups) zooms the page visually and leaves it stuck half-zoomed; the
//     View menu's Zoom In / Out / Actual Size stay the way to zoom.
//   * A native right-click menu in text fields: Cut / Copy / Paste / Select
//     All, plus the spellchecker's suggestions and "Add to Dictionary"
//     (Chromium's spellcheck is already on, webPreferences.spellcheck, but
//     without a menu its suggestions are unreachable). Selected text outside a
//     field gets Copy. Everywhere else, nothing: a web page's own Back /
//     Reload / Inspect menu has no place in an app.
//   * No rubber-band overscroll. Electron leaves macOS elastic scrolling off
//     unless webPreferences.scrollBounce is set, and main never sets it; the
//     site adds `overscroll-behavior: none` under body.is-desktop-app for the
//     page root and nested scrollers. So nothing is needed here — this note is
//     where that is written down, and test/native-feel.test.js pins that main
//     keeps it so.
//
// Installed once from main (installNativeFeel) and applied to every window as
// it is created — the app window, the widget windows and OAuth popups alike —
// so the files that build those windows don't each need to know.
//
// The menu template is built by a pure function (contextMenuTemplate) so the
// rules are unit-tested without Electron.

// Electron's context-menu params → a Menu template, or null for no menu.
// `actions` carries the two things a role can't do: swap the misspelled word
// for a suggestion, and teach the dictionary a word.
function contextMenuTemplate (params, actions = {}) {
  if (!params) return null
  const flags = params.editFlags || {}
  const selection = typeof params.selectionText === 'string' ? params.selectionText.trim() : ''

  if (!params.isEditable) {
    if (!selection) return null
    return [{ role: 'copy', enabled: flags.canCopy !== false }]
  }

  const template = []
  const word = typeof params.misspelledWord === 'string' ? params.misspelledWord : ''
  if (word) {
    const suggestions = Array.isArray(params.dictionarySuggestions)
      ? params.dictionarySuggestions.filter((s) => typeof s === 'string' && s).slice(0, 5)
      : []
    if (suggestions.length) {
      for (const suggestion of suggestions) {
        template.push({ label: suggestion, click: () => actions.replaceMisspelling?.(suggestion) })
      }
    } else {
      template.push({ label: 'No Guesses Found', enabled: false })
    }
    template.push({ type: 'separator' })
    template.push({ label: 'Add to Dictionary', click: () => actions.addToDictionary?.(word) })
    template.push({ type: 'separator' })
  }

  template.push(
    { role: 'undo', enabled: flags.canUndo !== false },
    { role: 'redo', enabled: flags.canRedo !== false },
    { type: 'separator' },
    { role: 'cut', enabled: Boolean(flags.canCut) },
    { role: 'copy', enabled: Boolean(flags.canCopy) },
    { role: 'paste', enabled: Boolean(flags.canPaste) },
    { type: 'separator' },
    { role: 'selectAll', enabled: flags.canSelectAll !== false },
  )
  return template
}

// Visual (pinch) zoom pinned at 1×. Chromium can reset the limit when a new
// document commits, so it is re-applied on each load.
function lockVisualZoom (contents) {
  const apply = () => {
    if (contents.isDestroyed()) return
    try {
      const pending = contents.setVisualZoomLevelLimits(1, 1)
      if (pending && typeof pending.catch === 'function') pending.catch(() => {})
    } catch {}
  }
  apply()
  contents.on('did-finish-load', apply)
}

function attachContextMenu (contents, { Menu, BrowserWindow }) {
  contents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate(params, {
      replaceMisspelling: (s) => contents.replaceMisspelling(s),
      addToDictionary: (w) => contents.session.addWordToSpellCheckerDictionary(w),
    })
    if (!template) return
    const window = BrowserWindow.fromWebContents(contents) || undefined
    Menu.buildFromTemplate(template).popup({ window })
  })
}

// Every top-level window's contents, as it is created. Only 'window'
// contents — not <webview>s or background pages.
function installNativeFeel (app, electron = require('electron')) {
  app.on('web-contents-created', (_event, contents) => {
    if (typeof contents.getType === 'function' && contents.getType() !== 'window') return
    lockVisualZoom(contents)
    attachContextMenu(contents, electron)
  })
}

module.exports = { contextMenuTemplate, lockVisualZoom, installNativeFeel }
