/**
 * 开发启动器：一条命令同时拉起 Vite 和 Electron。
 *
 * 为什么自己写而不装 concurrently / wait-on：
 * 这个项目对依赖数量有洁癖（第三方依赖越少，许可与审计负担越小），
 * 而这里要做的事用 Node 内置能力几十行就够 —— 起子进程、轮询端口、
 * 互相清理。不值得为它引入两个包。
 *
 * 用法：
 *   npm run dev            正常启动
 *   npm run dev -- --devtools   顺带打开开发者工具
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cleanEnv, electronExecutable } from './lib/electron-env.mjs'
import {
  clearDevServer,
  isPortFree,
  listeners,
  processName,
  readDevServer,
  recordDevServer,
} from './lib/port.mjs'
import { DEFAULT_MODEL, findModel, resolveEngineExe } from '../electron/paths.js'

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const PORT = Number(process.env.XBAOS_DEV_PORT || 5173)
const SERVER_URL = `http://localhost:${PORT}`
const WANT_DEVTOOLS = process.argv.includes('--devtools')

/** @type {import('node:child_process').ChildProcess[]} */
const children = []
let shuttingDown = false
/** Vite 提前退出时置位，用来打断「等服务器就绪」的轮询 */
let viteExited = false

function shutdown(code = 0) {
  if (shuttingDown) return
  shuttingDown = true
  // 状态文件里记的是自己起的服务，退出时一并撤掉，别给下一次启动留假线索
  clearDevServer()
  for (const child of children) {
    if (child.exitCode === null && !child.killed) {
      try {
        child.kill()
      } catch {
        /* 已经没了 */
      }
    }
  }
  // 给子进程一点时间自己退，超时就直接结束
  setTimeout(() => process.exit(code), 400)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
process.on('uncaughtException', (err) => {
  console.error(err)
  shutdown(1)
})

/**
 * 轮询到 Vite 真正能响应为止。
 *
 * 注意：这里**不能**把「5173 有响应」直接当成就绪。上一轮遗留的开发服务器
 * 也在同一个端口上应答，请求会成功返回，于是启动器以为 Vite 好了，
 * 把 Electron 指到**旧的那份代码**上 —— 改了文件却不生效，最难查。
 * 所以轮询期间同时盯着 Vite 子进程：它一退出就立刻放弃，
 * 而端口占用在启动前就已经拦掉了。
 */
async function waitForServer(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (shuttingDown || viteExited) return false
    try {
      const res = await fetch(SERVER_URL, { method: 'GET' })
      if (res.ok || res.status === 404) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

/** 描述占用者。优先用启动记录 —— 它不依赖任何外部命令，最靠得住。 */
function describeHolder() {
  const recorded = readDevServer()
  if (recorded && recorded.port === PORT) {
    return `本项目上一次的开发服务器（PID ${recorded.pid}，启动于 ${recorded.startedAt}）`
  }
  const holders = listeners(PORT)
  if (holders.length) {
    return holders.map((pid) => `${processName(pid) || '未知进程'} (PID ${pid})`).join('、')
  }
  return `未能取到进程号，可用 netstat -ano | findstr :${PORT} 查看`
}

/**
 * 端口体检。占用时直接退出，不做「反正也能跑」的让步。
 *
 * 之所以不自动杀掉：端口上跑的可能是别的东西（另一个项目、别的软件），
 * 替用户做这个决定不合适。给出占用者和一条现成的命令，让用户自己按。
 */
async function checkPort() {
  if (await isPortFree(PORT)) return true

  console.error(`\n[dev] 端口 ${PORT} 已被占用，无法启动开发服务器。`)
  console.error(`[dev]   占用者：${describeHolder()}`)
  console.error('[dev]  多半是上一次的开发服务器没退干净。可以这样处理：')
  console.error('[dev]    1) npm run dev:stop                              结束占用该端口的 node 进程')
  console.error(`[dev]    2) $env:XBAOS_DEV_PORT=${PORT + 1} 然后 npm run dev         换个端口启动`)
  return false
}

/**
 * 启动前自检。
 *
 * 引擎和模型缺了都不会让 npm run dev 失败 —— 界面照样打得开，只是识别用不了。
 * 但那种「界面正常、点开始没反应」的状态最难自查，所以提前把结果打在终端里。
 */
function preflight() {
  const { exe, source } = resolveEngineExe({ isPackaged: false })
  const model = findModel(DEFAULT_MODEL, { isPackaged: false })

  console.log('[dev] 启动前自检')
  console.log(
    exe
      ? `[dev]   识别引擎  ok    ${exe}（来源 ${source}）`
      : '[dev]   识别引擎  缺失  请先编译：bash engine/build.sh',
  )
  console.log(
    model
      ? `[dev]   默认模型  ok    ${model.path}（来源 ${model.source}）`
      : `[dev]   默认模型  缺失  需要把 ${DEFAULT_MODEL} 放到 models/ 目录`,
  )
  console.log('[dev]   （缺项不影响界面打开，只影响识别功能）')
}

async function main() {
  preflight()

  // 端口先体检。放在起 Vite 之前 —— 让 Vite 自己去撞 strictPort 报错，
  // 输出是一串 Vite 内部堆栈，看不出真正原因。
  if (!(await checkPort())) {
    process.exitCode = 1
    return
  }

  // 1. Vite。直接跑它的入口脚本，绕开 .cmd —— Node 20+ 起 spawn .cmd 必须带 shell，
  //    而带 shell 又会让路径里的空格变成新的坑。
  const viteEntry = path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js')
  const vite = spawn(process.execPath, [viteEntry], {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env },
  })
  children.push(vite)
  // 记下自己起的服务。万一整个启动器被强杀，状态文件里还留着能抓的进程号，
  // 下次 npm run dev:stop 就能收拾干净 —— 这正是今天这次卡住的场景。
  recordDevServer(PORT, vite.pid)
  vite.on('exit', (code) => {
    viteExited = true
    if (!shuttingDown) {
      console.error(`\n[vite] 意外退出（代码 ${code}）`)
      shutdown(code ?? 1)
    }
  })

  // 2. 等 Vite 就绪
  process.stdout.write('[dev] 正在等待 Vite 就绪')
  const ready = await waitForServer()
  if (!ready) {
    console.error(
      viteExited
        ? '\n[dev] Vite 启动失败，详情见上方 Vite 输出。'
        : `\n[dev] 等待 Vite 超时（${PORT} 无响应），已中止。`,
    )
    shutdown(1)
    return
  }
  console.log('\n[dev] Vite 已就绪，启动 Electron…')

  // 3. Electron。require('electron') 返回的是可执行文件的绝对路径。
  let electronPath
  try {
    electronPath = electronExecutable(require)
  } catch {
    console.error('[dev] 未找到 electron，请先执行 npm install')
    shutdown(1)
    return
  }

  const electron = spawn(electronPath, [repoRoot], {
    cwd: repoRoot,
    stdio: 'inherit',
    // cleanEnv 会剔掉 ELECTRON_RUN_AS_NODE —— 带着它 electron.exe 会退化成纯 Node，
    // 不创建任何窗口，排查起来很绕
    env: cleanEnv({
      VITE_DEV_SERVER_URL: SERVER_URL,
      ...(WANT_DEVTOOLS ? { XBAOS_DEVTOOLS: '1' } : {}),
    }),
  })
  children.push(electron)

  // 关掉软件窗口就是退出：连带把 Vite 也收掉，不留后台进程
  electron.on('exit', (code) => {
    if (!shuttingDown) {
      console.log(`\n[dev] Electron 已退出（代码 ${code ?? 0}）`)
      shutdown(code ?? 0)
    }
  })
}

main()
