/**
 * Electron 主进程。
 *
 * 职责边界很窄，只做渲染进程做不到的三类事：
 *   1. 窗口与生命周期
 *   2. 文件系统与系统对话框（渲染进程在 file:// 下拿不到真实路径）
 *   3. 托管识别引擎进程（subprocess 只有主进程能起）
 *
 * 所有业务逻辑都在渲染进程里，主进程只做转发。这样前端仍然可以用浏览器
 * 直接预览（`npm run dev:ui`），不依赖 Electron。
 */

import { app, BrowserWindow, dialog, ipcMain, nativeTheme, net, screen, session, shell, clipboard, desktopCapturer } from 'electron'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { EngineClient, EngineCanceledError, EngineCrashError } from './engine-client.js'
import { decodeTextAuto, encodeSubtitle } from './encoding.js'
import { ModelDownloader, MODEL_CATALOG } from './model-download.js'
import { MANIFEST_URL, allowedExternalUrl, checkForUpdate, isAllowedExternalHost } from './update.js'
import {
  DEFAULT_MODEL,
  findModel,
  listAvailableModels,
  modelSearchDirs,
  resolveEngineExe,
  resolveRendererDist,
  repoRoot,
  userModelsDir,
  writableModelsDir,
} from './paths.js'

// 同一时刻只允许一个实例：引擎进程和模型都是独占资源，跑两份没有意义
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
}

/** @type {BrowserWindow | null} */
let mainWindow = null

/**
 * 主窗口的关窗闸门。
 *
 * 「有没有未保存的内容」只有渲染进程知道（数据在它那儿），所以关窗是
 * 「主进程问 → 渲染进程裁决 → 回话放行」的两段式。`closeApproved` 就是放行标志：
 * 第一次 close 被拦下，用户在原生确认框里点了「仍要关闭」之后才置真。
 *
 * `closeWatchdog` 是兜底：万一渲染进程卡死（或干脆崩了）没有回话，
 * 4 秒后无条件放行 —— 窗口关不掉只能去杀进程，那更糟。
 */
let closeApproved = false
let closeWatchdog = null

/**
 * 「AI 校对」辅助窗口。
 *
 * 用户要跳出软件去网页版 AI 里操作，复制提示词、粘贴结果、再复制回来，
 * 所以这个窗口必须一直能看见 —— 默认置顶，也因此得是独立窗口而不是模态弹窗
 * （模态会把主窗口按住，用户反而没法对照着看）。
 * @type {BrowserWindow | null}
 */
let assistWindow = null

/**
 * 辅助窗口的数据：提示词全文 + 待校对的条目清单 + 校验用的片长。
 *
 * 主窗口与辅助窗口是两个独立的渲染进程，Pinia store 不共享，
 * 只能从主进程中转一趟。窗口关闭即清空。
 * @type {object | null}
 */
let assistPayload = null

/**
 * 「录制音频」窗口。与辅助窗口同一套形态（独立窗口 + 主界面压暗 + 关窗两段式），
 * 但**置顶、数据中转、关闭保护都是各自独立的一份** —— 两个窗口可能先后开着，
 * 共用一组标志的话，先关的那个会把后开的那个的锁一起解掉。
 * @type {BrowserWindow | null}
 */
let recordWindow = null

/** 录音窗口的关窗闸门。语义与主窗口的 `closeApproved` 完全一致，只是各管各的 */
let recordCloseApproved = false
let recordCloseWatchdog = null

/** @type {EngineClient | null} */
let engine = null

/** 当前正在跑的识别任务，保证同一时刻只有一个 */
let activeTask = null

/**
 * 用户自定义的模型目录。渲染进程启动时同步过来（设置存在 localStorage 里）。
 * 空串表示用默认位置。设了它之后**旧目录不再参与扫描** —— 见 paths.js。
 */
let customModelsDir = ''

/** 模型下载器。注册 IPC 时构造，事件统一转发给渲染进程 */
let modelDownloader = null

/** 渲染进程可见的模型目录条目。下载地址由主进程内部维护，不下发 */
const MODEL_CATALOG_PUBLIC = MODEL_CATALOG.map(({ key, file, sizeLabel }) => ({
  key,
  file,
  sizeLabel,
}))

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL || 'http://localhost:5173'
const isDev = !app.isPackaged

/**
 * 版本清单地址。
 *
 * 允许用环境变量覆盖：Electron 探针会起一个本地 HTTP 服务把它指过去，
 * 否则测「读不到清单」这条分支就只能靠真的断网。
 */
const UPDATE_URL = process.env.XBAOS_UPDATE_URL || MANIFEST_URL

// ---------------------------------------------------------------- 引擎装配

/** 模型查找上下文。集中构造一次，免得各处漏传某个字段导致开发态找不到模型。 */
function modelCtx() {
  return {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataPath: app.getPath('userData'),
    customModelsDir,
  }
}

