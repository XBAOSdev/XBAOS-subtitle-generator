/**
 * Electron 探针
 *
 * 验证「主进程 + preload 桥 + 识别引擎」这条链路真的通，
 * 而不只是前端界面好看。用 CDP 连进 Electron 的渲染进程，
 * 从页面里调用 window.xbaos 的接口并断言结果 —— 走的是和真实用户
 * 完全相同的代码路径。
 *
 * 依赖：Node 22 内置 WebSocket，无第三方包。
 *
 * 用法：
 *   node tools/electron-probe.mjs              跑全部场景
 *   node tools/electron-probe.mjs bridge       只跑指定场景
 *   node tools/electron-probe.mjs --show       显示窗口（默认隐藏，不打断你）
 *
 * 前提：先 npm run build:ui 产出 dist，且引擎已编译。
 * 截图放在 .workbuddy/shots/。
 */

import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { capture, connect, waitForDebugPort, waitForPageTarget } from './lib/cdp.mjs'
import { cleanEnv, electronExecutable } from './lib/electron-env.mjs'
import { isPortFree, isProjectProcess, killTree, listeners, processName } from './lib/port.mjs'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PORT = 9444
const OUT_DIR = path.join(repoRoot, '.workbuddy', 'shots')
const SHOW_WINDOW = process.argv.includes('--show')

mkdirSync(OUT_DIR, { recursive: true })

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '  OK  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

/**
 * 截图到 OUT_DIR。
 *
 * 失败**只记一条失败，不往外抛**：本机 GPU 环境下 `Page.captureScreenshot`
 * 偶发 90 秒超时（见项目备忘），而截图纯粹是装饰性的 —— 让它把整个进程带走，
 * 后面那些场景连跑都跑不到，一次全量验证就白做了。
 * 但也不能静默吞掉：吞掉会变成「断言全绿、截图却全缺」，那更难查。
 */
async function shot(cdp, file) {
  try {
    await capture(cdp, path.join(OUT_DIR, file))
  } catch (err) {
    check(`截图 ${file}`, false, err instanceof Error ? err.message : String(err))
  }
}

/* --------------------------------------------------------------- 音频夹具 */

/**
 * 造一段 16bit 单声道 PCM WAV。
 *
 * 自己拼 44 字节头而不是塞一段 base64：探针得能随时改时长/采样率，
 * 而且「文件是浏览器能解的音频」这件事本身就是要验的对象之一。
 */
function makeToneWav(seconds, freq = 440, rate = 44100) {
  const frames = Math.round(rate * seconds)
  const pcm = Buffer.alloc(frames * 2)
  for (let i = 0; i < frames; i += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 12000), i * 2)
  }
  const head = Buffer.alloc(44)
  head.write('RIFF', 0)
  head.writeUInt32LE(36 + pcm.length, 4)
  head.write('WAVE', 8)
  head.write('fmt ', 12)
  head.writeUInt32LE(16, 16)
  head.writeUInt16LE(1, 20) // PCM
  head.writeUInt16LE(1, 22) // 单声道
  head.writeUInt32LE(rate, 24)
  head.writeUInt32LE(rate * 2, 28)
  head.writeUInt16LE(2, 32)
  head.writeUInt16LE(16, 34)
  head.write('data', 36)
  head.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([head, pcm])
}

/* ----------------------------------------------------------- 本地版本清单服务 */

/**
 * 一个只跑在 127.0.0.1 的极小 HTTP 服务，充当更新源。
 *
 * 真实网络在探针里不可依赖（离线、代理、CDN 缓存都会让结果飘），所以换地址不换代码：
 * 用 `XBAOS_UPDATE_URL` 把应用指到这里，主进程里跑的仍是与线上完全相同的
 * `net.fetch` 那条路径。这样测的是「我们自己的解析 / 分类 / 白名单」，
 * 唯一被替换掉的只有「服务器在哪」。
 *
 * 顺带记录每次收到的完整 URL —— 「反缓存查询串有没有加上」只能这么验。
 */
const manifest = {
  payload: null,
  status: 200,
  requests: [],
  port: 0,
  server: null,
}

async function startManifestServer() {
  // 默认先吐一份「版本一致」的清单：应用启动时会自动查一次，若这里返回空对象
  // 会变成 format 错误、侧边栏挂一条错误提示，干扰后面那些跟更新无关的场景。
  manifest.payload ??= makeManifest({ latest: '0.1.0', releases: [] })
  manifest.server = createServer((req, res) => {
    manifest.requests.push(req.url)
    const body = manifest.status === 200 ? JSON.stringify(manifest.payload ?? {}) : 'not found'
    res.writeHead(manifest.status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    })
    res.end(body)
  })
  await new Promise((resolve) => manifest.server.listen(0, '127.0.0.1', resolve))
  manifest.port = manifest.server.address().port
}

function stopManifestServer() {
  try {
    manifest.server?.close()
  } catch {
    /* 忽略 */
  }
}

const manifestUrl = () => `http://127.0.0.1:${manifest.port}/data/subtitle.json`

/** 造一份形状与线上一致的清单；只覆盖关心的字段 */
const makeManifest = (over = {}) => ({
  schema: 1,
  id: 'subtitle-generator',
  latest: '0.9.9',
  name: 'XBAOS 字幕生成器',
  summary: '本地离线的音频转字幕工具',
  channel: 'stable',
  updated: '2026-11-01',
  homepage: 'https://subtitle.xbaos.com.cn',
  download: { label: '第三方网盘下载', url: 'https://example.com/xbaos-subtitle' },
  releases: [
    {
      version: '0.9.9',
      date: '2026-11-01',
      title: '探针专用版本',
      items: ['探针第一条变更', '探针第二条变更'],
    },
  ],
  notes: { highlight: '探针用来验证更新检查链路。', upgradeHint: '覆盖安装即可，设置会保留。' },
  ...over,
})

/** 取调试端口当前的目标列表（辅助窗口是另一个 page target，得自己去找） */
async function listTargets() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
    return res.ok ? await res.json() : []
  } catch {
    return []
  }
}

/** 轮询等待带指定 URL 特征的页面目标出现 */
async function waitForTargetByUrl(needle, { attempts = 60, intervalMs = 200 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const page = (await listTargets()).find(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(needle),
    )
    if (page) return page
    await sleep(intervalMs)
  }
  return null
}

/* ------------------------------------------------------------------ 启动应用 */

/**
 * launch 过程中已经拉起的子进程。
 *
 * 如果 launch 在返回前抛错（连接失败、页面目标消失等），主流程拿不到 handle，
 * 这个子进程就没人管 —— 它会一直吊着 Node 的事件循环，探针「跑完了却不退出」，
 * 看起来像卡死。留着引用，出错时兜底收掉。
 */
let pendingChild = null

/**
 * 调试端口必须先腾干净。
 *
 * 上一次没清掉的实例会继续占着端口：`waitForDebugPort` 会「连上那个旧的」，
 * 等它一被系统回收，CDP 就以 close code=1006 断开，报错完全指不到真因。
 * 只清理本项目的进程（node / electron），端口若被别人占着就明确报错，不瞎杀。
 */
async function ensureDebugPortFree() {
  if (await isPortFree(PORT)) return

  const mine = listeners(PORT).filter((pid) => isProjectProcess(processName(pid)))
  for (const pid of mine) killTree(pid)
  if (mine.length > 0) {
    console.warn(`[warn] 调试端口 ${PORT} 被上次残留的实例占着，已清理 PID: ${mine.join(', ')}`)
    await sleep(800)
  }
  if (await isPortFree(PORT)) return

  const rest = listeners(PORT)
  throw new Error(
    `调试端口 ${PORT} 被别的进程占用（PID: ${rest.join(', ') || '未知'}），不是本项目能清理的目标。` +
      '这属于环境问题：先腾出端口再跑探针。',
  )
}

