const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// <html data-desktop-fullscreen> tells the site's top bar the macOS traffic
// lights are gone (full screen), so it stops keeping room for them. The
// preload runs sandboxed and cannot be required here, so it runs in a bare
// context with just enough of Electron and the DOM stubbed in.

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8')

function runPreload (info) {
  const handlers = {}
  const root = { dataset: {}, appendChild () {} }
  const context = {
    require: () => ({
      contextBridge: { exposeInMainWorld () {} },
      ipcRenderer: { sendSync: () => info, on: (channel, fn) => { handlers[channel] = fn }, invoke () {} },
    }),
    location: { protocol: 'https:', hostname: 'example.test' },
    window: { addEventListener () {} },
    document: {
      readyState: 'complete',
      documentElement: root,
      head: null,
      body: null,
      getElementById: () => null,
      createElement: () => ({}),
      addEventListener () {},
    },
  }
  vm.runInNewContext(source, context)
  return { root, send: (on) => handlers['cfa:fullscreen'](null, on), handlers }
}

const chromeless = { chromeless: true, titleBarHeight: 40, captions: 'left' }

test('a window opened full screen is stamped from the start', () => {
  assert.equal(runPreload({ ...chromeless, fullscreen: true }).root.dataset.desktopFullscreen, '1')
  assert.ok(!('desktopFullscreen' in runPreload({ ...chromeless, fullscreen: false }).root.dataset))
})

test('entering and leaving full screen stamps and clears <html>', () => {
  const page = runPreload(chromeless)
  assert.ok(!('desktopFullscreen' in page.root.dataset))
  page.send(true)
  assert.equal(page.root.dataset.desktopFullscreen, '1')
  page.send(false)
  assert.ok(!('desktopFullscreen' in page.root.dataset))
  assert.equal(page.root.dataset.desktopCaptions, 'left', 'the caption side is left alone')
})

test('a window with its own frame is never stamped', () => {
  const page = runPreload({ chromeless: false, fullscreen: true })
  assert.ok(!('desktopFullscreen' in page.root.dataset))
  assert.equal(page.handlers['cfa:fullscreen'], undefined)
})
