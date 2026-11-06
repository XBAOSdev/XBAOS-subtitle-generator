import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9350
const BASE = 'http://127.0.0.1:5173'
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-p7dbg')

const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  '--no-first-run', '--no-proxy-server', '--proxy-bypass-list=<-loopback>',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, '--window-size=1480,940', 'about:blank'],
  { stdio: 'ignore' })
for (let i = 0; i < 60; i += 1) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break } catch {}
  await sleep(250)
}
const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const cdp = await connect(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable'); await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1480, height: 940, deviceScaleFactor: 1, mobile: false })
cdp.on?.('Runtime.consoleAPICalled', () => {})
await cdp.send('Page.navigate', { url: `${BASE}/?demo=1&view=editor` })
await sleep(3200)

const store = (n) => `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('${n}')`

// 1) 先滚到第二段
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const body = document.querySelector('.subtable__body')
  const at = s.itemLayout[1]
  const row = body.querySelectorAll('.row')[at.firstIndex + 2]
  body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - 6
})()`)
await sleep(500)

// 2) 点第三个子项目，逐步看状态
const step = await cdp.evaluate(`(async () => {
  const s = ${store('project')}
  const at = s.itemLayout[2]
  const items = [...document.querySelectorAll('.filetree__item')]
  const target = items.find((el) => el.querySelector('.filetree__name')?.textContent?.trim() === at.name)
  const body = document.querySelector('.subtable__body')
  const before = {
    active: s.activeFileId, scroll: Math.round(body.scrollTop), req: s.revealRequest,
  }
  target.click()
  const justAfter = {
    active: s.activeFileId, scroll: Math.round(body.scrollTop), req: s.revealRequest,
  }
  await new Promise((r) => setTimeout(r, 500))
  const rows = [...body.querySelectorAll('.row')]
  const top = body.getBoundingClientRect().top
  return {
    want: at.itemId, firstIndex: at.firstIndex, before, justAfter,
    after: {
      active: s.activeFileId, scroll: Math.round(body.scrollTop),
      topRow: rows.findIndex((r) => r.getBoundingClientRect().bottom > top + 1),
      rowOffset: Math.round(rows[at.firstIndex].getBoundingClientRect().top - top),
      maxScroll: Math.round(body.scrollHeight - body.clientHeight),
    },
  }
})()`)
console.log(JSON.stringify(step, null, 1))

await cdp.close(); child.kill()