function engineInfo() {
  const { exe, source } = resolveEngineExe({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  return { exe, source }
}

/**
 * 把「渲染进程给的模型标识」解析成引擎能用的绝对路径。
 *
 * 允许传三种东西：什么都不传（用默认模型）、只给文件名（在候选目录里找）、
 * 给绝对路径（直接检查存在性，给高级用户手动指定用）。
 * 找不到一律返回 null，由调用方决定怎么报错 —— 这里不抛，因为
 * engine:load 和 engine:transcribe 需要的错误文案不一样。
 */
/**
 * 从磁盘上已有的模型里挑一个兜底。
 *
 * 「模型不随包」之后用户装的很可能正是 base 或 turbo 而不是 small，
 * 不该因为他没点过「切换使用」就判定识别失败 —— 所以默认档找不到时
 * 还要继续在已装模型里挑。
 *
 * 多个候选时不听 readdir 的字母序：字母序会把 ggml-base 排在 ggml-small
 * 前面，等于默认给用户最差的那个。
 *
 * @returns {{path: string, dir: string, source: string} | null}
 */
function pickInstalledModel() {
  const preferred = findModel(DEFAULT_MODEL, modelCtx())
  if (preferred) return preferred

  const installed = listAvailableModels(modelCtx())
  if (installed.length === 0) return null

  const preferOrder = ['ggml-small.bin', 'ggml-base.bin', 'ggml-large-v3-turbo.bin']
  for (const name of preferOrder) {
    const hit = installed.find((m) => m.name === name)
    if (hit) return hit
  }
  return installed[0]
}

/**
 * 「这次到底会用哪个模型」的只读查询：不发事件、不产生副作用。
 *
 * 界面的「使用中」标记走这里，判断规则只在主进程存一份 —— 渲染进程
 * 若自己再算一遍（拿设置里的文件名比一比），文件被手动删掉之后就会
 * 留下一个「使用中」的空壳，点「切换使用」又切不过去。
 *
 * 刻意不发 `fallback` 事件：打开模型页看看不该冒出一条警告。
 */
function resolveModelInfo(requested) {
  if (requested) {
    const hit = path.isAbsolute(requested)
      ? (existsSync(requested) ? { path: requested, source: 'absolute' } : null)
      : findModel(requested, modelCtx())
    if (hit) return { name: path.basename(hit.path), path: hit.path, source: hit.source }
  }

  const fallback = pickInstalledModel()
  if (!fallback) return null
  return { name: path.basename(fallback.path), path: fallback.path, source: fallback.source }
}

function resolveModelPath(requested) {
  if (requested) {
    if (path.isAbsolute(requested)) {
      return existsSync(requested) ? requested : null
    }
    const found = findModel(requested, modelCtx())?.path ?? null
    if (found) return found

    /*
     * 用户在模型管理页选过的模型被手动删掉时，别让识别直接失败 ——
     * 那是最容易发生也最难自查的情形（在资源管理器里删了文件，软件这边
     * 一声不响地记着旧名字）。回退到任一可用模型并说明发生了什么。
     *
     * 注意回退目标用 pickInstalledModel() 而不是死盯 DEFAULT_MODEL：
     * 只装了 base 的用户，small 本来就不存在，盯默认档会白回退成 null。
     */
    const fallback = pickInstalledModel()
    if (!fallback) return null

    send('engine:stream', {
      taskId: null,
      msg: {
        type: 'fallback',
        from: requested,
        to: path.basename(fallback.path),
        reason: `所选模型 ${requested} 不存在，已回退到 ${path.basename(fallback.path)}`,
      },
    })
    return fallback.path
  }

  // 没选过模型（modelFile 为空）时同理
  return pickInstalledModel()?.path ?? null
}

// ---------------------------------------------------------------- 引擎诊断
//
// 这一组只在引擎出问题时才有用，但缺了它就没有任何现场可查：
// 之前 stderr 只 send('engine:log') 给渲染层，而 src/ 里没有任何监听方、
// 也不落盘 —— 用户报「点识别就崩」时，连崩溃前最后一行都拿不到。

const execFileAsync = promisify(execFile)

/** 引擎日志、崩溃现场、诊断包都放这里 */
function logsDir() {
  return path.join(app.getPath('userData'), 'logs')
}

function dateStamp(withTime = false) {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  if (!withTime) return day
  return `${day}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

let logsDirReady = false
function ensureLogsDir() {
  if (logsDirReady) return Promise.resolve()
  return fs
    .mkdir(logsDir(), { recursive: true })
    .then(() => {
      logsDirReady = true
    })
    .catch(() => {
      /* 日志目录建不出来不能影响识别 */
    })
}

/** 引擎日志按天落盘 */
function writeEngineLog(level, text) {
  ensureLogsDir()
    .then(() =>
      fs.appendFile(
        path.join(logsDir(), `engine-${dateStamp()}.log`),
        `[${new Date().toISOString()}] [${level}] ${text}\n`,
      ),
    )
    .catch(() => {
      /* 同上，静默 */
    })
}

/**
 * 最近若干条引擎日志的内存副本。
 * 崩溃后进程已经没了，日志文件里的最后一行可能还没 flush，
 * 这份副本用来拼崩溃现场和诊断包。
 */
const engineLogTail = []
const ENGINE_LOG_TAIL_MAX = 300

function rememberEngineLog(level, text) {
  engineLogTail.push({ at: new Date().toISOString(), level, text })
  if (engineLogTail.length > ENGINE_LOG_TAIL_MAX) {
    engineLogTail.splice(0, engineLogTail.length - ENGINE_LOG_TAIL_MAX)
  }
}

/**
 * 为什么要把「Vulkan 是否被禁用」存到磁盘。
 *
 * 用户的机器上只要有一个坏掉的 Vulkan 隐式层，引擎每次加载模型都会
 * 0xC0000005。识别失败后我们确实能自动降级，但如果不记住，用户下次
 * 打开软件又要再崩一次才降 —— 那是能避免的重复伤害。
 */
function engineStatePath() {
  return path.join(app.getPath('userData'), 'engine-state.json')
}

function readVulkanDisabled() {
  try {
    return JSON.parse(readFileSync(engineStatePath(), 'utf8'))?.vulkanDisabled === true
  } catch {
    return false
  }
}

function writeVulkanDisabled(value) {
  fs.mkdir(path.dirname(engineStatePath()), { recursive: true })
    .then(() => fs.writeFile(engineStatePath(), JSON.stringify({ vulkanDisabled: value === true }, null, 2)))
    .catch(() => {
      /* 记不住就算了，下次照常再试 */
    })
}

/**
 * 系统环境变量里是否已经要求禁用 Vulkan。
 *
 * 用户按排查建议手动设过 `GGML_DISABLE_VULKAN` 时会走到这里 —— 注意 ggml 只判断
 * `getenv(...) == nullptr`，所以**空字符串也算禁用**，这里必须跟它保持一致，
 * 否则界面会显示「自动（GPU）」而引擎实际在跑 CPU。
 */
function envDisablesVulkan() {
  return typeof process.env.GGML_DISABLE_VULKAN === 'string'
}

/**
 * 读 Vulkan 全局层的注册表项 —— 这是崩溃的**第一嫌疑清单**。
 *
 * 录屏、帧数、游戏加速、显卡厂商的覆盖层，都是往 ImplicitLayers 里塞一个
 * DLL，而这个 DLL 会在任何 Vulkan 应用创建实例时被无条件加载。它是静态
 * 环境信息，主进程在引擎死掉之后照样能读，不需要崩溃的进程配合。
 *
 * 用 reg.exe 而不是读注册表 API：Electron 没有内置注册表访问，而这里
 * 只在崩溃/导出诊断时跑一次，多进程开销无所谓。
 */
async function readVulkanLayers() {
  const targets = [
    ['HKLM', 'SOFTWARE\\Khronos\\Vulkan\\ImplicitLayers'],
    ['HKCU', 'SOFTWARE\\Khronos\\Vulkan\\ImplicitLayers'],
    ['HKLM', 'SOFTWARE\\Khronos\\Vulkan\\Drivers'],
    ['HKCU', 'SOFTWARE\\Khronos\\Vulkan\\Drivers'],
  ]

  // 并发读：崩溃现场要尽快落盘，四个键串行等下去最坏能拖十几秒
  const entries = await Promise.all(
    targets.map(async ([hive, key]) => {
      const full = `${hive}\\${key}`
      try {
        const { stdout } = await execFileAsync('reg', ['query', full], {
          windowsHide: true,
          timeout: 4000,
        })
        return [
          full,
          stdout
            .trim()
            .split(/\r?\n/)
            .map((s) => s.trimEnd())
            .filter(Boolean),
        ]
      } catch (err) {
        // 键不存在是常态（干净机器上就没有）；某些受限环境里 reg.exe 本身会被拦，
        // 那也只影响这一节内容，不能让整个诊断包失败
        return [full, [`(未找到或读取失败：${err.code ?? err.message})`]]
      }
    }),
  )

  return Object.fromEntries(entries)
}

/** 把 Windows 退出码翻译成人话，省得每次都要去查 */
function describeExitCode(code) {
  if (code === 0) return '正常退出'
  if (code === 3221225477) return '0xC0000005 访问违例（原生崩溃）'
  if (code === 3221225781) return '0xC0000135 缺少依赖 DLL'
  if (code === 3221225595) return '0xC000007B 映像格式不匹配（位数或 DLL 损坏）'
  if (typeof code === 'number') return `0x${(code >>> 0).toString(16).toUpperCase()}`
  return '(无退出码)'
}

function hostSummary() {
  const cpus = os.cpus()
  return [
    `平台：${process.platform} ${os.release()} (${os.arch()})`,
    `CPU：${cpus?.[0]?.model?.trim() ?? '(未知)'} × ${cpus?.length ?? 0}`,
    `内存：${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
  ]
}

/** 崩溃时立刻落一份现场，下一次用户再反馈就有据可查 */
async function writeCrashReport(client, info) {
  try {
    await ensureLogsDir()
    const layers = await readVulkanLayers()
    const lines = [
      'XBAOS 字幕生成器 引擎崩溃现场',
      `时间：${new Date().toLocaleString()}`,
      `版本：${app.getVersion()}`,
      `退出码：${info?.code ?? '(无)'} —— ${describeExitCode(info?.code)}`,
      `信号：${info?.signal ?? '(无)'}`,
      `引擎：${client?.exe ?? '(未知)'}`,
      `Vulkan 已禁用：${client?.disableVulkan ? '是' : '否'}`,
      ...hostSummary(),
      '',
      '--- Vulkan 全局层（第一嫌疑清单）---',
      ...Object.entries(layers).flatMap(([k, v]) => [k, ...v.map((s) => `  ${s}`), '']),
      '--- 引擎日志尾部 ---',
      ...engineLogTail.map((l) => `${l.at} [${l.level}] ${l.text}`),
      '',
    ]
    const file = path.join(logsDir(), `crash-${dateStamp(true)}.txt`)
    await fs.writeFile(file, lines.join('\n'), 'utf8')
    console.warn(`[engine] 崩溃现场已写入 ${file}`)
    return file
  } catch (err) {
    console.error(`[engine] 写崩溃现场失败：${err.message}`)
    return null
  }
}

function ensureEngine() {
  if (engine) return engine

  const { exe, source } = engineInfo()
  if (!exe) {
    throw new Error(
      '找不到识别引擎。开发态请先执行 engine/build.sh 编译；' +
        '也可以用环境变量 XBAOS_ENGINE_EXE 指定路径。',
    )
  }

  engine = new EngineClient(exe, [], { disableVulkan: readVulkanDisabled() || envDisablesVulkan() })
  engine.on('log', (level, text) => {
    rememberEngineLog(level, text)
    writeEngineLog(level, text)
    if (level === 'error' || level === 'warn') console.error(`[engine:${level}] ${text}`)
    else if (isDev) console.log(`[engine:${level}] ${text}`)
    mainWindow?.webContents.send('engine:log', { level, text })
  })
  engine.on('fallback', (msg) => {
    mainWindow?.webContents.send('engine:stream', { taskId: null, msg })
  })
  engine.on('exit', (info) => {
    mainWindow?.webContents.send('engine:exit', info)
    // 崩溃就立刻留现场：日志尾巴 + Vulkan 层清单，事后不用再求用户配合
    if (info?.crashed) {
      writeCrashReport(engine, info).then((file) => {
        if (file) mainWindow?.webContents.send('engine:crash', { code: info.code, report: file })
      })
    }
  })

  console.log(`[engine] 使用 ${exe}（来源 ${source}）`)
  return engine
}

/**
 * 把界面上的「推理后端」意图落到引擎进程上。
 *
 * ⚠ `backend: 'cpu'` 只传参数是**不够的**。引擎里那个判断只影响 whisper 的
 * `use_gpu`，而 ggml 的 Vulkan 后端是在注册表构造时无条件初始化的
 * （`ggml-backend-reg.cpp` 的 `#ifdef GGML_USE_VULKAN`），跟 use_gpu 无关。
 * 要真正避开 Vulkan，只能在 spawn 时给 `GGML_DISABLE_VULKAN=1`；那是环境
 * 变量，进程跑起来就改不了，所以这里可能需要重启引擎。
 *
 * 显式选 vulkan/gpu 时反过来做：把上次崩溃记下的禁用清掉，给用户一次机会。
 */
async function applyBackendIntent(client, backend) {
  if (backend === 'cpu') {
    if (!client.disableVulkan) await client.setDisableVulkan(true)
    return 'cpu'
  }
  if (backend === 'vulkan' || backend === 'gpu') {
    // 系统环境变量是外部强制的全局覆盖，界面改不动它
    if (envDisablesVulkan()) return 'cpu'
    if (client.disableVulkan) {
      await client.setDisableVulkan(false)
      writeVulkanDisabled(false)
    }
    return 'vulkan'
  }
  // auto：尊重上次降级的结果，不主动再撞一次
  return client.disableVulkan ? 'cpu' : 'auto'
}

// ---------------------------------------------------------------- 外观偏好

/**
 * 外观偏好的落地文件。
 *
 * 渲染进程把设置存在 localStorage 里（contextIsolation + file://，主进程读不到），
 * 但**首屏底色必须在窗口创建时就定下来** —— 那是页面还没跑起来之前的事。
 * 所以这里额外记一份极小的副本，只为了回答「下次启动画什么底色」这一个问题。
 *
 * 只存 `auto` / `light` / `dark` 三个值，不存别的设置，避免出现两份设置真相源。
 */
function themeStatePath() {
  return path.join(app.getPath('userData'), 'ui-theme.json')
}

/** 读上次记下的外观偏好。读不到就当 auto（跟随系统） */
function readThemeMode() {
  try {
    const raw = JSON.parse(readFileSync(themeStatePath(), 'utf8'))
    const mode = raw && raw.mode
    return mode === 'light' || mode === 'dark' ? mode : 'auto'
  } catch {
    return 'auto'
  }
}

/**
 * 毛玻璃偏好（标题栏 Acrylic 材质）。与主题同一个副本文件 —— 两者都是
 * 「窗口创建时就要定」的首屏参数，渲染进程的 localStorage 主进程读不到。
 * 缺省视为开启；不支持的环境（Win10 / 非 Windows）会静默回退纯色，无副作用。
 */
function readGlassPref() {
  try {
    const raw = JSON.parse(readFileSync(themeStatePath(), 'utf8'))
    return !(raw && raw.glass === false)
  } catch {
    return true
  }
}

/**
 * 副本文件是主题与毛玻璃两样东西共用的，写哪样都要**先读后并**，
 * 不能整文件覆盖 —— 否则存主题会把毛玻璃偏好抹掉，反之亦然。
 */
async function writeThemeState(patch) {
  let current = {}
  try {
    current = JSON.parse(readFileSync(themeStatePath(), 'utf8')) || {}
  } catch {
    /* 没有旧文件就从空对象开始 */
  }
  await fs.writeFile(themeStatePath(), JSON.stringify({ ...current, ...patch }), 'utf8')
}

/**
 * Windows 11 22H2（build 22621）起才有 Acrylic / Mica 材质。
 * `os.release()` 在 Win10/11 上都报 "10.0.x"，区别只在 build 号。
 */
function isGlassSupported() {
  if (process.platform !== 'win32') return false
  const build = Number(os.release().split('.')[2]) || 0
  return build >= 22621
}

/**
 * 毛玻璃窗口选项。**三个窗口（主窗口 / AI 辅助 / 录音）共用一套判定**，
 * 免得哪天改了一处忘了另一处 —— 它们都要求「系统支持 + 用户没关 + 不是无头模式」。
 *
 * 材质用 Acrylic：它模糊的是窗口**背后的真实画面**，拖动窗口能看到底下内容在动；
 * Mica 的底只是壁纸色调且整体偏不透明，深色下几乎看不出透明（2026-10-11 实测反馈）。
 *
 * 开启材质必须同时把窗口底色给成全透明（#00000000，8 位 RGBA 是 Electron 认的格式）：
 * 页面透明了、下面还垫一层不透明底色的话，材质永远看不见。
 */
const GLASS_MATERIAL = 'acrylic'

function glassWindowOptions(headless) {
  const active = !headless && isGlassSupported() && readGlassPref()
  return {
    active,
    /** 直接摊进 BrowserWindow 的选项里 */
    winOptions: active ? { backgroundMaterial: GLASS_MATERIAL, backgroundColor: '#00000000' } : {},
    /** 带给渲染进程的首屏状态参数（它要在首帧前决定是否透明化自己） */
    arg: `--xbaos-glass=${active ? '1' : '0'}`,
    /** 不开材质时该用的实色底 */
    solidBg: nativeTheme.shouldUseDarkColors ? '#121212' : '#ededed',
  }
}

/** 三个窗口一起切材质。窗口可能还没建、可能已销毁，逐个判掉 */
function applyGlassMaterial(active) {
  for (const win of [mainWindow, assistWindow, recordWindow]) {
    if (!win || win.isDestroyed()) continue
    try {
      win.setBackgroundMaterial(active ? GLASS_MATERIAL : 'none')
      win.setBackgroundColor(active ? '#00000000' : nativeTheme.shouldUseDarkColors ? '#121212' : '#ededed')
    } catch {
      /* 不支持的环境上调用可能抛错：保持原样即可，界面本来就走纯色 */
    }
  }
}

/** 广播给所有已存在的窗口（毛玻璃状态变化时三个窗口都要跟着换样式） */
function broadcast(channel, payload) {
  for (const win of [mainWindow, assistWindow, recordWindow]) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}

/**
 * 把这个偏好换算成**首屏实际该用的主题**。
 * `auto` 跟随系统；固定值直接用它 —— 用户选了浅色就不该在深色系统上先闪一下黑。
 */
function resolvedStartupTheme() {
  const mode = readThemeMode()
  if (mode === 'light' || mode === 'dark') return mode
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

// ---------------------------------------------------------------- 窗口创建

function createWindow() {
  // 探针（tools/electron-probe.mjs）用这个开关跑无窗口模式，
  // 免得每次自动化验证都在你屏幕上弹一下窗口、抢走焦点
  const headless = process.env.XBAOS_HEADLESS === '1'

  /*
   * 窗口尺寸按屏幕算，不写死。
   *
   * 1360×880 在 1080p 上顺眼，但在 1366×768 的轻薄本上比工作区还高 ——
   * 标题栏和底部状态条会被挤到屏幕外。这里取「工作区的 90%」与理想尺寸中
   * 较小的那个，并留 80px 的余量给任务栏与窗口边距。
   *
   * **刻意不记忆位置**：每次都以系统默认位置开在屏幕中央，用户明确要的。
   */
  const { workAreaSize } = screen.getPrimaryDisplay()
  const width = Math.max(960, Math.min(1360, workAreaSize.width - 80))
  const height = Math.max(640, Math.min(880, workAreaSize.height - 80))
  const startupTheme = resolvedStartupTheme()

  /*
   * 标题栏毛玻璃（Acrylic）。主窗口与两个附属窗口共用 glassWindowOptions：
   * Win10、浏览器预览、探针无窗口模式都走纯色 —— 材质是系统级 DWM 效果，
   * 不支持的环境上这个选项要么报错要么没效果，必须提前判掉。
   *
   * 启用时把玻璃开关从启动参数带给渲染进程，它好在**首帧之前**把自己
   * （html / 应用外壳 / 三处标题栏）改成半透明，同样是为了不给材质垫底色。
   */
  const glass = glassWindowOptions(headless)

  mainWindow = new BrowserWindow({
    width,
    height,
    // 最小尺寸也不能超过屏幕可用高度，否则小屏上窗口永远塞不进工作区
    minWidth: Math.min(1040, width),
    minHeight: Math.min(680, height),
    // 界面自带标题栏，用系统边框会重复一条
    frame: false,
    // 开发模式的窗口/任务栏图标。打包后 build/ 不进 asar，
    // Windows 会自动取 exe 里嵌的图标资源，无需指定
    ...(app.isPackaged ? {} : { icon: path.join(repoRoot, 'build', 'icon.ico') }),
    // 首屏底色跟随**用户设置的外观**（不是系统主题），避免固定浅色 + 深色系统时闪黑。
    // 毛玻璃开启时是全透明，材质才能透出来
    backgroundColor: glass.active ? '#00000000' : startupTheme === 'dark' ? '#121212' : '#ededed',
    ...(glass.active ? { backgroundMaterial: GLASS_MATERIAL } : {}),
    show: false,
    webPreferences: {
      preload: path.join(repoRoot, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关掉拼写检查的红色波浪线，字幕文本里全是专有名词，误报很吵
      spellcheck: false,
      // 渲染进程在 file:// 下读不到 package.json，版本号从启动参数带过去
      additionalArguments: [
        `--xbaos-version=${app.getVersion()}`,
        // 首屏主题：渲染进程在首帧前拿它定 data-theme，避免 HTML 里那句
        // 兜底深色底先闪一下（`index.html` 的 inline style）
        `--xbaos-theme=${startupTheme}`,
        // 毛玻璃：渲染进程在首帧前决定要不要把自己透明化
        glass.arg,
      ],
    },
  })

  mainWindow.once('ready-to-show', () => {
    if (!headless) mainWindow?.show()
  })

  loadRenderer(mainWindow, null)

  if (process.env.XBAOS_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' })
  }

  // 站内不许跳转：这是一个纯本地应用，任何导航都说明出了问题
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_SERVER_URL)) return
    event.preventDefault()
    console.warn(`[security] 已拦截导航: ${url}`)
  })

  // 外链只放行 XBAOS 官方域名（含子域），且必须在系统浏览器打开。
  // 其余一律拒绝 —— 应用承诺「全过程本地、不联网」，不能留任何静默外联的口子。
  // 判据与「前往官网更新」共用 update.js 里那一份，避免改域名时漏改一处。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    let host = ''
    try {
      host = new URL(url).hostname
    } catch {
      return { action: 'deny' }
    }
    if (isAllowedExternalHost(host)) {
      shell.openExternal(url)
    } else {
      console.warn(`[security] 已拦截外部链接: ${url}`)
    }
    return { action: 'deny' }
  })

  // 最大化 / 全屏状态回推给渲染进程，标题栏的图标才会跟着变
  attachWindowState(mainWindow)

  /*
   * 关窗闸门。见 `closeApproved` 的注释 —— 每次新建窗口都要复位，
   * 否则第二扇窗口会带着上一扇的放行状态直接关掉。
   */
  closeApproved = false
  mainWindow.on('close', (event) => {
    if (closeApproved) return
    event.preventDefault()
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('app:close-request')
    if (closeWatchdog) clearTimeout(closeWatchdog)
    closeWatchdog = setTimeout(() => {
      closeWatchdog = null
      closeApproved = true
      mainWindow?.close()
    }, 4000)
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    // 辅助窗口依附于主窗口，主窗口没了它也没有单独存在的意义
    if (assistWindow && !assistWindow.isDestroyed()) assistWindow.close()
    // 录音窗口同理：它保存音频靠的是主窗口的队列，单独留着也接不上
    if (recordWindow && !recordWindow.isDestroyed()) recordWindow.close()
  })

  /*
   * 用户点回窗口就把闪烁停掉。
   *
   * Windows 上 `flashFrame(true)` 会一直闪到窗口获得焦点为止，不主动停会闪得
   * 人心烦 —— 而「用户已经回来了」这件事只有窗口自己知道。
   */
  mainWindow.on('focus', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.flashFrame(false)
  })
}

