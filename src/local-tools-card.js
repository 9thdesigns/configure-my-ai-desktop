// The approval card. Shows the bot, the exact command or path, and its
// choices: Allow once, Always (for this command / this folder), Deny. A file
// change (write, create, delete) shows what it will do — the size, a preview
// of the new content, whether it replaces a file — and is asked every time,
// even in an approved folder. Main enforces the two-minute default Deny; the
// countdown here is only so the user can see it coming.
(function () {
  const $ = (id) => document.getElementById(id)
  const VERBS = {
    run_command: 'wants to run a command on this computer',
    read_file: 'wants to read a file on this computer',
    list_dir: 'wants to list a folder on this computer',
    take_screenshot: 'wants to take a screenshot of your screen',
    search_files: 'wants to search a folder on this computer',
    write_file: 'wants to change a file on this computer',
    create_file: 'wants to create a file on this computer',
    delete_file: 'wants to delete a file on this computer',
  }
  const FILE_TOOLS = ['read_file', 'list_dir', 'search_files', 'write_file', 'create_file', 'delete_file']
  const size = (n) => (n < 1024 ? `${n} bytes` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
  let current = null
  let timer = null

  function answer (choice) {
    if (!current) return
    window.cmaLocal.decide(current.id, choice)
    current = null
    clearInterval(timer)
    $('card').hidden = true
  }

  window.cmaLocal.onCard((card) => {
    current = card
    const file = FILE_TOOLS.includes(card.tool)
    const verb = card.tool === 'write_file' && !card.exists ? VERBS.create_file : VERBS[card.tool]
    $('title').textContent = `${card.bot.name} ${verb || 'wants to use this computer'}`
    $('subtitle').textContent = card.tool === 'run_command'
      ? `In folder: ${card.cwd}`
      : file ? `In folder: ${card.folder}${card.folderApproved ? ' (approved)' : ''}` : ''
    $('target').textContent = card.tool === 'search_files' && card.query ? `${card.target}\nSearching for: ${card.query}` : card.target

    // A change: what it does, and the new content.
    const meta = []
    if (card.change) {
      if (card.tool === 'delete_file') meta.push(card.exists ? `Deletes this file${card.bytes != null ? ` (${size(card.bytes)})` : ''}.` : 'This file doesn’t exist.')
      else meta.push(`${card.exists ? 'Replaces the existing file' : 'Creates a new file'} — ${size(card.bytes || 0)}.`)
    }
    $('change-meta').textContent = meta.join(' ')
    $('change-meta').hidden = meta.length === 0
    const preview = $('preview')
    preview.hidden = !(card.change && typeof card.preview === 'string' && card.tool !== 'delete_file')
    preview.textContent = preview.hidden ? '' : (card.preview || '(empty file)') + (card.previewTruncated ? '\n…' : '')
    const note = $('folder-note')
    note.hidden = !(card.change && card.alwaysLabel)
    note.textContent = note.hidden ? '' : 'Approving the folder lets it read there without asking; changes will still ask each time.'

    $('shell').hidden = !card.usesShell
    $('once').textContent = card.change && card.folderApproved ? (card.tool === 'delete_file' ? 'Delete' : 'Allow this change') : 'Allow once'
    const always = $('always')
    always.hidden = !card.alwaysLabel
    always.title = file && card.folder ? card.folder : ''
    always.textContent = card.tool === 'run_command'
      ? `Always allow “${card.alwaysLabel}” for ${card.bot.name}`
      : file ? 'Always for this folder' : `Always allow ${card.alwaysLabel} for ${card.bot.name}`
    $('card').hidden = false
    const deadline = Date.now() + card.timeoutMs
    clearInterval(timer)
    const tick = () => {
      const s = Math.max(0, Math.round((deadline - Date.now()) / 1000))
      $('countdown').textContent = `Denied automatically in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
    }
    tick()
    timer = setInterval(tick, 1000)
    $('deny').focus()
  })

  $('once').addEventListener('click', () => answer('once'))
  $('always').addEventListener('click', () => answer('always'))
  $('deny').addEventListener('click', () => answer('deny'))
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') answer('deny') })
})()
