/**
 * P7 及本轮界面微调截图验收：分界线、滚动跟随、侧栏定位、底栏按钮。
 *
 * 与 ui-probe 分开：这里只做「摆状态 → 截图 → 读几条断言」。
 * 断言只打印不抛错，重点在图上。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9348
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-p7')
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
  const file = path.join(OUT, `p7-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

const check = (label, ok, extra = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`)

// ?demo=1&view=editor 已经装好一个项目（3 个子项目），不要再 loadDemo 一次 ——
// 那会再造一个内容相同的项目，侧栏里出现两份同名字的子项目，点到哪一份都说不清
await goto(`${BASE}/?demo=1&view=editor`)
await sleep(900)

// ---- 1. 分界线：只有一条线，没有名字
const sep = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const sep = document.querySelector('.subsep')
  return {
    seps: document.querySelectorAll('.subsep').length,
    names: document.querySelectorAll('.subsep__name').length,
    text: sep?.textContent?.trim() ?? '',
    height: sep ? Math.round(sep.getBoundingClientRect().height) : 0,
  }
})()`)
console.log('sep', JSON.stringify(sep))
check('分界线只有线、没有文字', sep.names === 0 && sep.text === '')
await shot('sep-line')

// ---- 2. 滚动到第二段中段：侧栏第二个子项目亮起
const follow = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const body = document.querySelector('.subtable__body')
  const at = s.itemLayout[1]
  const row = body.querySelectorAll('.row')[at.firstIndex + 2]
  body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - 6
  return { want: at.itemId, name: at.name }
})()`)
await sleep(600)
const afterScroll = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const items = [...document.querySelectorAll('.filetree__item')]
  const active = items.findIndex((el) => el.classList.contains('is-active'))
  return {
    activeFile: s.activeFileId,
    activeName: s.activeFile?.name ?? '',
    activeIndex: active,
    activeText: items[active]?.querySelector('.filetree__name')?.textContent?.trim() ?? '',
  }
})()`)
console.log('follow', JSON.stringify(follow), '→', JSON.stringify(afterScroll))
check('滚动到第二段 → 侧栏第二个子项目选中', afterScroll.activeFile === follow.want,
  `${afterScroll.activeText}`)
await shot('follow-scroll')

// ---- 3. 底栏：保存项目有文字、导出字幕还在、没有被挤出去
const foot = await cdp.evaluate(`(() => {
  const bar = document.querySelector('.editor__foot')
  const btns = [...bar.querySelectorAll('.btn')].map((b) => ({
    text: b.textContent.trim(),
    right: Math.round(b.getBoundingClientRect().right),
    width: Math.round(b.getBoundingClientRect().width),
  }))
  return { barRight: Math.round(bar.getBoundingClientRect().right), btns, scrollW: bar.scrollWidth, clientW: bar.clientWidth }
})()`)
console.log('foot', JSON.stringify(foot))
check('「保存项目」有文字', foot.btns.some((b) => b.text.includes('保存项目')))
check('底栏没有横向溢出', foot.scrollW <= foot.clientW + 1, `${foot.scrollW}/${foot.clientW}`)
check('最右按钮没超出底栏', foot.btns.every((b) => b.right <= foot.barRight))

// ---- 4. 点侧栏第三个子项目：表格跳到它那一行
const click = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const at = s.itemLayout[2]
  const items = [...document.querySelectorAll('.filetree__item')]
  const target = items.find((el) => el.querySelector('.filetree__name')?.textContent?.trim() === at.name)
  target?.click()
  return { want: at.itemId, name: at.name, firstIndex: at.firstIndex }
})()`)
await sleep(700)
const revealed = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const body = document.querySelector('.subtable__body')
  const rows = [...body.querySelectorAll('.row')]
  const top = body.getBoundingClientRect().top
  const first = rows.findIndex((r) => r.getBoundingClientRect().bottom > top + 1)
  return { activeFile: s.activeFileId, topRow: first, scrollTop: Math.round(body.scrollTop) }
})()`)
console.log('click', JSON.stringify(click), '→', JSON.stringify(revealed))
check('点侧栏子项目 → 选中它', revealed.activeFile === click.want)
// 最后一个子项目往往只有几条，滚不到顶端（容器到底就停），只要求那一行进了视口
const rowVisible = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const body = document.querySelector('.subtable__body')
  const rows = [...body.querySelectorAll('.row')]
  const at = s.itemLayout[2]
  const r = rows[at.firstIndex].getBoundingClientRect()
  const b = body.getBoundingClientRect()
  return { inView: r.bottom > b.top + 1 && r.top < b.bottom - 1, offset: Math.round(r.top - b.top) }
})()`)
console.log('rowVisible', JSON.stringify(rowVisible))
check('点侧栏子项目 → 那一行进入视口', rowVisible.inView === true, `offset=${rowVisible.offset}`)
await shot('reveal-click')

// ---- 5. 跨项目：记住各自停下的位置
const cross = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const body = document.querySelector('.subtable__body')
  body.scrollTop = 900
  const keep = Math.round(body.scrollTop)
  const from = s.activeDraftId
  const to = s.createDraft({ activate: true })
  return { keep, from, to }
})()`)
await sleep(600)
const moved = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const body = document.querySelector('.subtable__body')
  return { scrollTop: Math.round(body.scrollTop), at: s.scrollTopOf(s.activeDraftId) }
})()`)
await shot('cross-project')
await cdp.evaluate(`${store('project')}.switchDraft('${cross.from}')`)
await sleep(700)
const back = await cdp.evaluate(`(() => {
  const body = document.querySelector('.subtable__body')
  return Math.round(body.scrollTop)
})()`)
console.log('cross', JSON.stringify(cross), '→', JSON.stringify(moved), 'back', back)
check('切到另一个项目时停在它自己的位置', moved.scrollTop === moved.at)
check('切回来还原离开时的位置', Math.abs(back - cross.keep) <= 4, `${back} vs ${cross.keep}`)

// ---- 6. 右侧那句「合并时间轴由 N 段音频依次拼接」已删除
const note = await cdp.evaluate(`(() => {
  const el = [...document.querySelectorAll('.player__note')].map((e) => e.textContent.trim())
  return { notes: el, hasOld: el.some((t) => t.includes('8ms')) }
})()`)
console.log('note', JSON.stringify(note))
check('右侧说明句已删除', note.hasOld === false)

await cdp.close()
child.kill()
