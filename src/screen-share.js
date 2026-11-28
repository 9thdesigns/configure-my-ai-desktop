'use strict'

// "Let Manager see your screen": a screenshot of the user's display, taken
// only when the user asks for one in the widget's chat (the composer's Share
// screen button, or a message that asks about the screen), attached to that
// one chat turn so the bot can read it. Never in the background, never on a
// timer, never at a bot's request (a bot that wants a screenshot uses the
// local tools' take_screenshot, which asks the user on its own card).
//
// Pure: the OS permission check, the capture, the indicator and the clock
// are injected, so test/screen-share.test.js runs under plain node. The
// Electron wiring (desktopCapturer, systemPreferences, shell) is in main.
//
// The flow for one request:
//   1. refused unless it is an explicit user request (EXPLICIT_REASONS) and
//      the "Let Manager see your screen" switch is on;
//   2. the OS permission, per platform (permissionState):
//        granted        → capture
//        not-determined → macOS only: our one-line explainer first, then the
//                         capture itself raises the system prompt; checked
//                         again afterwards
//        denied/restricted → refused, with the System Settings link
//   3. the indicator is shown for the whole capture (and a moment after, so
//      it is seen), then the image is shrunk and held in memory, in main, for
//      the next message to that bot. Nothing is written to disk.

const SCREEN_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

const LIMITS = Object.freeze({
  maxWidth: 1920,
  maxBytes: 5 * 1024 * 1024,
  jpegQuality: 70,
  previewWidth: 240,
  // A held screenshot the user never sent is dropped after this.
  heldMs: 5 * 60 * 1000,
  // The indicator stays up at least this long, so a fast capture is still seen.
  indicatorMinMs: 1500,
})

// Why a capture may start: the user pressed Share screen, or sent a message
// asking about their screen. Anything else (a bot, a timer, an unknown
// caller) is refused before the OS is even asked.
const EXPLICIT_REASONS = Object.freeze(['button', 'message'])

const PERMISSION = Object.freeze({
  GRANTED: 'granted',
  DENIED: 'denied',
  NOT_DETERMINED: 'not-determined',
  RESTRICTED: 'restricted',
})

// What the user sees for each outcome that isn't a screenshot. The renderer
// shows `message` as text and offers `settingsUrl` as a button main opens.
const MESSAGES = Object.freeze({
  disabled: 'Turn on “Let Manager see your screen” to share your screen.',
  not_requested: 'Screen sharing only happens when you ask for it.',
  explainer_declined: 'Okay, nothing was captured.',
  permission_denied: 'Configure My AI doesn’t have Screen Recording permission. Turn it on in System Settings → Privacy & Security → Screen Recording, then reopen the app.',
  wayland_unavailable: 'Your desktop didn’t share the screen. On Wayland, pick a screen in the system’s sharing dialog, or check that xdg-desktop-portal is installed.',
  capture_failed: 'Couldn’t capture your screen. Try again.',
  too_large: 'That screenshot is too large to send.',
  attachment_too_large: 'That screenshot was too large for the server. Your message wasn’t sent — try again without it.',
  attachment_invalid: 'The server couldn’t read that screenshot. Your message wasn’t sent — try again without it.',
  busy: 'Already capturing your screen.',
})

const EXPLAINER = Object.freeze({
  message: 'Let Manager see your screen?',
  detail: 'macOS will ask for Screen Recording permission. Configure My AI only captures your screen when you ask, and sends it to your chat — nothing is saved on this computer.',
})

function isWayland (env = {}) {
  return String(env.XDG_SESSION_TYPE || '').toLowerCase() === 'wayland' || Boolean(env.WAYLAND_DISPLAY)
}

// The OS permission for screen capture, normalised to the four PERMISSION
// values. Only macOS gates it behind a user permission; Windows lets any app
// capture, and on Linux X11 the same. Wayland has no up-front permission:
// the portal asks on each capture, so it counts as granted here and a
// refusal there shows up as an empty capture.
function permissionState ({ platform = process.platform, getMediaAccessStatus } = {}) {
  if (platform !== 'darwin') return PERMISSION.GRANTED
  let status
  try { status = typeof getMediaAccessStatus === 'function' ? getMediaAccessStatus('screen') : 'unknown' } catch { status = 'unknown' }
  if (status === 'granted') return PERMISSION.GRANTED
  if (status === 'denied') return PERMISSION.DENIED
  if (status === 'restricted') return PERMISSION.RESTRICTED
  // 'not-determined', and 'unknown' (an older macOS): the capture asks.
  return PERMISSION.NOT_DETERMINED
}

// What to do next for a permission state: capture, explain-then-capture, or
// refuse with the settings link.
function permissionAction (state) {
  if (state === PERMISSION.GRANTED) return 'capture'
  if (state === PERMISSION.NOT_DETERMINED) return 'explain'
  return 'refuse'
}

