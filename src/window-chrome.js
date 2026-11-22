// The colours of the window's own chrome — the band behind the Windows /
// Linux caption buttons (the Window Controls Overlay) and the window's
// background, which shows while a page loads or a resize catches up. Pure,
// so it is unit-testable without Electron (test/window-chrome.test.js), the
// same split url-policy.js and web-refresh.js make.
//
// The page paints the 40px strip itself; inside the app shell that strip is
// one piece with the page, each column running to the window's top edge
// (desktop.css in the Rails app). The OS paints the band behind its own
// buttons, so it has to be told the colour that is there — and the window
// background should be the page's, not white, or a dark window flashes white
// on every load. Two sources, in order:
//
//   1. the page, once it has painted: cmaiDesktop.setChromeColors({
//      background, symbol }) (lib/desktop_chrome.js in the Rails app works
//      out what is under the buttons) — validated here, it is input;
//   2. until then, the defaults for the OS theme: the Rails app's main
//      column on its light / dark theme (--shell-main-bg), and its ink.

const DEFAULTS = Object.freeze({
  light: Object.freeze({ background: '#fcfcfc', symbol: '#231d1b' }),
  dark: Object.freeze({ background: '#1c1c1c', symbol: '#ffffff' }),
})

function defaultColors (dark) {
  return { ...(dark ? DEFAULTS.dark : DEFAULTS.light) }
}

// "#rrggbb" only. Anything else from the page — a named colour, a function,
// an alpha channel, a string with something appended — is refused rather
// than passed to the OS.
const HEX = /^#[0-9a-f]{6}$/i

function validColor (value) {
  return typeof value === 'string' && HEX.test(value) ? value.toLowerCase() : null
}

// The page's ask, made safe: null when the background is unusable; a
// missing or unusable symbol colour falls back to the one that reads on that
// background.
function colorsFromPage (input) {
  if (!input || typeof input !== 'object') return null
  const background = validColor(input.background)
  if (!background) return null
  return { background, symbol: validColor(input.symbol) || symbolFor(background) }
}

// Dark ink on a light band, light ink on a dark one (relative luminance).
function symbolFor (background) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(background.slice(i, i + 2), 16) / 255)
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  return luminance > 0.4 ? DEFAULTS.light.symbol : DEFAULTS.dark.symbol
}

// What BrowserWindow#setTitleBarOverlay takes.
function overlayOptions (colors, height) {
  return { color: colors.background, symbolColor: colors.symbol, height }
}

module.exports = { DEFAULTS, defaultColors, validColor, colorsFromPage, symbolFor, overlayOptions }
