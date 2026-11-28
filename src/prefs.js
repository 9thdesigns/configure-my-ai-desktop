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
//   showIsland              — the status pill at the top of the screen is
//                             shown.
//   shareScreen             — "Let Manager see your screen": the widget's
//                             Share screen may capture the display when the
//                             user asks (screen-share.js). Off by default.
//   widgetPositions         — where the user dragged the dock, per display:
//                             [{ id, bounds, pos }], newest first
//                             (widget-placement.js validates them).
//   islandEdge              — where the island is attached: { displayId,
//                             displayBounds, edge: 'top' | 'bottom', offsetX
//                             0..1 } (island-placement.js), or null (top
//                             centre). Migrated once from the old per-display
//                             islandPositions, which is then dropped.

const fs = require('node:fs')
const path = require('node:path')
const { validEntries, validWidgetPos, validIslandPos } = require('./widget-placement')
const { validIslandEdge, migrateIslandPositions } = require('./island-placement')

// Keys whose values are structures, each with its own validator; the rest
// are plain values checked by type.
const STRUCTURED = {
  widgetPositions: (v) => validEntries(v, validWidgetPos),
  islandEdge: (v) => validIslandEdge(v),
}

function defaults (platform = process.platform) {
  return {
    keepRunningInBackground: platform === 'darwin',
    showWidget: true,
    showIsland: true,
    shareScreen: false,
    widgetPositions: [],
    islandEdge: null,
  }
}

function sanitize (input, platform) {
  const base = defaults(platform)
  if (!input || typeof input !== 'object') return base
  for (const key of Object.keys(base)) {
    if (STRUCTURED[key]) base[key] = STRUCTURED[key](input[key])
    else if (typeof input[key] === typeof base[key]) base[key] = input[key]
  }
  // The island's old per-display memory, read once into islandEdge; it is
  // not a key any more, so the next save drops it.
  if (!base.islandEdge && input.islandPositions !== undefined) {
    base.islandEdge = migrateIslandPositions(validEntries(input.islandPositions, validIslandPos))
  }
  return base
}

const same = (a, b) => a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b))

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
    get: () => JSON.parse(JSON.stringify(current)),
    set (patch) {
      const next = sanitize({ ...current, ...patch }, platform)
      const changed = Object.keys(next).some((k) => !same(next[k], current[k]))
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
