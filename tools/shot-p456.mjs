/**
 * P4–P6 截图验收：多项目侧栏、子项目分界、重新识别入口。
 *
 * 与 ui-probe 分开：探针跑全套要几分钟，这里只做「摆状态 → 截图 → 读几条断言」。
 * 断言只打印不抛错，重点在图上。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9347
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-p456')
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
  const file = path.join(OUT, `p4-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

const check = (label, ok) => console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`)

// ---- 1. 导入页：默认合并、无锁
// ?demo=1 已经把演示素材放进队列，这里不再手动 loadDemo —— 否则项目与队列会各持一份
await goto(`${BASE}/?demo=1`)
await sleep(900)
await shot('home-default')
const home = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const lock = document.querySelector('.mode.is-locked')
  const tag = [...document.querySelectorAll('.field__tag')].map((e) => e.textContent.trim())
  return { mode: s.batchMode, lock: !!lock, tags: tag }
})()`)
console.log('home', JSON.stringify(home))

// ---- 2. 编辑器：一个项目、一整条字幕列表、子项目之间有分界
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.clearAll()
  s.loadDemo(true)
  ${store('ui')}.navigate('editor')
})()`)
await sleep(1400)
await shot('editor-project')
const editor = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return {
    items: s.supportedFiles.length,
    rows: document.querySelectorAll('.subtable__body .row').length,
    seps: document.querySelectorAll('.subsep').length,
    borders: document.querySelectorAll('.tl-border').length,
    viewSegs: s.viewFile?.segments.length ?? 0,
    proj: document.querySelector('.filetree__proj-name')?.textContent?.trim(),
  }
})()`)
console.log('editor', JSON.stringify(editor))

// 滚到第一个分界处，确认那条细线与上下两个小字名都画出来了
await cdp.evaluate(`(() => {
  const body = document.querySelector('.subtable__body')
  const sep = document.querySelector('.subsep')
  if (!body || !sep) return false
  // 用视觉位置换算，不用 offsetTop：offsetParent 不是 body 时会一步滚到底
  const d = sep.getBoundingClientRect().top - body.getBoundingClientRect().top
  body.scrollTop += d - body.clientHeight * 0.34
  return true
})()`)
await sleep(400)
await shot('separator')

// 时间轴那条分界线只有 1px，整页缩到 1480 宽几乎看不见：单独放大一倍拍一张
const stageBox = await cdp.evaluate(`(() => {
  const el = document.querySelector('.timeline__stage')
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
})()`)
if (stageBox) {
  const zoomFile = path.join(OUT, 'p4-timeline-border.png')
  await capture(cdp, zoomFile, { ...stageBox, scale: 2 })
  console.log('shot', zoomFile)
}
check('分界行数 = 子项目数 - 1', editor.seps === editor.items - 1)
check('时间轴分界线数量一致', editor.borders === editor.items - 1)
check('列表条数 = 拼接视图条数', editor.rows === editor.viewSegs)

// ---- 3. 多项目：第二个项目出现在侧栏、点条切换
const multi = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  if (typeof s.createDraft !== 'function') return { skipped: true }
  const before = s.supportedFiles.length
  const id = s.createDraft({ name: '第二个项目' })
  return { before, id, drafts: s.drafts.length, activeItems: s.supportedFiles.length }
})()`)
// 把第一个项目的一条搬到新项目里（跨项目拖拽的 store 路径）
const skip = multi.skipped === true
const moved = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  if (${skip}) return { skipped: true }
  s.switchDraft(s.drafts[0].id)
  const from = s.drafts[0].id
  const to = s.drafts[s.drafts.length - 1].id
  const item = s.drafts[0].files[1]
  const ok = item ? s.moveItemTo(item.id, from, to, 0) : false
  return { ok, from: s.supportedFiles.length, to: s.drafts[s.drafts.length - 1].files.length }
})()`)
console.log('multi', JSON.stringify(multi), 'moved', JSON.stringify(moved))
await sleep(600)
await shot('multi-project')

// 切到第二个项目看看
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.switchDraft(s.drafts[s.drafts.length - 1].id)
})()`)
await sleep(1000)
await shot('switch-second')


// ---- 4. 漏斗：演示数据进队列 → 开始识别 → 落地成项目 → 自动去编辑器
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.loadDemo(false)
  ${store('ui')}.navigate('home')
})()`)
await sleep(900)
await shot('intake')
const intake = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return {
    intake: s.intake.length,
    project: s.files.length,
    tiles: document.querySelectorAll('.board__grid .tile').length,
    drafts: s.drafts.length,
  }
})()`)
console.log('intake', JSON.stringify(intake))

const before = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return { drafts: s.drafts.length, intake: s.intake.length }
})()`)
await cdp.evaluate(`(() => {
  const btn = [...document.querySelectorAll('.view__foot .btn--primary')].at(-1)
  btn?.click()
})()`)
await sleep(12000)
await shot('after-recognize')
const after = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return {
    drafts: s.drafts.length,
    intake: s.intake.length,
    left: s.intake.map((f) => f.name + ':' + f.status),
    items: s.supportedFiles.length,
    view: document.querySelector('.titlebar__view')?.textContent?.trim(),
  }
})()`)
console.log('recognize', JSON.stringify(before), '→', JSON.stringify(after))
check('识别完成后队列里只剩不支持的格式', after.left.every((x) => x.endsWith(':unsupported')))
check('识别完成后落进一个项目', after.items > 0)

// ---- 5. 单子项目重新识别：只动这一条，别的子项目原样
await cdp.evaluate(`(() => {
  // 浏览器预览没有桥，确认框退回 window.confirm；headless 默认自动否定，这里直接放行
  window.confirm = () => true
  ${store('ui')}.navigate('editor')
})()`)
await sleep(1300)

const target = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const list = s.supportedFiles
  const pick = list.length > 1 ? list[1] : list[0]
  return {
    id: pick?.id ?? '',
    name: pick?.name ?? '',
    counts: list.map((f) => f.segments.length),
    total: list.length,
  }
})()`)
console.log('target', JSON.stringify(target))

await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.recognizeItem('${target.id}')
})()`)

// 中途抓一张：显示「重新识别前」这一步的进度
let mid = false
for (let i = 0; i < 40; i += 1) {
  await sleep(200)
  const busy = await cdp.evaluate(`${store('project')}.recognizing`)
  if (busy && !mid) {
    mid = true
    await shot('rerecognize-running')
    break
  }
  if (!busy && i > 3) break
}

// 等它跑完
let idle = false
for (let i = 0; i < 120; i += 1) {
  await sleep(250)
  const busy = await cdp.evaluate(`${store('project')}.recognizing`)
  if (!busy) {
    idle = true
    break
  }
}
await sleep(1400)
await shot('rerecognize-done')
const redone = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  return {
    counts: s.supportedFiles.map((f) => f.segments.length),
    seps: document.querySelectorAll('.subsep').length,
    rows: document.querySelectorAll('.subtable__body .row').length,
    viewSegs: s.viewFile?.segments.length ?? 0,
  }
})()`)
console.log('rerecognize', JSON.stringify(redone), 'idle', idle)
check('重新识别只重建了这一条', redone.counts[1] > 0 && redone.counts[0] === target.counts[0])
check('重新识别后分界与拼接视图仍然自洽',
  redone.seps === target.total - 1 && redone.rows === redone.viewSegs)

await cdp.close()
child.kill()
