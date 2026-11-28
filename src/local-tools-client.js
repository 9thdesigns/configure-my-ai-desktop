// The wire between the Rails app and this machine's local tools.
//
// Transport (mirrors docs/desktop-local-tools.md in the web repo):
//   GET  https://configuremyai.com/desktop/tool_calls?wait=25
//        long-poll with the app's own session cookie. 200 → { tool_call: {...} },
//        204 → nothing queued (poll again), 401/403/3xx → signed out (back off).
//   POST https://configuremyai.com/desktop/tool_calls/:id/result
//        { status, result } — the outcome of one call, approved or not.
// Both carry `X-CMA-Desktop-Tools: 1` (a custom header the server requires, so
// no third-party page can forge either request with the user's cookie) and use
// the default session's cookie jar, i.e. the signed-in user of the app window.
//
// Tool calls are accepted only from our own origin: the endpoint is a fixed
// https URL on APP_HOST, redirects are not followed, the response's final URL
// is re-checked, and the payload is validated field by field before anything
// sees it. A call for any other tool, or with a malformed id, is dropped.

const { APP_URL, isAppUrl } = require('./url-policy')
const { TOOL_NAMES, runTool } = require('./local-tools')

const POLL_PATH = '/desktop/tool_calls'
const DESKTOP_HEADER = 'X-CMA-Desktop-Tools'
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const SIGNED_OUT_BACKOFF_MS = 60_000
const ERROR_BACKOFF_MS = 15_000
// A server without the endpoint (an older web deploy): check back rarely.
const NOT_DEPLOYED_BACKOFF_MS = 10 * 60_000
const MAX_RESULT_BYTES = 6 * 1024 * 1024
// The string arguments a tool call may carry, each with its own cap; content
// (write_file / create_file) is checked again against the write cap.
const STRING_ARGS = Object.freeze({ command: 4096, cwd: 4096, path: 4096, content: 1024 * 1024, query: 200, glob: 100 })
const NUMBER_ARGS = Object.freeze(['timeout_ms', 'max_bytes', 'max_results'])

function pollUrl (base = APP_URL) {
  return `${base}${POLL_PATH}?wait=25`
}

function resultUrl (id, base = APP_URL) {
  return `${base}${POLL_PATH}/${encodeURIComponent(id)}/result`
}

// A response we may act on: it came back from our own https origin, not via
// a redirect to somewhere else.
function responseFromApp (response) {
  if (!response) return false
  if (response.redirected) return false
  return isAppUrl(response.url)
}

// Normalise and validate a tool call from the server. Returns null for
// anything we will not act on.
function validateToolCall (payload) {
  const raw = payload && typeof payload === 'object' ? payload.tool_call : null
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id != null ? String(raw.id) : ''
  if (!ID_PATTERN.test(id)) return null
  if (!TOOL_NAMES.includes(raw.tool)) return null
  const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {}
  for (const [key, max] of Object.entries(STRING_ARGS)) {
    if (args[key] == null) continue
    if (typeof args[key] !== 'string' || args[key].length > max) return null
  }
  for (const key of NUMBER_ARGS) {
    if (args[key] != null && !Number.isFinite(Number(args[key]))) return null
  }
  const bot = raw.bot && typeof raw.bot === 'object' ? raw.bot : null
  if (!bot || bot.id == null || !ID_PATTERN.test(String(bot.id))) return null
  return {
    id,
    tool: raw.tool,
    args: {
      ...Object.fromEntries(Object.keys(STRING_ARGS).filter((k) => args[k] != null).map((k) => [k, args[k]])),
      ...Object.fromEntries(NUMBER_ARGS.filter((k) => args[k] != null).map((k) => [k, Number(args[k])])),
    },
    bot: { id: String(bot.id), name: String(bot.name || '').slice(0, 120) },
    runId: raw.run_id != null ? String(raw.run_id).slice(0, 64) : null,
    expiresAt: raw.expires_at ? String(raw.expires_at) : null,
  }
}

