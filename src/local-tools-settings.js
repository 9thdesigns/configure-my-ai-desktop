// Local Computer Access settings: the on/off switch, "Let Manager see your
// screen" with what it means, the standing grants (each
// revocable), and the audit trail. Built with textContent only.
(function () {
  const $ = (id) => document.getElementById(id)
  const TOOL_LABELS = { run_command: 'Command', read_file: 'Read file', list_dir: 'List folder', take_screenshot: 'Screenshot' }

  function cell (row, text) {
    const td = document.createElement('td')
    td.textContent = text == null ? '' : String(text)
    row.appendChild(td)
    return td
  }

  function table (headers) {
    const t = document.createElement('table')
    const head = t.createTHead().insertRow()
    for (const h of headers) {
      const th = document.createElement('th')
      th.textContent = h
      head.appendChild(th)
    }
    return t
  }

  function empty (text) {
    const p = document.createElement('p')
    p.className = 'empty'
    p.textContent = text
    return p
  }

  async function render () {
    const data = await window.cmaLocal.settings()
    if (!data) return
    $('enabled').checked = data.enabled !== false
    $('share-screen').checked = data.shareScreen === true
    $('screen-macos').hidden = data.platform !== 'darwin'

    const grants = $('grants')
    grants.replaceChildren()
    if (!data.grants.length) grants.appendChild(empty('Nothing is always-allowed. Every request asks first.'))
    else {
      const t = table(['Bot', 'Kind', 'Covers', 'Since', ''])
      const body = t.createTBody()
      for (const g of data.grants) {
        const row = body.insertRow()
        cell(row, g.botName)
        cell(row, TOOL_LABELS[g.tool] || g.tool)
        cell(row, g.label)
        cell(row, new Date(g.createdAt).toLocaleString())
        const btn = document.createElement('button')
        btn.textContent = 'Revoke'
        btn.addEventListener('click', async () => { await window.cmaLocal.revoke(g.id); render() })
        cell(row, '').appendChild(btn)
      }
      grants.appendChild(t)
    }

    const audit = $('audit')
    audit.replaceChildren()
    if (!data.audit.length) audit.appendChild(empty('No requests yet.'))
    else {
      const t = table(['When', 'Bot', 'Kind', 'Target', 'Decision', 'Result'])
      const body = t.createTBody()
      for (const a of data.audit) {
        const row = body.insertRow()
        cell(row, new Date(a.at).toLocaleString())
        cell(row, a.botName)
        cell(row, TOOL_LABELS[a.tool] || a.tool)
        cell(row, a.target)
        cell(row, `${a.decision} (${a.via})`)
        cell(row, a.status == null ? '' : a.exitCode != null ? `${a.status}, exit ${a.exitCode}` : a.status)
      }
      audit.appendChild(t)
    }
  }

  $('enabled').addEventListener('change', async (e) => { await window.cmaLocal.setEnabled(e.target.checked); render() })
  $('share-screen').addEventListener('change', async (e) => { await window.cmaLocal.setShareScreen(e.target.checked); render() })
  render()
})()
