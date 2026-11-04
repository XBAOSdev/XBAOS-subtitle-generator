/**
 * 官网截图生成器。
 *
 * 与 ui-probe 分开：那个是「验收」，这个是「出图」。跑出来直接写进
 * 官网的 `assets/`，文件名与页面里 `<img src>` 引用的一一对上 ——
 * 早先版本先写到 `.workbuddy/shots/site-*.png` 再靠手工改名复制，
 * 那一步很容易漏掉某一张、或者名字对不上（页面引用的还是旧图）。
 *
 * 关键点是 URL 里那个 `update=latest`：不带它，启动时的自动检查会因为
 * 开发机连不上更新服务器而在左下角留一句「更新检查失败」—— 那是探针环境的
 * 产物，不该出现在官网上。
 *
 * 用法：`node tools/site-shots.mjs`（需要 `npm run dev:ui` 已起）
 * 输出目录可用 `XBAOS_SITE_ASSETS` 覆盖，默认 D:/Code/Website/Subtitle/assets。
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
const BASE = `http://127.0.0.1:${process.env.XBAOS_DEV_PORT || 5173}`
const OUT_DIR = process.env.XBAOS_SITE_ASSETS || path.resolve('D:/Code/Website/Subtitle/assets')
const PROFILE = path.resolve('.workbuddy/shots/site-shot-profile')

mkdirSync(OUT_DIR, { recursive: true })

/** 统一带上的查询串：演示数据 + 浅色 + 假装更新已是最新 */
const COMMON = 'demo=1&theme=light&update=latest'

/*
 * 文件名就是官网 assets 里的名字，不要改 —— 页面里写死了这几个引用。
 * 宽高对应 index.html 里 <img> 的 width/height（这里是 CSS 像素，落盘是 2 倍图）。
 *
 * **`shot-models.png` 不在这里**：可下载的模型清单由主进程给，浏览器预览拿不到，
 * 拍出来是一张空壳。那张图由 `node tools/electron-probe.mjs site-models` 从真实应用出，
 * 写的是同一个目录 —— 放进这个列表只会被这里覆盖掉。
 */
const SHOTS = [
  // 首屏大图：编辑器，最有说服力的一张
  { file: 'shot-editor.png', query: `view=editor&${COMMON}`, w: 1454, h: 840 },
  // 图文块 1：导入页
  { file: 'shot-import.png', query: `view=home&${COMMON}`, w: 1454, h: 840 },
  // 图文块 2：辅助窗口本身就是 720 宽的窄窗，按它的真实比例出图。
  // 不带 `task` 才是校对那一侧 —— 带着图注讲的却是校对，对不上
  { file: 'shot-assist.png', query: `window=assist&${COMMON}`, w: 720, h: 840 },
]

/* 只重拍其中一张：`node tools/site-shots.mjs assist`，避免为了改一张把三张都覆盖一遍 */
const only = process.argv[2] || ''
const shots = only ? SHOTS.filter((s) => s.file.includes(only)) : SHOTS
if (shots.length === 0) throw new Error(`没有文件名包含「${only}」的截图`)

async function main() {
  const child = spawn(CHROME, [
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
    'about:blank',
  ], { stdio: 'ignore' })

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
  if (!version) throw new Error('Chrome 调试端口未就绪')

  const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  const tab = await tabRes.json()
  const cdp = await connect(tab.webSocketDebuggerUrl)

  for (const shot of shots) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: shot.w,
      height: shot.h,
      deviceScaleFactor: 2,
      mobile: false,
    })
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    const loaded = cdp.once('Page.loadEventFired')
    await cdp.send('Page.navigate', { url: `${BASE}/?${shot.query}` })
    await loaded
    /*
     * 等 1.5s 让界面把演示数据铺完。这里是固定等待而不是轮询 ——
     * 「界面画完了」没有可靠的判据，截图脚本宁可多等一下：
     * 截早了会得到一张半空的图，而且不会有任何报错。
     */
    await sleep(1500)

    const title = await cdp.evaluate(`document.title`)
    if (/ERR_|无法访问|拒绝/.test(String(title))) {
      throw new Error(`页面没加载成功：${title}`)
    }

    /*
     * 藏掉「开发期才有」的东西再拍：`?demo=` 只在 DEV 下生效，所以这些图只能对着
     * 开发服务器拍，而开发版界面上带着「载入演示数据」这类入口、左下角还可能冒出
     * 通知条 —— 官网上不该出现它们。用注入的样式藏，比事后修图可靠。
     */
    await cdp.evaluate(`(() => {
      const style = document.createElement('style')
      style.textContent = '.board__dev, .toasts, .aitip { display: none !important; }'
      document.head.appendChild(style)
      return true
    })()`)
    await sleep(120)

    await capture(cdp, path.join(OUT_DIR, shot.file))
    console.log(`  ok   ${shot.file}  ${shot.w}x${shot.h} @2x`)
  }

  child.kill()
  console.log(`\n截图已写入 ${OUT_DIR}`)
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
