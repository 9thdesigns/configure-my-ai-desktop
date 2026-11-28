# Local tools: the desktop side of the contract

What a bot (Manager first: its `desktop` tool, via `Desktop::ToolCallsController`)
can ask Configure My AI for desktop to do on the user's computer, and what comes
back. The desktop app never runs anything without the user's approval on this
machine. The server queues the call; the app asks; the user decides.

Source: `src/local-tools-client.js` (transport and validation),
`src/local-tools-approval.js` (who decides), `src/local-tools.js` and
`src/local-files.js` (what runs).

## Transport

```
GET  https://configuremyai.com/desktop/tool_calls?wait=25
     → 200 { tool_call: { id, tool, args, bot: { id, name }, run_id?, expires_at? } }
     → 204 nothing queued (the app polls again at once)
POST https://configuremyai.com/desktop/tool_calls/:id/result
     { status, approval?, result }
```

Both requests carry `X-CMA-Desktop-Tools: 1` and the app's session cookie.
Redirects are not followed. `id` and `bot.id` match `^[A-Za-z0-9_-]{1,64}$`.
Calls run one at a time, so cards never stack. A call past `expires_at` is dropped.

A tool call with an unknown tool, or with an argument of the wrong type or
over its cap, is dropped without a result. Unknown argument keys are
stripped.

| arg | type | cap |
|---|---|---|
| `path`, `cwd`, `command` | string | 4096 chars |
| `content` | string | 1 MB (1,048,576 chars on the wire; 1 MB of UTF-8 when written) |
| `query` | string | 200 chars |
| `glob` | string | 100 chars, a file-name pattern (`*`, `?`), no `/` |
| `timeout_ms`, `max_bytes`, `max_results` | number | clamped per tool |

## Tools

Paths must be absolute (or start with `~/`). A path with a `..` segment
anywhere is refused before the user is asked.

| tool | args | result (`status: 'ok'`) |
|---|---|---|
| `list_dir` | `path` (folder) | `{ path, entries: [{ name, type: file\|dir\|link\|other }], total, truncated }`, at most 1000 entries |
| `read_file` | `path`, `max_bytes?` | `{ path, content, size, truncated }`, 256 KB by default, `max_bytes` up to 1 MB |
| `search_files` | `path` (folder), `query?`, `glob?`, `max_results?` (default 50, max 200) | `{ path, results: [{ path, matches?: [{ line, text }] }], scanned, truncated }` |
| `write_file` | `path`, `content` | `{ path, bytes, created }`, creates or atomically replaces |
| `create_file` | `path`, `content` | `{ path, bytes, created: true }`, never replaces an existing file |
| `delete_file` | `path` | `{ path, deleted: true }`, files only, never folders |
| `run_command` | `command`, `cwd?`, `timeout_ms?` (default 30 s, max 90 s) | `{ exit_code, signal, stdout, stderr, truncated }` (64 KB per stream) |
| `take_screenshot` | none | `{ mime, width, height, data_base64 }`, the display under the pointer, at most 1920 px wide, 5 MB |

`search_files` needs a `query` (case-insensitive substring; up to 3 matching
lines per file) or a `glob` (file name), or both. It never follows symlinks.
It skips hidden folders and `node_modules` below the given folder, and binary
files. It stops at 5000 files scanned, 8 levels deep, 1 MB read per file, 10 s,
or `max_results`, and sets `truncated: true` when it does.

## Folder approvals

The file tools work only inside a folder the user approved, for that bot.

- **The folder of a call** is `path` itself for `list_dir` and `search_files`,
  and the file's parent folder for the others.
- **First access** shows a card: **Allow once** (this call only) or
  **Always for this folder** (a standing grant for this bot), or Deny.
- **Reads** (`list_dir`, `read_file`, `search_files`) inside an approved folder
  or any folder below it run without a card.
- **Changes** (`write_file`, `create_file`, `delete_file`) always show a card,
  even in an approved folder. It shows the size, a preview of the new content,
  and whether it replaces an existing file. In an approved folder the only
  choices are Allow and Deny; there is no standing approval for changes.
  Outside one, **Always for this folder** approves the folder and allows that
  one change. The next change still asks.
- **Grants** are stored per bot as `{ tool: 'folder', prefix: <real path> }` in
  the app's data folder. They're listed in Computer → Local Computer Access,
  and each can be revoked there. Revoking brings the card back.

Every allowed file call runs with a `scope`: the approved folder. The app
refuses, with `status: 'refused'`:

- a real path (symlinks resolved) outside the scope's real path, so a symlink
  inside the folder can't reach out;
- a write, create or delete whose target is itself a symlink;
- a call with no scope at all.

## Result statuses

| `status` | meaning |
|---|---|
| `ok` | ran; `result` holds the output above. `approval` is `grant`, `once` or `always`. |
| `denied` | the user said Deny (or closed the card). Nothing ran. |
| `timeout` | nobody answered the card within 2 minutes. Nothing ran. |
| `refused` | approved, but outside the approved folder, through a symlink, or a shell command without exact-command approval. Nothing changed. |
| `error` | ran and failed (`result.error`, e.g. `not found`, `a file with that name already exists`, `the folder does not exist`), or the path was relative or had `..`. |

A result over 6 MB is replaced by `{ status: 'error', result: { error: 'result too large' } }`.
The audit log on the machine records each call and decision, never file
contents or command output.
