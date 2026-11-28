'use strict'

// Haptic feedback on a Force Touch trackpad (macOS): a tick when the pointer
// enters something you can grab or click (a seat in the dock, the island,
// its grabber), a firmer one for a click, an open, a drop on a snap point or
// a flip to the other edge, and the level-change tick when the island's
// centre magnet catches.
//
// How: one long-lived helper, /usr/bin/osascript running a FIXED JavaScript
// for Automation script that reads one word per line on stdin and calls
// NSHapticFeedbackManager.defaultPerformer. Main only ever writes one of
// three fixed words (PATTERNS) — never anything from a renderer, a bot or
// the server — so nothing can be interpolated into the script or its input.
// No native module.
//
//   * macOS only; a no-op elsewhere (and silently nothing on a Mac without a
//     Force Touch trackpad: the performer does nothing there).
//   * At most one tick per THROTTLE_MS, whatever asks.
//   * Hover never buzzes: one tick per element on entering it, then none
//     for that element until the pointer has been off it for HOVER_REST_MS.
//   * The "Haptic Feedback" switch (prefs.hapticsEnabled, on by default;
//     tray and app menu), and off while the system asks for reduced motion
//     (systemPreferences.getAnimationSettings().prefersReducedMotion). The
//     system's own trackpad feedback settings apply on top: the performer
//     honours them.
//   * The helper is spawned on the first tick, restarted if it exits (at
//     most MAX_RESTARTS a minute), and killed when the app quits.
//
// Pure apart from the injected spawn: test/haptics.test.js.

const OSASCRIPT = '/usr/bin/osascript'
const THROTTLE_MS = 300
const HOVER_REST_MS = 500
const MAX_RESTARTS = 3
const RESTART_WINDOW_MS = 60_000

// The words main may write, and the NSHapticFeedbackPattern each means:
// Generic 0, Alignment 1, LevelChange 2.
const PATTERNS = Object.freeze({ alignment: 1, generic: 0, level: 2 })

// What happened → which pattern. Anything else is ignored.
const EVENTS = Object.freeze({
  hover: 'alignment', // entering a seat, the island, the grabber
  click: 'generic',
  expand: 'generic',
  drop: 'generic', // let go on a snap point
  flip: 'generic', // carried over to the other edge
  snap: 'level', // the centre magnet caught it
})

// The helper's script, fixed. Performance time 1 = NSHapticFeedbackPerformanceTimeNow.
const HELPER_SCRIPT = [
  "ObjC.import('AppKit')",
  "ObjC.import('Foundation')",
  'const performer = $.NSHapticFeedbackManager.defaultPerformer',
  'const input = $.NSFileHandle.fileHandleWithStandardInput',
  `const PATTERNS = ${JSON.stringify(PATTERNS)}`,
  "let buffer = ''",
  'for (;;) {',
  '  const data = input.availableData',
  '  if (!data || data.length === 0) break',
  '  buffer += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js',
  '  let i',
  "  while ((i = buffer.indexOf('\\n')) >= 0) {",
  '    const word = buffer.slice(0, i).trim()',
  '    buffer = buffer.slice(i + 1)',
  '    if (Object.prototype.hasOwnProperty.call(PATTERNS, word)) performer.performFeedbackPatternPerformanceTime(PATTERNS[word], 1)',
  '  }',
  '}',
].join('\n')

const HELPER_ARGS = Object.freeze(['-l', 'JavaScript', '-e', HELPER_SCRIPT])

// An element's name, from the pages: short, plain.
const validElement = (e) => (typeof e === 'string' && /^[a-z][a-z0-9:-]{0,63}$/i.test(e) ? e : null)

// deps:
//   platform
//   enabled()        — prefs.hapticsEnabled
//   reducedMotion()  — the system asks for reduced motion
//   spawn(cmd, args, opts) — child_process.spawn
//   now()
function createHaptics ({ platform = process.platform, enabled = () => true, reducedMotion = () => false, spawn = null, now = Date.now } = {}) {
  let helper = null
  let lastTick = -Infinity
  let restarts = []
  let stopped = false
  // element → { inside, leftAt }
  const hovers = new Map()

  const available = () => platform === 'darwin' && typeof spawn === 'function' && !stopped

  function ensureHelper () {
    if (helper) return helper
    const t = now()
    restarts = restarts.filter((r) => t - r < RESTART_WINDOW_MS)
    if (restarts.length >= MAX_RESTARTS) return null
    restarts.push(t)
    let child
    try {
      child = spawn(OSASCRIPT, HELPER_ARGS, { stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      return null
    }
    if (!child || !child.stdin) return null
    helper = child
    child.on?.('exit', () => { if (helper === child) helper = null })
    child.on?.('error', () => { if (helper === child) helper = null })
    child.stdin.on?.('error', () => {})
    return helper
  }

  function write (pattern) {
    const child = ensureHelper()
    if (!child) return false
    try {
      child.stdin.write(`${pattern}\n`)
      return true
    } catch {
      return false
    }
  }

  // What happened (EVENTS), and for a hover the element entered. → the
  // pattern played, or null.
  function play (event, element = null) {
    const pattern = EVENTS[event]
    if (!pattern || !available() || !enabled() || reducedMotion()) return null
    const t = now()
    if (event === 'hover') {
      const id = validElement(element)
      if (!id) return null
      const h = hovers.get(id)
      if (h && (h.inside || t - h.leftAt < HOVER_REST_MS)) {
        hovers.set(id, { inside: true, leftAt: h.leftAt })
        return null
      }
      hovers.set(id, { inside: true, leftAt: -Infinity })
    }
    if (t - lastTick < THROTTLE_MS) return null
    if (!write(pattern)) return null
    lastTick = t
    return pattern
  }

  // The pointer left an element: its next hover ticks once it has stayed
  // off for HOVER_REST_MS.
  function leave (element) {
    const id = validElement(element)
    if (!id) return
    hovers.set(id, { inside: false, leftAt: now() })
  }

  function shutdown () {
    stopped = true
    const child = helper
    helper = null
    if (!child) return
    try { child.stdin.end() } catch {}
    try { child.kill() } catch {}
  }

  return { play, leave, shutdown, get running () { return Boolean(helper) } }
}

// The "Haptic Feedback" checkbox (tray and app menu), wired to the pref.
const HAPTICS_MENU_ID = 'haptics'
function hapticsMenuItem (prefs) {
  return {
    id: HAPTICS_MENU_ID,
    label: 'Haptic Feedback',
    type: 'checkbox',
    checked: prefs.get().hapticsEnabled !== false,
    click: (item) => prefs.set({ hapticsEnabled: typeof item?.checked === 'boolean' ? item.checked : prefs.get().hapticsEnabled === false }),
  }
}
function syncHapticsMenuItem (menu, prefs) {
  const apply = (p) => {
    const item = menu && typeof menu.getMenuItemById === 'function' ? menu.getMenuItemById(HAPTICS_MENU_ID) : null
    if (item) item.checked = p.hapticsEnabled !== false
  }
  apply(prefs.get())
  return prefs.onChange(apply)
}

module.exports = {
  OSASCRIPT,
  THROTTLE_MS,
  HOVER_REST_MS,
  MAX_RESTARTS,
  PATTERNS,
  EVENTS,
  HELPER_SCRIPT,
  HELPER_ARGS,
  validElement,
  createHaptics,
  HAPTICS_MENU_ID,
  hapticsMenuItem,
  syncHapticsMenuItem,
}