// The server's refusal of an attachment (widget-chat.js attachmentError),
// in the same shape as a capture refusal, for the composer.
function serverRefusal (code) {
  return refusal(code === 'attachment_too_large' ? 'attachment_too_large' : 'attachment_invalid')
}

function refusal (code, extra = {}) {
  return { status: 'refused', code, message: MESSAGES[code] || MESSAGES.capture_failed, ...extra }
}

// Shrink a NativeImage-like ({ getSize, resize, toPNG, toJPEG, isEmpty }) to
// at most maxWidth wide, PNG unless that is over the byte cap, then JPEG.
function encodeImage (image, { maxWidth = LIMITS.maxWidth, maxBytes = LIMITS.maxBytes, jpegQuality = LIMITS.jpegQuality } = {}) {
  if (!image || (typeof image.isEmpty === 'function' && image.isEmpty())) return null
  let img = image
  const size = img.getSize?.() || {}
  if (size.width > maxWidth && typeof img.resize === 'function') {
    img = img.resize({ width: maxWidth, quality: 'good' })
  }
  let mime = 'image/png'
  let data = img.toPNG()
  if (data.length > maxBytes && typeof img.toJPEG === 'function') {
    mime = 'image/jpeg'
    data = img.toJPEG(jpegQuality)
  }
  if (!data || data.length === 0) return null
  const out = img.getSize?.() || size
  return { mime, data, width: Math.round(out.width) || 0, height: Math.round(out.height) || 0, tooLarge: data.length > maxBytes }
}

// The attachment for the chat turn, in the shape the server takes on
// POST /desktop/widget/bots/:id/messages (see widget-chat.js). Only a held
// screenshot goes in; the base64 is made here, in main, at send time.
function attachmentPayload (held) {
  if (!held || !Buffer.isBuffer(held.data) || !held.data.length) return null
  if (held.mime !== 'image/png' && held.mime !== 'image/jpeg') return null
  if (held.data.length > LIMITS.maxBytes) return null
  return {
    kind: 'screenshot',
    mime: held.mime,
    data_base64: held.data.toString('base64'),
    width: Math.max(0, Math.trunc(held.width) || 0),
    height: Math.max(0, Math.trunc(held.height) || 0),
    source: held.source === 'window' ? 'window' : 'display',
    captured_at: new Date(held.capturedAt).toISOString(),
  }
}