// What goes back to the server for a call: the decision plus the tool's
// result. A denied or timed-out call reports that and nothing else.
function resultPayload (decision, result) {
  if (!decision.allow && decision.via === 'invalid') {
    return { status: 'error', result: { error: 'path must be absolute, with no “..” in it' } }
  }
  if (!decision.allow) {
    return { status: decision.via === 'timeout' ? 'timeout' : 'denied', result: { error: decision.via === 'timeout' ? 'the user did not answer in time' : 'the user denied this action' } }
  }
  const status = result?.status === 'ok' ? 'ok' : (result?.status || 'error')
  return { status, approval: decision.via, result }
}

// One call end to end: approve, run, audit, report.
async function handleCall (call, { broker, audit, runDeps = {}, postResult, run = runTool }) {
  let decision
  try {
    decision = await broker.decide(call)
  } catch {
    decision = { allow: false, via: 'error' }
  }
  let result = null
  if (decision.allow) {
    // scope: the folder the user approved for a file tool (local-files.js
    // refuses anything outside it); absent for the other tools.
    result = await run(call.tool, call.args, { ...runDeps, shellApproved: Boolean(decision.shellApproved), ...(decision.scope ? { scope: decision.scope } : {}) })
  }
  try {
    audit?.record({ call, decision: decision.allow ? 'allow' : 'deny', via: decision.via, result })
  } catch {}
  let payload = resultPayload(decision, result)
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RESULT_BYTES) {
    payload = { status: 'error', result: { error: 'result too large' } }
  }
  await postResult(call.id, payload)
  return { decision, payload }
}

// The long-poll loop. `fetch` is session.defaultSession.fetch in main (the
// app's cookies); `isEnabled` is the user's "Allow bots to use this computer"
// switch. Calls are handled one at a time, so cards never stack.
function createPoller ({ fetch, broker, audit, runDeps, run = runTool, isEnabled = () => true, base = APP_URL, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = () => {} }) {
  let stopped = false
  const headers = { Accept: 'application/json', [DESKTOP_HEADER]: '1' }

  async function postResult (id, payload) {
    try {
      const res = await fetch(resultUrl(id, base), {
        method: 'POST',
        redirect: 'manual',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!responseFromApp(res) || !res.ok) log(`result for ${id} not accepted (${res?.status})`)
    } catch (err) {
      log(`result for ${id} failed: ${err.message}`)
    }
  }

  async function tick () {
    if (!isEnabled()) return SIGNED_OUT_BACKOFF_MS
    let res
    try {
      res = await fetch(pollUrl(base), { method: 'GET', redirect: 'manual', headers })
    } catch {
      return ERROR_BACKOFF_MS
    }
    if (!responseFromApp(res)) return SIGNED_OUT_BACKOFF_MS
    if (res.status === 204) return 0
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) return SIGNED_OUT_BACKOFF_MS
    if (res.status === 404) return NOT_DEPLOYED_BACKOFF_MS
    if (res.status !== 200) return ERROR_BACKOFF_MS
    let body
    try { body = await res.json() } catch { return ERROR_BACKOFF_MS }
    const call = validateToolCall(body)
    if (!call) return 0
    if (call.expiresAt && Date.parse(call.expiresAt) < Date.now()) return 0
    await handleCall(call, { broker, audit, runDeps, postResult, run })
    return 0
  }

  async function loop () {
    while (!stopped) {
      const wait = await tick().catch(() => ERROR_BACKOFF_MS)
      if (wait > 0 && !stopped) await sleep(wait)
    }
  }

  return {
    start () { stopped = false; loop() },
    stop () { stopped = true },
    tick,
    postResult,
  }
}

module.exports = {
  POLL_PATH,
  DESKTOP_HEADER,
  pollUrl,
  resultUrl,
  responseFromApp,
  validateToolCall,
  resultPayload,
  handleCall,
  createPoller,
}
