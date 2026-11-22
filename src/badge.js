'use strict'

// The dock / taskbar unread badge the web app asks for (bot alerts that
// arrived while the window was hidden; the site's bot_alerts_controller calls
// window.cmaiDesktop.setBadge(n), see src/preload.js). Pure, so it is
// unit-testable (test/badge.test.js), the same split window-chrome.js makes.

const MAX_BADGE = 9999

// Any input → a whole number in 0..MAX_BADGE (NaN, negatives and junk → 0).
function badgeCount (input) {
  const n = Math.trunc(Number(input))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(n, MAX_BADGE)
}

// Set the count on the app (macOS dock, Linux Unity launchers). On Windows
// app.setBadgeCount is a no-op; the window's taskbar flash covers attention.
function applyBadge (app, input) {
  const count = badgeCount(input)
  if (app && typeof app.setBadgeCount === 'function') app.setBadgeCount(count)
  return count
}

module.exports = { MAX_BADGE, badgeCount, applyBadge }
