// The hidden recorder page (src/recorder.html): on start, open the screen
// (getDisplayMedia — main's handler picks the display) or the microphone,
// record with MediaRecorder, and send each chunk to main; on stop, finish
// and say done.

(() => {
  'use strict'
  const api = window.cmaRecorder
  if (!api) return
  let recorder = null
  let stream = null
  let pending = Promise.resolve()

  const pick = (kind) => {
    const types = kind === 'voice' ? ['audio/webm;codecs=opus', 'audio/webm'] : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || ''
  }

  api.onStart(async (input) => {
    if (recorder) return
    const kind = input && input.kind === 'voice' ? 'voice' : 'screen'
    try {
      stream = kind === 'voice'
        ? await navigator.mediaDevices.getUserMedia({ audio: true, video: false })
        : await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false })
    } catch (err) {
      api.error(err && (err.name === 'NotAllowedError' || err.name === 'SecurityError') ? 'permission' : 'failed')
      return
    }
    const mimeType = pick(kind)
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {})
    recorder.ondataavailable = (e) => {
      if (!e.data || !e.data.size) return
      pending = pending.then(() => e.data.arrayBuffer()).then((buf) => api.chunk(new Uint8Array(buf))).catch(() => {})
    }
    recorder.onstop = () => {
      for (const t of stream.getTracks()) t.stop()
      stream = null
      recorder = null
      pending.then(() => api.done())
    }
    recorder.onerror = () => api.error('failed')
    // The screen's own "stop sharing" ends it too.
    for (const t of stream.getTracks()) t.addEventListener('ended', () => { if (recorder && recorder.state !== 'inactive') recorder.stop() })
    recorder.start(Number(input && input.timesliceMs) || 1000)
  })

  api.onStop(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop()
  })
})()
