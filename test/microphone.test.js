const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

// Composer dictation (t447u). The page records the microphone and streams
// phrases to the Rails app's /dictation; everything the shell has to do is
// let that recording happen. Four pieces, each of which on its own makes
// getUserMedia fail with nothing on screen — so each is pinned here.

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')
const main = read('src/main.js')

test('the session grants the app page the microphone on both the check and the request', () => {
  assert.match(main, /setPermissionCheckHandler\(/)
  assert.match(main, /setPermissionRequestHandler\(/)
  assert.match(main, /new Set\(\[[^\]]*'media'[^\]]*\]\)/, "'media' is an allowed permission")
  assert.match(main, /if \(permission === 'media'\) return mediaIsAudio\(details\)/, 'the check answers audio')
  assert.match(main, /grantMicrophone\(callback\)/, 'the request goes through the OS grant')
  assert.match(main, /app\.whenReady\(\)\.then\(\(\) => \{\s*restrictPermissions\(\)/, 'installed before the window loads')
})

test('the camera is not part of the grant', () => {
  assert.match(main, /if \(!mediaIsAudio\(details\)\) \{\s*callback\(false\)/)
})

test('macOS asks for microphone access (TCC) before granting', () => {
  assert.match(main, /systemPreferences\.askForMediaAccess\('microphone'\)/)
  assert.match(main, /getMediaAccessStatus\('microphone'\) === 'granted'/)
})

test('the mac build carries the audio-input entitlement and a usage string', () => {
  const plist = read('build/entitlements.mac.plist')
  assert.match(plist, /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/)
  const builder = read('electron-builder.yml')
  assert.match(builder, /entitlements: build\/entitlements\.mac\.plist/)
  assert.match(builder, /entitlementsInherit: build\/entitlements\.mac\.plist/)
  assert.match(builder, /NSMicrophoneUsageDescription: \S.+/)
})

test('the page is told it runs in the desktop app, so it never picks the dead Web Speech engine', () => {
  assert.match(main, /ConfigureMyAI-Desktop\//)
})
