# Configure My AI for Mac

Configure My AI in its own window — your configurations, bots, and chats one
Dock click away, on macOS.

This is the desktop app for **[configuremyai.com](https://configuremyai.com)**.
It's a native window around the web app (same idea as the Claude, Slack, and
Grok Bot desktop apps), so everything your account already does is here, and
new features arrive the moment they ship — no app update to wait for.

## Download

Get the latest version straight from the website, or grab a `.dmg` directly:

- **[Download for Apple Silicon](https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-arm64.dmg)** — M1/M2/M3/M4 Macs
- **[Download for Intel](https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-x64.dmg)** — older Macs
- Or visit **[configuremyai.com/download](https://configuremyai.com/download)**

Not sure which? Apple menu → **About This Mac**. A chip that starts with
“Apple” is Apple Silicon; “Intel” is Intel. Every version lives on the
[releases page](https://github.com/9thdesigns/configure-my-ai-desktop/releases).

**Requirements:** macOS 11 (Big Sur) or later.

## Install

1. Open the downloaded `.dmg`.
2. Drag **Configure My AI** onto the **Applications** folder.
3. Launch it from Applications or Spotlight, and sign in — your account,
   configurations, and chats are already there.

**First launch:** if macOS blocks the app the first time you open it, open
**System Settings → Privacy & Security**, find the note about “Configure My AI,”
and click **Open Anyway** — you only do this once. If it says the app is
“damaged,” run this in **Terminal**, then open it normally:

```sh
xattr -dr com.apple.quarantine "/Applications/Configure My AI.app"
```

*(These steps go away once the app is notarized by Apple.)*

## What you get

- **Its own window and Dock icon** — `⌘Tab` to your AI instead of hunting for a browser tab.
- **A real macOS menu bar** with Back / Forward / Home and standard shortcuts.
- **Sign-in that works**, including Google, GitHub, Apple, Microsoft, Facebook, LinkedIn, X, and Slack — those open inside the app; every other link opens in your normal browser.
- **Always current** — the app updates itself, and because the product lives on the server, every website feature is here instantly.
- **Offline-aware** — a friendly retry screen when the network drops.

Nothing new to trust: it's configuremyai.com in a dedicated window — same
sign-in, same security.

---

## For developers

The app is a thin [Electron](https://www.electronjs.org/) shell. It carries no
product logic and never sends the `Turbo Native` user-agent marker, so the
server renders it the full desktop UI rather than the mobile layout.

### Run it locally

```sh
npm install
npm start          # runs against https://configuremyai.com
npm run check      # parse-checks the main-process files
npm run pack       # unpacked .app in dist/ (no DMG), for local poking
npm run dist       # local DMGs in dist/
```

Requires Node 22+.

### Release

Tagging is shipping. Push a `v*` tag (or run the **Release** workflow manually
from the Actions tab):

```sh
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` builds Apple Silicon and Intel DMGs (plus the
zips `electron-updater` applies) on a macOS runner and publishes them to a
GitHub Release. The download links above point at the **latest** release's
assets at stable names, so a new release goes live with no website change.
Renaming `artifactName` in `electron-builder.yml` breaks those URLs — the
site's `/download` page must change in the same breath.

### Signing & notarization

With no secrets set, releases build **unsigned** (ad-hoc): they run, but
downloaders hit a one-time Gatekeeper prompt (see *First launch* above). For a
friction-free double-click, add these repository secrets (Settings → Secrets
and variables → Actions) — the workflow picks them up automatically and the
next release is Developer ID signed and notarized:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of your **Developer ID Application** certificate (`.p12`) |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID ([appleid.apple.com](https://appleid.apple.com)) |
| `APPLE_TEAM_ID` | your 10-character Team ID |

All five need a paid Apple Developer account. With them set, the DMG is signed
and notarized — users double-click and it just opens — and auto-update begins
working (macOS only applies signed updates).

### Project layout

```
src/main.js           app entry: window, navigation policy, auto-update
src/menu.js           macOS menu bar
src/window-state.js   remembered window bounds
src/preload.js        deliberately empty — see the comment inside
src/offline.html      the retry page shown when the network is gone
electron-builder.yml  packaging, artifact names, publish target
build/afterPack.js    ad-hoc signs unsigned builds so macOS will launch them
build/                app icon + hardened-runtime entitlements
scripts/make-icon.py  regenerates build/icon.png from the brand palette
```

## License

© 9th Designs. All rights reserved.
