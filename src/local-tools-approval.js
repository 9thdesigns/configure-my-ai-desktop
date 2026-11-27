// Who decides whether a bot's local tool call runs: the user, every time,
// unless they earlier said "Always allow" for that bot and that command prefix
// (or folder). Nothing runs without one or the other, and silence is a no:
// a card nobody answers is a Deny after two minutes.
//
//   GrantStore     — the standing "Always allow" grants, in a JSON file under
//                    app.getPath('userData'), listed and revocable from the
//                    Local Computer Access window.
//   AuditLog       — every call and what became of it (never its output), as
//                    JSON lines next to the grants, trimmed to the newest N.
//   ApprovalBroker — grant lookup, then the card, raced against the timeout.
//
// Pure: file paths, the prompt and the clock are injected, so
// test/local-tools-approval.test.js runs without Electron.

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { hasShellMeta, tokenize, resolveUserPath } = require('./local-tools')

const APPROVAL_TIMEOUT_MS = 2 * 60 * 1000

// The prefix an "Always allow" grant covers for a call, or null when the call
// can never be covered by a standing grant.
//   run_command — the program, plus a subcommand word if there is one
//                 ("git status -s" → ["git","status"]; "ls -la" → ["ls"]).
//                 A command with shell metacharacters has NO prefix: it runs
//                 only on a fresh approval of its exact text.
//   read_file   — the file's folder.   list_dir — the folder itself.
//   take_screenshot — the tool as a whole.
function grantPrefixFor (tool, args) {
  if (tool === 'run_command') {
    const command = args?.command
    if (typeof command !== 'string' || hasShellMeta(command)) return null
    const argv = tokenize(command)
    if (!argv) return null
    const prefix = [argv[0]]
    if (argv[1] && /^[a-z][a-z0-9-]*$/i.test(argv[1])) prefix.push(argv[1])
    return prefix
  }
  if (tool === 'read_file' || tool === 'list_dir') {
    const target = resolveUserPath(args?.path)
    if (!target) return null
    return tool === 'read_file' ? path.dirname(target) : target
  }
  if (tool === 'take_screenshot') return '*'
  return null
}