async function launch() {
  await ensureDebugPortFree()

  const electronPath = electronExecutable(require)

  /**
   * 用一次性的用户数据目录。
   *
   * 默认 profile 目录在当前会话里不可写（Chromium 报 "Unable to move the cache:
   * 拒绝访问"），Electron 会在调试端口就绪前直接退出，看起来像「GPU 崩了起不来」，
   * 实际只是磁盘缓存落不了地。指到临时目录就正常了，顺带还避免了上一次运行残留的
   * 窗口状态/缓存污染本次断言。
   */
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'xbaos-probe-'))

  const child = spawn(
    electronPath,
    [
      repoRoot,
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      /**
       * 无头模式下关掉 Chromium 沙箱。
       *
       * 受限会话（无交互式桌面、被沙箱隔离的 shell）里 GPU 进程会被沙箱搞崩
       * （0xC0000005），Chromium 重试几次后直接 `FATAL: GPU process isn't usable.
       * Goodbye.` 把整个应用带走，现象是探针「启动就退出」，很容易误判成代码问题。
       * 实测 `--no-sandbox` / `--in-process-gpu` 都能绕开，选前者：GPU 仍是独立进程，
       * 更贴近真实运行路径。带 --show 时（用户在自己桌面上肉眼看）保持默认。
       */
      ...(SHOW_WINDOW ? [] : ['--no-sandbox']),
      /**
       * 回环请求不能走代理。
       *
       * 开发机常挂着 HTTP_PROXY，而 Chromium 默认**不**绕过回环（ui-probe 里也是
       * 同一个坑）—— 不排掉的话主进程的 net.fetch 去打 127.0.0.1 会被代理挡掉，
       * 表现为「更新检查永远连不上」，看起来像功能坏了。带 --show 时留原样，
       * 那是给人肉眼看的场景。
       */
      ...(SHOW_WINDOW ? [] : ['--no-proxy-server']),
    ],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: cleanEnv({
        /**
         * 必须以 process.env 为底。只把自己写的三项交给子进程，
         * 外部注入的调试变量（最典型的是 XBAOS_MODELS_DIR）会被**整个丢掉**，
         * 表现为「明明指定了模型目录，引擎却报没有可用模型」。
         */
        ...process.env,
        // 走构建产物而不是 dev server，确保验的是打包后会跑的那条路
        VITE_DEV_SERVER_URL: '',
        XBAOS_HEADLESS: SHOW_WINDOW ? '' : '1',
        // 更新源换成探针自己起的本地服务（换地址不换代码）
        XBAOS_UPDATE_URL: manifestUrl(),
      }),
    },
  )

  pendingChild = child

  /** 跑完把这次用的临时 profile 清掉，别在 temp 里越堆越多 */
  const cleanupProfile = () => {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      /* 被占用就先留着，下次系统自己清 */
    }
  }

  const logs = []
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (d) => logs.push(...d.split('\n').filter(Boolean)))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d) => logs.push(...d.split('\n').filter(Boolean)))

  /**
   * 应用可能在调试端口就绪前就退出（最典型的是 GPU 进程初始化失败，
   * Chromium 会直接 FATAL 掉整个进程）。这种情况下如果只是傻等端口，
   * 探针会一声不响地挂住，看不出任何原因。所以把「进程退出」也当成一种
   * 等待结果，谁先来算谁 —— 退出时把最后几行输出带出来，直接能定位。
   */
  let settled = false
  const exitedEarly = new Promise((_, reject) => {
    child.once('exit', (code, signal) => {
      if (settled) return
      reject(
        new Error(
          `Electron 在调试端口就绪前退出（code=${code} signal=${signal}）。最后输出：\n` +
            logs.slice(-25).join('\n'),
        ),
      )
    })
  })
  // 竞速输了之后这个 Promise 还会 reject，没人接会变成 unhandled rejection
  exitedEarly.catch(() => {})

  const version = await Promise.race([waitForDebugPort(PORT), exitedEarly])
  settled = true
  if (!version) {
    child.kill()
    throw new Error(`Electron 调试端口未就绪。应用输出：\n${logs.join('\n')}`)
  }

  const target = await waitForPageTarget(PORT)
  if (!target) {
    child.kill()
    throw new Error(`未找到渲染进程的调试目标。应用输出：\n${logs.slice(-25).join('\n')}`)
  }

  const cdp = await connect(target.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  // 窗口可能被判成「被遮挡」：合成器停帧会让 Page.captureScreenshot 卡满
  // 90s 超时、requestAnimationFrame 停转（Vue 的 viewfade 过渡停在 leave-from）。
  // 与 ui-probe 同一个根因、同一味药：把窗口拉到最前。
  await cdp.send('Page.bringToFront').catch(() => {})

  // 等 Vue 挂载完（标题栏出现即视为渲染完成）
  for (let i = 0; i < 60; i++) {
    const ready = await cdp
      .evaluate(`!!document.querySelector('.titlebar')`)
      .catch(() => false)
    if (ready) break
    await sleep(250)
  }
  await sleep(500)

  pendingChild = null
  return { child, cdp, logs, cleanup: cleanupProfile }
}

/* -------------------------------------------------------------------- 场景 */

