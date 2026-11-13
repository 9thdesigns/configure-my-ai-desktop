// What a WEB-DEPLOY refresh may touch, and who may ask for one. Pure, so the
// policy is unit-testable without Electron (test/web-refresh.test.js) — the
// same split url-policy.js makes.
//
// Background: the Rails app's lib/app_version.js notices a web deploy and
// asks the shell to get the open window onto it. A plain reload is not always
// enough — Chromium's HTTP cache can resurrect the old release's document or
// assets — so the shell clears the caches first. But ONLY the caches:
//
//   * serviceworkers / cachestorage — the two stores that can serve a stale
//     release even past the HTTP cache. The Rails app registers no service
//     worker today; clearing covers the day it does.
//   * NEVER localstorage, indexdb or cookies. Composer drafts live in the
//     first two (lib/composer_drafts.js in the main repo) and the remember-me
//     session in the third — wiping any of them turns "refresh onto the new
//     release" into "sign in again and retype your message", the exact
//     failure this feature exists to end.
//
// The HTTP cache itself is cleared separately (session.clearCache()), which
// has no storage knob to get wrong.

const { isAppUrl } = require('./url-policy')

const WEB_REFRESH_STORAGES = Object.freeze(['serviceworkers', 'cachestorage'])

function webRefreshClearOptions () {
  return { storages: [...WEB_REFRESH_STORAGES] }
}

// Who may invoke the refresh and relaunch IPC: frames on our own origin,
// nothing else — the same gate the updater IPC keeps (cfa:update-* in
// main.js). An OAuth provider's page runs the same preload mid-round-trip
// and gets neither the bridge (preload gates it) nor, should it forge the
// invoke, an answer (main checks the sender's frame URL through this).
function senderAllowed (frameUrl) {
  return Boolean(frameUrl && isAppUrl(frameUrl))
}

module.exports = { WEB_REFRESH_STORAGES, webRefreshClearOptions, senderAllowed }
