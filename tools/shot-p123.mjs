/**
 * P1–P3 截图验收：项目级讲话人、音频缺失与映射、纯字幕子项目。
 *
 * 与 ui-probe 分开是有意的：探针跑全部场景要几分钟，这里只做导航 + 点击 + 截图。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9346
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-p123')
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

const tab = await (
  await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
).json()
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
  const file = path.join(OUT, `p1-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

async function centerOf(selector) {
  return cdp.evaluate(
    `(() => {
      const el = document.querySelector('${selector}')
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    })()`,
  )
}

// ---- 1. 合并模式侧栏：项目条 + 子项目行
await goto(`${BASE}/?demo=1&view=editor`)
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.loadDemo(true)
  s.batchMode = 'merge'
  return s.supportedFiles.length
})()`)
await sleep(1200)
await shot('tree-merge')

const tree = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return {
    rows: document.querySelectorAll('.filetree__sub').length,
    proj: document.querySelector('.filetree__proj-name')?.textContent?.trim(),
    files: s.supportedFiles.length,
    fold: !!document.querySelector('.filetree__fold'),
  }
})()`)
console.log('tree-merge', JSON.stringify(tree))

// ---- 2. 折叠：点箭头，子项目收起来
const fold = await centerOf('.filetree__fold')
if (fold) {
  await cdp.click(fold.x, fold.y)
  await sleep(400)
  await shot('tree-folded')
  const rows = await cdp.evaluate(
    `(() => {
      const list = document.querySelector('.filetree__list')
      return { display: list ? getComputedStyle(list).display : null }
    })()`,
  )
  console.log('folded', JSON.stringify(rows))
  await cdp.click(fold.x, fold.y)
  await sleep(400)
}

// ---- 3. 独立模式侧栏：同一套项目视图
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.batchMode = 'separate'
  return true
})()`)
await sleep(700)
await shot('tree-separate')
const sep = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return { active: !!document.querySelector('.filetree__item.is-active'), mode: s.batchMode }
})()`)
console.log('tree-separate', JSON.stringify(sep))

// ---- 4. 音频缺失：提示条 + 映射弹窗
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.batchMode = 'merge'
  const id = s.supportedFiles[0].id
  s.mediaState[id] = 'missing'
  return id
})()`)
await sleep(600)
await shot('audio-bar')

const fix = await centerOf('.audbar .btn')
if (fix) {
  await cdp.click(fix.x, fix.y)
  await sleep(600)
  await shot('audio-map')
  const dlg = await cdp.evaluate(`(() => {
    const p = document.querySelector('.modal__panel')
    return p
      ? {
          title: document.querySelector('.modal__title')?.textContent?.trim(),
          hasBox: !!p.querySelector('.audiomap'),
          hint: p.querySelector('.audiomap__hint')?.textContent?.trim(),
          state: p.querySelector('.audiomap__note')?.textContent?.trim(),
        }
      : null
  })()`)
  console.log('audio-map', JSON.stringify(dlg))
  await cdp
    .send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    .catch(() => {})
  await cdp
    .send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Escape',
      code: 'Escape',
      windowsVirtualKeyCode: 27,
    })
    .catch(() => {})
  await sleep(400)
}

// ---- 5. 讲话人面板：共用称呼是「本项目」
const seeded = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.batchMode = 'merge'
  // 演示数据没有讲话人编号，讲话人面板就不会渲染 —— 手动打上两位
  for (const f of s.supportedFiles) {
    f.segments.forEach((seg, i) => { seg.speaker = i % 2 })
  }
  return s.supportedFiles.map((f) => f.segments.length)
})()`)
console.log('seeded', JSON.stringify(seeded))
await sleep(900)

const share = await cdp.evaluate(`(() => {
  const el = document.querySelector('.speakers__share-check span')
  return el ? el.textContent.trim() : null
})()`)
console.log('share-label', share)
const speakersPanel = await cdp.evaluate(`(() => {
  const el = document.querySelector('.speakers__share')
  if (!el) return null
  el.scrollIntoView({ block: 'center' })
  return true
})()`)
if (speakersPanel) {
  await sleep(400)
  await shot('speaker-share')
}

// ---- 6. 对应关系表：一个子项目一列
const mapBtn = await centerOf('.speakers__mapbtn')
if (mapBtn) {
  await cdp.click(mapBtn.x, mapBtn.y)
  await sleep(700)
  await shot('speaker-map')
  const map = await cdp.evaluate(`(() => {
    const cols = [...document.querySelectorAll('.spkmap__file')].map((th) =>
      (th.textContent || '').trim(),
    )
    return { cols, rows: document.querySelectorAll('.spkmap__cell').length }
  })()`)
  console.log('speaker-map', JSON.stringify(map))
}

await cdp.send('Browser.close').catch(() => {})
child.kill()
process.exit(0)
