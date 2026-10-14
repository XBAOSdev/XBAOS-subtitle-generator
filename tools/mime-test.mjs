/**
 * 临时实验：验证 Blob MIME 类型标错是否会让 Chromium 拒播音频。
 * 用法：先起 Vite（XBAOS_DEV_PORT=5190），public/ 下放 __mime_test.wav。
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9444
const BASE = `http://127.0.0.1:${process.env.XBAOS_DEV_PORT || 5190}`
const PROFILE = path.resolve('.workbuddy/shots/mime-profile')

const args = [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--autoplay-policy=no-user-gesture-required',
  '--no-proxy-server',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`,
  'about:blank',
]
const child = spawn(CHROME, args, { stdio: 'ignore' })

try {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (res.ok) break
    } catch {}
    await sleep(250)
  }
  const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const tab = await tabRes.json()
  const cdp = await connect(tab.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Page.navigate', { url: BASE })
  await sleep(1500)

  const out = await cdp.evaluate(`(async () => {
    const res = await fetch('/__mime_test.wav')
    const buf = await res.arrayBuffer()
    const results = []
    for (const type of ['audio/mpeg', 'audio/wav', '']) {
      const url = URL.createObjectURL(new Blob([buf], { type }))
      const el = new Audio(url)
      el.preload = 'auto'
      const info = { type, error: null, currentTime: 0, paused: true, duration: NaN }
      el.addEventListener('error', () => { info.error = el.error ? el.error.code + '/' + (el.error.message||'') : 'unknown' })
      try {
        await el.play()
        await new Promise(r => setTimeout(r, 900))
        info.currentTime = el.currentTime
        info.paused = el.paused
        info.duration = el.duration
      } catch (e) {
        info.error = 'play(): ' + e.name + ' ' + e.message
      }
      el.pause()
      el.src = ''
      URL.revokeObjectURL(url)
      results.push(info)
    }
    return { byteLen: buf.byteLength, results }
  })()`)
  console.log(JSON.stringify(out, null, 2))
  cdp.close()
} finally {
  child.kill()
}