function isInside (parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function safeRealpath (p) {
  try { return fs.realpathSync(p) } catch {
    // A path that doesn't exist (yet): resolve its nearest existing parent.
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(safeRealpath(parent), path.basename(p))
  }
}

// Does a stored grant cover this call? Token-wise for commands (so a "git"
// grant never covers "gitx"), folder-wise for paths (so /Users/me/proj never
// covers /Users/me/project-secrets or ../ escapes). `realpath` resolves
// symlinks so a link inside a granted folder cannot reach outside it.
function grantCovers (grant, call, { realpath = safeRealpath } = {}) {
  if (!grant || !call || grant.tool !== call.tool) return false
  if (String(grant.botId) !== String(call.bot?.id)) return false
  if (call.tool === 'run_command') {
    const command = call.args?.command
    if (typeof command !== 'string' || hasShellMeta(command)) return false
    const argv = tokenize(command)
    if (!argv || !Array.isArray(grant.prefix) || grant.prefix.length === 0) return false
    return grant.prefix.every((token, i) => argv[i] === token)
  }
  if (call.tool === 'read_file' || call.tool === 'list_dir') {
    const target = resolveUserPath(call.args?.path)
    if (!target || typeof grant.prefix !== 'string') return false
    return isInside(realpath(grant.prefix), realpath(target))
  }
  if (call.tool === 'take_screenshot') return grant.prefix === '*'
  return false
}

function describePrefix (tool, prefix) {
  if (tool === 'run_command') return Array.isArray(prefix) ? prefix.join(' ') : ''
  if (tool === 'take_screenshot') return 'screenshots'
  return String(prefix || '')
}

function readJson (file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJsonAtomic (file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

class GrantStore {
  constructor (file) {
    this.file = file
  }

  list () {
    const data = readJson(this.file, { grants: [] })
    return Array.isArray(data.grants) ? data.grants : []
  }

  add ({ bot, tool, prefix, now = new Date() }) {
    if (prefix == null) throw new Error('this call cannot be covered by a standing grant')
    const grants = this.list()
    const existing = grants.find((g) => g.tool === tool && String(g.botId) === String(bot.id) &&
      JSON.stringify(g.prefix) === JSON.stringify(prefix))
    if (existing) return existing
    const grant = {
      id: crypto.randomUUID(),
      botId: String(bot.id),
      botName: String(bot.name || bot.id),
      tool,
      prefix,
      label: describePrefix(tool, prefix),
      createdAt: now.toISOString(),
    }
    grants.push(grant)
    writeJsonAtomic(this.file, { grants })
    return grant
  }

  revoke (id) {
    const grants = this.list()
    const kept = grants.filter((g) => g.id !== id)
    if (kept.length === grants.length) return false
    writeJsonAtomic(this.file, { grants: kept })
    return true
  }

  find (call, opts) {
    return this.list().find((g) => grantCovers(g, call, opts)) || null
  }
}

// What the audit records about a call's target: the command or path, cut to a
// sane length. Output never goes in the audit — it can hold anything.
function auditTarget (call) {
  const a = call.args || {}
  const value = call.tool === 'run_command' ? a.command : call.tool === 'take_screenshot' ? 'screen' : a.path
  return String(value ?? '').slice(0, 500)
}

class AuditLog {
  constructor (file, { maxEntries = 1000 } = {}) {
    this.file = file
    this.maxEntries = maxEntries
  }

  record ({ call, decision, via, result, now = new Date() }) {
    const entry = {
      at: now.toISOString(),
      callId: String(call.id),
      runId: call.runId != null ? String(call.runId) : null,
      botId: call.bot ? String(call.bot.id) : null,
      botName: call.bot ? String(call.bot.name || '') : null,
      tool: call.tool,
      target: auditTarget(call),
      cwd: call.tool === 'run_command' && call.args?.cwd ? String(call.args.cwd).slice(0, 500) : undefined,
      decision,
      via,
      status: result?.status ?? null,
      exitCode: result?.exit_code ?? undefined,
      truncated: result?.truncated || undefined,
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    fs.appendFileSync(this.file, JSON.stringify(entry) + '\n', { mode: 0o600 })
    this.trim()
    return entry
  }

  trim () {
    let lines
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean) } catch { return }
    if (lines.length <= this.maxEntries) return
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, lines.slice(-this.maxEntries).join('\n') + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
  }

  list ({ limit = 100 } = {}) {
    let lines
    try { lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean) } catch { return [] }
    return lines.slice(-limit).reverse().map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  }
}

// The decision for one call:
//   { allow: true,  via: 'grant',  grant }         — a standing grant covered it
//   { allow: true,  via: 'once',   shellApproved } — the user said Allow once
//   { allow: true,  via: 'always', grant }         — the user said Always allow
//   { allow: false, via: 'deny' | 'timeout' | 'error' }
//
// `prompt(card, { signal })` shows the card and resolves to 'once', 'always'
// or 'deny'; when `signal` aborts (the timeout fired) it must take the card
// down. Anything other than those three answers is a deny.
class ApprovalBroker {
  constructor ({ grants, prompt, timeoutMs = APPROVAL_TIMEOUT_MS, setTimer = setTimeout, clearTimer = clearTimeout, realpath } = {}) {
    this.grants = grants
    this.prompt = prompt
    this.timeoutMs = timeoutMs
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.realpath = realpath
  }

  card (call) {
    const prefix = grantPrefixFor(call.tool, call.args)
    return {
      id: String(call.id),
      bot: { id: String(call.bot?.id ?? ''), name: String(call.bot?.name || 'A bot') },
      tool: call.tool,
      target: auditTarget(call),
      cwd: call.tool === 'run_command' ? (call.args?.cwd || '~') : undefined,
      usesShell: call.tool === 'run_command' && hasShellMeta(call.args?.command || ''),
      // null when "Always allow" is not offered (shell commands).
      alwaysLabel: prefix == null ? null : describePrefix(call.tool, prefix),
      timeoutMs: this.timeoutMs,
    }
  }

  async decide (call) {
    const opts = this.realpath ? { realpath: this.realpath } : undefined
    const grant = this.grants?.find(call, opts)
    if (grant) return { allow: true, via: 'grant', grant, shellApproved: false }

    if (typeof this.prompt !== 'function') return { allow: false, via: 'error' }
    const card = this.card(call)
    const controller = new AbortController()
    let timer
    const timeout = new Promise((resolve) => {
      timer = this.setTimer(() => resolve('__timeout__'), this.timeoutMs)
    })
    let answer
    try {
      answer = await Promise.race([
        Promise.resolve().then(() => this.prompt(card, { signal: controller.signal })),
        timeout,
      ])
    } catch {
      answer = 'deny'
    } finally {
      this.clearTimer(timer)
    }
    if (answer === '__timeout__') {
      controller.abort()
      return { allow: false, via: 'timeout' }
    }
    if (answer === 'once') {
      // Allow once on a shell command is the approval of that exact string.
      return { allow: true, via: 'once', shellApproved: card.usesShell }
    }
    if (answer === 'always' && card.alwaysLabel != null) {
      const prefix = grantPrefixFor(call.tool, call.args)
      const added = this.grants.add({ bot: call.bot, tool: call.tool, prefix })
      return { allow: true, via: 'always', grant: added, shellApproved: false }
    }
    // 'deny', or 'always' where it was never offered (a forged answer).
    return { allow: false, via: 'deny' }
  }
}

module.exports = {
  APPROVAL_TIMEOUT_MS,
  grantPrefixFor,
  grantCovers,
  describePrefix,
  GrantStore,
  AuditLog,
  ApprovalBroker,
}
