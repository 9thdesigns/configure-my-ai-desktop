'use strict'

// File tools scoped to a folder the user approved. Every call runs against a
// `scope`: the folder the user allowed (once, or always) on the approval card
// (local-tools-approval.js decides that; this module only enforces it).
//
//   list_dir     { path }                         a folder's entries
//   read_file    { path, max_bytes? }             a file's text, capped
//   search_files { path, query?, glob?, max_results? }
//                                                 file names (glob) and/or
//                                                 lines (query) under a folder
//   write_file   { path, content }                create or replace a file
//   create_file  { path, content }                create a new file; never
//                                                 replaces one
//   delete_file  { path }                         remove one file (never a
//                                                 folder)
//
// Scoping, for every tool:
//   * the path must be absolute (or ~/…), and may not contain a `..` segment
//     at all — not even one that would resolve back inside;
//   * the real path (symlinks resolved; for a file that doesn't exist yet,
//     its nearest existing parent's real path) must be inside the real path
//     of the scope folder, so a symlink inside the folder cannot reach out;
//   * a write, create or delete refuses a target that is itself a symlink,
//     and writes to the resolved path, never through a link;
//   * search never follows symlinks, and skips hidden folders and
//     node_modules below the folder it was given.
//
// Caps: reads 256 KB by default (max_bytes up to 1 MB); writes 1 MB; search
// scans at most 5000 files, 8 levels, 1 MB per file, 200 results, 10 s.
//
// Pure apart from node:fs, so test/local-files.test.js runs it on temp dirs.

const fsp = require('node:fs/promises')
const path = require('node:path')
const { resolveUserPath } = require('./local-tools')

const READ_TOOLS = Object.freeze(['read_file', 'list_dir', 'search_files'])
const WRITE_TOOLS = Object.freeze(['write_file', 'create_file', 'delete_file'])
const FILE_TOOLS = Object.freeze([...READ_TOOLS, ...WRITE_TOOLS])

const LIMITS = Object.freeze({
  readBytes: 256 * 1024,
  maxReadBytes: 1024 * 1024,
  maxWriteBytes: 1024 * 1024,
  maxDirEntries: 1000,
  maxSearchResults: 200,
  maxSearchFiles: 5000,
  maxSearchDepth: 8,
  maxSearchFileBytes: 1024 * 1024,
  maxMatchesPerFile: 3,
  maxQueryLength: 200,
  maxGlobLength: 100,
  searchTimeoutMs: 10_000,
  previewChars: 2000,
})

const SKIP_DIRS = new Set(['node_modules', '.git'])

