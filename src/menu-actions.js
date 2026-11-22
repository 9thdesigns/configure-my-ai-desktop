// What the menu's Back and Home do. Pure (no Electron) so it's unit-testable
// (test/menu-actions.test.js), the same split window-chrome.js makes.
//
// The web app owns navigation. Its Back follows the app's route map (a bot
// page goes back to Mission Control, a bot sub-page to that bot, never a
// loop), and moving between pages is a Turbo visit, not a full reload. So the
// menu asks the page first:
//
//   Back: click the page's own Back control (the desktop title-bar Back,
//         which follows the route map); fall back to window history only
//         when the page has none.
//   Home: a Turbo visit to the app's home path (no full reload, no white
//         flash); fall back to loading the URL when Turbo isn't on the page
//         (the offline page, an error page, a page still loading).
//
// Each script returns true when the page handled it, so the caller knows
// whether to fall back.

const PAGE_BACK_SELECTOR =
  '[data-controller~="desktop-history"] [data-desktop-history-target="back"], [data-nav-top-back]'

const PAGE_BACK_SCRIPT = `(() => {
  const el = document.querySelector(${JSON.stringify(PAGE_BACK_SELECTOR)});
  if (!el || el.hidden || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
  el.click();
  return true;
})()`

function homeVisitScript (homePath) {
  return `(() => {
  if (!window.Turbo || typeof window.Turbo.visit !== 'function') return false;
  window.Turbo.visit(${JSON.stringify(homePath)});
  return true;
})()`
}

// The in-app path for a home URL ("https://host/home?x" -> "/home?x"); a URL
// on another origin or one that doesn't parse can't be Turbo-visited.
function homePathFor (homeUrl, appUrl) {
  try {
    const home = new URL(homeUrl)
    const app = new URL(appUrl)
    if (home.origin !== app.origin) return null
    return `${home.pathname}${home.search}`
  } catch (_) {
    return null
  }
}

// Run `script` in the page; if it didn't handle the action (false, an error,
// or no page), run `fallback`. Returns the promise for tests.
function runInPage (contents, script, fallback) {
  if (!contents || typeof contents.executeJavaScript !== 'function') {
    fallback()
    return Promise.resolve(false)
  }
  return Promise.resolve()
    .then(() => contents.executeJavaScript(script, true))
    .then((handled) => {
      if (handled !== true) fallback()
      return handled === true
    })
    .catch(() => {
      fallback()
      return false
    })
}

function goBack (contents) {
  return runInPage(contents, PAGE_BACK_SCRIPT, () => {
    const history = contents?.navigationHistory
    if (history?.canGoBack()) history.goBack()
  })
}

function goHome (contents, homeUrl, appUrl) {
  const path = homePathFor(homeUrl, appUrl)
  const load = () => contents?.loadURL(homeUrl)
  if (!path) {
    load()
    return Promise.resolve(false)
  }
  return runInPage(contents, homeVisitScript(path), load)
}

module.exports = { PAGE_BACK_SELECTOR, PAGE_BACK_SCRIPT, homeVisitScript, homePathFor, runInPage, goBack, goHome }
