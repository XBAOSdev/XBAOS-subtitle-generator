/**
 * 第 9 轮截图验收：字幕工作台改名 + 常驻可进、撤销重做进工具栏、
 * 忽略告警撤列、窄窗口横向滑动、底栏归位到侧栏右侧、状态栏改全工程合计、
 * 音频映射「当前音频」不再显示字幕路径。
 *
 * 与 ui-probe 分开：摆状态 → 截图 → 读几条断言。断言只打印不抛错，重点在图上。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9356
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-ui9')
mkdirSync(OUT, { recursive: true })

const WIDE = { width: 1480, height: 940 }
const NARROW = { width: 780, height: 900 }

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
    `--window-size=${WIDE.width},${WIDE.height}`,
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
  width: WIDE.width,
  height: WIDE.height,
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
  const file = path.join(OUT, `ui9-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

const check = (label, ok, extra = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`)

/* ---------------------------------------------------------------- 编辑器 */

await goto(`${BASE}/?demo=1&view=editor`)
await sleep(1400)

const layout = await cdp.evaluate(`(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom), r: Math.round(r.right) }
  }
  const nav = [...document.querySelectorAll('.sidebar__item')].map((b) => ({
    text: b.textContent.trim().replace(/\\s+/g, ' '),
    disabled: b.disabled,
    cls: b.className,
  }))
  return {
    nav,
    tree: rect('.filetree'),
    editor: rect('.editor'),
    body: rect('.editor__body'),
    foot: rect('.editor__foot'),
    footDetail: (() => {
      const el = document.querySelector('.editor__foot')
      if (!el) return null
      const cs = getComputedStyle(el)
      return {
        h: Math.round(el.getBoundingClientRect().height),
        scrollH: el.scrollHeight,
        padTop: cs.paddingTop, padBottom: cs.paddingBottom,
        maxH: cs.maxHeight, rows: getComputedStyle(document.querySelector('.editor')).gridTemplateRows,
      }
    })(),
    flagCells: document.querySelectorAll('.cell--flag').length,
    ackBtns: document.querySelectorAll('.row__ack').length,
    toolbar: [...document.querySelectorAll('.subtable__toolbar .op')].map((b) => ({
      text: b.textContent.trim(),
      h: Math.round(b.getBoundingClientRect().height),
      x: Math.round(b.getBoundingClientRect().left),
      r: Math.round(b.getBoundingClientRect().right),
    })),
    title: document.querySelector('.titlebar__view')?.textContent?.trim() ?? '',
    textColW: (() => {
      const cell = document.querySelector('.subtable__body .cell--text')
      return cell ? Math.round(cell.getBoundingClientRect().width) : null
    })(),
  }
})()`)
console.log('layout', JSON.stringify(layout))

check('侧栏入口叫「字幕工作台」', layout.nav[1]?.text.includes('字幕工作台'), layout.nav[1]?.text)
check('侧栏入口不再被禁用', layout.nav.every((n) => n.disabled === false && !n.cls.includes('is-disabled')))
check('页面标题也叫「字幕工作台」', layout.title === '字幕工作台', layout.title)

check(
  '底栏只占侧栏右侧（不再横跨全宽）',
  !!layout.tree && !!layout.foot && layout.foot.x >= layout.tree.r - 1,
  JSON.stringify({ treeRight: layout.tree?.r, footLeft: layout.foot?.x }),
)
check(
  '侧栏一路落到底（与底栏同底）',
  !!layout.tree && !!layout.foot && Math.abs(layout.tree.b - layout.foot.b) <= 1,
  JSON.stringify({ treeBottom: layout.tree?.b, footBottom: layout.foot?.b }),
)
check(
  '底栏宽度 = 页面宽 - 侧栏宽',
  !!layout.tree && !!layout.editor && !!layout.foot &&
    Math.abs(layout.foot.w - (layout.editor.w - layout.tree.w)) <= 2,
  JSON.stringify({ footW: layout.foot?.w, expected: layout.editor?.w - layout.tree?.w }),
)

check('「忽略告警」不再占一列', layout.flagCells === 0, String(layout.flagCells))
check('行内不再有「忽略告警」按钮', layout.ackBtns === 0, String(layout.ackBtns))
check(
  '字幕文本列拿到了腾出来的宽度',
  (layout.textColW ?? 0) >= 380,
  String(layout.textColW),
)

