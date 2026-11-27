const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { APPROVAL_TIMEOUT_MS, grantPrefixFor, grantCovers, GrantStore, AuditLog, ApprovalBroker } = require('../src/local-tools-approval')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cma-lta-'))
const bot = { id: '42', name: 'Helper' }
const cmd = (command, b = bot) => ({ id: 'c1', tool: 'run_command', args: { command }, bot: b })

// A fake clock: the broker's timer fires only when the test says so.
function fakeTimers () {
  const timers = []
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t },
    clearTimer: (t) => { if (t) t.cleared = true },
    fire: () => { for (const t of timers) if (!t.cleared) t.fn() },
    timers,
  }
}

test('the default timeout is two minutes', () => {
  assert.equal(APPROVAL_TIMEOUT_MS, 120000)
})

test('an unanswered card is a Deny when the timeout fires, and the card is told to close', async () => {
  const clock = fakeTimers()
  let aborted = false
  const broker = new ApprovalBroker({
    grants: new GrantStore(path.join(tmp(), 'g.json')),
    prompt: (_card, { signal }) => { signal.addEventListener('abort', () => { aborted = true }); return new Promise(() => {}) },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  const pending = broker.decide(cmd('ls'))
  await new Promise((r) => setImmediate(r))
  assert.equal(clock.timers[0].ms, 120000)
  clock.fire()
  const d = await pending
  assert.deepEqual([d.allow, d.via], [false, 'timeout'])
  assert.equal(aborted, true)
})

test('nothing runs without a prompt or a grant', async () => {
  const broker = new ApprovalBroker({ grants: new GrantStore(path.join(tmp(), 'g.json')) })
  assert.equal((await broker.decide(cmd('ls'))).allow, false)
})

test('Deny, a thrown prompt and an unknown answer all deny', async () => {
  for (const prompt of [async () => 'deny', async () => { throw new Error('x') }, async () => 'yes please']) {
    const broker = new ApprovalBroker({ grants: new GrantStore(path.join(tmp(), 'g.json')), prompt })
    assert.equal((await broker.decide(cmd('ls'))).allow, false)
  }
})

test('Allow once runs this call only; the next one asks again', async () => {
  let asked = 0
  const broker = new ApprovalBroker({ grants: new GrantStore(path.join(tmp(), 'g.json')), prompt: async () => { asked++; return 'once' } })
  assert.equal((await broker.decide(cmd('git status'))).via, 'once')
  assert.equal((await broker.decide(cmd('git status'))).via, 'once')
  assert.equal(asked, 2)
})

test('Always allow stores a bot+prefix grant that covers later matching calls without asking', async () => {
  const store = new GrantStore(path.join(tmp(), 'g.json'))
  let asked = 0
  const broker = new ApprovalBroker({ grants: store, prompt: async () => { asked++; return 'always' } })
  assert.equal((await broker.decide(cmd('git status -s'))).via, 'always')
  assert.deepEqual(store.list()[0].prefix, ['git', 'status'])
  assert.equal((await broker.decide(cmd('git status --porcelain'))).via, 'grant')
  assert.equal(asked, 1)
  // A different subcommand, a different bot: asks again.
  await broker.decide(cmd('git push'))
  await broker.decide(cmd('git status', { id: '7', name: 'Other' }))
  assert.equal(asked, 3)
})

test('prefix grants match whole tokens, never string prefixes', () => {
  const grant = { tool: 'run_command', botId: '42', prefix: ['git'] }
  assert.ok(grantCovers(grant, cmd('git log')))
  assert.ok(!grantCovers(grant, cmd('gitx log')))
  assert.ok(!grantCovers(grant, cmd('git log', { id: '43' })))
})

test('a shell-metacharacter command is never covered by a grant and never offered Always allow', async () => {
  const grant = { tool: 'run_command', botId: '42', prefix: ['git'] }
  assert.ok(!grantCovers(grant, cmd('git log | sh')))
  assert.equal(grantPrefixFor('run_command', { command: 'git log; rm -rf ~' }), null)
  const store = new GrantStore(path.join(tmp(), 'g.json'))
  const cards = []
  const broker = new ApprovalBroker({ grants: store, prompt: async (card) => { cards.push(card); return 'always' } })
  const d = await broker.decide(cmd('ls | wc -l'))
  assert.equal(cards[0].alwaysLabel, null)
  assert.equal(cards[0].usesShell, true)
  assert.equal(d.allow, false, 'a forged Always on a shell command is a deny')
  assert.equal(store.list().length, 0)
  const once = new ApprovalBroker({ grants: store, prompt: async () => 'once' })
  const d2 = await once.decide(cmd('ls | wc -l'))
  assert.deepEqual([d2.allow, d2.shellApproved], [true, true])
})

test('folder grants cover files inside, not siblings with the same prefix or ../ escapes', () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'proj'))
  fs.mkdirSync(path.join(dir, 'project-secrets'))
  const grant = { tool: 'read_file', botId: '42', prefix: path.join(dir, 'proj') }
  const read = (p) => ({ tool: 'read_file', args: { path: p }, bot })
  assert.ok(grantCovers(grant, read(path.join(dir, 'proj', 'a.txt'))))
  assert.ok(!grantCovers(grant, read(path.join(dir, 'project-secrets', 'a.txt'))))
  assert.ok(!grantCovers(grant, read(path.join(dir, 'proj', '..', 'project-secrets', 'a.txt'))))
  assert.ok(!grantCovers({ ...grant, tool: 'list_dir' }, read(path.join(dir, 'proj', 'a.txt'))))
})

test('a symlink inside a granted folder cannot reach outside it', () => {
  const dir = tmp()
  fs.mkdirSync(path.join(dir, 'proj'))
  fs.writeFileSync(path.join(dir, 'secret'), 's')
  fs.symlinkSync(path.join(dir, 'secret'), path.join(dir, 'proj', 'link'))
  const grant = { tool: 'read_file', botId: '42', prefix: path.join(dir, 'proj') }
  assert.ok(!grantCovers(grant, { tool: 'read_file', args: { path: path.join(dir, 'proj', 'link') }, bot }))
})

test('grants are revocable and persisted', () => {
  const file = path.join(tmp(), 'g.json')
  const store = new GrantStore(file)
  const g = store.add({ bot, tool: 'run_command', prefix: ['ls'] })
  assert.equal(new GrantStore(file).list().length, 1)
  assert.equal(store.add({ bot, tool: 'run_command', prefix: ['ls'] }).id, g.id, 'no duplicates')
  assert.ok(store.revoke(g.id))
  assert.equal(new GrantStore(file).list().length, 0)
  assert.equal(store.revoke(g.id), false)
})

test('the audit records each call and decision without output, newest first, trimmed', () => {
  const file = path.join(tmp(), 'audit.jsonl')
  const audit = new AuditLog(file, { maxEntries: 3 })
  for (let i = 0; i < 5; i++) {
    audit.record({ call: { ...cmd(`echo ${i}`), id: `c${i}`, runId: 'r1' }, decision: 'allow', via: 'once', result: { status: 'ok', exit_code: 0, stdout: 'SECRET OUTPUT' } })
  }
  const raw = fs.readFileSync(file, 'utf8')
  assert.ok(!raw.includes('SECRET OUTPUT'), 'output never reaches the audit')
  const entries = audit.list()
  assert.equal(entries.length, 3)
  assert.equal(entries[0].callId, 'c4')
  assert.equal(entries[0].target, 'echo 4')
  assert.equal(entries[0].runId, 'r1')
  assert.equal(entries[0].exitCode, 0)
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600)
})
