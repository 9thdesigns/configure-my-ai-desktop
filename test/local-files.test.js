// Scoped file tools (src/local-files.js) and their folder approvals
// (src/local-tools-approval.js), on real temp folders: scoping, `..` and
// symlink escapes, size caps, search, write / create / delete, Allow once vs
// Always for this folder, revoke, the confirm card on every change, and the
// whole path from a server tool call to a result.

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const F = require('../src/local-files')
const { ApprovalBroker, GrantStore, AuditLog, grantCovers, grantPrefixFor, grantToolFor } = require('../src/local-tools-approval')
const { validateToolCall, handleCall } = require('../src/local-tools-client')

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-lf-')))
const bot = { id: '42', name: 'Manager' }
let seq = 0
const call = (tool, args, b = bot) => ({ id: `c${++seq}`, tool, args, bot: b })

// A project folder, a secret beside it, and links pointing out.
function world () {
  const root = tmp()
  const proj = path.join(root, 'proj')
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'README.md'), '# Proj\nTODO: write docs\n')
  fs.writeFileSync(path.join(proj, 'src', 'app.js'), 'const x = 1 // TODO fix\n')
  fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret')
  fs.mkdirSync(path.join(root, 'proj-secrets'))
  fs.writeFileSync(path.join(root, 'proj-secrets', 'key'), 'k')
  fs.symlinkSync(path.join(root, 'secret.txt'), path.join(proj, 'link-out'))
  fs.symlinkSync(root, path.join(proj, 'dir-out'))
  return { root, proj }
}

// --- Scoping -----------------------------------------------------------------

test('reads inside the approved folder work; siblings with the same prefix do not', async () => {
  const { root, proj } = world()
  const ok = await F.readFile({ path: path.join(proj, 'README.md') }, { scope: proj })
  assert.equal(ok.status, 'ok')
  assert.match(ok.content, /TODO/)
  const sib = await F.readFile({ path: path.join(root, 'proj-secrets', 'key') }, { scope: proj })
  assert.deepEqual([sib.status, sib.error], ['refused', 'outside the approved folder'])
})

test('any `..` segment is refused, even one that resolves back inside', async () => {
  const { proj } = world()
  for (const p of [`${proj}/../secret.txt`, `${proj}/src/../README.md`, `${proj}/../proj/README.md`]) {
    const r = await F.readFile({ path: p }, { scope: proj })
    assert.equal(r.status, 'refused', p)
    assert.match(r.error, /“\.\.”/)
  }
  assert.equal(F.hasTraversal('/a/b/../c'), true)
  assert.equal(F.hasTraversal('C:\\a\\..\\b'), true)
  assert.equal(F.hasTraversal('/a/b..c/d'), false, 'two dots inside a name are fine')
})

test('a symlink inside the folder cannot reach outside it — read, list, write or delete', async () => {
  const { root, proj } = world()
  assert.equal((await F.readFile({ path: path.join(proj, 'link-out') }, { scope: proj })).status, 'refused')
  assert.equal((await F.listDir({ path: path.join(proj, 'dir-out') }, { scope: proj })).status, 'refused')
  assert.equal((await F.readFile({ path: path.join(proj, 'dir-out', 'secret.txt') }, { scope: proj })).status, 'refused')
  assert.equal((await F.writeFile({ path: path.join(proj, 'dir-out', 'planted.txt'), content: 'x' }, { scope: proj })).status, 'refused')
  assert.equal(fs.existsSync(path.join(root, 'planted.txt')), false)
  assert.equal((await F.writeFile({ path: path.join(proj, 'link-out'), content: 'x' }, { scope: proj })).status, 'refused')
  assert.equal((await F.deleteFile({ path: path.join(proj, 'link-out') }, { scope: proj })).status, 'refused')
  assert.equal(fs.readFileSync(path.join(root, 'secret.txt'), 'utf8'), 'top secret')
})

test('a link that stays inside the folder is not an escape, but writes never go through a link', async () => {
  const { proj } = world()
  fs.symlinkSync(path.join(proj, 'README.md'), path.join(proj, 'readme-link'))
  assert.equal((await F.readFile({ path: path.join(proj, 'readme-link') }, { scope: proj })).status, 'ok')
  const w = await F.writeFile({ path: path.join(proj, 'readme-link'), content: 'x' }, { scope: proj })
  assert.deepEqual([w.status, w.error], ['refused', 'the target is a symbolic link'])
})

