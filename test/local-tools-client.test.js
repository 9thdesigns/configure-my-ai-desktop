const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const client = require('../src/local-tools-client')
const { AuditLog } = require('../src/local-tools-approval')

const good = { tool_call: { id: 'tc_1', tool: 'run_command', args: { command: 'ls', cwd: '/tmp' }, bot: { id: 42, name: 'Helper' }, run_id: 9 } }

test('endpoints are fixed https URLs on our own origin', () => {
  assert.equal(client.pollUrl(), 'https://configuremyai.com/desktop/tool_calls?wait=25')
  assert.equal(client.resultUrl('tc_1'), 'https://configuremyai.com/desktop/tool_calls/tc_1/result')
})

test('only responses from our own origin, not redirected, are accepted', () => {
  assert.ok(client.responseFromApp({ url: 'https://configuremyai.com/desktop/tool_calls?wait=25', redirected: false }))
  assert.ok(!client.responseFromApp({ url: 'https://evil.test/desktop/tool_calls', redirected: false }))
  assert.ok(!client.responseFromApp({ url: 'https://configuremyai.com.evil.test/x', redirected: false }))
  assert.ok(!client.responseFromApp({ url: 'http://configuremyai.com/desktop/tool_calls', redirected: false }))
  assert.ok(!client.responseFromApp({ url: 'https://configuremyai.com/x', redirected: true }))
  assert.ok(!client.responseFromApp(null))
})

test('tool calls are validated field by field', () => {
  const call = client.validateToolCall(good)
  assert.deepEqual(call, { id: 'tc_1', tool: 'run_command', args: { command: 'ls', cwd: '/tmp' }, bot: { id: '42', name: 'Helper' }, runId: '9', expiresAt: null })
  const bad = (patch) => client.validateToolCall({ tool_call: { ...good.tool_call, ...patch } })
  assert.equal(bad({ tool: 'shell_execute' }), null, 'unknown tool')
  assert.equal(bad({ id: '../../x' }), null, 'unsafe id')
  assert.equal(bad({ bot: null }), null, 'no bot')
  assert.equal(bad({ args: { command: ['rm', '-rf'] } }), null, 'non-string command')
  assert.equal(client.validateToolCall(null), null)
  assert.equal(client.validateToolCall({}), null)
  // Unknown args are dropped, not passed through.
  assert.deepEqual(bad({ args: { command: 'ls', env: { PATH: '/evil' } } }).args, { command: 'ls' })
})

function fakeFetch (responses) {
  const requests = []
  const fetch = async (url, init) => {
    requests.push({ url, init })
    const r = responses.shift() || { status: 204, url }
    return { redirected: false, ok: r.status >= 200 && r.status < 300, json: async () => r.body, url: r.url || url, status: r.status }
  }
  return { fetch, requests }
}

test('the poller sends the desktop header, never follows redirects, and posts the result back', async () => {
  const { fetch, requests } = fakeFetch([{ status: 200, body: good }, { status: 200 }])
  const audit = new AuditLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cma-ltc-')), 'a.jsonl'))
  const ran = []
  const poller = client.createPoller({
    fetch,
    broker: { decide: async () => ({ allow: true, via: 'once', shellApproved: false }) },
    audit,
    runDeps: {},
    run: async (tool, args) => { ran.push({ tool, args }); return { status: 'ok', exit_code: 0, stdout: 'a\nb' } },
  })
  await poller.tick()
  assert.equal(requests[0].init.method, 'GET')
  assert.equal(requests[0].init.redirect, 'manual')
  assert.equal(requests[0].init.headers['X-CMA-Desktop-Tools'], '1')
  assert.equal(requests[1].url, 'https://configuremyai.com/desktop/tool_calls/tc_1/result')
  assert.equal(requests[1].init.method, 'POST')
  assert.equal(requests[1].init.redirect, 'manual')
  const body = JSON.parse(requests[1].init.body)
  assert.equal(body.approval, 'once')
  assert.equal(body.result.stdout, 'a\nb')
  assert.equal(audit.list()[0].callId, 'tc_1')
  assert.deepEqual(ran, [{ tool: 'run_command', args: { command: 'ls', cwd: '/tmp' } }])
})

