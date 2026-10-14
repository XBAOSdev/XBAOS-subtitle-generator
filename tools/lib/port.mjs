/**
 * 开发端口的占用探测、记录与清理。
 *
 * 为什么需要这个：开发过程中「上一次的 Vite 还留在后台」是最常见的启动失败原因。
 * 更麻烦的是它**不一定报错** —— 旧服务器照样能返回 200，启动器会误以为
 * 「Vite 已就绪」，于是 Electron 连到了上一次的代码上：改了文件不生效，
 * 排查方向全跑偏。所以启动前必须先确认端口是干净的。
 *
 * 两条路配合：
 *   1. 启动时把自己起的 Vite 进程号记到状态文件里。要清理时直接按号抓人，
 *      不依赖任何外部命令 —— 这是主力手段。
 *   2. 记不到号时（比如服务器是别人起的、状态文件被删了），退回 netstat 查。
 *      这条属于尽力而为，失败就给通用提示，不假装成功。
 *
 * 「端口是否空闲」的判断刻意不用 netstat：
 *   - 解析依赖输出格式，状态列在部分环境会被本地化，脆；
 *   - 它要拉外部进程，在受限环境里可能直接被拦掉；
 *   - 我们真正关心的只是「这个端口现在干净吗」，有更直接的答案。
 * 改成先真实连接一次、再尝试绑定一次，两个都过才算干净。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 运行时状态，放 node_modules 下：本来就是可丢弃的目录，不会污染仓库 */
const STATE_FILE = path.join(REPO_ROOT, 'node_modules', '.cache', 'xbaos-dev-server.json')

/** 系统工具一律走绝对路径：PATH 里可能有同名 shim，别被劫持 */
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')

/** 本项目的开发进程名单。清理时只认它们，端口被别人占着是另一回事。 */
const SAFE_NAMES = ['node.exe', 'electron.exe']

function runTool(exe, args) {
  try {
    return execFileSync(path.join(SYS32, exe), args, { encoding: 'utf8', windowsHide: true })
  } catch {
    return ''
  }
}

/* ---------------------------------------------------------------- 端口探测 */

/**
 * 能否连上 127.0.0.1:port。
 *
 * 这一条能抓到监听在 0.0.0.0 上的进程 —— 而「尝试绑定」在 Windows 上
 * 因为 SO_REUSEADDR 语义会给出假成功（实测：127.0.0.1:5173 已被占用时，
 * 绑定 0.0.0.0:5173 仍然成功），所以单靠绑定判断是不够的。
 */
function canConnect(port, timeoutMs = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host: '127.0.0.1' })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      sock.destroy()
      resolve(result)
    }
    sock.setTimeout(timeoutMs)
    sock.once('connect', () => finish(true))
    // 无人应答就是没人在听；回环上不存在「有监听却连不上」的正常情况
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/** 能否绑定 127.0.0.1:port。必须和目标端口同址，见 canConnect 的说明。 */
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer()
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    srv.once('error', () => finish(false))
    srv.once('listening', () => srv.close(() => finish(true)))
    srv.listen(port, '127.0.0.1')
  })
}

/**
 * 端口是否可自由使用。
 * @returns {Promise<boolean>}
 */
export async function isPortFree(port) {
  if (await canConnect(port)) return false
  return canBind(port)
}

/* ------------------------------------------------------------ 状态文件读写 */

/** 记下「这个端口的服务是我起的」。shutdown 里会主动清掉。 */
export function recordDevServer(port, pid) {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    writeFileSync(
      STATE_FILE,
      JSON.stringify({ port, pid, startedAt: new Date().toISOString() }, null, 2),
      'utf8',
    )
  } catch {
    // 记不下来不影响开发，退化成「靠 netstat 找」而已
  }
}

export function clearDevServer() {
  try {
    rmSync(STATE_FILE, { force: true })
  } catch {
    /* 已经没了 */
  }
}

/** @returns {{ port: number, pid: number, startedAt: string } | null} */
export function readDevServer() {
  try {
    if (!existsSync(STATE_FILE)) return null
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (!Number.isInteger(data?.port) || !Number.isInteger(data?.pid)) return null
    return data
  } catch {
    return null
  }
}

/** 进程还在不在。EPERM 说明存在但没权限动它，也算「在」。 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/* -------------------------------------------------------------- netstat 兜底 */

/** netstat 输出按行首 TCP + 状态 + 末列 PID 解析，不依赖列宽。 */
function listenersFromNetstat(port, text) {
  const found = new Map()
  for (const line of text.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    // TCP  <local>  <remote>  <state>  <pid>
    if (cols.length < 5 || cols[0].toUpperCase() !== 'TCP') continue
    if (cols[3].toUpperCase() !== 'LISTENING') continue
    if (!cols[1].endsWith(`:${port}`)) continue
    const pid = Number(cols[4])
    if (Number.isInteger(pid) && pid > 0 && !found.has(pid)) found.set(pid, pid)
  }
  return [...found.values()]
}

/** 纯函数，便于离线验证解析逻辑 */
export function parseListeners(port, netstatText) {
  return listenersFromNetstat(port, netstatText)
}

/** 尽力找占用者 PID。取不到返回空数组，调用方照常给通用提示。 */
export function listeners(port) {
  return listenersFromNetstat(port, runTool('netstat.exe', ['-ano']))
}

/** 进程名（如 node.exe）。取不到返回空串。 */
export function processName(pid) {
  const csv = runTool('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])
  const m = csv.match(/^"([^"]+)"/)
  return m ? m[1] : ''
}

export function isProjectProcess(name) {
  return name === '' || SAFE_NAMES.includes(name.toLowerCase())
}

/* ------------------------------------------------------------------ 结束进程 */

/**
 * 结束进程。
 *
 * 先用 Node 自带的 process.kill —— 它不依赖外部命令，最不可能被环境挡住；
 * 再补一发 taskkill /T 收掉子进程（拿不到就算了，不影响主进程已经死掉这件事）。
 */
export function killTree(pid) {
  let ok = false
  try {
    process.kill(pid)
    ok = true
  } catch {
    // 已经没了，或者没权限 —— 交给 taskkill 再试一次
  }
  runTool('taskkill.exe', ['/PID', String(pid), '/F', '/T'])
  if (ok) return true
  return !isAlive(pid)
}