// Does a message ask about the user's screen? Deliberately narrow: it has to
// name the screen (or "this error" / "what I'm looking at"), so an ordinary
// message never triggers a capture. Only consulted when the switch is on.
const SCREEN_PHRASES = [
  /\b(on|at|in) my (screen|display|monitor)\b/i,
  /\b(look|see|check|read)\b.{0,20}\bmy (screen|display)\b/i,
  /\bwhat('?s| is) (this|that) (error|warning|message|dialog|popup|pop-up)\b/i,
  /\bwhat('?s| is| am i) (on|looking at)\b.{0,10}\b(screen|here)\b/i,
  /\bscreenshot\b/i,
  /\bshare (my )?screen\b/i,
]

function asksAboutScreen (text) {
  if (typeof text !== 'string' || !text.trim()) return false
  return SCREEN_PHRASES.some((re) => re.test(text))
}

// The indicator: show() when a capture starts, hide() when it ends, with a
// minimum on-screen time. `onChange(on)` drives the island chip and the
// widget's line. Overlapping captures keep it up until the last ends.
function createIndicator ({ onChange = () => {}, minMs = LIMITS.indicatorMinMs, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let active = 0
  let shownAt = 0
  let timer = null
  let on = false
  const set = (next) => {
    if (next === on) return
    on = next
    onChange(on)
  }
  return {
    show () {
      active++
      if (timer) { clearTimer(timer); timer = null }
      if (!on) shownAt = now()
      set(true)
    },
    hide () {
      if (active === 0) return
      active--
      if (active > 0) return
      const left = minMs - (now() - shownAt)
      if (left <= 0) return set(false)
      timer = setTimer(() => { timer = null; if (active === 0) set(false) }, left)
    },
    get on () { return on },
  }
}

// One screen share broker per app. deps:
//   isEnabled()              — the "Let Manager see your screen" switch
//   platform, env
//   getMediaAccessStatus(t)  — systemPreferences.getMediaAccessStatus
//   explain()                — macOS first-time explainer; resolves true/false
//   capture({ maxWidth })    — resolves a NativeImage-like, or null
//   indicator                — createIndicator()
//   now()
function createScreenShare ({ isEnabled = () => false, platform = process.platform, env = process.env, getMediaAccessStatus, explain = async () => false, capture, indicator = createIndicator(), now = Date.now } = {}) {
  const held = new Map() // botId → { mime, data, width, height, source, capturedAt }
  let busy = false

  function sweep () {
    const t = now()
    for (const [id, h] of held) if (t - h.capturedAt > LIMITS.heldMs) held.delete(id)
  }

  async function request ({ reason, botId } = {}) {
    if (!EXPLICIT_REASONS.includes(reason)) return refusal('not_requested')
    if (typeof botId !== 'string' || !botId) return refusal('not_requested')
    if (!isEnabled()) return refusal('disabled')
    if (busy) return refusal('busy')
    busy = true
    try {
      let state = permissionState({ platform, getMediaAccessStatus })
      const action = permissionAction(state)
      if (action === 'refuse') return refusal('permission_denied', { settingsUrl: SCREEN_SETTINGS_URL })
      if (action === 'explain') {
        const ok = await Promise.resolve().then(explain).catch(() => false)
        if (!ok) return refusal('explainer_declined')
      }

      indicator.show()
      let image = null
      try {
        image = typeof capture === 'function' ? await capture({ maxWidth: LIMITS.maxWidth }) : null
      } catch {
        image = null
      } finally {
        indicator.hide()
      }

      // The macOS prompt was raised by that capture: what did the user say?
      if (action === 'explain') {
        state = permissionState({ platform, getMediaAccessStatus })
        if (state === PERMISSION.DENIED || state === PERMISSION.RESTRICTED) return refusal('permission_denied', { settingsUrl: SCREEN_SETTINGS_URL })
      }
      const encoded = encodeImage(image)
      if (!encoded) {
        if (platform === 'linux' && isWayland(env)) return refusal('wayland_unavailable')
        if (platform === 'darwin') return refusal('permission_denied', { settingsUrl: SCREEN_SETTINGS_URL })
        return refusal('capture_failed')
      }
      if (encoded.tooLarge) return refusal('too_large')

      sweep()
      const entry = { mime: encoded.mime, data: encoded.data, width: encoded.width, height: encoded.height, source: 'display', capturedAt: now() }
      held.set(botId, entry)
      return { status: 'ok', botId, mime: entry.mime, width: entry.width, height: entry.height, preview: previewOf(image) }
    } finally {
      busy = false
    }
  }

  // A small data: URL for the composer's chip — the renderer never gets the
  // full image.
  function previewOf (image) {
    try {
      const small = image.resize({ width: LIMITS.previewWidth, quality: 'good' })
      return `data:image/jpeg;base64,${small.toJPEG(60).toString('base64')}`
    } catch {
      return null
    }
  }

  return {
    request,
    // The held screenshot for this bot's next message, removed as it is taken.
    take (botId) {
      sweep()
      const h = held.get(botId)
      held.delete(botId)
      return h || null
    },
    // The held screenshot, left in place (it goes once the send succeeds).
    peek (botId) { sweep(); return held.get(botId) || null },
    has (botId) { sweep(); return held.has(botId) },
    discard (botId) { return botId == null ? (held.clear(), true) : held.delete(botId) },
    get busy () { return busy },
  }
}

// The one switch, as a native menu checkbox (app menu, tray, the manager's
// seat menu in the dock), kept in step with the pref from anywhere.
const SHARE_MENU_ID = 'share-screen'
const SHARE_MENU_LABEL = 'Let Manager See Your Screen'

function shareScreenMenuItem (prefs) {
  return {
    id: SHARE_MENU_ID,
    label: SHARE_MENU_LABEL,
    type: 'checkbox',
    checked: Boolean(prefs.get().shareScreen),
    // Electron flips the item before click: item.checked is the user's ask.
    click: (item) => prefs.set({ shareScreen: typeof item?.checked === 'boolean' ? item.checked : !prefs.get().shareScreen }),
  }
}

function syncShareScreenMenuItem (menu, prefs) {
  const apply = (p) => {
    const item = menu && typeof menu.getMenuItemById === 'function' ? menu.getMenuItemById(SHARE_MENU_ID) : null
    if (item) item.checked = Boolean(p.shareScreen)
  }
  apply(prefs.get())
  return prefs.onChange(apply)
}

module.exports = {
  SCREEN_SETTINGS_URL,
  SHARE_MENU_ID,
  SHARE_MENU_LABEL,
  shareScreenMenuItem,
  syncShareScreenMenuItem,
  LIMITS,
  EXPLICIT_REASONS,
  PERMISSION,
  MESSAGES,
  EXPLAINER,
  isWayland,
  permissionState,
  permissionAction,
  encodeImage,
  attachmentPayload,
  serverRefusal,
  asksAboutScreen,
  createIndicator,
  createScreenShare,
}