function isInside (parent, child) {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// A `..` segment anywhere in what the bot sent, before any normalising.
function hasTraversal (input) {
  return typeof input === 'string' && input.split(/[\\/]+/).some((seg) => seg === '..')
}

// The folder a call is about: the folder itself for list_dir and
// search_files, the file's folder for the rest. Null for a bad path.
function scopeFolderFor (tool, args) {
  const target = resolveUserPath(args?.path)
  if (!target || hasTraversal(args?.path)) return null
  return tool === 'list_dir' || tool === 'search_files' ? target : path.dirname(target)
}

// The real path of `p`, or — for a path that doesn't exist yet — the real
// path of its nearest existing parent with the rest appended.
async function realpathLoose (p, fs = fsp) {
  try {
    return await fs.realpath(p)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    const parent = path.dirname(p)
    if (parent === p) return p
    return path.join(await realpathLoose(parent, fs), path.basename(p))
  }
}

const fail = (error, code) => ({ status: code || 'error', error })

// Where a call may act, or a refusal. `mustExist` for read/list/delete.
async function resolveInScope (input, scope, { mustExist = false, forWrite = false, fs = fsp } = {}) {
  if (typeof scope !== 'string' || !scope) return { error: fail('no approved folder for this call', 'refused') }
  const target = resolveUserPath(input)
  if (!target) return { error: fail('path must be an absolute path') }
  if (hasTraversal(input)) return { error: fail('path may not contain “..”', 'refused') }
  let scopeReal
  try { scopeReal = await fs.realpath(scope) } catch { return { error: fail('the approved folder no longer exists') } }
  let real
  try { real = mustExist ? await fs.realpath(target) : await realpathLoose(target, fs) } catch (err) {
    return { error: fail(err.code === 'ENOENT' ? 'not found' : (err.code || err.message)) }
  }
  if (!isInside(scopeReal, real)) return { error: fail('outside the approved folder', 'refused') }
  if (forWrite) {
    try {
      const st = await fs.lstat(target)
      if (st.isSymbolicLink()) return { error: fail('the target is a symbolic link', 'refused') }
    } catch (err) {
      if (err.code !== 'ENOENT') return { error: fail(err.code || err.message) }
    }
  }
  return { target, real, scopeReal }
}

// --- Closing the gap between the check and the use -------------------------
//
// resolveInScope checks a path; by the time it is opened, a file (or a folder
// on the way) could have been swapped for a symlink. So every open that acts
// on a file is checked again *after* it is open, on the file descriptor:
//   * writes, creates and deletes open with O_NOFOLLOW (macOS, Linux): a
//     target that became a symlink fails to open (ELOOP);
//   * creates also use O_EXCL, which never follows a symlink either;
//   * then the opened descriptor is located — on Linux by reading
//     /proc/self/fd/<fd>, elsewhere by comparing the descriptor's
//     device/inode with the path's real path — and must still be inside
//     the approved folder's real path. If not, the call is refused (and a
//     file a write created out there is removed).
// Node has no unlinkat, so a delete re-checks with the file open and unlinks
// straight after; the window left is microseconds wide and only the
// descriptor's own file is ever removed.

const C = require('node:fs').constants
const O_NOFOLLOW = C.O_NOFOLLOW || 0 // 0 on Windows: the re-check still runs

// Where an open descriptor really is, or null when that can't be told.
async function openedPath (handle, target, fs) {
  if (process.platform === 'linux') {
    try { return await fs.readlink(`/proc/self/fd/${handle.fd}`) } catch {}
  }
  try {
    const [st, real] = await Promise.all([handle.stat(), fs.realpath(target)])
    const st2 = await fs.stat(real)
    return st.dev === st2.dev && st.ino === st2.ino ? real : null
  } catch {
    return null
  }
}

// Refusal (or null when fine) for an open descriptor that must be inside
// `scopeReal`, and — with `noLink` — must be the file at `target` itself,
// not something reached through a link.
async function verifyOpened (handle, target, scopeReal, fs, { noLink = false } = {}) {
  const where = await openedPath(handle, target, fs)
  if (!where || !isInside(scopeReal, where)) return fail('the file moved outside the approved folder', 'refused')
  if (noLink) {
    try {
      const [st, lst] = await Promise.all([handle.stat(), fs.lstat(target)])
      if (lst.isSymbolicLink() || st.dev !== lst.dev || st.ino !== lst.ino) return fail('the target changed into a symbolic link', 'refused')
    } catch {
      return fail('the target changed while it was being opened', 'refused')
    }
  }
  return null
}

const linkError = (err) => err && (err.code === 'ELOOP' || err.code === 'EMLINK')

function clampBytes (value, fallback, max) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.floor(n), max)
}

async function readFile (args, { scope, fs = fsp } = {}) {
  const r = await resolveInScope(args?.path, scope, { mustExist: true, fs })
  if (r.error) return r.error
  const maxBytes = clampBytes(args?.max_bytes, LIMITS.readBytes, LIMITS.maxReadBytes)
  let handle
  try {
    const stat = await fs.stat(r.real)
    if (!stat.isFile()) return fail('not a regular file')
    handle = await fs.open(r.real, 'r')
    const moved = await verifyOpened(handle, r.real, r.scopeReal, fs)
    if (moved) return moved
    const length = Math.min(stat.size, maxBytes)
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return { status: 'ok', path: r.target, content: buffer.subarray(0, bytesRead).toString('utf8'), size: stat.size, truncated: stat.size > bytesRead }
  } catch (err) {
    return fail(err.code || err.message)
  } finally {
    await handle?.close?.()
  }
}

