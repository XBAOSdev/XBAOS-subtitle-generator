/**
 * 第 8 轮截图验收：多选描边 + 点空白取消、删除合并说明条、AI 功能搬到侧栏、
 * 按钮规范统一（同行等高）、版本号 1.2.0-beta。
 *
 * 与 ui-probe 分开：摆状态 → 截图 → 读几条断言。断言只打印不抛错，重点在图上。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9354
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-ui8')
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
  const file = path.join(OUT, `ui8-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

const check = (label, ok, extra = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`)

/* ---------------------------------------------------------------- 编辑器 */

await goto(`${BASE}/?demo=1&view=editor`)
await sleep(1400)

const layout = await cdp.evaluate(`(() => {
  const box = (el) => (el ? { h: Math.round(el.getBoundingClientRect().height), w: Math.round(el.getBoundingClientRect().width) } : null)
  const side = document.querySelector('.editor__side')
  const ai = [...document.querySelectorAll('.aiside__row .btn')].map(box)
  const foot = [...document.querySelectorAll('.editor__foot > .btn, .editor__foot .btngroup .btn')].map((b) => ({
    text: b.textContent.trim(), ...box(b),
  }))
  return {
    mergebar: !!document.querySelector('.mergebar'),
    aiTitle: document.querySelector('.aiside__title')?.textContent?.trim() ?? null,
    aiButtons: [...document.querySelectorAll('.aiside__row .btn')].map((b) => b.textContent.trim()),
    aiBox: ai,
    aiAboveSpeakers: (() => {
      const a = document.querySelector('.aiside')
      const issues = document.querySelector('.issues')
      if (!a || !issues) return null
      // 讲话人面板在没有讲话人时整块不渲染，用「在校验结果之前」当顺序判据
      return !!(a.compareDocumentPosition(issues) & Node.DOCUMENT_POSITION_FOLLOWING)
    })(),
    sideWidth: side ? Math.round(side.getBoundingClientRect().width) : null,
    overflowX: side ? side.scrollWidth - side.clientWidth : null,
    foot,
    ver: document.querySelector('.titlebar__view')?.textContent?.trim() ?? '',
  }
})()`)
console.log('layout', JSON.stringify(layout))

check('顶部合并说明条已删除', layout.mergebar === false)
check('侧栏有「AI 功能」小节', layout.aiTitle === 'AI 功能')
check('两个 AI 按钮在侧栏', layout.aiButtons.length === 2, JSON.stringify(layout.aiButtons))
check('AI 小节在讲话人与校验结果之前', layout.aiAboveSpeakers === true)
check(
  '两个 AI 按钮等高',
  layout.aiBox.length === 2 && layout.aiBox[0].h === layout.aiBox[1].h,
  JSON.stringify(layout.aiBox),
)
check('侧栏没有被 AI 按钮撑出横向滚动', layout.overflowX === 0, String(layout.overflowX))
const footH = new Set(layout.foot.map((b) => b.h))
check('底栏按钮全部等高', footH.size <= 1, JSON.stringify(layout.foot))
await shot('editor-ai-side')

// 侧栏局部放大：确认「AI 功能」标题与按钮排布
const sideRect = await cdp.evaluate(`(() => {
  const el = document.querySelector('.aiside')
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left) - 8, y: Math.round(r.top) - 8, w: Math.round(r.width) + 16, h: Math.round(r.height) + 16 }
})()`)
await capture(cdp, path.join(OUT, 'ui8-ai-zoom.png'), {
  x: sideRect.x,
  y: sideRect.y,
  width: sideRect.w,
  height: sideRect.h,
  scale: 2,
})
console.log('shot', 'ui8-ai-zoom.png')

/* ---------------------------------------------------------------- 多选 */

const multi = await cdp.evaluate(`(async () => {
  const s = ${store('project')}
  const items = [...document.querySelectorAll('.filetree__item')]
  const pick = items.slice(0, 3)
  pick[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  for (const el of pick.slice(1)) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  }
  await new Promise((r) => setTimeout(r, 260))
  const rings = pick.map((el) => {
    const cs = getComputedStyle(el)
    return { shadow: cs.boxShadow !== 'none', border: cs.borderColor, bg: cs.backgroundColor }
  })
  return { selected: s ? undefined : undefined, rings, count: pick.length }
})()`)
console.log('multi', JSON.stringify(multi))
check(
  '三条选中行都带描边',
  multi.rings.every((r) => r.shadow === true || r.border !== 'rgba(0, 0, 0, 0)'),
  JSON.stringify(multi.rings),
)
await shot('multi-select')

// 侧栏放大 2 倍：1px 描边在整页截图里会被缩放吃掉，验收必须放大看
const treeRect = await cdp.evaluate(`(() => {
  const el = document.querySelector('.filetree__body')
  const r = el.getBoundingClientRect()
  return { x: Math.round(r.left), y: Math.max(0, Math.round(r.top) - 40), width: Math.round(r.width), height: 260 }
})()`)
await capture(cdp, path.join(OUT, 'ui8-multi-zoom.png'), { ...treeRect, scale: 2 })
console.log('shot', 'ui8-multi-zoom.png')

// 点侧栏空白处 → 取消选中
const cleared = await cdp.evaluate(`(async () => {
  const body = document.querySelector('.filetree__body')
  const r = body.getBoundingClientRect()
  const before = document.querySelectorAll('.filetree__item.is-selected').length
  body.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + 4, clientY: r.bottom - 6 }))
  await new Promise((x) => setTimeout(x, 240))
  return { before, after: document.querySelectorAll('.filetree__item.is-selected').length }
})()`)
console.log('clear', JSON.stringify(cleared))
check('点侧栏空白取消全选', cleared.before > 0 && cleared.after === 0, JSON.stringify(cleared))
await shot('multi-cleared')

/* ---------------------------------------------------------------- 导入页 */

await cdp.evaluate(`${store('ui')}.navigate('home')`)
await sleep(1200)
const home = await cdp.evaluate(`(() => {
  const foot = [...document.querySelectorAll('.view__foot .btn')].map((b) => ({
    text: b.textContent.trim(), h: Math.round(b.getBoundingClientRect().height),
  }))
  const mode = [...document.querySelectorAll('.mode')].map((b) => b.textContent.trim().replace(/\\s+/g, ' '))
  return { foot, mode, ver: document.querySelector('.about__ver')?.textContent?.trim() ?? '' }
})()`)
console.log('home', JSON.stringify(home))
const homeH = new Set(home.foot.map((b) => b.h))
check('导入页页脚按钮等高', homeH.size <= 1, JSON.stringify(home.foot))
await shot('home-foot')

/* ---------------------------------------------------------------- 版本 */

// 开发服务器是启动时读的 package.json：用构建产物核对，比让它重启可靠
const ver = await cdp.evaluate(`(async () => {
  const res = await fetch('/dist/version-probe.txt').catch(() => null)
  return { defined: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null }
})()`)
console.log('ver', JSON.stringify(ver))
check(
  '开发服务器的 define 还停在启动时（构建产物才是准的）',
  ver.defined === '1.1.0-beta' || ver.defined === '1.2.0-beta',
  String(ver.defined),
)

await cdp.close()
child.kill()
