/**
 * 官网（D:\Code\Website\Subtitle）验收探针。
 *
 * 官网没有构建步骤，改完只能靠肉眼点。但有两件事必须被机器守住：
 *   1. 首页显示的版本号 / 下载链接**确实来自 `/data/subtitle.json`**（而不是 HTML 里写死的兜底值）
 *   2. 更新日志页的条目**确实由同一份清单渲染**（顺序、当前版本标签、条目数）
 * 清单是唯一真相源，改错了不会报错，只会静默显示旧版本号 —— 所以这里塞哨兵值验证。
 *
 * 做法：把站点复制到系统临时目录 → 把两个页面里的清单地址改写成 `data:` URL
 * （内容 = 塞了哨兵值的清单）→ 无头 Chrome 渲染 → 断言 DOM。**不动站点里的任何文件**。
 *
 * 为什么不用「起个本地http服务」：无头浏览器在受限环境里连不上 127.0.0.1，会直接挂住；
 * `file://` + `data:` 完全不碰网络，跑得又快又稳。
 *
 * 用法：node tools/site-probe.mjs
 *   XBAOS_SITE_DIR   站点目录（默认 D:\Code\Website\Subtitle）
 *   XBAOS_CHROME     浏览器可执行文件（默认自动找 Chrome / Edge）
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SITE_DIR = resolve(process.env.XBAOS_SITE_DIR || 'D:\\Code\\Website\\Subtitle')
// 临时目录放系统 temp 里：跑完清不掉也不污染仓库（受限环境会拦 rm，删除一律 best-effort）
const WORK_DIR = join(tmpdir(), 'xbaos-site-probe')
/** 截图落点，与其它探针统一放 .workbuddy/shots */
const SHOTS_DIR = fileURLToPath(new URL('../.workbuddy/shots/', import.meta.url))

const SENTINEL_VERSION = '9.9.9'
const SENTINEL_DATE = '2099-01-01'
const SENTINEL_DOWNLOAD = 'https://example.com/PROBE-SENTINEL-DOWNLOAD'
const SENTINEL_TITLE = 'PROBE-SENTINEL-TITLE'
const OLD_TITLE = 'PROBE-OLDER-RELEASE'
const ORIGINAL_MANIFEST = 'https://subtitle.xbaos.com.cn/data/subtitle.json'

let pass = 0
let fail = 0

function check(label, ok, detail = '') {
  if (ok) {
    pass++
    console.log(`  ok  ${label}`)
  } else {
    fail++
    console.log(`  FAIL ${label}${detail ? `\n        ${detail}` : ''}`)
  }
}

function safeClean(dir) {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 受限环境里删除可能被拦下；临时目录留着不影响下次运行（会被覆盖） */
  }
}

function findChrome() {
  if (process.env.XBAOS_CHROME && existsSync(process.env.XBAOS_CHROME)) return process.env.XBAOS_CHROME
  return (
    [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ].find((p) => existsSync(p)) || ''
  )
}

function render(chrome, file) {
  const result = spawnSync(
    chrome,
    [
      // 老式 headless 比 --headless=new 稳：新实现在部分受限环境下会挂住不返回
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      `--user-data-dir=${join(WORK_DIR, 'chrome-profile')}`,
      '--virtual-time-budget=5000',
      '--dump-dom',
      pathToFileURL(file).href,
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 90_000 },
  )
  if (result.error) throw result.error
  const dom = result.stdout || ''
  if (!dom.trim()) {
    const why = (result.stderr || '').trim().split('\n').slice(-1)[0] || '没有任何输出'
    throw new Error(`渲染 ${file} 失败：${why}`)
  }
  return dom
}

/** 页面里的「读不到清单」提示是否处于显示状态（初始 HTML 带 hidden，脚本摘掉它才可见） */
function shouldShowState(dom) {
  const tag = dom.match(/<p[^>]*id="log-state"[^>]*>/)
  return !!tag && !/\shidden/.test(tag[0])
}

/** 出一张整页截图，给肉眼核对用。失败的截图只记一条 FAIL，绝不中断探针 */
function shoot(chrome, file, outPath) {
  try {
    mkdirSync(SHOTS_DIR, { recursive: true })
    const result = spawnSync(
      chrome,
      [
        '--headless',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--no-first-run',
        `--user-data-dir=${join(WORK_DIR, 'chrome-profile')}`,
        '--window-size=1440,2000',
        // 不加这两句，截图里大图会是空框：合成器还没画完就落盘了
        '--run-all-compositor-stages-before-draw',
        '--disable-new-content-rendering-timeout',
        '--virtual-time-budget=10000',
        `--screenshot=${outPath}`,
        pathToFileURL(file).href,
      ],
      { encoding: 'utf8', timeout: 90_000 },
    )
    if (result.error) throw result.error
    if (!existsSync(outPath)) throw new Error('浏览器没有产出文件')
    check(`截图 ${outPath.split(/[\\/]/).pop()}`, true)
  } catch (err) {
    check(`截图 ${outPath.split(/[\\/]/).pop()}`, false, err instanceof Error ? err.message : String(err))
  }
}

