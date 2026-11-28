// Local computer tools: what a bot may do on THIS machine, once the user has
// approved it. Nothing here decides whether a call is
// allowed: that is the approval broker's job (local-tools-approval.js), and the
// server-facing loop (local-tools-client.js) runs a tool only after it has a
// decision. This module just does the work, with hard limits on time and size.
//
//   run_command     — child_process.spawn, argv only. No shell: a command that
//                     needs one (pipes, globs, $VARS, redirects, ;, &&, ~ …) is
//                     refused unless the user approved that exact string, and
//                     only then is it handed to the shell, verbatim.
//   list_dir, read_file, search_files, write_file, create_file, delete_file
//                   — file tools, each run inside the folder the user
//                     approved for it (local-files.js enforces the scope).
//   take_screenshot — the primary screen as a PNG (desktopCapturer, injected so
//                     the module stays testable without Electron).
//
// Pure apart from the injected spawn/fs/capture, so test/local-tools.test.js
// runs it under plain node.

const childProcess = require('node:child_process')
const os = require('node:os')
const path = require('node:path')

const TOOL_NAMES = Object.freeze(['run_command', 'read_file', 'list_dir', 'take_screenshot', 'search_files', 'write_file', 'create_file', 'delete_file'])

const LIMITS = Object.freeze({
  commandTimeoutMs: 30_000,
  maxCommandTimeoutMs: 90_000, // the server caps timeout_ms at 90 s too
  maxOutputBytes: 64 * 1024, // per stream, stdout and stderr each
  maxCommandLength: 4096,
  maxScreenshotWidth: 1920,
  maxScreenshotBytes: 5 * 1024 * 1024,
})