async function listDir (args, { scope, fs = fsp } = {}) {
  const r = await resolveInScope(args?.path, scope, { mustExist: true, fs })
  if (r.error) return r.error
  try {
    const dirents = await fs.readdir(r.real, { withFileTypes: true })
    const entries = dirents.slice(0, LIMITS.maxDirEntries).map((d) => ({
      name: d.name,
      type: d.isDirectory() ? 'dir' : d.isSymbolicLink() ? 'link' : d.isFile() ? 'file' : 'other',
    }))
    return { status: 'ok', path: r.target, entries, total: dirents.length, truncated: dirents.length > entries.length }
  } catch (err) {
    return fail(err.code || err.message)
  }
}

// "*.md", "report-??.txt": * and ? only, matched against the file name.
function globToRegExp (glob) {
  const body = String(glob).split('').map((ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${body}$`, 'i')
}

async function searchFiles (args, { scope, fs = fsp, now = Date.now } = {}) {
  const query = typeof args?.query === 'string' ? args.query.trim() : ''
  const glob = typeof args?.glob === 'string' ? args.glob.trim() : ''
  if (!query && !glob) return fail('give a query, a glob, or both')
  if (query.length > LIMITS.maxQueryLength) return fail(`query longer than ${LIMITS.maxQueryLength} characters`)
  if (glob.length > LIMITS.maxGlobLength || /[\\/]/.test(glob)) return fail('glob must be a file-name pattern like *.md')
  const r = await resolveInScope(args?.path, scope, { mustExist: true, fs })
  if (r.error) return r.error
  const maxResults = clampBytes(args?.max_results, 50, LIMITS.maxSearchResults)
  const nameRe = glob ? globToRegExp(glob) : null
  const needle = query.toLowerCase()
  const deadline = now() + LIMITS.searchTimeoutMs

  const results = []
  let scanned = 0
  let truncated = false
  const queue = [{ dir: r.real, shown: r.target, depth: 0 }]
  while (queue.length && !truncated) {
    const { dir, shown, depth } = queue.shift()
    let dirents
    try { dirents = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    for (const d of dirents) {
      if (now() > deadline || scanned >= LIMITS.maxSearchFiles || results.length >= maxResults) { truncated = true; break }
      if (d.isSymbolicLink()) continue // never followed
      const full = path.join(dir, d.name)
      const display = path.join(shown, d.name)
      if (d.isDirectory()) {
        if (depth + 1 < LIMITS.maxSearchDepth && !SKIP_DIRS.has(d.name) && !d.name.startsWith('.')) queue.push({ dir: full, shown: display, depth: depth + 1 })
        continue
      }
      if (!d.isFile()) continue
      scanned++
      if (nameRe && !nameRe.test(d.name)) continue
      if (!needle) {
        results.push({ path: display })
        continue
      }
      const matches = await grepFile(full, needle, fs)
      if (matches.length) results.push({ path: display, matches })
    }
  }
  return { status: 'ok', path: r.target, results, scanned, truncated }
}

// Up to three matching lines of a text file (binary files are skipped).
async function grepFile (file, needle, fs) {
  let handle
  try {
    const stat = await fs.stat(file)
    const length = Math.min(stat.size, LIMITS.maxSearchFileBytes)
    if (!length) return []
    handle = await fs.open(file, 'r')
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const data = buffer.subarray(0, bytesRead)
    if (data.subarray(0, 8000).includes(0)) return []
    const out = []
    const lines = data.toString('utf8').split('\n')
    for (let i = 0; i < lines.length && out.length < LIMITS.maxMatchesPerFile; i++) {
      if (lines[i].toLowerCase().includes(needle)) out.push({ line: i + 1, text: lines[i].trim().slice(0, 200) })
    }
    return out
  } catch {
    return []
  } finally {
    await handle?.close?.()
  }
}

// write_file and create_file. `create` never replaces an existing file.
async function writeFile (args, { scope, create = false, fs = fsp } = {}) {
  const content = args?.content
  if (typeof content !== 'string') return fail('content is required')
  const bytes = Buffer.byteLength(content)
  if (bytes > LIMITS.maxWriteBytes) return fail(`content larger than ${LIMITS.maxWriteBytes} bytes`)
  const r = await resolveInScope(args?.path, scope, { forWrite: true, fs })
  if (r.error) return r.error
  try {
    const parent = await fs.stat(path.dirname(r.real))
    if (!parent.isDirectory()) return fail('the folder does not exist')
  } catch {
    return fail('the folder does not exist')
  }
  let existed = false
  try {
    const st = await fs.lstat(r.real)
    if (!st.isFile()) return fail('not a regular file')
    existed = true
  } catch {}
  if (create && existed) return fail('a file with that name already exists')
  const dir = path.dirname(r.real)
  // create_file writes the file itself (O_EXCL: never an existing file or
  // link); write_file writes a temp file next to it and renames it over,
  // which replaces a link rather than following it.
  const file = create ? r.real : path.join(dir, `.${path.basename(r.real)}.cma-${process.pid}-${Date.now()}.tmp`)
  let handle
  try {
    handle = await fs.open(file, C.O_WRONLY | C.O_CREAT | C.O_EXCL | O_NOFOLLOW, 0o644)
  } catch (err) {
    if (linkError(err)) return fail('the target is a symbolic link', 'refused')
    if (err.code === 'EEXIST') {
      const st = await fs.lstat(file).catch(() => null)
      return st && st.isSymbolicLink() ? fail('the target is a symbolic link', 'refused') : fail('a file with that name already exists')
    }
    return fail(err.code || err.message)
  }
  let ok = false
  try {
    const moved = await verifyOpened(handle, file, r.scopeReal, fs, { noLink: true })
    if (moved) return moved
    await handle.writeFile(content)
    await handle.close()
    handle = null
    if (!create) {
      // The folder must still be the approved one at the moment of the rename.
      const dirReal = await fs.realpath(dir).catch(() => null)
      if (!dirReal || !isInside(r.scopeReal, dirReal)) return fail('the file moved outside the approved folder', 'refused')
      await fs.rename(file, r.real)
    }
    ok = true
    return { status: 'ok', path: r.target, bytes, created: !existed }
  } catch (err) {
    return fail(err.code || err.message)
  } finally {
    await handle?.close?.().catch(() => {})
    // Anything we created that didn't end up as the result goes.
    if (!ok) await fs.unlink(file).catch(() => {})
  }
}

async function deleteFile (args, { scope, fs = fsp } = {}) {
  const r = await resolveInScope(args?.path, scope, { mustExist: true, forWrite: true, fs })
  if (r.error) return r.error
  let handle
  try {
    handle = await fs.open(r.real, C.O_RDONLY | O_NOFOLLOW)
  } catch (err) {
    if (linkError(err)) return fail('the target is a symbolic link', 'refused')
    return fail(err.code === 'ENOENT' ? 'not found' : (err.code || err.message))
  }
  try {
    const st = await handle.stat()
    if (!st.isFile()) return fail('only files can be deleted')
    const moved = await verifyOpened(handle, r.real, r.scopeReal, fs, { noLink: true })
    if (moved) return moved
    await fs.unlink(r.real)
    return { status: 'ok', path: r.target, deleted: true }
  } catch (err) {
    return fail(err.code || err.message)
  } finally {
    await handle.close().catch(() => {})
  }
}

// What the confirm card shows about a change before the user decides: does
// the file exist (so "replace" vs "create"), and how big is it now.
async function inspectTarget (args, { fs = fsp } = {}) {
  const target = resolveUserPath(args?.path)
  if (!target) return { exists: false }
  try {
    const st = await fs.lstat(target)
    return { exists: true, size: st.size, link: st.isSymbolicLink(), file: st.isFile() }
  } catch {
    return { exists: false }
  }
}

function runFileTool (tool, args, deps = {}) {
  switch (tool) {
    case 'read_file': return readFile(args, deps)
    case 'list_dir': return listDir(args, deps)
    case 'search_files': return searchFiles(args, deps)
    case 'write_file': return writeFile(args, { ...deps, create: false })
    case 'create_file': return writeFile(args, { ...deps, create: true })
    case 'delete_file': return deleteFile(args, deps)
    default: return Promise.resolve(fail(`unknown tool ${tool}`))
  }
}

module.exports = {
  READ_TOOLS,
  WRITE_TOOLS,
  FILE_TOOLS,
  LIMITS,
  isInside,
  hasTraversal,
  scopeFolderFor,
  realpathLoose,
  resolveInScope,
  readFile,
  listDir,
  searchFiles,
  globToRegExp,
  writeFile,
  deleteFile,
  inspectTarget,
  runFileTool,
}
