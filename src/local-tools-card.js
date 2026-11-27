// The approval card. Shows the bot, the exact command or path, and three
// choices. Main enforces the two-minute default Deny; the countdown here is
// only so the user can see it coming.
(function () {
  const $ = (id) => document.getElementById(id)
  const VERBS = {
    run_command: 'wants to run a command on this computer',
    read_file: 'wants to read a file on this computer',
    list_dir: 'wants to list a folder on this computer',
    take_screenshot: 'wants to take a screenshot of your screen',
  }
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
    $('title').textContent = `${card.bot.name} ${VERBS[card.tool] || 'wants to use this computer'}`
    $('subtitle').textContent = card.tool === 'run_command' ? `In folder: ${card.cwd}` : ''
    $('target').textContent = card.target
    $('shell').hidden = !card.usesShell
    const always = $('always')
    always.hidden = !card.alwaysLabel
    always.textContent = card.tool === 'run_command'
      ? `Always allow “${card.alwaysLabel}” for ${card.bot.name}`
      : `Always allow ${card.alwaysLabel} for ${card.bot.name}`
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