const undoBtn = layout.toolbar.find((b) => b.text === '撤销')
const redoBtn = layout.toolbar.find((b) => b.text === '重做')
let splitBtn = layout.toolbar.find((b) => b.text === '分割')
check('撤销 / 重做住进表格工具栏', !!undoBtn && !!redoBtn)
check(
  '撤销 / 重做紧挨着（间距 ≤ 4px）',
  !!undoBtn && !!redoBtn && redoBtn.x - undoBtn.r <= 4,
  JSON.stringify({ undoRight: undoBtn?.r, redoLeft: redoBtn?.x, gap: redoBtn && undoBtn ? redoBtn.x - undoBtn.r : null }),
)
check(
  '撤销排在「分割」之后（编辑动作连成一组）',
  !!splitBtn && !!undoBtn && undoBtn.x > splitBtn.r,
  JSON.stringify({ splitRight: splitBtn?.r, undoLeft: undoBtn?.x }),
)
const toolbarH = new Set(layout.toolbar.map((b) => b.h))
check('工具栏按钮等高', toolbarH.size <= 1, JSON.stringify([...toolbarH]))

await shot('editor')

// 工具栏放大 2 倍：1px 分隔线与按钮间距在整页图里看不出来
const barRect = await cdp.evaluate(`(() => {
  const el = document.querySelector('.subtable__toolbar')
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.round(r.top) - 2, width: Math.min(760, Math.round(r.width)), height: Math.round(r.height) + 4 }
})()`)
await capture(cdp, path.join(OUT, 'ui9-toolbar-zoom.png'), { ...barRect, scale: 2 })
console.log('shot', 'ui9-toolbar-zoom.png')

// 表格右侧：确认正文一直铺到行尾，没有留给「忽略告警」的空档
const rowRect = await cdp.evaluate(`(() => {
  const row = document.querySelector('.subtable__body .row')
  const r = row.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.max(0, Math.round(r.top) - 34), width: Math.round(r.width), height: 160 }
})()`)
await capture(cdp, path.join(OUT, 'ui9-row-zoom.png'), { ...rowRect, scale: 2 })
console.log('shot', 'ui9-row-zoom.png')

/* ---------------------------------------------------------- 窄窗口滑动 */

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: NARROW.width,
  height: NARROW.height,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(600)

const narrow = await cdp.evaluate(`(() => {
  const bar = document.querySelector('.subtable__toolbar')
  const body = document.querySelector('.subtable__body')
  const head = document.querySelector('.subtable__head')
  return {
    barScroll: bar ? { scroll: bar.scrollWidth, client: bar.clientWidth } : null,
    bodyScroll: body ? { scroll: body.scrollWidth, client: body.clientWidth } : null,
    headTransform: head ? getComputedStyle(head).transform : null,
    rowMinWidth: (() => {
      const row = document.querySelector('.subtable__body .row')
      return row ? Math.round(row.getBoundingClientRect().width) : null
    })(),
  }
})()`)
console.log('narrow', JSON.stringify(narrow))

check(
  '窄窗口下工具栏可左右滑（内容宽于可视）',
  !!narrow.barScroll && narrow.barScroll.scroll > narrow.barScroll.client,
  JSON.stringify(narrow.barScroll),
)
check(
  '窄窗口下表格可左右滑，行不再被压缩',
  !!narrow.bodyScroll && narrow.bodyScroll.scroll > narrow.bodyScroll.client,
  JSON.stringify(narrow.bodyScroll),
)
await shot('narrow')

// 横滑之后表头要跟着走，否则列名和内容对不上
const synced = await cdp.evaluate(`(async () => {
  const body = document.querySelector('.subtable__body')
  const head = document.querySelector('.subtable__head')
  body.scrollLeft = 120
  body.dispatchEvent(new Event('scroll'))
  await new Promise((r) => setTimeout(r, 220))
  return {
    scrollLeft: body.scrollLeft,
    transform: getComputedStyle(head).transform,
  }
})()`)
console.log('sync', JSON.stringify(synced))
// matrix(a, b, c, d, e, f)：第五个才是横移量
const shiftX = Number((synced.transform.match(/matrix\(([^)]*)\)/) ?? [])[1]?.split(',')[4] ?? 0)
check(
  '表头跟着正文横移（translateX ≈ -scrollLeft）',
  shiftX <= -100,
  JSON.stringify(synced),
)
await shot('narrow-scrolled')

