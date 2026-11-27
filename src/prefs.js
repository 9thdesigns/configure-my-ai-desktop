'use strict'

// The shell's own preferences — the few switches that live in the tray menu
// rather than on the website. Hand-rolled like window-state.js: one JSON file
// in userData. Only known keys of the right type are read back, so a
// hand-edited or corrupt file falls back to the defaults, never to junk.
//
//   keepRunningInBackground — closing the main window leaves the app (and the
//                             menu bar item / widget) running. On by default
//                             on macOS, where that is the convention anyway;
//                             off elsewhere, where closing the last window has
//                             always quit.
//   showWidget              — the floating bot dock is shown.

const fs = require('node:fs')
const path = require('node:path')

function defaults (platform = process.platform) {
  return {
    keepRunningInBackground: platform === 'darwin',
    showWidget: true,
  }
}

function sanitize (input, platform) {
  const base = defaults(platform)
  if (!input || typeof input !== 'object') return base
  for (const key of Object.keys(base)) {
    if (typeof input[key] === typeof base[key]) base[key] = input[key]
  }
  return base
}

// A tiny store: get() returns a copy, set() merges known keys, persists, and
// tells subscribers. The file path is injected so tests need no Electron.
function createPrefs ({ file, platform = process.platform } = {}) {
  let current = defaults(platform)
  if (file) {
    try {
      current = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')), platform)
    } catch {
      // First run or unreadable — defaults.
    }
  }
  const listeners = new Set()

  return {
    get: () => ({ ...current }),
    set (patch) {
      const next = sanitize({ ...current, ...patch }, platform)
      const changed = Object.keys(next).some((k) => next[k] !== current[k])
      current = next
      if (!changed) return this.get()
      if (file) {
        try {
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, JSON.stringify(current))
        } catch {
          // A failed save costs the setting at next launch, nothing more.
        }
      }
      for (const fn of listeners) fn(this.get())
      return this.get()
    },
    onChange (fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
  }
}

module.exports = { defaults, sanitize, createPrefs }