// ------------------------------------------------------------ 辅助窗口装配

/**
 * 把最大 / 全屏状态回推给某个窗口自己。
 *
 * 必须按窗口分别注册：之前这段是写在 registerIpc() 里的，而 registerIpc()
 * 先于 createWindow() 执行，那时 mainWindow 还是 null —— `mainWindow?.on(...)`
 * 静默什么都没注册，图标从来没更新过。
 */
function attachWindowState(win) {
  const push = () => {
    if (win.isDestroyed()) return
    win.webContents.send('window:state', {
      maximized: win.isMaximized(),
      fullScreen: win.isFullScreen(),
    })
  }
  for (const evt of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen']) {
    win.on(evt, push)
  }
  return push
}

/**
 * 把前端产物装进窗口。
 *
 * 有 dev server 就用它（热更新最舒服），否则加载构建产物，这样 `npm start`
 * 能在 Electron 里跑真实 dist。query 用来区分窗口用途（辅助窗口带 window=assist）。
 */
function loadRenderer(win, query) {
  const distIndex = path.join(resolveRendererDist(), 'index.html')
  const devUrl = process.env.VITE_DEV_SERVER_URL || ''
  const withQuery = (base) => {
    if (!query) return base
    const url = new URL(base)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    return url.toString()
  }

  if (devUrl) {
    win.loadURL(withQuery(devUrl))
  } else if (existsSync(distIndex)) {
    win.loadFile(distIndex, query ? { query } : undefined)
  } else {
    console.warn('[dev] 没有 dist 产物，回退到开发服务器地址')
    win.loadURL(withQuery(DEV_SERVER_URL))
  }
}