test('the scope itself may be reached through a link (e.g. /tmp on macOS): real paths on both sides', async () => {
  const { root, proj } = world()
  const alias = path.join(root, 'alias')
  fs.symlinkSync(proj, alias)
  assert.equal((await F.readFile({ path: path.join(alias, 'README.md') }, { scope: alias })).status, 'ok')
  assert.equal((await F.readFile({ path: path.join(proj, 'README.md') }, { scope: alias })).status, 'ok')
})

test('relative paths and no scope are refused', async () => {
  const { proj } = world()
  assert.equal((await F.readFile({ path: 'README.md' }, { scope: proj })).status, 'error')
  assert.equal((await F.readFile({ path: path.join(proj, 'README.md') }, {})).status, 'refused')
  assert.equal((await F.readFile({ path: path.join(proj, 'README.md') }, { scope: path.join(proj, 'gone') })).error, 'the approved folder no longer exists')
})

// --- Size caps ------------------------------------------------------------------

test('reads are capped at 256 KB by default and at most 1 MB on request', async () => {
  const { proj } = world()
  const big = path.join(proj, 'big.txt')
  fs.writeFileSync(big, 'y'.repeat(2 * 1024 * 1024))
  const d = await F.readFile({ path: big }, { scope: proj })
  assert.deepEqual([d.content.length, d.truncated, d.size], [256 * 1024, true, 2 * 1024 * 1024])
  const m = await F.readFile({ path: big, max_bytes: 10 * 1024 * 1024 }, { scope: proj })
  assert.equal(m.content.length, 1024 * 1024, 'max_bytes is clamped to 1 MB')
  assert.equal((await F.readFile({ path: big, max_bytes: 10 }, { scope: proj })).content.length, 10)
  assert.equal((await F.readFile({ path: proj }, { scope: proj })).error, 'not a regular file')
})

test('writes over 1 MB are refused and nothing is written', async () => {
  const { proj } = world()
  const r = await F.writeFile({ path: path.join(proj, 'huge.txt'), content: 'z'.repeat(1024 * 1024 + 1) }, { scope: proj })
  assert.equal(r.status, 'error')
  assert.equal(fs.existsSync(path.join(proj, 'huge.txt')), false)
})

test('list_dir is capped at 1000 entries', async () => {
  const dir = tmp()
  for (let i = 0; i < 1005; i++) fs.writeFileSync(path.join(dir, `f${i}`), '')
  const r = await F.listDir({ path: dir }, { scope: dir })
  assert.deepEqual([r.entries.length, r.total, r.truncated], [1000, 1005, true])
})

// --- Search -------------------------------------------------------------------------

test('search finds lines and names, never follows links, skips node_modules and hidden folders', async () => {
  const { proj } = world()
  fs.mkdirSync(path.join(proj, 'node_modules', 'pkg'), { recursive: true })
  fs.writeFileSync(path.join(proj, 'node_modules', 'pkg', 'x.js'), 'TODO in a dependency')
  fs.mkdirSync(path.join(proj, '.git'))
  fs.writeFileSync(path.join(proj, '.git', 'HEAD'), 'TODO')
  fs.writeFileSync(path.join(proj, 'bin.dat'), Buffer.from([0, 1, 2, 84, 79, 68, 79]))
  const r = await F.searchFiles({ path: proj, query: 'todo' }, { scope: proj })
  assert.equal(r.status, 'ok')
  assert.deepEqual(r.results.map((x) => path.relative(proj, x.path)).sort(), ['README.md', path.join('src', 'app.js')])
  assert.deepEqual(r.results.find((x) => x.path.endsWith('README.md')).matches, [{ line: 2, text: 'TODO: write docs' }])
  const names = await F.searchFiles({ path: proj, glob: '*.js' }, { scope: proj })
  assert.deepEqual(names.results.map((x) => path.basename(x.path)), ['app.js'])
  assert.equal((await F.searchFiles({ path: proj }, { scope: proj })).status, 'error', 'needs a query or a glob')
  assert.equal((await F.searchFiles({ path: proj, glob: '../*' }, { scope: proj })).status, 'error')
  assert.equal((await F.searchFiles({ path: path.join(proj, 'dir-out'), query: 'secret' }, { scope: proj })).status, 'refused')
})