await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: WIDE.width,
  height: WIDE.height,
  deviceScaleFactor: 1,
  mobile: false,
})
await sleep(500)

/* ------------------------------------------------------------ 音频映射 */

const mapTarget = await cdp.evaluate(`(async () => {
  const p = ${store('project')}
  const ui = ${store('ui')}
  // 纯字幕子项目 = 扩展名是字幕格式。演示数据里全是 mp3，就地造一个
  // 「导入 srt 的字幕条目」：path 指向 .srt、ext 也是 srt，这正是用户
  // 截图里那张（当前音频显示成字幕路径）的现场。
  const SUB = ['srt', 'vtt', 'ass']
  let f = p.supportedFiles.find((x) => SUB.includes(x.ext))
  if (!f) {
    f = p.supportedFiles[0]
    if (!f) return null
    f.ext = 'srt'
    f.subtitleFormat = 'srt'
    f.subtitlePath = 'D:////Podcast////数据单位换算.srt'
    f.path = 'D:////Podcast////数据单位换算.srt'
    f.dir = 'D:////Podcast'
  }
  const media = { id: f.id, name: f.name, path: f.path, ext: f.ext }
  ui.openDialog('audio-map', { fileId: f.id })
  await new Promise((r) => setTimeout(r, 500))
  const none = document.querySelector('.audiomap__none')
  const pathEl = document.querySelector('.audiomap__path')
  return {
    media,
    noneText: none?.textContent?.trim() ?? null,
    currentPath: pathEl?.textContent?.trim() ?? null,
  }
})()`)
console.log('map', JSON.stringify(mapTarget))
check(
  '纯字幕子项目的「当前音频」显示「无」',
  mapTarget?.noneText === '无',
  JSON.stringify({ none: mapTarget?.noneText, path: mapTarget?.currentPath }),
)
check(
  '不再把字幕文件路径当成音频地址',
  !(mapTarget?.currentPath ?? '').match(/\.(srt|vtt|ass)$/i),
  String(mapTarget?.currentPath),
)
await shot('audio-map')

await cdp.evaluate(`${store('ui')}.closeDialog()`)
await sleep(300)

/* -------------------------------------------------------- 状态栏全工程 */

const before = await cdp.evaluate(`(() => {
  const left = document.querySelector('.statusbar__side')
  return { text: left.textContent.trim().replace(/\\s+/g, ' ') }
})()`)

// 切到另一个项目：底栏（工作台那条）会变，最外层状态栏不该变
const switched = await cdp.evaluate(`(async () => {
  const p = ${store('project')}
  // 演示数据只有一个项目：新建一个空项目再切过去。若状态栏读的是「当前项目」，
  // 切过去之后会变成「尚未导入音频」；全工程口径则纹丝不动。
  const other =
    p.drafts.find((d) => d.id !== p.activeDraftId) ??
    (() => {
      const id = p.createDraft({ name: '临时空项目' })
      return p.drafts.find((d) => d.id === id)
    })()
  if (!other) return { skipped: true }
  await p.switchDraft(other.id)
  await new Promise((r) => setTimeout(r, 600))
  return {
    left: document.querySelector('.statusbar__side').textContent.trim().replace(/\\s+/g, ' '),
    foot: document.querySelector('.editor__foot')?.textContent.trim().replace(/\\s+/g, ' ') ?? '',
    active: p.activeDraftId,
  }
})()`)
console.log('switch', JSON.stringify({ before, switched }))
check(
  '切项目后最外层状态栏仍是全工程合计',
  switched.skipped === true || switched.left === before.text,
  JSON.stringify({ before: before.text, after: switched.left }),
)

/* ---------------------------------------------------------------- 空态 */

const empty = await cdp.evaluate(`(async () => {
  const p = ${store('project')}
  for (const f of [...p.files]) p.removeItem(f.id)
  await new Promise((r) => setTimeout(r, 600))
  return {
    empty: !!document.querySelector('.editor__empty'),
    text: document.querySelector('.editor__empty-title')?.textContent?.trim() ?? '',
  }
})()`)
console.log('empty', JSON.stringify(empty))
check('没有内容时显示空态而不是一堆空控件', empty.empty === true, JSON.stringify(empty))
await shot('empty')

await cdp.close()
child.kill()
