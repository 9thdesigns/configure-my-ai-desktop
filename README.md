# Configure My AI for macOS

The desktop app for [configuremyai.com](https://configuremyai.com) — a thin
[Electron](https://www.electronjs.org/) shell around the web app, distributed
as a direct-download DMG from the site's `/download` page rather than the Mac
App Store. Same model as the Claude, Slack and Grok Bot desktop apps: the
bundled Chromium renders the site, and every feature shipped server-side lands
here with no app release.

## What the shell does (and doesn't)

**Does:** windowing with remembered bounds, a real macOS menu bar with
Back/Forward/Home, keeps OAuth provider pages (Google, GitHub, Apple,
Microsoft, Facebook, LinkedIn, X, Slack) inside the app window while sending
every other foreign link to the default browser, shows a retry page offline,
and auto-updates from GitHub Releases when builds are signed.

**Doesn't:** carry any product logic. It never sends the `Turbo Native` user
agent marker, so the Rails app serves it the full desktop UI, not the phone
chrome (see `app/helpers/mobile_helper.rb` in the main repo). The site's
native bridge no-ops here by design.

## Development

```sh
npm install
npm start          # runs against https://configuremyai.com
npm run check      # parse-checks the main-process files
npm run pack       # unpacked .app in dist/ (no DMG), for local poking
npm run dist       # local DMGs in dist/
```

Requires Node 22+. Local builds are ad-hoc signed: they run on your own
machine, but anyone else downloading one must right-click → Open to get past
Gatekeeper (or `xattr -dr com.apple.quarantine "/Applications/Configure My AI.app"`).

## Releasing

Push a tag and CI does the rest:

```sh
git tag v0.1.0
git push origin v0.1.0
```

`.github/workflows/release.yml` builds Apple Silicon and Intel DMGs (plus the
zips electron-updater applies) on a macOS runner and publishes them to a
GitHub Release. The site's download page links to the **latest** release's
assets at stable names, so publishing a release is shipping:

```
https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-arm64.dmg
https://github.com/9thdesigns/configure-my-ai-desktop/releases/latest/download/ConfigureMyAI-x64.dmg
```

Renaming `artifactName` in `electron-builder.yml` breaks those URLs — the
Rails `/download` page must change in the same breath.

### Signing and notarization

Without secrets, releases build **unsigned** (ad-hoc): fine for testing, but
downloaders hit Gatekeeper warnings. For real distribution, add these
repository secrets — the workflow picks them up automatically:

| Secret | What it is |
| --- | --- |
| `CSC_LINK` | base64 of your **Developer ID Application** certificate (.p12) |
| `CSC_KEY_PASSWORD` | password for that .p12 |
| `APPLE_ID` | Apple ID email used for notarization |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID ([appleid.apple.com](https://appleid.apple.com)) |
| `APPLE_TEAM_ID` | your 10-character team ID |

All five need a paid Apple Developer account ($99/yr). With them set, the DMG
is Developer ID signed and notarized — users double-click and it just opens —
and auto-update starts working (macOS only applies signed updates).

## Layout

```
src/main.js          app entry: window, navigation policy, updater
src/menu.js          macOS menu bar
src/window-state.js  remembered window bounds
src/preload.js       deliberately empty — see the comment inside
src/offline.html     the retry page when the network is gone
electron-builder.yml packaging, artifact names, publish target
build/               icon + hardened-runtime entitlements
scripts/make-icon.py regenerates build/icon.png from the brand palette
```
