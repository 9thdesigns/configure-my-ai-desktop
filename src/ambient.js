'use strict'

// The ambient state the floating windows (the dock, the island) dress for:
//
//   paused       — the screen is locked or the Mac is asleep
//                  (powerMonitor lock-screen / suspend, until unlock /
//                  resume): every looping animation (the dock's rim pulse,
//                  the badge's working dots, the island's recording dot, the
//                  faces) holds still. A window that is hidden or covered is
//                  paused by its page itself (document.visibilityState:
//                  Chromium reports an occluded window as hidden).
//   transparency — 'reduce' while the system asks for reduced transparency
//                  (nativeTheme.prefersReducedTransparency): the pages swap
//                  their see-through tints for solid colours.
//   motion       — 'reduce' while it asks for reduced motion
//                  (systemPreferences.getAnimationSettings()); the pages
//                  also follow the prefers-reduced-motion media query.
//
// Pure apart from the injected Electron modules (test/ambient.test.js);
// ambient-view.js applies it in the pages.

function createAmbient ({ powerMonitor = null, nativeTheme = null, systemPreferences = null, onChange = () => {} } = {}) {
  let locked = false
  let asleep = false

  const read = (fn, fallback) => { try { return fn() } catch { return fallback } }

  function state () {
    return {
      paused: locked || asleep,
      transparency: read(() => nativeTheme?.prefersReducedTransparency === true, false) ? 'reduce' : 'normal',
      motion: read(() => systemPreferences?.getAnimationSettings?.().prefersReducedMotion === true, false) ? 'reduce' : 'normal',
    }
  }

  let last = JSON.stringify(state())
  function changed () {
    const now = state()
    const key = JSON.stringify(now)
    if (key === last) return
    last = key
    onChange(now)
  }

  const handlers = {
    'lock-screen': () => { locked = true; changed() },
    'unlock-screen': () => { locked = false; changed() },
    suspend: () => { asleep = true; changed() },
    resume: () => { asleep = false; changed() },
  }
  for (const [event, fn] of Object.entries(handlers)) powerMonitor?.on?.(event, fn)
  const onTheme = () => changed()
  nativeTheme?.on?.('updated', onTheme)

  return {
    state,
    destroy () {
      for (const [event, fn] of Object.entries(handlers)) powerMonitor?.removeListener?.(event, fn)
      nativeTheme?.removeListener?.('updated', onTheme)
    },
  }
}

// What a page may be told: three known fields, nothing else.
function validAmbient (input) {
  if (!input || typeof input !== 'object') return null
  return {
    paused: input.paused === true,
    transparency: input.transparency === 'reduce' ? 'reduce' : 'normal',
    motion: input.motion === 'reduce' ? 'reduce' : 'normal',
  }
}

module.exports = { createAmbient, validAmbient }
