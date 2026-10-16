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
 */
const SHOTS = [
  // 首屏大图：编辑器，最有说服力的一张
  { file: 'shot-editor.png', query: `view=editor&${COMMON}`, w: 1454, h: 840 },
  // 图文块 1：导入页
  { file: 'shot-import.png', query: `view=home&${COMMON}`, w: 1454, h: 840 },
  // 图文块 2：辅助窗口本身就是 720 宽的窄窗，按它的真实比例出图
  { file: 'shot-assist.png', query: `window=assist&task=review&${COMMON}`, w: 720, h: 840 },
  // 图文块 3：模型页。浏览器预览里没有 Electron 桥，装不出「已安装模型」的样子，
  // 但「首次启动会引导你配置模型」本来就是这一块要讲的事，落在原样反而如实。
  { file: 'shot-models.png', query: `view=models&${COMMON}`, w: 1454, h: 840 },
]

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

  for (const shot of SHOTS) {
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
