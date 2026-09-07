# Configure My AI for Desktop

Configure My AI in its own window — your configurations, bots, and chats one
click away, on **macOS and Windows**.

This is the desktop app for **[configuremyai.com](https://configuremyai.com)**.
It's a native window around the web app (same idea as the Claude, Slack, and
Grok Bot desktop apps), so everything your account already does is here, and
new features arrive the moment they ship — no app update to wait for.

## Download

Get the latest version straight from the website, or grab an installer
directly:

**macOS**
- **[Apple Silicon](https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-arm64.dmg)** — M1/M2/M3/M4 Macs
- **[Intel](https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-x64.dmg)** — older Macs

**Windows**
- **[Windows x64](https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-win-x64.exe)** — most PCs
- **[Windows ARM64](https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-win-arm64.exe)** — Arm-based PCs

Or visit **[configuremyai.com/downloads](https://configuremyai.com/downloads)**.
Every version lives on the
[releases page](https://github.com/9thdesigns/configure-my-ai-desktop/releases).

On macOS, not sure which? Apple menu → **About This Mac**; a chip that starts
with “Apple” is Apple Silicon, “Intel” is Intel.

**Requirements:** macOS 11 (Big Sur) or later; Windows 10 or later.

## Install

**macOS**

1. Open the downloaded `.dmg`.
2. Drag **Configure My AI** onto the **Applications** folder.
3. Launch it from Applications or Spotlight, and sign in — your account,
   configurations, and chats are already there.

First launch: if macOS blocks the app, open **System Settings → Privacy &
Security**, find the note about “Configure My AI,” and click **Open Anyway** —
once only. If it says the app is “damaged,” run this in **Terminal**, then open
it normally:

```sh
xattr -dr com.apple.quarantine "/Applications/Configure My AI.app"
```

*(This goes away once the app is notarized by Apple.)*

**Windows**

1. Run the downloaded `.exe`. It's a per-user install — no admin prompt.
2. Launch **Configure My AI** from the Start menu or the desktop shortcut, and
   sign in.

First launch: if the installer isn't code-signed yet, Windows SmartScreen may
warn. Click **More info → Run anyway** — once only. *(This goes away once the
installer is signed.)*

## What you get

- **Its own window and icon** — one keystroke to your AI instead of hunting for a browser tab.
- **A chromeless, native window** with working window controls and a real menu bar (Back / Forward / Home and standard shortcuts).
- **Sign-in that works**, including Google, GitHub, Apple, Microsoft, Facebook, LinkedIn, X, and Slack — those open inside the app; every other link opens in your normal browser.
- **Always current** — the app updates itself with an in-app “Restart Now” prompt, and because the product lives on the server, every website feature is here instantly.
- **Offline-aware** — a friendly retry screen when the network drops.

Nothing new to trust: it's configuremyai.com in a dedicated window — same
sign-in, same security.

---

## For developers

The app is a thin [Electron](https://www.electronjs.org/) shell. It carries no
product logic and never sends the `Turbo Native` user-agent marker, so the
server renders it the full desktop UI rather than the mobile layout. The same
`src/` runs on both platforms; the few OS differences (window chrome,
quit-on-close) are branched inline in `src/main.js`.

### Run it locally

```sh
npm install
npm start           # runs against https://configuremyai.com
npm run check       # parse-checks the main-process files
npm run pack        # unpacked .app in dist/ (macOS), for local poking
npm run pack:win    # unpacked app in dist/ (Windows)
npm run dist        # local DMGs in dist/
npm run dist:win    # local Windows installers in dist/
```

Requires Node 22+. Windows installers must be built on Windows; macOS DMGs on
macOS.

### Release

Tagging is shipping. Push a `v*` tag (or run the **Release** workflow manually
from the Actions tab):

```sh
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` pre-creates the GitHub Release, then builds in
parallel: Apple Silicon + Intel DMGs (plus the zips `electron-updater` applies)
on a macOS runner, and x64 + ARM64 NSIS installers on a Windows runner. Both
publish into the one release. The download links above point at the **latest**
release's assets at stable names, so a new release goes live with no website
change. Renaming an `artifactName` in `electron-builder.yml` breaks those URLs
— the site's `/downloads` page must change in the same breath.

### Signing & notarization

With no secrets set, releases build **unsigned** on both platforms: they run,
but users hit a one-time Gatekeeper (macOS) or SmartScreen (Windows) prompt.
For a friction-free launch, add repository secrets (Settings → Secrets and
variables → Actions) — the workflow picks them up automatically.

macOS (all five needed, and a paid Apple Developer account):

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of your **Developer ID Application** certificate (`.p12`) |
| `CSC_KEY_PASSWORD` | password for that `.p12` |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID ([appleid.apple.com](https://appleid.apple.com)) |
| `APPLE_TEAM_ID` | your 10-character Team ID |

Windows (optional, independent of Apple — an Authenticode cert from a CA):

| Secret | What it is |
| --- | --- |
| `WIN_CSC_LINK` | base64 of your Authenticode code-signing certificate (`.pfx`) |
| `WIN_CSC_KEY_PASSWORD` | password for that `.pfx` |

With the platform's secrets set, that platform's build is signed — users just
open it — and auto-update works (each OS only applies signed updates). The
Windows job never receives the Apple `CSC_LINK`, so the macOS certificate is
never mistaken for a Windows one.

### Project layout

```
src/main.js           app entry: window, navigation policy, auto-update
src/updater.js        in-app auto-update + "Restart Now" modal
src/menu.js           the application menu bar
src/window-state.js   remembered window bounds
src/preload.js        deliberately empty — see the comment inside
src/offline.html      the retry page shown when the network is gone
electron-builder.yml  packaging, artifact names (macOS + Windows), publish target
build/afterPack.js    ad-hoc signs unsigned macOS builds so they'll launch
build/                app icon + hardened-runtime entitlements
scripts/make-icon.py  regenerates build/icon.png from the brand palette
```

## License

© 9th Designs. All rights reserved.