test('a call from a foreign origin (redirected response) is dropped without asking or running', async () => {
  let asked = false
  const fetch = async () => ({ redirected: true, url: 'https://evil.test/', status: 200, json: async () => good })
  const poller = client.createPoller({ fetch, broker: { decide: async () => { asked = true; return { allow: true } } } })
  const wait = await poller.tick()
  assert.ok(wait > 0)
  assert.equal(asked, false)
})

test('signed out (401 or a redirect to sign-in) backs off without asking', async () => {
  for (const status of [401, 403, 302]) {
    let asked = false
    const { fetch } = fakeFetch([{ status }])
    const poller = client.createPoller({ fetch, broker: { decide: async () => { asked = true } } })
    assert.ok((await poller.tick()) >= 60000)
    assert.equal(asked, false)
  }
})

test('when the user has switched access off, the poller does not even poll', async () => {
  const { fetch, requests } = fakeFetch([])
  const poller = client.createPoller({ fetch, broker: {}, isEnabled: () => false })
  await poller.tick()
  assert.equal(requests.length, 0)
})

test('a denied or timed-out call is reported without running anything', async () => {
  for (const via of ['deny', 'timeout']) {
    let ran = false
    const posted = []
    await client.handleCall(client.validateToolCall(good), {
      broker: { decide: async () => ({ allow: false, via }) },
      run: async () => { ran = true },
      postResult: async (id, payload) => posted.push({ id, payload }),
    })
    assert.equal(ran, false)
    assert.equal(posted[0].id, 'tc_1')
    assert.equal(posted[0].payload.status, via === 'timeout' ? 'timeout' : 'denied')
  }
})

test('an approved shell command reaches the runner with shellApproved; a grant never sets it', async () => {
  const seen = []
  const run = async (tool, args, deps) => { seen.push(deps.shellApproved); return { status: 'ok' } }
  const call = client.validateToolCall(good)
  await client.handleCall(call, { broker: { decide: async () => ({ allow: true, via: 'once', shellApproved: true }) }, run, postResult: async () => {} })
  await client.handleCall(call, { broker: { decide: async () => ({ allow: true, via: 'grant' }) }, run, postResult: async () => {} })
  assert.deepEqual(seen, [true, false])
})

test('oversized results are replaced by an error', async () => {
  const posted = []
  await client.handleCall(client.validateToolCall(good), {
    broker: { decide: async () => ({ allow: true, via: 'once' }) },
    run: async () => ({ status: 'ok', stdout: 'z'.repeat(7 * 1024 * 1024) }),
    postResult: async (_id, p) => posted.push(p),
  })
  assert.deepEqual(posted[0], { status: 'error', result: { error: 'result too large' } })
})

test('a server without the endpoint (404) is checked back rarely', async () => {
  const { fetch } = fakeFetch([{ status: 404 }])
  const poller = client.createPoller({ fetch, broker: {} })
  assert.ok((await poller.tick()) >= 10 * 60000)
})

test('result statuses reaching the server are ok | denied | error | refused | timeout', () => {
  const allowed = ['ok', 'denied', 'error', 'refused', 'timeout']
  const cases = [
    client.resultPayload({ allow: false, via: 'deny' }),
    client.resultPayload({ allow: false, via: 'timeout' }),
    client.resultPayload({ allow: false, via: 'error' }),
    client.resultPayload({ allow: true, via: 'once' }, { status: 'ok' }),
    client.resultPayload({ allow: true, via: 'once' }, { status: 'refused' }),
    client.resultPayload({ allow: true, via: 'once' }, { status: 'timeout' }),
    client.resultPayload({ allow: true, via: 'once' }, { status: 'error' }),
    client.resultPayload({ allow: true, via: 'once' }, null),
  ]
  for (const p of cases) assert.ok(allowed.includes(p.status), p.status)
  assert.equal(cases[4].approval, 'once')
  assert.ok(cases[4].result, 'the tool result rides in result: {...}')
})