test('search stops at its result cap and says so', async () => {
  const dir = tmp()
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(dir, `n${i}.txt`), 'needle')
  const r = await F.searchFiles({ path: dir, query: 'needle', max_results: 5 }, { scope: dir })
  assert.deepEqual([r.results.length, r.truncated], [5, true])
})

// --- Write, create, delete -----------------------------------------------------------

test('write_file creates or replaces; create_file never replaces; delete_file removes files only', async () => {
  const { proj } = world()
  const notes = path.join(proj, 'notes.md')
  assert.deepEqual(await F.writeFile({ path: notes, content: 'one' }, { scope: proj }), { status: 'ok', path: notes, bytes: 3, created: true })
  assert.equal((await F.writeFile({ path: notes, content: 'two' }, { scope: proj })).created, false)
  assert.equal(fs.readFileSync(notes, 'utf8'), 'two')
  assert.deepEqual(fs.readdirSync(proj).filter((n) => n.includes('.tmp')), [], 'no temp files left behind')
  const c = await F.writeFile({ path: notes, content: 'three' }, { scope: proj, create: true })
  assert.deepEqual([c.status, c.error], ['error', 'a file with that name already exists'])
  assert.equal(fs.readFileSync(notes, 'utf8'), 'two')
  assert.equal((await F.writeFile({ path: path.join(proj, 'nope', 'x.md'), content: 'x' }, { scope: proj })).error, 'the folder does not exist')
  assert.equal((await F.deleteFile({ path: path.join(proj, 'src') }, { scope: proj })).error, 'only files can be deleted')
  assert.equal((await F.deleteFile({ path: notes }, { scope: proj })).status, 'ok')
  assert.equal(fs.existsSync(notes), false)
  assert.equal((await F.deleteFile({ path: notes }, { scope: proj })).error, 'not found')
})

// --- Folder approvals -------------------------------------------------------------------

function brokerWith (answers, dir = tmp()) {
  const cards = []
  const grants = new GrantStore(path.join(dir, 'grants.json'))
  const broker = new ApprovalBroker({ grants, prompt: async (card) => { cards.push(card); return answers.shift() || 'deny' } })
  return { broker, grants, cards }
}

test('first read in a folder asks: Allow once / Always for this folder', async () => {
  const { proj } = world()
  const { broker, cards } = brokerWith(['once'])
  const d = await broker.decide(call('read_file', { path: path.join(proj, 'README.md') }))
  assert.deepEqual([d.allow, d.via, d.scope], [true, 'once', proj])
  assert.equal(cards[0].folder, proj)
  assert.equal(cards[0].alwaysLabel, `the folder ${proj}`)
  assert.equal(cards[0].change, false)
})

test('Allow once covers only that call: the next read asks again', async () => {
  const { proj } = world()
  const { broker, cards, grants } = brokerWith(['once', 'once'])
  await broker.decide(call('read_file', { path: path.join(proj, 'README.md') }))
  await broker.decide(call('read_file', { path: path.join(proj, 'README.md') }))
  assert.equal(cards.length, 2)
  assert.equal(grants.list().length, 0)
})

test('Always for this folder: reads, lists and searches inside it stop asking; persisted as one folder grant', async () => {
  const { root, proj } = world()
  const dir = tmp()
  const { broker, cards, grants } = brokerWith(['always'], dir)
  const first = await broker.decide(call('list_dir', { path: proj }))
  assert.deepEqual([first.via, first.scope], ['always', proj])
  for (const [tool, args] of [['read_file', { path: path.join(proj, 'src', 'app.js') }], ['search_files', { path: path.join(proj, 'src'), query: 'x' }], ['list_dir', { path: path.join(proj, 'src') }]]) {
    const d = await broker.decide(call(tool, args))
    assert.deepEqual([d.allow, d.via, d.scope], [true, 'grant', proj], tool)
  }
  assert.equal(cards.length, 1)
  const saved = new GrantStore(path.join(dir, 'grants.json')).list()
  assert.deepEqual(saved.map((g) => [g.tool, g.prefix, g.botId]), [['folder', proj, '42']])
  // Not for another bot, not next door, not via `..`.
  const other = await broker.decide(call('read_file', { path: path.join(proj, 'README.md') }, { id: '7', name: 'Other' }))
  assert.equal(other.via, 'deny')
  assert.equal(grants.find(call('read_file', { path: path.join(root, 'proj-secrets', 'key') })), null)
  assert.equal((await broker.decide(call('read_file', { path: `${proj}/../secret.txt` }))).via, 'invalid')
})

