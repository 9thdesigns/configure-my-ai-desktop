# Design note: letting Manager use the mouse and keyboard

Status: **proposal only. Nothing here is built.** This is t511u (c). It records
the options, their costs and risks, and the gating a build would need, so a
later decision can start from it.

The goal: Dave asks "do X on my screen", and Manager clicks and types on
his computer to do it, in apps that have no API. Screen capture (#54) and
scoped file tools (#55, #57) already cover "see" and "read and write files".
This note covers "act".

## 1. How input can be injected

Electron itself can't do this. `webContents.sendInputEvent` only reaches our
own windows, and `robotjs`-style control of other apps needs OS-level APIs.
The options:

| Option | What it is | Platforms | Cost and risk |
|---|---|---|---|
| **nut.js** (`@nut-tree/nut-js` + `libnut`) | Maintained Node native module for mouse, keyboard and screen | macOS, Windows, X11 | Native addon: rebuilt for **every Electron major** (we're on Electron 44 and bump often) and per platform and arch (mac arm64/x64, win x64, linux x64). Prebuilt binaries have moved behind the project's sponsor registry, so check the licence and terms before depending on it. No Wayland. |
| **robotjs** | The original Node module | macOS, Windows, X11 | Effectively unmaintained, with frequent breakage on new Node and Electron ABIs. **Not recommended.** |
| **A small helper per platform (recommended)** | A tiny signed binary we ship and spawn as a child process, speaking JSON lines over stdin/stdout. macOS: Swift with `CGEvent`. Windows: C# or C++ with `SendInput`. | macOS, Windows | **No Node ABI coupling**: it doesn't need rebuilding for Electron bumps, only when the helper changes. About 200–400 lines each. It must be code-signed and notarised with the app (afterPack already signs). macOS Accessibility permission attaches to the app bundle that contains the helper. |
| **xdotool** (spawned) | Existing CLI | X11 only | Only if installed. It doesn't work on Wayland sessions, including Omarchy/Hyprland, which is our Linux target. |
| **ydotool** / `/dev/uinput` | Kernel-level virtual input device | Wayland and X11 | Needs write access to `/dev/uinput` (root, a udev rule, or a daemon). It injects into **any** session, with no compositor consent. **Not acceptable** for a consumer app. |
| **RemoteDesktop portal** (`org.freedesktop.portal.RemoteDesktop`, with libei) | The compositor-sanctioned way on Wayland | GNOME, KDE; others vary | The user approves each session in a system dialog, which is good. Support differs by compositor. The Hyprland portal's RemoteDesktop support is limited or absent at the time of writing, so check before promising Omarchy. Needs D-Bus plumbing (a helper, or a pure-JS D-Bus client). |

**Recommendation:** if this is built, build the **per-platform helper binaries**
for macOS and Windows first. Linux:

- **X11:** spawn `xdotool` when present.
- **Wayland:** RemoteDesktop portal where the compositor supports it.
- **Otherwise:** "not available on this desktop", as Share screen already does
  for Wayland.

Avoid Node native modules: the per-Electron rebuild cost is exactly what
`electron-updater`-driven fast bumps make painful.

## 2. macOS: the Accessibility permission

Posting synthetic events (`CGEventPost`) needs **Accessibility** (Privacy &
Security → Accessibility). Screen Recording, which #54 already asks for, is a
separate permission.

- **Check:** `systemPreferences.isTrustedAccessibilityClient(false)`.
- **Prompt:** `isTrustedAccessibilityClient(true)` shows the system prompt
  once. After that, macOS shows nothing, and we must deep-link:
  `x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility`.
- **Relaunch:** the grant applies to the signed bundle. A re-signed or
  differently signed build loses it. Quitting and reopening is usually needed
  after granting, so say so.
- **Flow:** reuse the screen-share pattern. Show our one-line explainer
  first ("Let Manager use your mouse and keyboard when you ask: you'll approve
  each task, and Esc stops it"), then the system prompt. On denial, show an
  inline "Open System Settings" button. Never prompt at launch, only on the
  first task that needs it.
- **Secure input:** while a password field has focus, macOS turns on Secure
  Event Input (`IsSecureEventInputEnabled()`), and synthetic typing should
  **stop**. The helper must check it before every `type` action and refuse.

Windows has no equivalent permission. UIPI blocks input into elevated
(admin) windows from a non-elevated app, so report that as an error; never
offer to elevate.

## 3. Gating: how it stays safe

Input control is the most dangerous tool in the set: it can click "Delete",
"Send" or "Pay". The design keeps every part of the local-tools model (#40,
#55) and adds more.

**Per-task approval, never standing.** A new `input_session` tool call shows
the local-tools card (its own window by the island, never a server-fed
surface). The card shows:

- the **task in words** ("Fill the expense form in Safari with the receipt
  totals")
- the **target**: one app (bundle id / exe name) and one display
- a **time limit** (default 2 minutes, at most 10)
- an **action budget** (default 100 actions)

The only choices are **Start** and **Deny**. There is no "Always", ever.

**Scoped to the session.** Each action carries the session id. The helper:

- refuses actions once the session has ended or run out of time or budget;
- refuses actions while the frontmost app isn't the approved one, so Manager
  can't switch to Mail and send;
- refuses typing while Secure Input is on;
- refuses key combos on a deny-list (log out, force quit, ⌘⌥⎋, Ctrl+Alt+Del,
  and app-quit shortcuts), unless the task named them.

**Always visible, always stoppable:**

- the island shows a red **"Manager is using your mouse · Esc to stop"** chip,
  with a Stop button, for the whole session;
- **Esc** is registered as a `globalShortcut` only while a session runs, and
  ends it at once;
- **moving the mouse yourself** ends it: after each move the helper notes
  where it put the cursor, and a real cursor position that differs means the
  user took over;
- quitting, sleep, screen lock or fast user switching ends it.

**See, then act.** Each step is screenshot → model decides → action, with the
screenshot going through #54's capture and indicator. That makes the action
loop slow (seconds per step) on purpose, and every step is visible.

**Audited.** Every action is recorded in the existing audit log: type,
coordinates, key names, and characters typed as a count, never the text. The
session's start and end are recorded with the reason.

**Off by default.** A separate "Let Manager use your mouse and keyboard"
switch lives in the Computer menu and Local Computer Access, next to "Let
Manager see your screen". It's off by default, and off means `input_session`
is refused before any card.

## 4. Proposed tool contract (for t512u, if built)

The same transport as `docs/local-tools.md`.

```
input_session  { task, app, display?, max_seconds?, max_actions? }
  → card (Start / Deny) → { session_id, expires_at } | denied | timeout
input_actions  { session_id, actions: [
                   { type: 'move',   x, y } |
                   { type: 'click',  x, y, button?: 'left'|'right', count?: 1|2 } |
                   { type: 'type',   text } |               // ≤ 500 chars per action
                   { type: 'key',    key, modifiers?: [...] } |
                   { type: 'scroll', dx, dy } ] }           // ≤ 20 actions per call
  → { status: 'ok', done: n } | { status: 'stopped', reason: 'esc'|'user_moved'|'timeout'|'budget'|'wrong_app'|'secure_input' }
input_end      { session_id }
```

Coordinates are in the approved display's points, matching the screenshots
Manager sees.

## 5. What it would take

| Piece | Rough size |
|---|---|
| macOS helper (Swift, CGEvent, secure-input check, frontmost-app check) and signing in afterPack | 2–3 days |
| Windows helper (SendInput, foreground-window check, UIPI errors) and signing | 2 days |
| Linux: xdotool path; portal path where supported | 1 day (X11); portal 2–4 days, compositor-dependent |
| Session broker, card, island chip, Esc and user-moved stop, audit, switch, tests | 2–3 days |
| Web: `desktop` tool actions and the screenshot loop (t512u) | separate |

**Not recommended now.** The value is real, but so is the blast radius. Ship
it only after the screen and file tools have been used for a while, and with
the per-task gating above, not a weaker version of it.