/**
 * 把主窗口一次性拉到最前。
 *
 * 只做一次恢复 + 聚焦，**不改变置顶状态** —— 用户如果把 AI 窗口设成置顶，
 * 那是他自己要的效果，不能因为关窗就把它一起改掉。
 */
function raiseMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 打开「AI 校对」辅助窗口。
 *
 * 样式与主窗口保持一致（自绘标题栏 + 无边框），可缩放、**默认不置顶**（置顶按钮
 * 保留，用户需要时自己开）。已存在时只刷新数据并聚焦，不重复开窗。
 */
function createAssistWindow(payload) {
  assistPayload = payload

  if (assistWindow && !assistWindow.isDestroyed()) {
    if (assistWindow.isMinimized()) assistWindow.restore()
    assistWindow.show()
    assistWindow.focus()
    // 已在的窗口重新拉一次数据（prompt 可能换了字幕）
    assistWindow.webContents.send('assist:refresh', true)
    return assistWindow
  }

  const headless = process.env.XBAOS_HEADLESS === '1'
  const glass = glassWindowOptions(headless)

  assistWindow = new BrowserWindow({
    width: 720,
    height: 840,
    minWidth: 560,
    minHeight: 520,
    // 可缩放：提示词长短不一，用户会想把它拉大一点看
    resizable: true,
    maximizable: true,
    // 与主窗口一致的自绘标题栏
    frame: false,
    // 不默认置顶：两个窗口来回切是这段流程的常态，长期钉在最前反而挡住别的窗口
    alwaysOnTop: false,
    ...(app.isPackaged ? {} : { icon: path.join(repoRoot, 'build', 'icon.ico') }),
    backgroundColor: glass.active ? '#00000000' : glass.solidBg,
    ...glass.winOptions,
    show: false,
    webPreferences: {
      preload: path.join(repoRoot, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--xbaos-version=${app.getVersion()}`, glass.arg],
    },
  })

  attachWindowState(assistWindow)

  /**
   * 兜底显示。
   *
   * 常规路径是 ready-to-show；但它只在「首帧已绘制」时触发，渲染慢或首帧异常时
   * 可能一直不来 —— 窗口是 show:false 建出来的，那就变成「点了按钮什么都没弹出」的
   * 假死观感。所以 did-finish-load 之后再补一次，两条路谁先到都算数。
   */
  const reveal = () => {
    if (headless) return
    if (assistWindow && !assistWindow.isDestroyed() && !assistWindow.isVisible()) {
      assistWindow.show()
    }
  }
  assistWindow.once('ready-to-show', reveal)
  assistWindow.webContents.once('did-finish-load', () => setTimeout(reveal, 120))

  // 渲染进程起不来时要留痕，否则窗口永远不会出现，外面完全看不出原因
  assistWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[assist] 渲染进程异常退出：', details?.reason)
  })

  // 与主窗口同一条安全策略：不允许任何站内跳转与新窗口
  assistWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_SERVER_URL)) return
    event.preventDefault()
    console.warn(`[security] 已拦截导航(辅助窗口): ${url}`)
  })
  assistWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  loadRenderer(assistWindow, { window: 'assist' })

  assistWindow.on('closed', () => {
    assistWindow = null
    assistPayload = null
    // 通知主窗口解锁（主界面在辅助窗口存在期间是压暗的）
    send('assist:closed', true)
    // 用户常把 AI 助手的网页盖在软件上面，关掉辅助窗口后如果什么都不做，
    // 露出来的是别人的窗口 —— 看起来就像「软件不见了」。把主窗口拉回来。
    raiseMainWindow()
  })

  return assistWindow
}

/**
 * 打开「录制音频」窗口。
 *
 * 形态照搬辅助窗口：自绘标题栏、无边框、**不默认置顶**（用户切去别的窗口时
 * 不该被挡住）、关窗走两段式闸门、关掉之后把主窗口拉回最前。
 */
function createRecordWindow() {
  if (recordWindow && !recordWindow.isDestroyed()) {
    if (recordWindow.isMinimized()) recordWindow.restore()
    recordWindow.show()
    recordWindow.focus()
    return recordWindow
  }

  const headless = process.env.XBAOS_HEADLESS === '1'
  const glass = glassWindowOptions(headless)

  recordWindow = new BrowserWindow({
    width: 880,
    height: 620,
    minWidth: 680,
    minHeight: 480,
    resizable: true,
    maximizable: true,
    frame: false,
    alwaysOnTop: false,
    ...(app.isPackaged ? {} : { icon: path.join(repoRoot, 'build', 'icon.ico') }),
    backgroundColor: glass.active ? '#00000000' : glass.solidBg,
    ...glass.winOptions,
    show: false,
    webPreferences: {
      preload: path.join(repoRoot, 'electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      additionalArguments: [`--xbaos-version=${app.getVersion()}`, glass.arg],
    },
  })

  attachWindowState(recordWindow)

  const reveal = () => {
    if (headless) return
    if (recordWindow && !recordWindow.isDestroyed() && !recordWindow.isVisible()) {
      recordWindow.show()
    }
  }
  recordWindow.once('ready-to-show', reveal)
  recordWindow.webContents.once('did-finish-load', () => setTimeout(reveal, 120))

  recordWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[record] 渲染进程异常退出：', details?.reason)
  })

  recordWindow.webContents.on('will-navigate', (event, url) => {
    if (isDev && url.startsWith(DEV_SERVER_URL)) return
    event.preventDefault()
    console.warn(`[security] 已拦截导航(录音窗口): ${url}`)
  })
  recordWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  loadRenderer(recordWindow, { window: 'record' })

  /*
   * 关窗闸门。**必须单独一份标志**：窗口是新建的，若沿用 `closeApproved`，
   * 主窗口上一次放行留下的 `true` 会让录音窗口第一次点关闭就直接关掉，
   * 录制中的内容一并丢掉。看门狗同理，且每次建窗都要复位。
   */
  recordCloseApproved = false
  if (recordCloseWatchdog) {
    clearTimeout(recordCloseWatchdog)
    recordCloseWatchdog = null
  }
  recordWindow.on('close', (event) => {
    if (recordCloseApproved) return
    event.preventDefault()
    if (!recordWindow || recordWindow.isDestroyed()) return
    recordWindow.webContents.send('record:close-request')
    if (recordCloseWatchdog) clearTimeout(recordCloseWatchdog)
    recordCloseWatchdog = setTimeout(() => {
      recordCloseWatchdog = null
      recordCloseApproved = true
      recordWindow?.close()
    }, 4000)
  })

  recordWindow.on('closed', () => {
    recordWindow = null
    if (recordCloseWatchdog) {
      clearTimeout(recordCloseWatchdog)
      recordCloseWatchdog = null
    }
    recordCloseApproved = false
    // 通知主窗口解锁（录音窗口存在期间主界面是压暗的）
    send('record:closed', true)
    // 同辅助窗口：关掉之后什么都不做的话，露出来的是别人的窗口
    raiseMainWindow()
  })

  return recordWindow
}

/**
 * 系统声音怎么取：**直接给桌面音频，不弹选择框**。
 *
 * Electron 默认会为 `getDisplayMedia()` 弹一个「选择要共享的内容」的窗口 ——
 * 对这个场景是纯噪音（用户要的就是「这台电脑正在播的声音」）。
 * 这里把 handler 挂死：无脑返回主屏 + `audio: 'loopback'`（Windows 上
 * 这是唯一能拿到系统播放音频的方式）。
 *
 * `desktopCapturer.getSources` 是异步的，必须等它回来再 `callback`。
 * 挂在 defaultSession 上：只有录音窗口会调 `getDisplayMedia`，
 * 主窗口与辅助窗口里没有这个调用点。
 */
function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          const primary = sources[0]
          if (!primary) {
            console.warn('[record] 没有拿到屏幕源，系统声音不可用')
            callback({})
            return
          }
          callback({ video: primary, audio: 'loopback' })
        })
        .catch((err) => {
          console.error('[record] 取屏幕源失败：', err)
          callback({})
        })
    },
    { useSystemPicker: false },
  )
}

// -------------------------------------------------------------- 事件转发

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  // ---- 应用信息
  ipcMain.handle('app:info', () => {
    const { exe, source } = engineInfo()
    return {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      isDev,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light',
      engine: { exe, source, available: !!exe },
      /*
       * 模型清单带 source 字段（user / custom / bundled / env / dev）。
       * 「哪些算已装」由这里说了算：只按 .bin 后缀收，文件名不参与判定 ——
       * 用户从浏览器重复下载会得到 ggml-small(1).bin，自己改名也常见。
       */
      models: listAvailableModels(modelCtx()),
      // 全部模型查找目录（按优先级拼接），诊断「为什么没找到模型」时看这个
      modelsDir: modelSearchDirs(modelCtx())
        .map((d) => d.dir)
        .join(';'),
      defaultModel: DEFAULT_MODEL,
      paths: {
        userData: app.getPath('userData'),
        downloadDir: writableModelsDir(app.getPath('userData'), customModelsDir),
        downloads: app.getPath('downloads'),
        documents: app.getPath('documents'),
        home: app.getPath('home'),
        temp: app.getPath('temp'),
      },
    }
  })

  // 主题变化通知渲染进程（渲染进程自己也能监听 prefers-color-scheme，这里只是补一条）
  nativeTheme.on('updated', () => {
    send('app:theme', { theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light' })
  })

  // ---- 关窗确认（两段式，闸门在 createWindow 里）
  ipcMain.on('app:close-ack', () => {
    // 渲染进程已收到请求，正在算有没有未保存内容 —— 撤掉看门狗
    if (closeWatchdog) {
      clearTimeout(closeWatchdog)
      closeWatchdog = null
    }
  })

  ipcMain.on('app:force-close', () => {
    if (closeWatchdog) {
      clearTimeout(closeWatchdog)
      closeWatchdog = null
    }
    closeApproved = true
    mainWindow?.close()
  })

  // ---- 任务栏进度。识别与模型下载都要几分钟，用户切走后得能从任务栏看到进展
  ipcMain.on('app:progress', (_event, value) => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const n = Number(value)
    // 约定与 Electron 一致：0–1 之间显示进度，负数清除进度条
    mainWindow.setProgressBar(Number.isFinite(n) && n >= 0 ? Math.min(1, n) : -1)
  })

  // ---- 长任务跑完的提醒。
  //      窗口就在用户眼前时不闪 —— 那是噪音，他已经看见了；只有被别的窗口盖住
  //      或最小化时才闪，那才是真的「失联」。停闪交给窗口的 focus 事件。
  ipcMain.on('app:flash', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isFocused() && !mainWindow.isMinimized()) return
    mainWindow.flashFrame(true)
  })

  // ---- 外观偏好副本：只为下次启动画首屏底色（设置真相源仍在渲染进程）
  ipcMain.on('app:set-theme-mode', async (_event, mode) => {
    const value = mode === 'light' || mode === 'dark' ? mode : 'auto'
    try {
      await writeThemeState({ mode: value })
    } catch {
      /* 写不进去也不影响使用，下次启动退回跟随系统 */
    }
  })

  // ---- 标题栏毛玻璃开关。设置真相源在渲染进程，这里只存副本并**即时**应用
  ipcMain.on('app:set-glass', (_event, enabled) => {
    const active = isGlassSupported() && !!enabled
    try {
      writeThemeState({ glass: !!enabled })
    } catch {
      /* 存不下来就只当本次会话有效 */
    }
    // 三个窗口一起切（主窗口 + AI 辅助 + 录音），并广播给每个渲染进程
    applyGlassMaterial(active)
    broadcast('app:glass', { active })
  })

  // ---- 窗口控制
  // 「谁发起的就控制谁」：主窗口与辅助窗口共用这一条通道，
  // 否则辅助窗口点最小化会把主窗口收起来。
  ipcMain.on('window:control', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return
    if (action === 'minimize') win.minimize()
    else if (action === 'maximize') {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    } else if (action === 'close') win.close()
  })

  // ---- 系统对话框
  ipcMain.handle('dialog:pickAudio', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择音频文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '音频文件', extensions: ['wav', 'mp3', 'flac', 'ogg', 'opus'] },
        { name: 'WAV', extensions: ['wav'] },
        { name: 'MP3', extensions: ['mp3'] },
        { name: 'FLAC', extensions: ['flac'] },
        { name: 'OGG / Opus', extensions: ['ogg', 'opus'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:pickDirectory', async (_event, options = {}) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || '选择文件夹',
      defaultPath: options.defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('dialog:saveSubtitle', async (_event, options = {}) => {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      title: '导出字幕',
      defaultPath: options.defaultPath,
      filters: options.filters || [
        { name: 'SubRip 字幕', extensions: ['srt'] },
        { name: 'WebVTT 字幕', extensions: ['vtt'] },
        { name: '纯文本', extensions: ['txt'] },
      ],
    })
    return result.canceled ? null : result.filePath ?? null
  })

  ipcMain.handle('dialog:pickSubtitle', async () => {
    if (!mainWindow) return []
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择字幕文件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '字幕文件', extensions: ['srt', 'vtt', 'ass'] },
        { name: 'SubRip 字幕', extensions: ['srt'] },
        { name: 'WebVTT 字幕', extensions: ['vtt'] },
        { name: 'ASS / SSA 字幕', extensions: ['ass', 'ssa'] },
        { name: '全部文件', extensions: ['*'] },
      ],
    })
    return result.canceled ? [] : result.filePaths
  })

  ipcMain.handle('dialog:confirm', async (_event, options = {}) => {
    if (!mainWindow) return false
    const result = await dialog.showMessageBox(mainWindow, {
      type: options.type || 'question',
      title: options.title || '确认',
      message: options.message || '',
      detail: options.detail,
      buttons: options.buttons || ['取消', '确定'],
      defaultId: options.defaultId ?? 1,
      cancelId: options.cancelId ?? 0,
      noLink: true,
    })
    return result.response
  })

  // ---- 文件系统
  ipcMain.handle('fs:exists', async (_event, target) => {
    try {
      await fs.access(target)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('fs:stat', async (_event, target) => {
    try {
      const s = await fs.stat(target)
      return { ok: true, size: s.size, mtimeMs: s.mtimeMs, isFile: s.isFile(), isDir: s.isDirectory() }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('fs:readText', async (_event, target) => {
    return fs.readFile(target, 'utf8')
  })

  /**
   * 编码自适应的文本读取，给「导入字幕文件」用。
   *
   * 老播放器导出的 SRT 大量是 GBK，硬按 UTF-8 读会满屏乱码且不可逆。
   * 判定顺序与写回编码都在 `electron/encoding.js`（那里有单测覆盖）。
   * 返回实际使用的编码，「覆盖保存」时原样写回，保证二次保存不换码。
   */
  ipcMain.handle('fs:readTextAuto', async (_event, target) => {
    return decodeTextAuto(await fs.readFile(target))
  })

  /**
   * 读整个音频文件的二进制。渲染进程拿去做两件事：
   * AudioContext 解码出波形峰值 + 交给 <audio> 播放。
   * 结构化克隆直接支持 ArrayBuffer，不需要 base64。
   */
  ipcMain.handle('fs:readArrayBuffer', async (_event, target) => {
    const buf = await fs.readFile(target)
    // 返回副本的 buffer，避开 Electron 对池化 Buffer 的序列化边界问题
    const copy = new ArrayBuffer(buf.byteLength)
    new Uint8Array(copy).set(buf)
    return copy
  })

  /**
   * 写字幕文件，带编码选择。目录不存在就建，避免用户手填了一个
   * 还不存在的路径时直接失败。返回真实写入的路径。
   *
   * 编码探测与编码实现都在 `electron/encoding.js`（那里可被单测覆盖）。
   */
  ipcMain.handle('fs:writeSubtitle', async (_event, target, content, encoding) => {
    const dir = path.dirname(target)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(target, encodeSubtitle(content, encoding))
    return target
  })

  /** 通用文本写入（UTF-8 无 BOM）。字幕导出请用 fs:writeSubtitle */
  ipcMain.handle('fs:writeText', async (_event, target, content) => {
    const dir = path.dirname(target)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(target, content, { encoding: 'utf8' })
    return target
  })

  ipcMain.handle('fs:reveal', async (_event, target) => {
    shell.showItemInFolder(target)
  })

  ipcMain.handle('fs:openPath', async (_event, target) => {
    return shell.openPath(target)
  })

  ipcMain.handle('fs:basename', (_event, target) => path.basename(target))
  ipcMain.handle('fs:dirname', (_event, target) => path.dirname(target))

  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(text)
    return true
  })

  /** 读剪贴板。AI 校对靠它把用户从网页版复制的结果接回来 */
  ipcMain.handle('clipboard:readText', () => clipboard.readText())

  // ---- AI 校对辅助窗口
  // 数据经主进程中转：主窗口把提示词与待校对条目交上来，辅助窗口取走；
  // 用户在辅助窗口里确认后，结果再原路送回主窗口执行覆盖。
  ipcMain.handle('assist:open', (_event, payload) => {
    createAssistWindow(payload)
    return { ok: true }
  })

  ipcMain.handle('assist:payload', () => assistPayload)

  ipcMain.handle('assist:setAlwaysOnTop', (event, value) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win || win.isDestroyed()) return false
    win.setAlwaysOnTop(!!value)
    return win.isAlwaysOnTop()
  })

  ipcMain.handle('assist:isAlwaysOnTop', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return win && !win.isDestroyed() ? win.isAlwaysOnTop() : false
  })

  /**
   * 辅助窗口提交校对结果 → 转发给主窗口。
   * 覆盖与进撤回栈都在主窗口做：那边才持有 store 与历史记录。
   */
  ipcMain.on('assist:submit', (_event, payload) => {
    send('assist:result', payload)
  })

  /**
   * 关闭辅助窗口。两个方向都走它：辅助窗口自己点关闭、
   * 主窗口应用完结果之后收尾。
   */
  ipcMain.on('assist:close', () => {
    if (assistWindow && !assistWindow.isDestroyed()) assistWindow.close()
  })

  /**
   * 把辅助窗口重新拉到最前。
   *
   * 主界面在辅助窗口存在期间是压暗的，上面那个「回到 AI 窗口」按钮靠它工作 ——
   * 用户被别的窗口盖住、找不到辅助窗口时，不用去任务栏里翻。
   */
  ipcMain.handle('assist:focus', () => {
    if (!assistWindow || assistWindow.isDestroyed()) return { ok: false }
    if (assistWindow.isMinimized()) assistWindow.restore()
    assistWindow.show()
    assistWindow.focus()
    return { ok: true }
  })

  // ---- 录制音频窗口
  // 只**新增**这几条，assist 的三件套（open / submit / close）一个没动。
  ipcMain.handle('record:open', () => {
    createRecordWindow()
    return { ok: true }
  })

  ipcMain.handle('record:focus', () => {
    if (!recordWindow || recordWindow.isDestroyed()) return { ok: false }
    if (recordWindow.isMinimized()) recordWindow.restore()
    recordWindow.show()
    recordWindow.focus()
    return { ok: true }
  })

  ipcMain.on('record:close', () => {
    if (recordWindow && !recordWindow.isDestroyed()) recordWindow.close()
  })

  /**
   * 关窗确认。渲染进程裁决「现在关会不会丢东西」之后调这里。
   *
   * 对话框**父窗口挂在录音窗口上**（不是主窗口）：用户此刻的注意力在录音窗口，
   * 挂到主窗口会让弹窗出现在另一个窗口里，看起来像卡住了。
   * `defaultId` / `cancelId` **都指向「取消」** —— 这是要丢数据的动作。
   */
  ipcMain.handle('record:confirmDiscard', async (_event, options = {}) => {
    const parent = recordWindow && !recordWindow.isDestroyed() ? recordWindow : mainWindow
    if (!parent) return false
    const result = await dialog.showMessageBox(parent, {
      type: 'warning',
      title: '确认放弃录音',
      message: options.message || '现在关闭会丢弃正在录制的内容',
      detail: options.detail,
      buttons: ['取消', '仍要关闭'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    return result.response === 1
  })

  ipcMain.on('record:close-ack', () => {
    if (recordCloseWatchdog) {
      clearTimeout(recordCloseWatchdog)
      recordCloseWatchdog = null
    }
  })

  /**
   * 录音保存好之后，由录音窗口把**路径**递过来，主进程转给主窗口去入队。
   *
   * 为什么不让录音窗口自己入队：两个窗口是两个渲染进程，Pinia store 不共享。
   * 在录音窗口里 addFiles 只会加进它自己那份空工程，窗口一关就没了 ——
   * 用户会看到「保存成功」但队列里什么都没有。
   */
  ipcMain.on('record:submit', (_event, filePath) => {
    if (typeof filePath !== 'string' || !filePath) return
    send('record:saved', filePath)
  })

  ipcMain.on('record:force-close', () => {
    if (recordCloseWatchdog) {
      clearTimeout(recordCloseWatchdog)
      recordCloseWatchdog = null
    }
    recordCloseApproved = true
    recordWindow?.close()
  })

  /**
   * 保存录音。**写盘在主进程**：渲染进程在 file:// 沙箱里拿不到任意写权限。
   *
   * `data` 是渲染层编好的完整 WAV（`Uint8Array`，经结构化克隆过来）。
   * 默认落在「音乐」目录，文件名带时间戳 —— 连录好几条也不会互相覆盖。
   */
  ipcMain.handle('record:save', async (_event, payload = {}) => {
    const parent = recordWindow && !recordWindow.isDestroyed() ? recordWindow : mainWindow
    if (!parent) return null
    const data = payload.data
    if (!data || typeof data.byteLength !== 'number' || data.byteLength === 0) {
      throw new Error('没有可保存的音频数据')
    }
    const ext = 'wav'
    const stamp = new Date()
    const pad = (n) => String(n).padStart(2, '0')
    const suggested =
      payload.defaultName ||
      `录音 ${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())} ` +
        `${pad(stamp.getHours())}-${pad(stamp.getMinutes())}-${pad(stamp.getSeconds())}.${ext}`

    let defaultPath = suggested
    try {
      const music = app.getPath('music')
      if (music) defaultPath = path.join(music, suggested)
    } catch {
      /* 取不到就退回纯文件名，用户自己选目录 */
    }

    const picked = await dialog.showSaveDialog(parent, {
      title: '保存录音',
      defaultPath,
      filters: [{ name: 'WAV 音频', extensions: [ext] }],
    })
    if (picked.canceled || !picked.filePath) return null

    await fs.writeFile(picked.filePath, Buffer.from(data))
    return picked.filePath
  })

  // ---- 模型下载
  // 下载在主进程完成：渲染进程在 file:// 沙箱里既不能发起外联，
  // 也没有可靠的断点续传能力。进度通过 model:download:progress 推送。
  const userModels = () => writableModelsDir(app.getPath('userData'), customModelsDir)
  modelDownloader ??= new ModelDownloader((payload) => send('model:download:progress', payload))

  ipcMain.handle('model:catalog', () => MODEL_CATALOG_PUBLIC)

  ipcMain.handle('model:download', (_event, key) => {
    const started = modelDownloader.start(key, userModels())
    if (!started && modelDownloader.isRunning(key)) {
      throw new Error('该模型正在下载中')
    }
    return { ok: true }
  })

  ipcMain.handle('model:downloadCancel', (_event, key) => {
    return { ok: modelDownloader.cancel(key) }
  })

  ipcMain.handle('model:delete', async (_event, fileName) => {
    await modelDownloader.remove(fileName, userModels())
    return { ok: true }
  })

  /**
   * 「这次实际会用哪个模型」的只读查询。
   *
   * 界面的「使用中」标记必须走这里：判断规则（设置里指定的那个 → 不存在就
   * 回退任一已装模型）只在主进程存一份。渲染进程自己拿名字比一比的话，
   * 文件被手动删掉之后会留下一个「使用中」的空壳。
   */
  ipcMain.handle('models:resolve', (_event, file) => resolveModelInfo(file))

  // ---- 模型存储位置
  ipcMain.handle('model:getDir', () => ({
    dir: writableModelsDir(app.getPath('userData'), customModelsDir),
    defaultDir: userModelsDir(app.getPath('userData')),
    custom: customModelsDir,
  }))

  /**
   * 设置自定义模型目录。
   *
   * 必须**真的试着写一次**：路径存在不代表可写（Program Files、只读挂载、
   * 需要管理员权限的位置都会通过「存在」检查，然后在下载时失败）。
   * 传空串表示恢复默认。
   */
  ipcMain.handle('model:setDir', async (_event, dir) => {
    const value = typeof dir === 'string' ? dir.trim() : ''
    if (!value) {
      customModelsDir = ''
      return { ok: true, dir: userModelsDir(app.getPath('userData')) }
    }
    try {
      await fs.mkdir(value, { recursive: true })
      const probe = path.join(value, '.xbaos-write-test')
      await fs.writeFile(probe, 'ok')
      await fs.rm(probe, { force: true })
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
    customModelsDir = value
    return { ok: true, dir: value }
  })

  /** 在系统文件管理器里打开模型文件夹（不存在就先建出来） */
  ipcMain.handle('model:openDir', async () => {
    const dir = writableModelsDir(app.getPath('userData'), customModelsDir)
    try {
      await fs.mkdir(dir, { recursive: true })
    } catch {
      /* 建不出来也照样交给系统打开，让系统自己报错更清楚 */
    }
    const message = await shell.openPath(dir)
    return { ok: !message, message: message || undefined }
  })

  // ---- 更新检查
  /*
   * 只做「读清单 + 比版本」，不下载安装包、不替换文件。
   *
   * 用 `net.fetch` 而不是 Node 的全局 fetch：它走 Chromium 的网络栈，
   * 会沿用系统代理设置与系统证书链。国内用户很多靠系统代理上网，
   * 用 Node fetch 会绕过代理直接连不上，而错误信息还只说 ENOTFOUND。
   */
  ipcMain.handle('update:check', async () => {
    try {
      return await checkForUpdate({
        currentVersion: app.getVersion(),
        url: UPDATE_URL,
        fetchImpl: (url, init) => net.fetch(url, init),
      })
    } catch (err) {
      // checkForUpdate 自己已经把预期内的失败收成返回值了，走到这里是意料之外的情况
      return {
        ok: false,
        state: 'error',
        reason: 'unknown',
        code: null,
        current: app.getVersion(),
        message: err instanceof Error ? err.message : String(err),
      }
    }
  })

  /**
   * 打开外部链接。
   *
   * 地址来自网上读回来的清单，而 shell.openExternal 对协议几乎是照单全收
   * （`file:`、注册过的自定义协议都会被系统交给对应程序）。所以闸门开在
   * update.js 里：只放行 https + 自家域名。
   */
  ipcMain.handle('update:openUrl', async (_event, target) => {
    const url = allowedExternalUrl(target)
    if (!url) {
      return { ok: false, message: '这个地址不在允许打开的范围内，已拒绝' }
    }
    try {
      await shell.openExternal(url)
      return { ok: true }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })

  // ---- 引擎
  ipcMain.handle('engine:status', async () => {
    const client = ensureEngine()
    try {
      const pong = await client.ping()
      // Vulkan 被禁用时引擎仍可能报 gpu（whisper 对 use_gpu 是静默忽略的），
      // 这里按实际情况纠正，免得界面显示一个用不了的后端
      return {
        ok: true,
        ...pong,
        backend: client.disableVulkan ? 'cpu' : client.backend,
        modelLoaded: client.modelLoaded,
      }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  })

  ipcMain.handle('engine:load', async (_event, opts = {}) => {
    const client = ensureEngine()
    const model = resolveModelPath(opts.model)
    if (!model) {
      // 不写死具体文件名：模型不随包之后，用户目录里可能一个模型都没有，
      // 也可能只有个改了名的。指向「模型管理」页比报一个他根本没见过的名字有用。
      throw new Error(
        '没有可用的识别模型。请在「模型管理」页下载一个，' +
          '或把 ggml 格式的 .bin 模型文件放进模型文件夹。',
      )
    }

    // 后端意图必须在 load 之前落地：Vulkan 初始化就发生在加载模型这一步
    const backend = await applyBackendIntent(client, opts.backend)

    const result = await client.load({ model, backend })
    return {
      ok: true,
      ...result,
      model,
      backend: client.disableVulkan ? 'cpu' : client.backend,
    }
  })

  ipcMain.handle('engine:unload', async () => {
    const client = ensureEngine()
    await client.unload()
    return { ok: true }
  })

  /**
   * 发起识别。结果分两路回渲染进程：
   *   - 流式：engine:stream（progress / segment），带 taskId
   *   - 最终：本 handle 的返回值
   * 这样界面能边跑边出字幕，不用等整段音频跑完。
   */
  ipcMain.handle('engine:transcribe', async (_event, opts = {}) => {
    if (activeTask) {
      throw new Error('已有识别任务在进行中，请先取消')
    }

    const client = ensureEngine()
    const taskId = opts.taskId || `t${Date.now()}`

    // 后端意图先落地：选「仅 CPU」时这里可能重启引擎（环境变量改不了运行中的进程）
    const backend = await applyBackendIntent(client, opts.backend)

    /**
     * 跑一遍「必要时加载模型 + 识别」。
     * 抽成函数是为了崩溃降级之后能原样再走一次。
     */
    const runOnce = async (backendForLoad) => {
      // 没加载模型就先加载，省得渲染进程每次都自己判断
      if (!client.modelLoaded) {
        const model = resolveModelPath(opts.model)
        if (!model) throw new Error('没有可用的识别模型，请在「模型管理」页先放置一个模型')
        await client.load({ model, backend: backendForLoad })
      }

      return client.transcribe(
        {
          audio: opts.audio,
          language: opts.language,
          prompt: opts.prompt,
          threads: opts.threads,
          translate: opts.translate,
          // 多遍识别的采样温度与解码参数、音质前处理开关
          temperature: opts.temperature,
          beamSize: opts.beamSize,
          bestOf: opts.bestOf,
          vad: opts.vad,
          normalize: opts.normalize,
        },
        (msg) => {
          if (msg.type === 'progress' || msg.type === 'segment') {
            send('engine:stream', { taskId, msg })
          }
        },
      )
    }

    activeTask = { id: taskId, canceled: false }
    const startedAt = Date.now()

    try {
      let done
      try {
        done = await runOnce(backend)
      } catch (err) {
        /*
         * 引擎意外退出时的自动降级重试。
         *
         * 发行版打的是 Vulkan 构建，而 ggml 的后端注册表**在构造时就无条件**
         * 初始化 Vulkan（`ggml-backend-reg.cpp` 的 `#ifdef GGML_USE_VULKAN`）——
         * 机器上任何一个坏掉的隐式层（录屏 / 帧数 / 游戏加速 / 显卡覆盖层）都能让
         * 它在加载模型时直接 0xC0000005。引擎自己那圈 try/catch 只接 C++ 异常、
         * 接不住访问违例，所以 `main.cpp` 里「GPU 失败回退 CPU」的代码永远走不到。
         * 只能由我们在进程外兜：换个环境变量重开一个进程，再试一次。
         *
         * 只降级一次 —— CPU 也崩就是别的问题，无限重试只会把用户困在原地。
         */
        if (!(err instanceof EngineCrashError) || client.disableVulkan) throw err

        send('engine:stream', {
          taskId,
          msg: {
            type: 'fallback',
            from: 'vulkan',
            to: 'cpu',
            reason: '识别引擎异常退出，已自动改用 CPU 重试',
          },
        })
        await client.setDisableVulkan(true)
        writeVulkanDisabled(true)
        done = await runOnce('cpu')
      }

      return {
        ok: true,
        taskId,
        ...done,
        wallMs: Date.now() - startedAt,
      }
    } catch (err) {
      if (err instanceof EngineCanceledError) {
        return { ok: false, canceled: true, taskId, message: err.message }
      }
      throw err
    } finally {
      activeTask = null
    }
  })

  ipcMain.handle('engine:abort', async () => {
    const client = ensureEngine()
    await client.abort()
    return { ok: true }
  })

  /**
   * 导出诊断信息。
   *
   * 用户是经 B 站私信反馈的，让他自己开事件查看器翻崩溃日志不现实。
   * 这里把能自动收的东西一次性塞进文件：系统与显卡无关的环境摘要、
   * 引擎状态与最近一次退出码、**Vulkan 全局层清单**、引擎日志尾部。
   * 他只要点一下按钮，把生成的文件发过来就行。
   */
  ipcMain.handle('diag:export', async () => {
    const client = engine
    try {
      await ensureLogsDir()
      const layers = await readVulkanLayers()
      const lastExit = client?.lastExit
      const lines = [
        'XBAOS 字幕生成器 诊断信息',
        `时间：${new Date().toLocaleString()}`,
        `版本：${app.getVersion()}`,
        ...hostSummary(),
        `引擎：${client?.exe ?? '(未启动)'}`,
        `引擎状态：${client?.running ? '运行中' : '未运行'}`,
        `Vulkan 已禁用：${client?.disableVulkan ? '是' : '否'}`,
        `最近一次退出：${
          lastExit ? `code=${lastExit.code} —— ${describeExitCode(lastExit.code)}` : '(无)'
        }`,
        '',
        '--- Vulkan 全局层（出问题时第一嫌疑清单）---',
        ...Object.entries(layers).flatMap(([k, v]) => [k, ...v.map((s) => `  ${s}`), '']),
        '--- 引擎日志尾部 ---',
        ...engineLogTail.map((l) => `${l.at} [${l.level}] ${l.text}`),
        '',
      ]
      const file = path.join(logsDir(), `diag-${dateStamp(true)}.txt`)
      await fs.writeFile(file, lines.join('\n'), 'utf8')
      shell.showItemInFolder(file)
      return { ok: true, file }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
}

// -------------------------------------------------------------- 生命周期

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

app.whenReady().then(async () => {
  app.setAppUserModelId('com.xbaos.subtitle-generator')

  if (!gotLock) return

  registerIpc()
  createWindow()
  // 系统声音采集必须先把 handler 挂上：不挂的话 getDisplayMedia() 会弹
  // Electron 自带的「选择要共享的内容」窗口。
  installDisplayMediaHandler()

  // 提前把引擎拉起来做握手，用户点「开始识别」时就不用等进程启动
  try {
    const client = ensureEngine()
    await client.start()
    const pong = await client.ping()
    console.log(`[engine] 握手成功 backends=${JSON.stringify(pong.backends)}`)
  } catch (err) {
    console.error(`[engine] 预启动失败：${err.message}（界面会提示，不影响其他功能）`)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Windows 上关窗就是退出；macOS 的习惯（留驻 Dock）对这个工具没有意义
  app.quit()
})

app.on('before-quit', async (event) => {
  if (!engine) return
  event.preventDefault()
  const client = engine
  engine = null
  try {
    await client.dispose()
  } catch {
    /* 已经退了 */
  }
  app.quit()
})