function asDataUrl(value) {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(value))}`
}

function main() {
  console.log('官网探针：清单是不是真的驱动了页面')

  if (!existsSync(SITE_DIR)) {
    console.log(`  FAIL 找不到站点目录 ${SITE_DIR}`)
    process.exit(1)
  }
  const chrome = findChrome()
  if (!chrome) {
    console.log('  FAIL 找不到 Chrome / Edge，可用 XBAOS_CHROME 指定路径')
    process.exit(1)
  }

  safeClean(WORK_DIR)
  mkdirSync(WORK_DIR, { recursive: true })
  const root = join(WORK_DIR, 'site')
  cpSync(SITE_DIR, root, { recursive: true })

  const pages = ['index.html', 'changelog.html']
  const originalManifest = JSON.parse(readFileSync(join(root, 'data', 'subtitle.json'), 'utf8'))

  const sentinelManifest = {
    ...originalManifest,
    latest: SENTINEL_VERSION,
    updated: SENTINEL_DATE,
    download: { ...(originalManifest.download || {}), url: SENTINEL_DOWNLOAD },
    releases: [
      { version: SENTINEL_VERSION, title: SENTINEL_TITLE, date: SENTINEL_DATE, items: ['哨兵条目一', '哨兵条目二'] },
      { version: '0.0.9', title: OLD_TITLE, date: '2026-01-01', items: ['旧版本占位'] },
    ],
  }

  /** 把页面里的清单地址换掉（两个页面各有 meta 与脚本兜底两处，必须全部替换） */
  let currentManifest = ORIGINAL_MANIFEST
  function pointManifest(url) {
    for (const page of pages) {
      const file = join(root, page)
      const html = readFileSync(file, 'utf8').split(currentManifest).join(url)
      if (!html.includes(url)) {
        throw new Error(`${page} 里没找到清单地址 ${currentManifest} —— 探针的改写规则要跟着改`)
      }
      writeFileSync(file, html)
    }
    currentManifest = url
  }

  try {
    // ---- 先用**站点自己的清单内容**出两张截图（哨兵值会让人看不懂图）
    pointManifest(asDataUrl(originalManifest))
    shoot(chrome, join(root, 'index.html'), join(SHOTS_DIR, 'site-home.png'))
    shoot(chrome, join(root, 'changelog.html'), join(SHOTS_DIR, 'site-changelog.png'))

    // ---- 再换成塞了哨兵值的清单，断言「页面显示的确实是清单里的东西」
    pointManifest(asDataUrl(sentinelManifest))

    // ---- 首页：版本号 / 日期 / 下载链接是否来自清单
    const home = render(chrome, join(root, 'index.html'))
    check('首页版本号来自清单', home.includes(SENTINEL_VERSION), `哨兵值 ${SENTINEL_VERSION}`)
    check('首页更新日期来自清单', home.includes(SENTINEL_DATE))
    check('首页下载链接被清单的 download.url 覆盖', home.includes(SENTINEL_DOWNLOAD))
    check(
      '首页写死的兜底下载链接已被覆盖',
      !home.includes('example.com/xbaos-subtitle-download'),
      '没被覆盖 = 清单没生效',
    )
    check('首页兜底的旧版本号已被替换', !/id="dl-version"[^>]*>0\.1\.0</.test(home))

    // ---- 更新日志页：条目、顺序、当前版本标签
    const log = render(chrome, join(root, 'changelog.html'))
    check('更新日志渲染出最新一版的标题', log.includes(SENTINEL_TITLE))
    check('更新日志同时渲染出更早的版本', log.includes(OLD_TITLE))
    check(
      '更新日志按清单顺序排（新的在上）',
      log.indexOf(SENTINEL_TITLE) > -1 && log.indexOf(SENTINEL_TITLE) < log.indexOf(OLD_TITLE),
    )
    check('更新日志标出了「当前版本」', log.includes('当前版本'))
    check('更新日志渲染了条目正文', log.includes('哨兵条目一') && log.includes('哨兵条目二'))
    check('更新日志顶部的版本号与清单一致', log.includes(`>${SENTINEL_VERSION}<`))
    check('清单正常时「读不到清单」的提示不出现', !shouldShowState(log))

    // ---- 降级：清单拿回来不是 JSON
    pointManifest('data:text/plain;charset=utf-8,not-a-json')
    const broken = render(chrome, join(root, 'changelog.html'))
    check('清单不是 JSON 时显示提示而不是空白页', shouldShowState(broken), broken.match(/<p[^>]*id="log-state"[^>]*>/)?.[0] || '没找到提示元素')
    check('降级时页面标题与页脚仍在（不是白屏）', broken.includes('返回首页'))
  } finally {
    safeClean(WORK_DIR)
  }

  console.log(`\n通过 ${pass}，失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

try {
  main()
} catch (err) {
  console.error(err)
  process.exit(1)
}
