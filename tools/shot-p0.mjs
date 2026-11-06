/**
 * P0 截图验收：把「项目容器 + 拼接视图 + 保存项目」这三件事的界面拍下来。
 *
 * 与 ui-probe 分开是有意的：探针跑全部场景要几分钟，而改一版底栏只想看
 * 一眼「按钮还在不在、对话框长什么样」。这个脚本只做导航 + 点击 + 截图。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9345
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile')
mkdirSync(OUT, { recursive: true })

const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--no-proxy-server',
    '--proxy-bypass-list=<-loopback>',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    '--window-size=1480,940',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let version = null
for (let i = 0; i < 60; i += 1) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/version`)
    if (res.ok) {
      version = await res.json()
      break
    }
  } catch {
    /* 还没起来 */
  }
  await sleep(250)
}
if (!version) throw new Error('Chrome 没起来')

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json()
const cdp = await connect(tab.webSocketDebuggerUrl)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1480,
  height: 940,
  deviceScaleFactor: 1,
  mobile: false,
})

async function goto(url) {
  await cdp.send('Page.navigate', { url })
  for (let i = 0; i < 60; i += 1) {
    await sleep(200)
    const ready = await cdp.evaluate(
      `document.readyState === 'complete' && !!document.querySelector('#app .shell, #app .editor, #app > *')`,
    )
    if (ready) break
  }
  await sleep(900)
}

const store = (name) =>
  `document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('${name}')`

async function shot(name) {
  const file = path.join(OUT, `p0-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

// ---- 1. 编辑器底栏：合并模式下的项目视图
await goto(`${BASE}/?demo=1&view=editor`)
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.batchMode = 'merge'
  return true
})()`)
// 演示数据要「识别完成」才有内容
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  for (const f of s.files) if (f.status !== 'unsupported') f.status = 'pending'
  s.loadDemo(true)
  s.batchMode = 'merge'
  return s.viewFile ? s.viewFile.segments.length : -1
})()`)
await sleep(1200)
const info = await cdp.evaluate(
  `(() => {
    const s = ${store('project')}
    const v = s.viewFile
    return {
      name: v ? v.name : null,
      segments: v ? v.segments.length : 0,
      first: v && v.segments[0] ? v.segments[0].start : null,
      second: v && v.segments[0] ? v.segments[0].originFileId : null,
    }
  })()`,
)
console.log('viewFile', JSON.stringify(info))
const foot = await cdp.evaluate(
  `[...document.querySelectorAll('.editor__foot button')].map((b) => ({
    text: b.textContent.replace(/\\s+/g, ''),
    title: (b.getAttribute('title') || '').slice(0, 24),
    w: Math.round(b.getBoundingClientRect().width),
    right: Math.round(b.getBoundingClientRect().right),
  }))`,
)
console.log('foot', JSON.stringify(foot))
await shot('editor-foot')

// ---- 2. 点图标按钮 → 保存项目对话框
const pos = await cdp.evaluate(
  `(() => {
    const b = [...document.querySelectorAll('.editor__foot button')].find(
      (x) => (x.getAttribute('title') || '').includes('保存为项目文件'),
    )
    if (!b) return null
    const r = b.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })()`,
)
if (pos) {
  await cdp.click(pos.x, pos.y)
  await sleep(600)
  await shot('save-dialog')
  const dlg = await cdp.evaluate(
    `(() => {
      const p = document.querySelector('.modal__panel')
      return p ? { title: document.querySelector('.modal__title')?.textContent, hasBox: !!p.querySelector('.saveproj') } : null
    })()`,
  )
  console.log('dialog', JSON.stringify(dlg))
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(400)
}

// ---- 3. 导入页：打开项目的入口
await goto(`${BASE}/?demo=1`)
await shot('home-open')

await cdp.send('Browser.close').catch(() => {})
child.kill()
process.exit(0)