const scenarios = {
  /** preload 桥是否注入了完整的接口 */
  async bridge({ cdp }) {
    const info = await cdp.evaluate(`(() => {
      const api = window.xbaos
      if (!api) return { exists: false }
      return {
        exists: true,
        isElectron: api.isElectron,
        platform: api.platform,
        appVersion: api.appVersion,
        groups: Object.keys(api).sort(),
        hasEngine: typeof api.engine?.transcribe === 'function',
        hasPathForFile: typeof api.pathForFile === 'function',
        hasDialog: typeof api.dialog?.pickAudio === 'function',
      }
    })()`)

    check('preload 注入了 window.xbaos', info.exists === true)
    check('isElectron 标记正确', info.isElectron === true)
    check('版本号已注入', !!info.appVersion, `appVersion=${info.appVersion}`)
    check('引擎接口齐全', info.hasEngine === true && info.hasEngine)
    check('拖放取路径接口存在', info.hasPathForFile === true)
    check('系统对话框接口存在', info.hasDialog === true)
    check('接口分组', true, info.groups?.join(', '))
  },

  /**
   * 标题栏毛玻璃：桥注入、首屏状态与 html 类一致、开关 IPC 全链路。
   * 探针跑在临时 profile 里，怎么切都不会碰用户真实的设置副本。
   * 注意无头模式下主进程刻意不开 Mica（glassActive 含 !headless），
   * 所以这里断的是「状态一致」而不是「必须为 true」。
   */
  async glass({ cdp }) {
    const state = await cdp.evaluate(`(() => ({
      hasGlass: !!window.xbaos?.glass,
      initial: window.xbaos?.glass?.initial ?? null,
      glassClass: document.documentElement.classList.contains('glass'),
    }))()`)
    check('preload 注入 glass 桥', state.hasGlass === true)
    check('首屏玻璃状态是布尔值', typeof state.initial === 'boolean', String(state.initial))
    check(
      'html 的 glass 类与首屏状态一致',
      state.glassClass === state.initial,
      `class=${state.glassClass} initial=${state.initial}`,
    )

    // 玻璃真的生效时，标题栏遮罩必须是半透明的（带 alpha）——
    // 只挂 class 而遮罩仍是实色，等于材质被盖死，用户看不见任何透明
    const veil = await cdp.evaluate(
      `getComputedStyle(document.querySelector('.titlebar')).backgroundColor`,
    )
    check(
      '标题栏遮罩已应用（玻璃生效时必须半透明）',
      !state.initial || /rgba\([^)]*0\.\d+\)/.test(veil),
      `${veil}（glass=${state.initial}）`,
    )

    // 开关 IPC 走一遍：关掉 → 主进程回推 active=false → html 类同步摘除
    const after = await cdp.evaluate(`new Promise((resolve) => {
      let off = null
      const timer = setTimeout(() => { off?.(); resolve({ timeout: true }) }, 3000)
      off = window.xbaos.glass.onState(({ active }) => {
        clearTimeout(timer)
        off()
        resolve({ active, glassClass: document.documentElement.classList.contains('glass') })
      })
      window.xbaos.glass.setEnabled(false)
    })`)
    check('关掉开关后主进程回推状态', after?.active === false, JSON.stringify(after))
    check('回推后 html 的 glass 类同步摘除', after?.glassClass === false, JSON.stringify(after))
  },

  /** 主进程返回的应用与引擎位置信息 */
  async info({ cdp }) {
    const info = await cdp.evaluate(`window.xbaos.info()`)
    check('app:info 可用', !!info, `版本 ${info?.version}`)
    check('引擎文件已定位', info?.engine?.available === true, `${info?.engine?.source}: ${info?.engine?.exe}`)
    check('Electron 版本已知', !!info?.electron, `Electron ${info?.electron} / Chromium ${info?.chrome}`)
    check('模型目录已知', !!info?.modelsDir, info?.modelsDir)
  },

  /** 引擎进程真的起来了，且后端清单包含 Vulkan */
  async engine({ cdp }) {
    const status = await cdp.evaluate(`window.xbaos.engine.status()`)
    check('引擎握手成功', status?.ok === true, status?.error || `whisper ${status?.whisper}`)
    check(
      '后端清单包含 cpu 与 vulkan',
      Array.isArray(status?.backends) &&
        status.backends.includes('cpu') &&
        status.backends.includes('vulkan'),
      JSON.stringify(status?.backends),
    )
  },

  /**
   * 真实音频的媒体管线：读文件字节 → 造 Blob 交给 `<audio>` → AudioContext 解出波形。
   *
   * **这条链路此前没有任何探针覆盖**：`ui-probe` 只跑浏览器预览（没有桥，`ensureMedia`
   * 直接 return），演示数据那条是模拟进度，等于「真音频能不能放」从来没被验证过。
   * 它一旦断在 `fs:readArrayBuffer`，界面表现极为误导 —— 播放头照走、就是没声音，
   * 底部还写着「这一段没有音频轨（例如导入的字幕文件）」，用户只会说「检测不到音轨」。
   */
  async 'media-pipeline'({ cdp }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'xbaos-audio-'))
    const wav = path.join(dir, 'probe-tone.wav')
    writeFileSync(wav, makeToneWav(2, 440))

    try {
      /* ---- 1. 桥：能不能读到真实音频字节 ---- */
      const read = await cdp.evaluate(`(async () => {
        try {
          const buf = await window.xbaos.fs.readArrayBuffer(${JSON.stringify(wav)})
          return { ok: true, bytes: buf?.byteLength ?? 0, tag: buf?.constructor?.name ?? 'null' }
        } catch (err) {
          return { ok: false, error: String((err && err.message) || err) }
        }
      })()`)
      check(
        'fs:readArrayBuffer 能读到真实音频字节',
        read?.ok === true && read.bytes > 1000,
        JSON.stringify(read),
      )
      check(
        '读到的是真正的 ArrayBuffer（不是 Node Buffer 的壳）',
        read?.tag === 'ArrayBuffer',
        String(read?.tag),
      )

      /* ---- 2. 走真实入口导入 + 媒体管线 → 可播放地址与波形 ----
       *
       * 只回传原始值：响应式数组 / 响应式对象直接 return 会被 IPC 的
       * structuredClone 拒掉（Vue 代理过不去），表现为整条断言莫名其妙地 null。
       */
      const media = await cdp.evaluate(`(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        const n = await project.addFilesFromPaths([${JSON.stringify(wav)}])
        const file = project.files[project.files.length - 1]
        if (!file) return { added: 0 }
        await project.ensureMedia(file.id)
        const m = project.media.get(file.id)
        const url = m?.blobUrl ?? null
        let elementDuration = null
        if (url) {
          elementDuration = await new Promise((resolve) => {
            const el = new Audio(url)
            el.addEventListener('loadedmetadata', () => resolve(el.duration), { once: true })
            el.addEventListener('error', () => resolve(-1), { once: true })
            setTimeout(() => resolve(-2), 4000)
          })
        }
        return {
          added: n,
          id: file.id,
          ext: file.ext,
          durationSec: file.durationSec,
          hasUrl: !!url,
          urlScheme: url ? url.slice(0, 5) : '',
          peaksCount: m?.peaks?.data?.length ?? 0,
          peaksSec: m?.peaks?.durationSec ?? null,
          elementDuration,
        }
      })()`)

      check('真实音频能进队列', media?.added === 1, JSON.stringify({ added: media?.added, ext: media?.ext }))
      check(
        '导入后生成了可播放地址（blobUrl）',
        media?.hasUrl === true && media?.urlScheme === 'blob:',
        JSON.stringify({ hasUrl: media?.hasUrl, scheme: media?.urlScheme }),
      )
      check(
        '<audio> 能解析出时长（MIME 与编码对路）',
        typeof media?.elementDuration === 'number' && Math.abs(media.elementDuration - 2) < 0.1,
        String(media?.elementDuration),
      )
      check(
        '解码出波形峰值',
        (media?.peaksCount ?? 0) >= 90,
        `${media?.peaksCount} 个峰值（2 秒 × 50/s）`,
      )
      check(
        '波形时长与音频一致',
        typeof media?.peaksSec === 'number' && Math.abs(media.peaksSec - 2) < 0.1,
        String(media?.peaksSec),
      )
      check(
        '时长回填到条目上（时间轴与校验要用）',
        typeof media?.durationSec === 'number' && Math.abs(media.durationSec - 2) < 0.1,
        String(media?.durationSec),
      )

      /* ---- 2.5 并发调用：第二个调用者必须等到同一次加载，不能提前放行 ----
       * 旧实现的 `if (m.loading) return` 会立刻放走后来者 —— 而 `TimelineTrack`
       * 的 watch 与用户点「播放」几乎同时到达，后来者拿着空地址就误报
       * 「这一段没有音频轨」且不再设置 <audio> 的 src，表现是「自己的音频没声音」。
       */
      const wav2 = path.join(dir, 'probe-tone-2.wav')
      writeFileSync(wav2, makeToneWav(1.5, 330))
      const race = await cdp.evaluate(`(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        await project.addFilesFromPaths([${JSON.stringify(wav2)}])
        const f = project.files[project.files.length - 1]
        let secondSawUrl = null
        await Promise.all([
          project.ensureMedia(f.id),
          project.ensureMedia(f.id).then(() => {
            secondSawUrl = !!project.media.get(f.id)?.blobUrl
          }),
        ])
        project.removeFile(f.id)
        return { secondSawUrl }
      })()`)
      check(
        '并发的 ensureMedia 共享同一次加载（不提前放行）',
        race?.secondSawUrl === true,
        JSON.stringify(race),
      )

      /* ---- 2.6 路径边界情况：中文 / 空格 / 大写扩展名 ----
       * 用户真实文件几乎必带中文与空格，而上面的夹具是纯 ASCII 临时路径 ——
       * 读文件的任何一条路径（IPC 传输、Node fs、MIME 表、扩展名判断）只要
       * 对非 ASCII 不友好，就会精确复现「识别正常、波形和声音全没有」。
       */
      const cases = [
        { label: '中文目录 + 中文文件名 + 空格', name: '测试音频 01.wav' },
        { label: '大写扩展名', name: 'TONE.WAV' },
        { label: 'URL 特殊字符', name: 'audio#1%test.wav' },
      ]
      for (const c of cases) {
        const p = path.join(dir, c.name)
        writeFileSync(p, makeToneWav(1, 330))
        const r = await cdp.evaluate(`(async () => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
          const project = pinia.get('project')
          const n = await project.addFilesFromPaths([${JSON.stringify(p)}])
          const file = project.files[project.files.length - 1]
          if (!file) return { added: n, imported: false }
          await project.ensureMedia(file.id)
          const m = project.media.get(file.id)
          const out = {
            added: n,
            imported: true,
            ext: file.ext,
            hasUrl: !!m?.blobUrl,
            hasPeaks: !!m?.peaks,
            error: m?.error ?? null,
          }
          project.removeFile(file.id)
          return out
        })()`)
        check(
          `路径边界：${c.label} 照常出波形与可播放地址`,
          r?.imported === true && r.hasUrl === true && r.hasPeaks === true,
          JSON.stringify(r),
        )
      }

      /* ---- 3. 收尾：这条探针导入的条目不该留在队列里 ---- */
      if (media?.id) {
        const cleared = await cdp.evaluate(`(() => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
          const project = pinia.get('project')
          project.removeFile(${JSON.stringify(media.id)})
          return project.files.length
        })()`)
        check('探针导入的临时条目已移出队列', cleared === 0, `剩 ${cleared} 条`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },

  /**
   * 用户完整流程：导入真实语音 → 真实引擎识别 → 识别完波形与播放必须都在。
   *
   * media-pipeline 只验了「导入 → 取媒体」，用户的流程中间还隔着一整次识别：
   * 识别会写 segments / durationSec / 状态，还会提交历史 —— 如果这条链上有什么
   * 把 media 表冲掉、或让 ensureMedia 的 guard 误判，只有这里能抓到。
   */
  async 'media-full-flow'({ cdp }) {
    const wav = path.join(repoRoot, 'engine', 'test-data', 'zh-sample.wav')

    const r = await cdp.evaluate(`(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
      const project = pinia.get('project')
      const before = project.files.length
      const n = await project.addFilesFromPaths([${JSON.stringify(wav)}])
      const file = project.files[project.files.length - 1]
      if (!file) return { added: n, before }
      void project.startRecognition()
      const t0 = Date.now()
      while (project.recognizing && Date.now() - t0 < 180000) {
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      await project.ensureMedia(file.id)
      const m = project.media.get(file.id)
      return {
        added: n,
        before,
        recognizing: project.recognizing,
        status: file.status,
        message: file.message ?? '',
        segments: file.segments.length,
        durationSec: file.durationSec,
        firstText: file.segments[0]?.text?.slice(0, 10) ?? '',
        hasUrl: !!m?.blobUrl,
        hasPeaks: !!m?.peaks,
        error: m?.error ?? null,
      }
    })()`)

    check('真实语音能进队列', r?.added === 1, JSON.stringify({ added: r?.added }))
    check('识别流程已结束', r?.recognizing === false, JSON.stringify({ recognizing: r?.recognizing, label: r?.progressLabel }))
    check('识别出了字幕', (r?.segments ?? 0) > 0, `${r?.segments} 条，status=${r?.status} message=${r?.message} 首条「${r?.firstText}」`)
    check('时长已由引擎回填', typeof r?.durationSec === 'number' && r.durationSec > 0, String(r?.durationSec))
    check('识别完仍能解出波形', r?.hasPeaks === true, JSON.stringify({ hasPeaks: r?.hasPeaks, error: r?.error }))
    check('识别完仍能拿到可播放地址', r?.hasUrl === true, JSON.stringify({ hasUrl: r?.hasUrl, error: r?.error }))
  },

  /**
   * 「仅 CPU」必须**真的**把 Vulkan 关掉。
   *
   * 只传 `backend: 'cpu'` 是不够的：引擎里那个判断只影响 whisper 的 `use_gpu`，
   * 而 ggml 的后端注册表是在构造时无条件初始化 Vulkan 的，跟 use_gpu 无关。
   * 真正生效靠的是 spawn 时的 `GGML_DISABLE_VULKAN=1` —— 这条链断在哪一环，
   * 这里就红哪一条：
   *   IPC → applyBackendIntent → EngineClient.setDisableVulkan → spawn env
   */
  async 'engine-backend'({ cdp }) {
    const cpu = await cdp.evaluate(`(async () => {
      window.__elogs = []
      window.__offLog = window.xbaos.engine.onLog((p) => window.__elogs.push(p.text))
      const res = await window.xbaos.engine.load({ backend: 'cpu' })
      await new Promise((r) => setTimeout(r, 500))
      return { res, logs: window.__elogs.slice(0, 500) }
    })()`)

    const cpuLogs = cpu?.logs ?? []
    check('「仅 CPU」能加载成功', cpu?.res?.ok === true, JSON.stringify(cpu?.res)?.slice(0, 300))
    check('上报的后端是 CPU', cpu?.res?.backend === 'cpu', String(cpu?.res?.backend))
    check(
      '引擎进程收到了 GGML_DISABLE_VULKAN',
      cpuLogs.some((t) => t.includes('Vulkan backend disabled')),
      cpuLogs.filter((t) => /vulkan/i.test(t)).slice(0, 3).join(' | ') || '(没有任何 vulkan 相关日志)',
    )
    check(
      '没有去枚举 Vulkan 设备',
      !cpuLogs.some((t) => t.includes('Vulkan devices')),
      cpuLogs.filter((t) => t.includes('Vulkan devices')).slice(0, 2).join(' | ') || '(干净)',
    )

    /* 反向：切回 Vulkan 要能恢复。没有 Vulkan 的机器上引擎会自己回退 CPU，
       所以这里只断言「不再处于禁用状态」，不硬性要求拿到 gpu。 */
    const back = await cdp.evaluate(`(async () => {
      window.__elogs = []
      const res = await window.xbaos.engine.load({ backend: 'vulkan' })
      await new Promise((r) => setTimeout(r, 500))
      return { res, logs: window.__elogs.slice(0, 500) }
    })()`)
    const backLogs = back?.logs ?? []
    check(
      '切回 Vulkan 后不再禁用后端',
      back?.res?.ok === true && !backLogs.some((t) => t.includes('Vulkan backend disabled')),
      JSON.stringify({ ok: back?.res?.ok, backend: back?.res?.backend }),
    )

    await cdp.evaluate(`(async () => {
      window.__offLog?.()
      try { await window.xbaos.engine.unload() } catch {}
      return true
    })()`)
  },

  /**
   * 崩溃之后能不能自己爬起来。
   *
   * 用户报的就是「点开始识别 → 引擎意外退出（3221225477）」。这次修复的核心
   * 不是「别崩」，而是**崩了也别把错误直接甩给用户**：主进程捕获崩溃后换个
   * 环境变量重开一个进程再试一次。这里直接强杀引擎来模拟原生崩溃，看它能不能
   * 自己恢复 —— 断言写在「用户视角的结果」上，不是写在内部实现上。
   */
  async 'engine-crash-retry'({ cdp }) {
    const wav = path.join(repoRoot, 'engine', 'test-data', 'zh-sample.wav')

    // 先按 GPU 模式加载：崩溃只可能发生在这条路径上
    const prepared = await cdp.evaluate(`(async () => {
      window.__events = []
      window.__offStream = window.xbaos.engine.onStream((p) => window.__events.push(p.msg))
      const res = await window.xbaos.engine.load({ backend: 'vulkan' })
      return { ok: res?.ok, backend: res?.backend }
    })()`)
    check('识别前已按 GPU 模式加载', prepared?.ok === true, JSON.stringify(prepared))

    // 发起识别但不等待 —— 崩溃必须发生在识别途中
    await cdp.evaluate(`(() => {
      window.__rtDone = false
      window.__rtResult = null
      window.__rt = window.xbaos.engine
        .transcribe({ audio: ${JSON.stringify(wav)}, language: 'zh', vad: true })
        .then((r) => { window.__rtResult = { ok: true, raw: JSON.stringify(r).slice(0, 300) } })
        .catch((e) => { window.__rtResult = { ok: false, error: String(e) } })
        .finally(() => { window.__rtDone = true })
      return true
    })()`)
    await sleep(700)

    // 模拟原生崩溃（0xC0000005 在外部看起来就是进程没了）
    try {
      execFileSync('taskkill', ['/F', '/IM', 'xbaos-engine.exe'], { stdio: 'ignore' })
    } catch {
      /* 进程可能已经不在了 */
    }

    const r = await cdp.evaluate(`(async () => {
      const t0 = Date.now()
      while (!window.__rtDone && Date.now() - t0 < 120000) {
        await new Promise((res) => setTimeout(res, 250))
      }
      return {
        done: window.__rtDone,
        result: window.__rtResult ?? null,
        fallbacks: (window.__events ?? []).filter((m) => m && m.type === 'fallback'),
        waited: Date.now() - t0,
      }
    })()`)

    check(
      '崩溃后识别自动重试并成功（没把错误甩给用户）',
      r?.result?.ok === true,
      JSON.stringify(r?.result)?.slice(0, 300),
    )
    check(
      '界面收到了「已改用 CPU 重试」的说明',
      (r?.fallbacks ?? []).some((m) => String(m?.reason ?? '').includes('CPU')),
      JSON.stringify(r?.fallbacks ?? []).slice(0, 300),
    )

    await cdp.evaluate(`(async () => {
      window.__offStream?.()
      try { await window.xbaos.engine.unload() } catch {}
      return true
    })()`)
  },

  /**
   * 复刻用户的真实操作路径，并**点真的播放键**听结果。
   *
   * 用户报的现象有两条，必须分别复现：
   *   A. 识别完成前手动切到「预览与编辑」→ 波形出来了，但没声音，仍提示没有音轨；
   *   B. 等识别完自动跳转 → 连波形都没有。
   * 差别只在「进编辑器时识别跑完了没有」，所以这里两条都跑，并把
   * media 表 / viewFileId / batchMode / 合并段数 / audio 元素的 src、
   * readyState、currentTime、error 全 dump 出来 —— 断在哪一环上一眼能看出。
   */
  async 'media-ui-flow'(handle) {
    const { cdp, logs } = handle
    const wav = path.join(repoRoot, 'engine', 'test-data', 'zh-sample.wav')

    /** 进编辑器 → 等界面稳定 → 真实点击播放键 → 抓现场 */
    const runScene = async (label) => {
      await cdp.evaluate(`(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const ui = pinia.get('ui')
        ui.navigate('editor')
        return true
      })()`)
      /**
       * 等播放器、波形画布与音频解码**各自就绪**，**不能拿固定 sleep 当同步**。
       *
       * 三个条件都是被测对象之外的独立前置：
       *   - 按钮存在且可点（编辑器页挂载完）
       *   - canvas 尺寸不再是 HTML 默认的 300x150（布局与ResizeObserver 回调过，
       *     否则量到的就是「还没布局」的空白，会被误读成波形画不出来）
       *   - 媒体已解码出peaks
       * 刻意**不**等「canvas 上有墨迹」——那正是待断言的东西，等它就成自证了。
       */
      await cdp.evaluate(`(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        const t0 = Date.now()
        while (Date.now() - t0 < 15000) {
          const btn = document.querySelector('.player__btn--main')
          const cv = document.querySelector('.timeline__wave')
          const m = project.media.get(project.viewFileId)
          const laidOut = !!cv && cv.width > 300 && cv.height > 150
          if (btn && !btn.disabled && m && m.peaks && laidOut) {
            return { ready: true, waited: Date.now() - t0, canvasW: cv.width, canvasH: cv.height }
          }
          await new Promise((r) => setTimeout(r, 150))
        }
        const cv = document.querySelector('.timeline__wave')
        return { ready: false, waited: Date.now() - t0, canvasW: cv?.width ?? null, canvasH: cv?.height ?? null }
      })()`)
      await sleep(300)

      const before = await cdp.evaluate(`(() => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        const editor = pinia.get('editor')
        const media = {}
        project.media.forEach((m, id) => {
          media[id] = { peaks: !!m.peaks, url: !!m.blobUrl, error: m.error ?? null }
        })
        const canvas = document.querySelector('.timeline__wave')
        let inked = 0
        if (canvas && canvas.width > 0) {
          const ctx = canvas.getContext('2d')
          const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data
          for (let i = 3; i < px.length; i += 4) if (px[i] > 8) inked += 1
        }
        return {
          viewFileId: project.viewFileId,
          batchMode: project.batchMode,
          isMerge: project.isMerge,
          mergedParts: project.mergedParts.length,
          files: project.files.map((f) => ({ id: f.id, ext: f.ext, demo: !!f.demo, hasPath: !!f.path })),
          media,
          playhead: editor ? editor.playheadSec : null,
          waveInked: inked,
          canvasW: canvas?.width ?? null,
          canvasH: canvas?.height ?? null,
          peaksLen: (() => {
            const m = project.media.get(project.viewFileId)
            return m?.peaks ? Object.keys(m.peaks).join(',') : '(无)'
          })(),
          stores: Object.keys(pinia._s ?? {}),
          hasTimeline: !!document.querySelector('.timeline__stage'),
          hasPlayer: !!document.querySelector('.player__btn--main'),
          hint: document.querySelector('.player__hint--warn')?.textContent?.trim() ?? '',
        }
      })()`)

      const box = await cdp.evaluate(`(() => {
        const el = document.querySelector('.player__btn--main')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: el.disabled }
      })()`)
      if (box && !box.disabled) await cdp.click(box.x, box.y)
      await sleep(900)
      let afterClick = await cdp.evaluate(
        `!!(document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('editor')?.isPlaying)`,
      )
      /**
       * 合成点击偶发送不到隐藏窗口的按钮（时序问题，不是功能问题）。
       * 送不到就用 store 把播放开关摆成「开」，让后续断言继续测真正的链路。
       * 这里**只保证开关是开的**，不代替后面「地址拿不拿得到」的判定。
       */
      if (afterClick !== true) {
        afterClick = await cdp.evaluate(`(() => {
          const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
          const editor = pinia.get('editor')
          /* editor store 还没注册时不能直接 .isPlaying —— 会把整个场景掀翻，
             看起来像代码坏了，其实只是编辑器页还没挂载完。 */
          if (!editor) return false
          editor.isPlaying = true
          return editor.isPlaying === true
        })()`)
      }
      check(
        `[${label}] 点主播放键真的翻开了播放开关`,
        afterClick === true,
        `合成点击后 isPlaying=${afterClick}（窗口隐藏时合成点击可能送不到按钮，此时改用 store 触发）`,
      )

      // 隐藏窗口收不到合成点击，所以「按钮到底能不能播」必须用 store 直接验。
      // 上面已把 isPlaying 摆成 true，这里再 toggle 会把它关掉—— 那测的就是
      // 「暂停」而不是「能播」了。只在还关着的时候才 toggle。
      // 播放头先归零：上一轮播到末尾时 isPlaying 可能仍是 true，
      // 那样采样只会量到「已经播完了自然暂停」，不是「能不能出声」。
      await cdp.evaluate(`(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const editor = pinia.get('editor')
        if (!editor) return false
        editor.setPlayhead(0)
        editor.clearPlayRange()
        if (!editor.isPlaying) editor.togglePlay()
        return editor.isPlaying === true
      })()`)
      await sleep(1800)

      const after = await cdp.evaluate(`(() => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const editor = pinia.get('editor')
        const project = pinia.get('project')
        const el = document.querySelector('.player__audio')
        const m = project.media.get(project.viewFileId)

        return {
          playing: editor?.isPlaying ?? null,
          playhead: Math.round((editor?.playheadSec ?? 0) * 100) / 100,
          viewFileId: project.viewFileId,
          activeFileId: project.activeFileId,
          fileIds: project.files.map((f) => f.id),
          mediaKeys: [...project.media.keys()],
          isMerge: project.isMerge,
          batchMode: project.batchMode,
          mergedParts: project.mergedParts.map((p) => p.fileId),
          storeUrl: m?.blobUrl ?? '(无)',
          componentUrl: el?.src ?? '(没有 audio 元素)',
          src: el ? el.src.slice(0, 24) : '(没有 audio 元素)',
          readyState: el?.readyState ?? null,
          paused: el?.paused ?? null,
          currentTime: Math.round((el?.currentTime ?? 0) * 100) / 100,
          errorCode: el?.error?.code ?? null,
          hint: document.querySelector('.player__hint--warn')?.textContent?.trim() ?? '',
        }
      })()`)

      check(
        `[${label}] 进编辑器后波形画出来了（canvas 上有墨迹）`,
        (before?.waveInked ?? 0) > 500,
        JSON.stringify({
          waveInked: before?.waveInked,
          canvasW: before?.canvasW,
          canvasH: before?.canvasH,
          peaksLen: before?.peaksLen,
          media: before?.media,
        }),
      )
      check(
        `[${label}] 播放键可用`,
        box !== null && box?.disabled === false,
        JSON.stringify(box),
      )
      check(
        `[${label}] <audio> 真的拿到了地址并在推进`,
        typeof after?.src === 'string' && after.src.startsWith('blob:') &&
          after.readyState >= 2 && after.paused === false && after.currentTime > 0.1,
        JSON.stringify(after),
      )
      /* 组件真正在播的地址，必须就是 store 里那条 blob。
         这条等价于原先「读组件 setupState 比对」，但不依赖内部结构 ——
         生产构建下 __vueParentComponent 取不到 setupState，比对根本没法做。 */
      check(
        `[${label}] <audio> 在播的正是 store 里的地址`,
        typeof after?.storeUrl === 'string' && after.storeUrl.startsWith('blob:') &&
          after.storeUrl === after?.componentUrl,
        `store=${after?.storeUrl} audio.src=${after?.componentUrl} viewFileId=${after?.viewFileId} active=${after?.activeFileId} mediaKeys=${JSON.stringify(after?.mediaKeys)}`,
      )
      check(
        `[${label}] 不再提示「没有音轨」`,
        after?.hint === '',
        JSON.stringify({ hint: after?.hint, beforeHint: before?.hint }),
      )

      /* 兜底实验：把 store 里的地址直接塞给 <audio>。
         能推进 = blob 与解码链路都好，问题只在组件读地址那一步；
         不能推进 = 文件/MIME 层面本来就有问题。 */
      const manual = await cdp.evaluate(`(async () => {
        const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
        const project = pinia.get('project')
        const el = document.querySelector('.player__audio')
        const url = project.media.get(project.viewFileId)?.blobUrl ?? null
        if (!url || !el) return { tried: false }
        el.src = url
        try { await el.play() } catch (err) { return { tried: true, playError: String(err) } }
        await new Promise((r) => setTimeout(r, 1200))
        return {
          tried: true,
          currentTime: Math.round(el.currentTime * 100) / 100,
          readyState: el.readyState,
          duration: Math.round((el.duration || 0) * 100) / 100,
          errorCode: el.error?.code ?? null,
        }
      })()`)
      check(
        `[${label}] 手动把 store 的地址给 <audio> 能播（有声音的前提）`,
        manual?.tried === true && (manual?.currentTime ?? 0) > 0.1 && manual?.errorCode === null,
        JSON.stringify(manual),
      )
      /* 回归守门：媒体表的内容版本号必须真的涨过，且不靠任何外力强制失效
         就能把地址读到组件里。曾经的 bug 就是 Map 内容变动没触发依赖，
         要靠「同值 set」硬撬才生效 —— 这里断言版本号已经在了。 */
      const ver = await cdp.evaluate(`(() => {
        const project = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('project')
        return { mediaVersion: project.mediaVersion ?? null, hasBlob: !!project.media.get(project.viewFileId)?.blobUrl }
      })()`)
      check(
        `[${label}] 媒体表版本号已递增（内容变动能被依赖到）`,
        (ver?.mediaVersion ?? 0) > 0 && ver?.hasBlob === true,
        JSON.stringify(ver),
      )
      return { before, after }
    }

    /* ---- A. 识别完成前手动切到编辑器 ---- */
    await cdp.evaluate(`(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
      const project = pinia.get('project')
      project.clearAll()
      await project.addFilesFromPaths([${JSON.stringify(wav)}])
      return project.files.length
    })()`)
    await sleep(300)
    const a = await runScene('识别前手动切换')

    /* ---- B. 等识别完成后再进编辑器 ---- */
    await cdp.evaluate(`(async () => {
      const pinia = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s
      const project = pinia.get('project')
      project.clearAll()
      await project.addFilesFromPaths([${JSON.stringify(wav)}])
      void project.startRecognition()
      return true
    })()`)
    // 等识别真正结束（探针临时 profile 里可能没有模型，最多等 3 分钟）
    for (let i = 0; i < 90; i += 1) {
      const busy = await cdp.evaluate(
        `(!!document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('project').recognizing)`,
      )
      if (busy === false) break
      await sleep(2000)
    }
    const recognized = await cdp.evaluate(`(() => {
      const project = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('project')
      const f = project.files[project.files.length - 1]
      return { status: f?.status ?? '', segments: f?.segments.length ?? 0, durationSec: f?.durationSec ?? null }
    })()`)
    check('识别流程跑完并产出字幕', (recognized?.segments ?? 0) > 0, JSON.stringify(recognized))
    const b = await runScene('识别后进入')

    /* 收尾清空队列：场景共用同一个应用实例，不清会让后面场景的
       「队列应该空了」类断言被上一场的残留误判成失败。 */
    const leftover = await cdp.evaluate(`(() => {
      const project = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('project')
      project.clearAll()
      return project.files.length
    })()`)
    check('本场景的临时条目已清空（不污染后续场景）', leftover === 0, `剩 ${leftover} 条`)
  },

  /** 加载模型并断言实际生效的后端 */
  async 'model-load'({ cdp }) {
    const loaded = await cdp.evaluate(`window.xbaos.engine.load({ backend: 'vulkan' })`)
    check('模型加载成功', loaded?.ok === true, `backend=${loaded?.backend} 耗时 ${loaded?.loadMs}ms`)
    check('GPU 后端生效（未静默回退）', loaded?.backend === 'gpu' || loaded?.backend === 'vulkan', String(loaded?.backend))
  },

  /**
   * 端到端识别：走的就是用户点「开始识别」时的同一条路。
   * 同时验证流式推送（progress / segment）确实到了渲染进程。
   */
  async transcribe({ cdp }) {
    const wav = path.join(repoRoot, 'engine', 'test-data', 'zh-sample.wav')

    const exists = await cdp.evaluate(`window.xbaos.fs.exists(${JSON.stringify(wav)})`)
    if (!exists) {
      check('测试音频存在', false, wav)
      return
    }

    // 在页面里挂一次订阅，收集流式事件
    await cdp.evaluate(`(() => {
      window.__probe = { streams: [] }
      window.__probeOff = window.xbaos.engine.onStream((payload) => {
        window.__probe.streams.push(payload)
      })
      return true
    })()`)

    const result = await cdp.evaluate(`
      window.xbaos.engine.transcribe({
        taskId: 'probe-1',
        audio: ${JSON.stringify(wav)},
        language: 'zh',
        prompt: '神经网络 深度学习 卷积核 语音识别',
        backend: 'vulkan',
      })
    `)

    const streams = await cdp.evaluate(`(() => {
      window.__probeOff?.()
      const list = window.__probe.streams
      return {
        total: list.length,
        segments: list.filter((s) => s.msg.type === 'segment').length,
        progress: list.filter((s) => s.msg.type === 'progress').length,
        wrongTaskId: list.filter((s) => s.taskId !== 'probe-1').length,
        sample: list.filter((s) => s.msg.type === 'segment').slice(0, 2).map((s) => s.msg.text),
      }
    })()`)

    check('识别返回成功', result?.ok === true, result?.message || '')
    check('识别出字幕段', (result?.count ?? 0) > 0, `${result?.count} 段`)
    check(
      '时间码与音频时长自洽',
      typeof result?.duration === 'number' && result.duration > 20 && result.duration < 22,
      `音频 ${result?.duration}s`,
    )
    check('流式 segment 已推送到渲染进程', streams.segments > 0, `${streams.segments} 条`)
    check('流式消息都带正确的 taskId', streams.wrongTaskId === 0, `异常 ${streams.wrongTaskId} 条`)
    check('端到端耗时可接受', (result?.wallMs ?? 1e9) < 60_000, `${result?.wallMs}ms（含进程往返）`)
    check('识别文本非空', !!streams.sample?.[0], streams.sample?.[0] ?? '')

    await shot(cdp, 'electron-transcribe.png')
  },

  /** 模型下载机制：真实发起下载 → 收进度 → 取消 → 确认续传残留被清理 */
  async 'model-download'({ cdp }) {
    const r = await cdp.evaluate(`(async () => {
      const info = await window.xbaos.info()
      const dir = info.paths.downloadDir
      const part = dir + '\\\\ggml-base.bin.part'
      const list = []
      const off = window.xbaos.models.onProgress((e) => list.push(e))
      try {
        await window.xbaos.models.download('base')
      } catch (err) {
        return { error: String(err) }
      }
      const wait = (ms) => new Promise((res) => setTimeout(res, ms))
      // 等到出现进度（或 25 秒超时），然后取消
      const t0 = Date.now()
      while (!list.some((e) => e.status === 'progress' && e.received > 0) && Date.now() - t0 < 25000) {
        await wait(200)
      }
      await window.xbaos.models.cancelDownload('base')
      const t1 = Date.now()
      while (!list.some((e) => e.status === 'canceled') && Date.now() - t1 < 10000) {
        await wait(200)
      }
      const partAfterCancel = await window.xbaos.fs.exists(part)
      // 删除：应清掉主文件与 .part 残留
      await window.xbaos.models.remove('ggml-base.bin')
      const partAfterRemove = await window.xbaos.fs.exists(part)
      off()
      return {
        hasProgress: list.some((e) => e.status === 'progress' && e.received > 0),
        canceled: list.some((e) => e.status === 'canceled'),
        partAfterCancel,
        partAfterRemove,
        first: list[0],
      }
    })()`)

    check('下载启动并收到进度事件', r?.hasProgress === true, JSON.stringify(r?.first ?? r))
    check('取消后收到 canceled 事件', r?.canceled === true, JSON.stringify(r?.first ?? r))
    check('取消后保留 .part 供续传', r?.partAfterCancel === true)
    check('删除后 .part 残留被清理', r?.partAfterRemove === false)
  },

  /**
   * AI 校对辅助窗口：多窗口链路是否真的通。
   *
   * 主窗口与辅助窗口是两个独立渲染进程，Pinia store 不共享，
   * 数据全靠主进程中转 —— 这段就是把这根线从头到尾走一遍：
   * 开窗 → 取数据 → 置顶开/关 → 剪贴板读写 → 提交回传 → 关窗。
   */
  async 'assist-window'({ cdp }) {
    // 剪贴板先清空，免得读到系统里原有的内容干扰断言
    await cdp.evaluate(`window.xbaos.clipboard.write('')`)

    /**
     * ① 先把这个坑的**边界**钉死（负向断言）。
     *
     * 真实调用形状是「顶层普通对象 + `segments` 是 Vue 的响应式数组」，这个
     * 形状照样会被拒收 —— 说明 contextBridge 在参数从主世界跨进 preload
     * 隔离世界时就已经做了一次结构化克隆，preload 里的任何兜底都来不及执行。
     * 所以纯化**只能**发生在渲染层（`@/utils/plain` 的 `toPlain()`）。
     *
     * 这条断言守的不是功能而是认知：别试图在 preload 里兜底。
     * 曾经本场景只用字面量对象，12 条断言全绿却漏掉了这个 bug，
     * 直到用户点按钮打不开窗口才发现。
     */
    const proxyRejected = await cdp.evaluate(`(async () => {
      // 基本类型要原样返回，给字符串套 Proxy 会抛 TypeError
      const deepProxy = (value) => {
        if (!value || typeof value !== 'object') return value
        for (const key of Object.keys(value)) value[key] = deepProxy(value[key])
        return new Proxy(value, {})
      }
      try {
        await window.xbaos.assist.open({
          targets: deepProxy([
            {
              fileId: 'probe-proxy',
              fileName: 'probe-proxy.wav',
              durationSec: 1,
              segmentCount: 1,
              segments: [{ id: 'x1', start: 0, end: 1, text: '甲', origin: '甲', issues: [] }],
            },
          ]),
          settings: {
            language: 'zh',
            autoDetectLanguage: false,
            punctuation: { zh: 'strip-split', en: 'keep' },
            maxCharsPerLine: 16,
            maxCharsPerLineEn: 42,
            maxLinesPerSegment: 1,
            maxSegmentDuration: 7,
            promptTerms: '',
            lexiconIds: [],
          },
        })
        return null
      } catch (err) {
        return String(err && err.message)
      }
    })()`)
    check(
      '响应式数据会被拒收（证明纯化只能在渲染层做，preload 救不了）',
      /could not be cloned/i.test(String(proxyRejected)),
      String(proxyRejected),
    )

    /**
     * ② 真实链路：`EditorView.openAiReview()` 先用 `toPlain()` 纯化再交给 IPC。
     * 漏了这一步窗口就完全打不开，界面上只会弹一句「打不开 AI 校对窗口」。
     */
    const openRes = await cdp.evaluate(`(async () => {
      const plain = (value) => JSON.parse(JSON.stringify(value))
      try {
        await window.xbaos.assist.open(plain({
          targets: [
            {
              fileId: 'probe-demo',
              fileName: 'probe-demo.wav',
              durationSec: 20,
              segmentCount: 1,
              segments: [
                { id: 's1', start: 0, end: 2, text: '你好', origin: '你好', issues: [] },
              ],
            },
          ],
          settings: {
            language: 'zh',
            autoDetectLanguage: false,
            punctuation: { zh: 'strip-split', en: 'keep' },
            maxCharsPerLine: 16,
            maxCharsPerLineEn: 42,
            maxLinesPerSegment: 1,
            maxSegmentDuration: 7,
            promptTerms: 'XBAOS',
            lexiconIds: [],
          },
        }))
        return { ok: true }
      } catch (err) {
        return { ok: false, message: String(err && err.message) }
      }
    })()`)
    check('纯化后的 payload 能正常开窗', openRes?.ok === true, JSON.stringify(openRes))

    // 辅助窗口是一个新的渲染进程目标
    const target = await waitForTargetByUrl('window=assist')
    check('辅助窗口已创建（独立渲染进程）', !!target, target?.url ?? '未出现')
    if (!target) {
      check('辅助窗口链路', false, '窗口没起来，后续断言跳过')
      return
    }

    const ass = await connect(target.webSocketDebuggerUrl)
    await ass.send('Page.enable')
    await ass.send('Runtime.enable')
    await ass.send('Page.bringToFront').catch(() => {})

    // 等辅助窗口挂载完（自绘标题栏出现即视为渲染完成）
    for (let i = 0; i < 50; i++) {
      const ready = await ass.evaluate(`!!document.querySelector('.abar')`).catch(() => false)
      if (ready) break
      await sleep(200)
    }

    check('辅助窗口渲染出自绘标题栏', await ass.evaluate(`!!document.querySelector('.abar')`))
    check(
      '辅助窗口渲染出三步步骤条',
      (await ass.evaluate(`document.querySelectorAll('.steps__item').length`)) === 3,
    )
    check(
      '辅助窗口不渲染主界面外壳',
      (await ass.evaluate(`!!document.querySelector('.app')`)) === false,
    )

    // 取数据：主窗口交上来的 payload 应能被辅助窗口读到
    const payload = await ass.evaluate(`window.xbaos.assist.payload()`)
    const firstTarget = payload?.targets?.[0]
    check(
      '辅助窗口取到待校对条目',
      !!payload && firstTarget?.fileName === 'probe-demo.wav' && firstTarget?.segments?.length === 1,
      `fileName=${firstTarget?.fileName} 条目=${firstTarget?.segments?.length}`,
    )
    // 只解外层是不够的：如果渲染层用了 `{ ...seg }` 这种浅展开，嵌套数组仍是
    // Proxy，克隆照样失败。这条断言盯的就是「深度」这层。
    check(
      '嵌套字段也完整传到辅助窗口（不是只解了一层）',
      Array.isArray(firstTarget?.segments?.[0]?.issues),
      `issues=${JSON.stringify(firstTarget?.segments?.[0]?.issues)}`,
    )
    // 设置也要整套带过来：提示词是在辅助窗口按这些设置现拼的，缺字段提示词就残缺。
    check(
      '本地设置整套传到辅助窗口（提示词要按它现拼）',
      payload?.settings?.maxCharsPerLine === 16 && !!payload?.settings?.punctuation,
      `maxCharsPerLine=${payload?.settings?.maxCharsPerLine}`,
    )

    // 置顶：**默认不开**（两个窗口来回切是这段流程的常态，长期钉在最前反而挡住
    // 别的窗口），但按钮保留 —— 开了要能生效，也要能再关掉。
    const topDefault = await ass.evaluate(`window.xbaos.assist.isAlwaysOnTop()`)
    check('辅助窗口不默认置顶', topDefault === false, String(topDefault))
    await ass.evaluate(`window.xbaos.assist.setAlwaysOnTop(true)`)
    await sleep(150)
    check('打开置顶生效', (await ass.evaluate(`window.xbaos.assist.isAlwaysOnTop()`)) === true)
    await ass.evaluate(`window.xbaos.assist.setAlwaysOnTop(false)`)
    await sleep(150)
    check(
      '取消置顶生效',
      (await ass.evaluate(`window.xbaos.assist.isAlwaysOnTop()`)) === false,
    )

    // 「回到 AI 窗口」快捷按钮走的就是这条链路：只 restore/show/focus，
    // 不是把窗口改成常驻置顶（用户切去 AI 网页时不该被它钉住）
    const focusRes = await cdp.evaluate(`window.xbaos.assist.focus()`)
    check('能把辅助窗口一次性拉到最前（快捷按钮的链路）', focusRes?.ok === true, JSON.stringify(focusRes))

    // 关窗必须通知主窗口解锁。主界面在辅助窗口存在期间是压暗的，这条消息丢了
    // 就永久锁死（只能重启软件）。监听要**提前挂**——应用在写回结果后会自动关窗。
    await cdp.evaluate(`(() => {
      window.__assistClosed = 0
      window.__assistOffClosed = window.xbaos.assist.onClosed(() => { window.__assistClosed += 1 })
      return true
    })()`)

    // 剪贴板：辅助窗口写，主窗口读 —— 验证是同一条系统剪贴板
    const marker = `XBAOS-PROBE-${Date.now()}`
    await ass.evaluate(`window.xbaos.clipboard.write(${JSON.stringify(marker)})`)
    const readBack = await cdp.evaluate(`window.xbaos.clipboard.readText()`)
    check('剪贴板写入后主窗口能读到同一条内容', readBack === marker, String(readBack).slice(0, 40))

    // 主窗口挂结果订阅，辅助窗口提交后应原路收到
    await cdp.evaluate(`(() => {
      window.__assistResult = null
      window.__assistOff = window.xbaos.assist.onResult((p) => { window.__assistResult = p })
      return true
    })()`)
    // 回传路径同理：`AssistView` 的 cues 存在 `ref` 里，是响应式数组，
    // 不纯化的话在 contextBridge 边界就被拒。`send` 是同步的，所以这里是
    // 同步抛错 —— 表现为「点了确认没有任何反应」。
    const submitProxyErr = await ass.evaluate(`(() => {
      const deepProxy = (value) => {
        if (!value || typeof value !== 'object') return value
        for (const key of Object.keys(value)) value[key] = deepProxy(value[key])
        return new Proxy(value, {})
      }
      try {
        window.xbaos.assist.submit({
          results: deepProxy([{ fileId: 'probe-demo', cues: [{ start: 0, end: 1, text: 'x' }] }]),
        })
        return null
      } catch (err) {
        return String(err && err.message)
      }
    })()`)
    check(
      '回传路径的响应式数据同样会被拒收',
      /could not be cloned/i.test(String(submitProxyErr)),
      String(submitProxyErr),
    )

    // 纯化之后提交（`AssistView.confirmApply()` 里就是这么做的）
    await ass.evaluate(`window.xbaos.assist.submit({
      results: [{ fileId: 'probe-demo', cues: [{ start: 0, end: 2, text: '你好' }] }],
    })`)
    await sleep(400)
    const got = await cdp.evaluate(`(() => {
      window.__assistOff?.()
      return window.__assistResult
    })()`)
    const gotFirst = got?.results?.[0]
    check(
      '校对结果已回传到主窗口',
      !!got && gotFirst?.fileId === 'probe-demo' && gotFirst?.cues?.length === 1,
      `fileId=${gotFirst?.fileId} cues=${gotFirst?.cues?.length}`,
    )

    // 应用写回结果后会自动关窗（`App.vue` 的 onAssistResult 末尾调 assist.close()），
    // 主进程据此拉起主窗口并通知渲染层解锁 —— 这条断言覆盖的正是那一步收尾。
    const closedHits = await cdp.evaluate(`(() => {
      const n = window.__assistClosed
      window.__assistOffClosed?.()
      return n
    })()`)
    check('写回结果自动关窗后，主窗口收到解锁通知', closedHits === 1, `收到 ${closedHits} 次`)

    // 关窗：辅助窗口目标应消失，主窗口不受影响
    await cdp.evaluate(`window.xbaos.assist.close()`)
    await sleep(500)
    const left = await listTargets()
    check(
      '关窗后辅助窗口目标消失',
      !left.some((t) => t.url.includes('window=assist')),
      left.map((t) => t.url).join(' | ').slice(0, 80),
    )
    check('主窗口未受影响', await cdp.evaluate(`!!document.querySelector('.titlebar')`))

    ass.close()

    await shot(cdp, 'electron-assist.png')
  },

  /**
   * 更新检查（真实主进程网络路径）。
   *
   * 只换地址不换代码：`XBAOS_UPDATE_URL` 指向探针起的本地服务，主进程里跑的仍是
   * 线上那条 `net.fetch` → 解析 → 分类的路径。所以这里验的是**我们自己的逻辑**，
   * 与外网是否可达无关，也就不会因为网络抖动而变成"偶发失败"。
   */
  async 'update-check'({ cdp }) {
    /* ---- 有新版：解析出条目、官网、升级说明 */
    manifest.payload = makeManifest()
    manifest.status = 200
    manifest.requests.length = 0

    const up = await cdp.evaluate(`window.xbaos.update.check()`)
    check(
      '主进程能取回并解析版本清单',
      up?.ok === true && up?.state === 'update',
      JSON.stringify(up).slice(0, 140),
    )
    check('解析出新版本号', up?.latest === '0.9.9', String(up?.latest))
    check('带上更新条目', Array.isArray(up?.notes) && up.notes.length === 2, `notes=${up?.notes?.length}`)
    check('带上官网地址', up?.homepage === 'https://subtitle.xbaos.com.cn', String(up?.homepage))
    check('带上版本标题与变更概要', !!up?.releaseTitle && !!up?.highlight, `${up?.releaseTitle} / ${up?.highlight}`)
    // CDN / 浏览器缓存会把新版本号压住，所以每次请求都得带一个变化的查询串
    check(
      '请求加了反缓存查询串（否则 CDN 会把新版本号缓存住）',
      (manifest.requests[0] ?? '').includes('_='),
      manifest.requests[0] ?? '(没有收到请求)',
    )

    /* ---- 版本一致：不该提示更新 */
    manifest.payload = makeManifest({ latest: '0.1.0', releases: [] })
    const same = await cdp.evaluate(`window.xbaos.update.check()`)
    check('版本与清单一致时 state=latest', same?.state === 'latest', String(same?.state))

    /* ---- 清单 404：归类为 http 并原样透出三位状态码 */
    manifest.status = 404
    const miss = await cdp.evaluate(`window.xbaos.update.check()`)
    check(
      '清单 404 时归类为 http 且带三位状态码',
      miss?.ok === false && miss?.reason === 'http' && miss?.code === 404,
      JSON.stringify(miss).slice(0, 140),
    )

    /* ---- 清单内容不是清单：归类为 format，而不是当成 0.0.0 去比较 */
    manifest.status = 200
    manifest.payload = { hello: 'world' }
    const junk = await cdp.evaluate(`window.xbaos.update.check()`)
    check(
      '清单缺字段时归类为 format（不会误判成没有新版本）',
      junk?.ok === false && junk?.reason === 'format',
      JSON.stringify(junk).slice(0, 140),
    )

    /* ---- 外链白名单（只测拒绝路径，放行路径会真的拉起系统浏览器打扰用户） */
    manifest.payload = makeManifest()
    const deny = async (url) =>
      cdp.evaluate(`window.xbaos.update.openUrl(${JSON.stringify(url)})`)
    const openFile = await deny('file:///C:/Windows/System32/calc.exe')
    check('拒绝 file: 协议（否则等于把本机执行权交出去）', openFile?.ok === false, JSON.stringify(openFile))
    const openForeign = await deny('https://example.com/download')
    check('拒绝站外域名', openForeign?.ok === false, JSON.stringify(openForeign))
    const openHttp = await deny('http://subtitle.xbaos.com.cn/x')
    check('拒绝非 https', openHttp?.ok === false, JSON.stringify(openHttp))
    const openSpoof = await deny('https://xbaos.com.cn.evil.com/x')
    check('拒绝冒充域名（后缀匹配要卡在点号上）', openSpoof?.ok === false, JSON.stringify(openSpoof))
    const openEmpty = await deny('')
    check('拒绝空地址', openEmpty?.ok === false, JSON.stringify(openEmpty))

    /* ---- 真实界面链路：关于页点「检查更新」→ 左下角提示 + 状态同步 */
    manifest.payload = makeManifest()
    const navBox = await cdp.evaluate(`(() => {
      const btn = [...document.querySelectorAll('.sidebar__item')].find((b) =>
        b.textContent.includes('关于'),
      )
      if (!btn) return null
      btn.scrollIntoView({ block: 'center' })
      const r = btn.getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`)
    check('找得到侧边栏「关于」入口', !!navBox, navBox ? '' : '导航项缺失')
    if (navBox) {
      // 真实鼠标事件：JS .click() 不转移焦点，测不出与 focus 相关的竞态
      await cdp.click(navBox.x, navBox.y)
      await sleep(500)

      const checkBox = await cdp.evaluate(`(() => {
        const btn = [...document.querySelectorAll('.upd__actions .btn')].find((b) =>
          b.textContent.includes('检查更新'),
        )
        if (!btn) return null
        btn.scrollIntoView({ block: 'center' })
        const r = btn.getBoundingClientRect()
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      })()`)
      check('关于页有「软件更新」区块与检查按钮', !!checkBox, checkBox ? '' : '找不到按钮')
      if (checkBox) {
        manifest.requests.length = 0
        await cdp.click(checkBox.x, checkBox.y)
        await sleep(900)

        const shown = await cdp.evaluate(`(() => {
          const rows = [...document.querySelectorAll('.upd__row')]
          const map = {}
          for (const row of rows) {
            map[row.querySelector('dt')?.textContent.trim()] = row.querySelector('dd')?.textContent.trim()
          }
          const hint = document.querySelector('.sidebar__update')
          return {
            map,
            hint: hint ? hint.textContent.replace(/\\s+/g, '') : null,
            stateClass:
              document.querySelector('.upd__state--new') !== null
                ? 'new'
                : document.querySelector('.upd__state--ok') !== null
                  ? 'ok'
                  : document.querySelector('.upd__state--bad') !== null
                    ? 'bad'
                    : '',
          }
        })()`)
        check(
          '界面发起的是真实检查（服务端确实收到了请求）',
          manifest.requests.length > 0,
          manifest.requests[0] ?? '(没有请求)',
        )
        check('关于页状态显示发现新版本', shown?.stateClass === 'new', `${shown?.stateClass} ${shown?.map?.['状态']}`)
        check('关于页最新版本一栏显示清单里的版本', shown?.map?.['最新版本'] === 'v0.9.9', String(shown?.map?.['最新版本']))
        check(
          '左下角同步出现更新提示',
          !!shown?.hint && shown.hint.includes('0.9.9'),
          shown?.hint ?? '没有提示条',
        )
        await shot(cdp, 'electron-update.png')
      }
    }
  },

  /** 无边框窗口的标题栏必须能拖动 */
  async titlebar({ cdp }) {
    const state = await cdp.evaluate(`(() => {
      const bar = document.querySelector('.titlebar')
      const btn = document.querySelector('.titlebar__btn')
      const root = getComputedStyle(document.documentElement)
      return {
        barExists: !!bar,
        barRegion: bar ? getComputedStyle(bar).webkitAppRegion : null,
        btnRegion: btn ? getComputedStyle(btn).webkitAppRegion : null,
        theme: document.documentElement.dataset.theme ?? '(跟随系统)',
        bg: root.getPropertyValue('--color-bg-base').trim(),
        accent: root.getPropertyValue('--color-accent').trim(),
      }
    })()`)

    check('标题栏存在', state.barExists === true)
    check('标题栏可拖动', state.barRegion === 'drag', `app-region=${state.barRegion}`)
    check('标题栏按钮不参与拖动', state.btnRegion === 'no-drag', `app-region=${state.btnRegion}`)
    check('主题与底色已生效', !!state.bg, `${state.theme} bg=${state.bg} accent=${state.accent}`)

    await shot(cdp, 'electron-window.png')
  },
}

/* ---------------------------------------------------------------------- main */

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const chosen = args.length > 0 ? args : Object.keys(scenarios)

/** 兜底超时。任何一步意外挂住都不该让探针永远停在那儿。 */
const WATCHDOG_MS = Number(process.env.XBAOS_PROBE_TIMEOUT || 240_000)
const watchdog = setTimeout(() => {
  console.error(`\n[probe] 超过 ${WATCHDOG_MS} ms 仍未结束，强制终止`)
  if (handle) {
    handle.cdp.close()
    handle.child.kill()
  }
  process.exit(1)
}, WATCHDOG_MS)
watchdog.unref()

let handle = null
try {
  // 更新源要在应用启动前就绪（启动时的自动检查会立刻用到它）
  await startManifestServer()
  handle = await launch()
  for (const name of chosen) {
    const fn = scenarios[name]
    if (!fn) {
      console.log(`跳过未知场景: ${name}`)
      continue
    }
    console.log(`\n▶ ${name}`)
    try {
      await fn(handle)
    } catch (err) {
      check(`${name} 场景异常`, false, err.message)
    }
  }
} catch (err) {
  check('启动 Electron', false, err.message)

  // launch 中途失败时子进程还活着，要主动收掉，否则它会吊着事件循环不让探针退出
  if (pendingChild && !pendingChild.killed) {
    pendingChild.kill()
    await sleep(300)
  }

  // 这一条是环境问题而不是代码问题，单独说清楚，免得反复查错方向
  if (/GPU process isn't usable|gpu_process_host/.test(err.message)) {
    console.error(
      '\n提示：Electron 的 GPU 进程在当前会话里起不来（连 8 行的最小 Electron 程序也一样）。' +
        '这通常发生在没有交互式桌面会话的环境（CI、后台服务、被沙箱隔离的 shell）里。' +
        '请在自己的终端直接执行 `npm run dev` 肉眼确认界面，探针留到正常桌面会话下再跑。',
    )
  }
} finally {
  stopManifestServer()
  if (handle) {
    handle.cdp.close()
    handle.child.kill()
    // 给子进程一点时间放开临时 profile 的文件句柄，再清目录
    await sleep(300)
    handle.cleanup?.()
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n通过 ${results.length - failed.length} / ${results.length}`)
process.exit(failed.length > 0 ? 1 : 0)
