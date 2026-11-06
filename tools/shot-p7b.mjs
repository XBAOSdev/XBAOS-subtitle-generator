/**
 * P7 截图验收：右键菜单（项目条 / 子项目 / 多选）、侧栏搜索、行内改名、保存全部小三角。
 *
 * 与 ui-probe 分开：摆状态 → 截图 → 读几条断言。断言只打印不抛错，重点在图上。
 */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9352
const BASE = 'http://127.0.0.1:5173'
const OUT = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/shot-profile-p7b')
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
  const file = path.join(OUT, `p7b-${name}.png`)
  await capture(cdp, file)
  console.log('shot', file)
}

const check = (label, ok, extra = '') =>
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${extra ? ` ${extra}` : ''}`)

/** 菜单里现在都有哪几项（含子菜单根项，不含子菜单展开项） */
const menuLabels = `(() => {
  const roots = document.querySelectorAll('.menu')
  const last = roots[roots.length - 1]
  return last ? [...last.querySelectorAll(':scope > * .menu__item, :scope > .menu__item')].map((e) => e.textContent.trim()) : []
})()`

/** 关掉浮层菜单：UiMenu 靠遮罩 mousedown.self 关（body.click 够不着） */
const closeMenu = `(() => {
  const layer = document.querySelector('.menulayer')
  if (layer) layer.dispatchEvent(new MouseEvent('mousedown', { bubbles: false }))
})()`

await goto(`${BASE}/?demo=1&view=editor`)
await sleep(900)

// 再造第二个项目（搬一个子项目过去），菜单里的「移到…」才有目标
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const id = s.createDraft({ activate: false })
  s.moveItemTo(s.supportedFiles[2].id, s.activeDraftId, id, 0)
  return s.drafts.length
})()`)
await sleep(500)

// ---- 1. 子项目右键菜单
await cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.filetree__sub')]
  const el = rows[0]
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 8 }))
})()`)
await sleep(400)
const itemMenu = await cdp.evaluate(menuLabels)
console.log('item-menu', JSON.stringify(itemMenu))
check(
  '子项目菜单含重命名/重新识别/音频映射/导出/保存字幕/移到/移除',
  ['重命名', '重新识别', '音频映射', '导出这一条…', '单独保存为字幕…', '移到…', '从项目中移除'].every(
    (t) => itemMenu.some((x) => x.startsWith(t)),
  ),
  JSON.stringify(itemMenu),
)
await shot('item-menu')

// ---- 2. 「移到…」子菜单
await cdp.evaluate(`(() => {
  const roots = document.querySelectorAll('.menu')
  const last = roots[roots.length - 1]
  const it = [...last.querySelectorAll('.menu__item')].find((e) => e.textContent.includes('移到'))
  it?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
})()`)
await sleep(400)
const subMenu = await cdp.evaluate(`(() => {
  const roots = document.querySelectorAll('.menu')
  return roots.length
})()`)
check('「移到…」展开出子菜单（两个菜单层）', subMenu >= 2, `layers=${subMenu}`)
await shot('move-submenu')
await cdp.evaluate(closeMenu)
await sleep(300)

// ---- 3. 项目条右键菜单
await cdp.evaluate(`(() => {
  const bars = [...document.querySelectorAll('.filetree__proj')]
  const el = bars[0]
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 60, clientY: r.top + 8 }))
})()`)
await sleep(400)
const draftMenu = await cdp.evaluate(menuLabels)
console.log('draft-menu', JSON.stringify(draftMenu))
check(
  '项目条菜单含重命名/保存/另存为/在文件夹中显示/关闭/删除/全部折叠/全部展开',
  ['重命名', '保存', '另存为…', '在文件夹中显示', '关闭项目', '删除项目…', '全部折叠', '全部展开'].every(
    (t) => draftMenu.some((x) => x.startsWith(t)),
  ),
  JSON.stringify(draftMenu),
)
await shot('draft-menu')
await cdp.evaluate(closeMenu)
await sleep(300)

// ---- 4. 多选两条 → 右键：单选专属项消失
await cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.filetree__sub .filetree__item')]
  rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  rows[1].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
})()`)
await sleep(300)
const multiSel = await cdp.evaluate(`(() => {
  return [...document.querySelectorAll('.filetree__item.is-selected')].length
})()`)
check('Ctrl 点两条都在选区里', multiSel === 2, `selected=${multiSel}`)
await cdp.evaluate(`(() => {
  const rows = [...document.querySelectorAll('.filetree__sub')]
  const el = rows[0]
  const r = el.getBoundingClientRect()
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 8 }))
})()`)
await sleep(400)
const multiMenu = await cdp.evaluate(menuLabels)
console.log('multi-menu', JSON.stringify(multiMenu))
check(
  '多选菜单不出「重命名 / 重新识别 / 音频映射」这些单选专属项',
  !multiMenu.some((x) => x.startsWith('重命名')) &&
    !multiMenu.some((x) => x.startsWith('重新识别')) &&
    !multiMenu.some((x) => x.startsWith('音频映射')),
  JSON.stringify(multiMenu),
)
check(
  '多选菜单保留批量动作（保存字幕 / 移到 / 移除）',
  multiMenu.some((x) => x.includes('单独保存')) &&
    multiMenu.some((x) => x.startsWith('移到')) &&
    multiMenu.some((x) => x.includes('从项目中移除')),
  JSON.stringify(multiMenu),
)
await shot('item-menu-multi')
await cdp.evaluate(closeMenu)
await sleep(300)

