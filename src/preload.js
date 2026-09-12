// The renderer side of the shell.
//
// The site's native bridge (app/javascript/turbo/bridge.js in the main repo)
// no-ops when neither window.webkit nor the Android interface exists, which is
// exactly the situation here: the desktop app IS the web app, and needs no
// channel to itself. So nothing is exposed to the page — that is a statement,
// not an omission, and when the shell grows native features (a Dock badge
// count, global shortcuts) the contextBridge.exposeInMainWorld call lands
// here, behind contextIsolation.
//
// What this file does own is the window's drag strip, below.

const { ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('cfa:window-info')

// ---------------------------------------------------------------------------
// The drag strip
// ---------------------------------------------------------------------------
//
// The app window has no title bar — hiddenInset on macOS, a Window Controls
// Overlay on Windows — which leaves the OS nothing to drag it by. Only the
// page can say where the window may be dragged from, by marking an element
// `-webkit-app-region: drag`, and until now neither the shell nor the site
// marked anything at all: the window moved only where macOS happened to leave
// a sliver of its hidden title bar exposed, and not at all on Windows.
//
// So the shell draws the strip itself, on every page it shows — the site's
// screens, a provider's sign-in page during an OAuth round trip, the bundled
// offline page. It is transparent and exactly as tall as the room the site
// reserves at the top of the page (body.desktop-app in the Rails app), so it
// covers chrome rather than content, and it is re-attached as the last child
// of <body> after every navigation: a draggable region is resolved in paint
// order, so a strip that any overlay can stack on top of is a strip that
// stops working as soon as a modal opens.
//
// Windows that keep a native frame — the OAuth popups, and Linux — get none of
// this; `chromeless` is false there and the OS handles dragging itself.

const DRAG_STRIP_ID = 'cfa-desktop-drag-strip'
const DRAG_STYLE_ID = 'cfa-desktop-drag-style'

function dragStripCss (height) {
  return `
    #${DRAG_STRIP_ID} {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${height}px;
      z-index: 2147483647;
      background: transparent;
      -webkit-app-region: drag;
      -webkit-user-select: none;
      user-select: none;
    }

    /* The window controls are painted by the OS over the page, so nothing here
       has to leave room for them. Anything ever placed inside the strip stays
       clickable. */
    #${DRAG_STRIP_ID} * { -webkit-app-region: no-drag; }
  `
}

function installDragStrip (height) {
  let bodyObserver = null
  let lastPointerDown = 0

  const ensureStyle = () => {
    const root = document.head || document.documentElement
    if (!root || document.getElementById(DRAG_STYLE_ID)) return
    const style = document.createElement('style')
    style.id = DRAG_STYLE_ID
    style.textContent = dragStripCss(height)
    root.appendChild(style)
  }

  const ensureStrip = () => {
    const body = document.body
    if (!body) return
    const strip = document.getElementById(DRAG_STRIP_ID) || document.createElement('div')
    strip.id = DRAG_STRIP_ID
    strip.setAttribute('aria-hidden', 'true')

    // A page with no strip at all has nothing to interrupt: put it in.
    if (!strip.isConnected) {
      body.appendChild(strip)
      return
    }

    // Beyond that the strip wants to be the LAST child. Two elements that both
    // reach the top of the stack are separated by document order, so a strip
    // that stays put while the page appends over it is a strip that a toast or
    // a modal can eventually stack above. Re-appending something already last
    // is a no-op, which is also what keeps the observer below from looping.
    //
    // Except mid-drag: moving the element re-enters layout, and re-entering
    // layout under the cursor is how a drag already in flight gets cancelled.
    // A press anywhere buys a second of stillness — a timestamp rather than a
    // flag, so a press whose release the page never sees (the window server
    // swallows it once it takes over the drag) cannot wedge this off for good.
    if (Date.now() - lastPointerDown < 1000) return
    if (body.lastElementChild !== strip) body.appendChild(strip)
  }

  const ensure = () => {
    ensureStyle()
    ensureStrip()
    // <body> is a different element after a Turbo visit; the observer follows it.
    if (document.body && bodyObserver) {
      bodyObserver.disconnect()
      bodyObserver.observe(document.body, { childList: true })
    }
  }

  const start = () => {
    if (typeof MutationObserver === 'function') {
      bodyObserver = new MutationObserver(ensure)
      // A replaced <body> is a childList change on <html>.
      new MutationObserver(ensure).observe(document.documentElement, { childList: true })
    }
    ensure()
  }

  for (const event of ['pointerdown', 'mousedown']) {
    window.addEventListener(event, () => { lastPointerDown = Date.now() }, true)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true })
  } else {
    start()
  }

  // Belt and braces for what a MutationObserver does not see as a change: a
  // restored back/forward entry, and Turbo's own render events.
  for (const event of ['pageshow', 'turbo:load', 'turbo:render']) {
    window.addEventListener(event, ensure)
  }
}

if (info && info.chromeless) installDragStrip(info.titleBarHeight)