// Characters a POSIX shell (or cmd.exe) would interpret rather than pass
// through: pipes and lists, redirects, subshells, expansion of every kind,
// globs, comments, history, line breaks. Quotes are NOT here: the tokenizer
// below honours plain '…' and "…" grouping itself, without expanding inside.
const SHELL_META = /[|&;<>()$`\\*?[\]{}~!#\n\r%^]/

function hasShellMeta (command) {
  return SHELL_META.test(String(command))
}

// Split a metacharacter-free command into argv, honouring simple quotes.
// Returns null for anything we will not run without a shell: an unbalanced
// quote, an empty command, or a command containing metacharacters.
function tokenize (command) {
  const text = String(command || '')
  if (!text.trim() || hasShellMeta(text)) return null
  const argv = []
  let current = ''
  let quote = null
  let inToken = false
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      inToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (inToken) argv.push(current)
      current = ''
      inToken = false
      continue
    }
    current += ch
    inToken = true
  }
  if (quote) return null
  if (inToken) argv.push(current)
  return argv.length ? argv : null
}

// "~/x" and "~" mean the home folder for the file tools; anything else must
// already be absolute. Relative paths are refused rather than resolved against
// wherever the app happens to have been launched from.
function resolveUserPath (input) {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')) return null
  let p = input.trim()
  if (p === '~') p = os.homedir()
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2))
  if (!path.isAbsolute(p)) return null
  return path.resolve(p)
}

function clampTimeout (value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return LIMITS.commandTimeoutMs
  return Math.min(Math.floor(n), LIMITS.maxCommandTimeoutMs)
}

// A bounded buffer: keeps the first `max` bytes of a stream and counts the
// rest, so a runaway command cannot balloon the app's memory.
function cappedCollector (max) {
  const chunks = []
  let kept = 0
  let total = 0
  return {
    push (chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      total += buf.length
      if (kept >= max) return
      const slice = buf.subarray(0, max - kept)
      chunks.push(slice)
      kept += slice.length
    },
    text () { return Buffer.concat(chunks).toString('utf8') },
    get truncated () { return total > kept },
    get totalBytes () { return total },
  }
}

// run_command. `shellApproved` is true only when the user approved this exact
// command string in the card (never via a standing grant); without it a
// command with shell metacharacters is refused outright.
function runCommand (args, { spawn = childProcess.spawn, shellApproved = false, maxOutputBytes = LIMITS.maxOutputBytes, env = process.env } = {}) {
  const command = typeof args?.command === 'string' ? args.command : ''
  if (!command.trim()) return Promise.resolve({ status: 'error', error: 'command is required' })
  if (command.length > LIMITS.maxCommandLength) {
    return Promise.resolve({ status: 'error', error: `command longer than ${LIMITS.maxCommandLength} characters` })
  }

  let cwd = os.homedir()
  if (args.cwd != null && args.cwd !== '') {
    cwd = resolveUserPath(args.cwd)
    if (!cwd) return Promise.resolve({ status: 'error', error: 'cwd must be an absolute path' })
  }

  const needsShell = hasShellMeta(command)
  let file
  let argv
  let options
  if (needsShell) {
    if (!shellApproved) {
      return Promise.resolve({
        status: 'refused',
        error: 'command uses shell features (pipes, globs, variables, redirects); it runs only when the user approves the exact command',
      })
    }
    file = command
    argv = []
    options = { shell: true }
  } else {
    const tokens = tokenize(command)
    if (!tokens) return Promise.resolve({ status: 'error', error: 'could not parse command (unbalanced quotes?)' })
    file = tokens[0]
    argv = tokens.slice(1)
    options = { shell: false }
  }

  const timeoutMs = clampTimeout(args.timeout_ms)
  const stdout = cappedCollector(maxOutputBytes)
  const stderr = cappedCollector(maxOutputBytes)

  return new Promise((resolve) => {
    let child
    let settled = false
    let timedOut = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({
        ...result,
        stdout: stdout.text(),
        stderr: stderr.text(),
        truncated: stdout.truncated || stderr.truncated,
      })
    }
    try {
      child = spawn(file, argv, { ...options, cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (err) {
      resolve({ status: 'error', error: err.message, stdout: '', stderr: '', truncated: false })
      return
    }
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
      finish({ status: 'timeout', error: `timed out after ${timeoutMs} ms`, exit_code: null })
    }, timeoutMs)
    child.stdout?.on('data', (d) => stdout.push(d))
    child.stderr?.on('data', (d) => stderr.push(d))
    child.on('error', (err) => finish({ status: 'error', error: err.message, exit_code: null }))
    child.on('close', (code, signal) => {
      if (timedOut) return
      finish({ status: 'ok', exit_code: code, signal: signal || null })
    })
  })
}

// take_screenshot. `capture` is supplied by main (desktopCapturer); it resolves
// to a NativeImage-like object ({ toPNG(), toJPEG(q), getSize(), isEmpty() }).
async function takeScreenshot (_args, { capture, maxBytes = LIMITS.maxScreenshotBytes } = {}) {
  if (typeof capture !== 'function') return { status: 'error', error: 'screen capture unavailable' }
  try {
    const image = await capture({ maxWidth: LIMITS.maxScreenshotWidth })
    if (!image || image.isEmpty?.()) return { status: 'error', error: 'screen capture returned nothing (permission not granted?)' }
    let mime = 'image/png'
    let data = image.toPNG()
    if (data.length > maxBytes && typeof image.toJPEG === 'function') {
      mime = 'image/jpeg'
      data = image.toJPEG(70)
    }
    if (data.length > maxBytes) return { status: 'error', error: 'screenshot too large' }
    const size = image.getSize?.() || {}
    return { status: 'ok', mime, width: size.width, height: size.height, data_base64: data.toString('base64') }
  } catch (err) {
    return { status: 'error', error: err.message }
  }
}

// File tools need deps.scope: the folder the user approved for this call
// (the approval broker's decision). Without one they are refused.
function runTool (tool, args, deps = {}) {
  switch (tool) {
    case 'run_command': return runCommand(args, deps)
    case 'take_screenshot': return takeScreenshot(args, deps)
    default: {
      // Required here, not at the top: local-files.js requires this module.
      const files = require('./local-files')
      if (files.FILE_TOOLS.includes(tool)) return files.runFileTool(tool, args, deps)
      return Promise.resolve({ status: 'error', error: `unknown tool ${tool}` })
    }
  }
}

module.exports = {
  TOOL_NAMES,
  LIMITS,
  hasShellMeta,
  tokenize,
  resolveUserPath,
  clampTimeout,
  cappedCollector,
  runCommand,
  takeScreenshot,
  runTool,
}
