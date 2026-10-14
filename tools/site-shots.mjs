/**
 * 官网截图生成器。
 *
 * 与 ui-probe 分开：那个是「验收」，这个是「出图」。跑出来直接是给
 * `D:\Code\Website\Subtitle\assets\` 用的三张产品图。
 *
 * 关键点是 URL 里那个 `update=latest`：不带它，启动时的自动检查会因为
 * 开发机连不上更新服务器而在左下角留一句「更新检查失败」—— 那是探针环境的
 * 产物，不该出现在官网上。
 *
 * 用法：`node tools/site-shots.mjs`（需要 `npm run dev:ui` 已起）
 */

import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import path from 'node:path'
import { capture, connect } from './lib/cdp.mjs'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = 9334
const BASE = `http://127.0.0.1:${process.env.XBAOS_DEV_PORT || 5173}`
const OUT_DIR = path.resolve('.workbuddy/shots')
const PROFILE = path.resolve('.workbuddy/shots/site-shot-profile')

mkdirSync(OUT_DIR, { recursive: true })

/** 统一带上的查询串：演示数据 + 浅色 + 假装更新已是最新 */
const COMMON = 'demo=1&theme=light&update=latest'

const SHOTS = [
  { file: 'site-import.png', query: `view=home&${COMMON}`, w: 1454, h: 840 },
  { file: 'site-editor.png', query: `view=editor&${COMMON}`, w: 1454, h: 840 },
  // 辅助窗口本身就是 720 宽的窄窗，按它的真实比例出图
  { file: 'site-assist.png', query: `window=assist&task=review&${COMMON}`, w: 720, h: 840 },
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
    await sleep(1500)

    const title = await cdp.evaluate(`document.title`)
    if (/ERR_|无法访问|拒绝/.test(String(title))) {
      throw new Error(`页面没加载成功：${title}`)
    }
    await capture(cdp, path.join(OUT_DIR, shot.file))
    console.log(`  ok   ${shot.file}  ${shot.w}x${shot.h} @2x`)
  }

  child.kill()
  console.log('\n截图已写入 .workbuddy/shots/')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