test('revoking the folder grant brings the card back', async () => {
  const { proj } = world()
  const { broker, cards, grants } = brokerWith(['always', 'deny'])
  await broker.decide(call('read_file', { path: path.join(proj, 'README.md') }))
  const [g] = grants.list()
  assert.ok(grants.revoke(g.id))
  const d = await broker.decide(call('read_file', { path: path.join(proj, 'README.md') }))
  assert.deepEqual([d.allow, cards.length], [false, 2])
})

test('every change shows the confirm card — even inside an approved folder', async () => {
  const { proj } = world()
  const { broker, cards } = brokerWith(['always', 'once', 'once', 'once'])
  await broker.decide(call('list_dir', { path: proj })) // approve the folder
  for (const [tool, args] of [
    ['write_file', { path: path.join(proj, 'README.md'), content: '# New' }],
    ['create_file', { path: path.join(proj, 'new.md'), content: 'hello' }],
    ['delete_file', { path: path.join(proj, 'src', 'app.js') }],
  ]) {
    const d = await broker.decide(call(tool, args))
    assert.deepEqual([d.allow, d.via, d.scope], [true, 'once', proj], tool)
    const card = cards.at(-1)
    assert.equal(card.tool, tool)
    assert.equal(card.change, true)
    assert.equal(card.folderApproved, true)
    assert.equal(card.alwaysLabel, null, 'no standing approval for changes')
  }
  assert.equal(cards.length, 4)
  const [write, create, del] = cards.slice(1)
  assert.deepEqual([write.exists, write.bytes, write.preview], [true, 5, '# New'])
  assert.deepEqual([create.exists, create.bytes], [false, 5])
  assert.deepEqual([del.exists, del.bytes, del.preview], [true, 24, undefined])
})

test('a forged "always" on a change in an approved folder is a deny; denied changes never run', async () => {
  const { proj } = world()
  const { broker } = brokerWith(['always', 'always', 'deny'])
  await broker.decide(call('list_dir', { path: proj }))
  assert.equal((await broker.decide(call('write_file', { path: path.join(proj, 'x.md'), content: 'x' }))).allow, false)
  assert.equal((await broker.decide(call('delete_file', { path: path.join(proj, 'README.md') }))).allow, false)
})

test('a change outside any approved folder offers Always for this folder, which approves it and allows this change', async () => {
  const { proj } = world()
  const { broker, cards, grants } = brokerWith(['always'])
  const d = await broker.decide(call('create_file', { path: path.join(proj, 'a.md'), content: 'a' }))
  assert.deepEqual([d.allow, d.via, d.scope], [true, 'always', proj])
  assert.equal(cards[0].alwaysLabel, `the folder ${proj}`)
  assert.deepEqual(grants.list().map((g) => g.tool), ['folder'])
  // Reads now pass; the next change still asks.
  assert.equal((await broker.decide(call('read_file', { path: path.join(proj, 'a.md') }))).via, 'grant')
  assert.equal((await broker.decide(call('write_file', { path: path.join(proj, 'a.md'), content: 'b' }))).allow, false, 'asked again (and the stub said deny)')
  assert.equal(cards.length, 2)
})

test('grants from older versions (read_file / list_dir) keep covering those tools only', () => {
  const { proj } = world()
  const legacy = { tool: 'read_file', botId: '42', prefix: proj }
  assert.ok(grantCovers(legacy, call('read_file', { path: path.join(proj, 'README.md') })))
  assert.ok(!grantCovers(legacy, call('search_files', { path: proj, query: 'x' })))
  assert.ok(!grantCovers(legacy, call('write_file', { path: path.join(proj, 'x'), content: '' })))
  assert.equal(grantToolFor('search_files'), 'folder')
  assert.equal(grantToolFor('run_command'), 'run_command')
  assert.equal(grantPrefixFor('write_file', { path: path.join(proj, 'src', 'a.js') }), path.join(proj, 'src'))
  assert.equal(grantPrefixFor('search_files', { path: proj }), proj)
  assert.equal(grantPrefixFor('read_file', { path: 'relative.txt' }), null)
})