// ---- 5. 搜索
await cdp.evaluate(`(() => {
  const inp = document.querySelector('.filetree__search')
  inp.value = '片头'
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(400)
const search = await cdp.evaluate(`(() => {
  return {
    rows: document.querySelectorAll('.filetree__group').length,
    items: document.querySelectorAll('.filetree__sub').length,
    names: [...document.querySelectorAll('.filetree__name')].map((e) => e.textContent.trim()),
    hint: document.querySelector('.filetree__hint')?.textContent?.trim() ?? '',
  }
})()`)
console.log('search', JSON.stringify(search))
check('搜索「片头」只剩命中那一条子项目', search.items === 1 && search.names[0].includes('片头'), JSON.stringify(search))
await shot('search')
await cdp.evaluate(`(() => {
  const inp = document.querySelector('.filetree__search')
  inp.value = ''
  inp.dispatchEvent(new Event('input', { bubbles: true }))
})()`)
await sleep(300)

// ---- 6. 双击项目名改名
await cdp.evaluate(`(() => {
  const name = document.querySelector('.filetree__proj-name')
  name.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
})()`)
await sleep(400)
const rename = await cdp.evaluate(`(() => {
  const inp = document.querySelector('.filetree__rename')
  return { open: !!inp, value: inp?.value ?? '' }
})()`)
console.log('rename', JSON.stringify(rename))
check('双击项目名出输入框且带原名', rename.open && rename.value.length > 0, JSON.stringify(rename))
await shot('rename')
await cdp.evaluate(`(() => {
  const inp = document.querySelector('.filetree__rename')
  inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
})()`)
await sleep(300)

// ---- 7. 两个项目都有改动 → 保存项目右侧出小三角 → 展开「保存全部项目」
const dirty = await cdp.evaluate(`(() => {
  const s = ${store('project')}
  const first = s.supportedFiles[0]
  s.renameItem(first.id, first.name + ' ')
  const other = s.drafts.find((d) => d.id !== s.activeDraftId)
  s.switchDraft(other.id)
  return s.drafts.length
})()`)
await sleep(600)
await cdp.evaluate(`(() => {
  const s = ${store('project')}
  s.renameItem(s.supportedFiles[0].id, s.supportedFiles[0].name + ' ')
})()`)
await sleep(400)
const caret = await cdp.evaluate(`(() => {
  return {
    drafts: ${store('project')}.drafts.length,
    caret: document.querySelectorAll('.editor__caret').length,
  }
})()`)
console.log('caret', JSON.stringify(caret))
check('多项目有改动 → 「保存项目」右侧出小三角', caret.caret === 1, JSON.stringify(caret))
await cdp.evaluate(`(() => {
  document.querySelector('.editor__caret').dispatchEvent(new MouseEvent('click', { bubbles: true }))
})()`)
await sleep(400)
const saveMenu = await cdp.evaluate(menuLabels)
console.log('save-menu', JSON.stringify(saveMenu))
check('小三角展开出「保存全部项目」', saveMenu.some((x) => x.includes('保存全部项目')), JSON.stringify(saveMenu))
await shot('save-all-menu')
await cdp.evaluate(closeMenu)
await sleep(200)

await cdp.close()
child.kill()
