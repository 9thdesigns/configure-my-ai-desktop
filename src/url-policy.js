// Which URLs belong in the app window, which are OAuth hops that may open as
// popups, and which leave for the browser. Pure, so it can be unit-tested
// without Electron (test/url-policy.test.js).

const APP_HOST = 'configuremyai.com'
const APP_URL = `https://${APP_HOST}`

// The app opens on the walkthrough landing (/welcome), not the marketing
// home. Signed out, /welcome renders the desktop-only wizard — what Configure
// My AI does, plus Log in / Create account — with no marketing chrome (see
// the server's desktop_app? branch); already signed in, the server bounces
// /welcome straight into the app. Sign-in itself is email/password only in
// the app (no OAuth buttons, which a desktop webview can't complete), and
// marketing pages are never linked from these screens, so the app never
// surfaces them.
const START_URL = `${APP_URL}/welcome`

// Hosts that must complete INSIDE the app window: every OAuth provider the
// Rails app offers (see the omniauth-* gems in its Gemfile). Their round trip
// ends back on APP_HOST, so sending them to the system browser would strand
// the session in the wrong cookie jar. Everything else off-host opens in the
// user's default browser.
const AUTH_HOSTS = new Set([
  'accounts.google.com',
  'accounts.youtube.com',
  'github.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
  'facebook.com',
  'www.facebook.com',
  'm.facebook.com',
  'linkedin.com',
  'www.linkedin.com',
  'twitter.com',
  'x.com',
  'api.twitter.com',
  'api.x.com',
  'slack.com',
])

function parseUrl (value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isAppUrl (value) {
  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:') return false
  return url.hostname === APP_HOST || url.hostname.endsWith(`.${APP_HOST}`)
}

// A few AUTH_HOSTS are also ordinary destinations, not just OAuth waypoints —
// GitHub most of all: the app surfaces repo, PR and release links, and those
// need the user's BROWSER session (where they are signed in to GitHub), not
// this app's empty cookie jar, which 404s on anything private. So for these
// hosts only the real sign-in / OAuth endpoints stay in the app (to complete a
// provider-connect round trip); every other path is content and opens
// externally.
const AUTH_PATH_ONLY_HOSTS = new Set(['github.com'])

// GitHub's auth surface: the OAuth authorize / access-token endpoints (which
// live under /login/oauth) and the sign-in gate they bounce through.
// Everything else on github.com is content.
function isGithubAuthPath (pathname) {
  return /^\/(login|session)(\/|$)/.test(pathname)
}

function isAuthUrl (value) {
  const url = parseUrl(value)
  if (!url || url.protocol !== 'https:') return false
  if (!AUTH_HOSTS.has(url.hostname)) return false
  if (AUTH_PATH_ONLY_HOSTS.has(url.hostname)) return isGithubAuthPath(url.pathname)
  return true
}

module.exports = { APP_HOST, APP_URL, START_URL, AUTH_HOSTS, AUTH_PATH_ONLY_HOSTS, parseUrl, isAppUrl, isAuthUrl, isGithubAuthPath }