// --- End to end: a server tool call → card → scoped run → result ----------------------------

test('tool calls validate the new arguments and caps', () => {
  const ok = validateToolCall({ tool_call: { id: 't1', tool: 'write_file', args: { path: '/a/b.md', content: 'x', evil: 'y' }, bot: { id: '42' } } })
  assert.deepEqual(ok.args, { path: '/a/b.md', content: 'x' })
  const s = validateToolCall({ tool_call: { id: 't2', tool: 'search_files', args: { path: '/a', query: 'q', glob: '*.md', max_results: '20' }, bot: { id: '42' } } })
  assert.deepEqual(s.args, { path: '/a', query: 'q', glob: '*.md', max_results: 20 })
  assert.equal(validateToolCall({ tool_call: { id: 't3', tool: 'write_file', args: { path: '/a', content: 'z'.repeat(1024 * 1024 + 1) }, bot: { id: '42' } } }), null)
  assert.equal(validateToolCall({ tool_call: { id: 't4', tool: 'write_file', args: { path: '/a', content: 7 }, bot: { id: '42' } } }), null)
  assert.equal(validateToolCall({ tool_call: { id: 't5', tool: 'search_files', args: { path: '/a', query: 'q'.repeat(201) }, bot: { id: '42' } } }), null)
  assert.equal(validateToolCall({ tool_call: { id: 't6', tool: 'rm_rf', args: {}, bot: { id: '42' } } }), null)
})

test('handleCall: approve once, run inside the folder, audit, report — and a denied change reports denied', async () => {
  const { proj } = world()
  const dir = tmp()
  const posted = []
  const audit = new AuditLog(path.join(dir, 'audit.jsonl'))
  const { broker } = brokerWith(['once', 'deny'], dir)
  const target = path.join(proj, 'out.md')
  await handleCall({ ...call('create_file', { path: target, content: 'made by Manager' }) }, { broker, audit, postResult: async (id, p) => posted.push(p) })
  assert.equal(posted[0].status, 'ok')
  assert.equal(posted[0].approval, 'once')
  assert.equal(fs.readFileSync(target, 'utf8'), 'made by Manager')
  await handleCall({ ...call('delete_file', { path: target }) }, { broker, audit, postResult: async (id, p) => posted.push(p) })
  assert.equal(posted[1].status, 'denied')
  assert.ok(fs.existsSync(target), 'denied: the file is still there')
  const entries = audit.list()
  assert.deepEqual(entries.map((e) => [e.tool, e.decision, e.target]), [['delete_file', 'deny', target], ['create_file', 'allow', target]])
  assert.ok(!JSON.stringify(entries).includes('made by Manager'), 'file contents never go in the audit')
  // A `..` path never reaches the user and reports an error.
  await handleCall({ ...call('read_file', { path: `${proj}/../secret.txt` }) }, { broker, audit, postResult: async (id, p) => posted.push(p) })
  assert.equal(posted[2].status, 'error')
})

test('the docs describe the tool contract the web side relies on', () => {
  const doc = fs.readFileSync(path.join(__dirname, '../docs/local-tools.md'), 'utf8')
  for (const tool of ['list_dir', 'read_file', 'search_files', 'write_file', 'create_file', 'delete_file', 'run_command', 'take_screenshot']) assert.match(doc, new RegExp(`\`${tool}\``), tool)
  assert.match(require('../package.json').scripts.check, /node --check src\/local-files\.js/)
  for (const word of ['Always for this folder', 'Allow once', 'scope', '256 KB', '1 MB', 'denied', 'timeout', 'refused']) assert.match(doc, new RegExp(word), word)
})

// --- The check-then-use gap -------------------------------------------------------
//
// A wrapped fs that swaps things for symlinks at the worst moment: after the
// scope check, right before the open (or the rename).

function racing (hooks) {
  const fsp = require('node:fs/promises')
  const wrapped = Object.assign({}, fsp)
  for (const [name, hook] of Object.entries(hooks)) {
    let fired = false
    wrapped[name] = async (p, ...rest) => {
      if (!fired && hook.when(p)) { fired = true; hook.then(p) }
      return fsp[name](p, ...rest)
    }
  }
  return wrapped
}

function outside () {
  const { root, proj } = world()
  const away = path.join(root, 'away')
  fs.mkdirSync(away)
  fs.writeFileSync(path.join(away, 'victim.txt'), 'precious')
  return { root, proj, away, victim: path.join(away, 'victim.txt') }
}

test('race: create_file target swapped for a symlink before the open → refused, nothing written outside', async () => {
  const { proj, victim } = outside()
  const target = path.join(proj, 'new.md')
  const fsr = racing({ open: { when: (p) => p === target, then: () => fs.symlinkSync(victim, target) } })
  const r = await F.writeFile({ path: target, content: 'pwned' }, { scope: proj, create: true, fs: fsr })
  assert.deepEqual([r.status, r.error], ['refused', 'the target is a symbolic link'])
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious')
})

test('race: write_file folder swapped for a link to outside before the open → refused, temp removed, nothing left outside', async () => {
  const { root, proj, away } = outside()
  const sub = path.join(proj, 'sub')
  fs.mkdirSync(sub)
  const target = path.join(sub, 'a.md')
  const fsr = racing({ open: { when: (p) => p.startsWith(sub + path.sep), then: () => { fs.renameSync(sub, path.join(root, 'sub-moved')); fs.symlinkSync(away, sub) } } })
  const r = await F.writeFile({ path: target, content: 'pwned' }, { scope: proj, fs: fsr })
  assert.equal(r.status, 'refused')
  assert.match(r.error, /outside the approved folder/)
  assert.deepEqual(fs.readdirSync(away), ['victim.txt'], 'the temp file it opened out there is gone')
  assert.equal(fs.readFileSync(path.join(away, 'victim.txt'), 'utf8'), 'precious')
})

test('race: write_file target swapped for a symlink before the rename → the link is replaced, never followed', async () => {
  const { proj, victim } = outside()
  const target = path.join(proj, 'README.md')
  const fsr = racing({ rename: { when: () => true, then: () => { fs.unlinkSync(target); fs.symlinkSync(victim, target) } } })
  const r = await F.writeFile({ path: target, content: 'new readme' }, { scope: proj, fs: fsr })
  assert.equal(r.status, 'ok')
  assert.equal(fs.readFileSync(victim, 'utf8'), 'precious')
  assert.equal(fs.lstatSync(target).isSymbolicLink(), false)
  assert.equal(fs.readFileSync(target, 'utf8'), 'new readme')
})

test('race: delete_file target swapped for a symlink before the open → refused, the outside file survives', async () => {
  const { proj, victim } = outside()
  const target = path.join(proj, 'README.md')
  const fsr = racing({ open: { when: (p) => p === target, then: () => { fs.unlinkSync(target); fs.symlinkSync(victim, target) } } })
  const r = await F.deleteFile({ path: target }, { scope: proj, fs: fsr })
  assert.equal(r.status, 'refused')
  assert.ok(fs.existsSync(victim))
})

test('race: delete_file folder swapped for a link to outside before the open → refused, the outside file survives', async () => {
  const { root, proj, away } = outside()
  const sub = path.join(proj, 'sub')
  fs.mkdirSync(sub)
  fs.writeFileSync(path.join(sub, 'victim.txt'), 'mine')
  const target = path.join(sub, 'victim.txt')
  const fsr = racing({ open: { when: (p) => p === target, then: () => { fs.renameSync(sub, path.join(root, 'sub-moved')); fs.symlinkSync(away, sub) } } })
  const r = await F.deleteFile({ path: target }, { scope: proj, fs: fsr })
  assert.equal(r.status, 'refused')
  assert.equal(fs.readFileSync(path.join(away, 'victim.txt'), 'utf8'), 'precious')
})

test('race: read_file swapped for a symlink to outside before the open → refused, nothing read', async () => {
  const { proj, victim } = outside()
  const target = path.join(proj, 'README.md')
  const fsr = racing({ open: { when: (p) => p === target, then: () => { fs.unlinkSync(target); fs.symlinkSync(victim, target) } } })
  const r = await F.readFile({ path: target }, { scope: proj, fs: fsr })
  assert.equal(r.status, 'refused')
  assert.equal(r.content, undefined)
})
