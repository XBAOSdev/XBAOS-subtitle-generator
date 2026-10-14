/**
 * 结束占用开发端口的进程。
 *
 * 用法：
 *   npm run dev:stop            清掉 5173（默认端口）
 *   npm run dev:stop -- 5174    清指定端口
 *
 * 优先按启动时记下的进程号抓人（准、快、不依赖外部命令）；
 * 记不到才退回 netstat 查。两种都查不到就如实说查不到，不假报成功。
 *
 * 只对 node.exe / electron.exe 动手 —— 端口被别的软件占着是另一回事，
 * 不该由这个脚本替用户决定要不要杀。
 */

import process from 'node:process'
import {
  clearDevServer,
  isAlive,
  isPortFree,
  isProjectProcess,
  killTree,
  listeners,
  processName,
  readDevServer,
} from './lib/port.mjs'

const PORT = Number(process.argv[2] || process.env.XBAOS_DEV_PORT || 5173)

if (!Number.isInteger(PORT) || PORT <= 0) {
  console.error(`[dev:stop] 端口号不合法：${process.argv[2]}`)
  process.exit(1)
}

if (await isPortFree(PORT)) {
  console.log(`[dev:stop] 端口 ${PORT} 没有监听进程，无需清理。`)
  clearDevServer()
  process.exit(0)
}

/** 目标进程：{ pid, from } —— from 只用于日志措辞 */
const targets = []

const recorded = readDevServer()
if (recorded && recorded.port === PORT && isAlive(recorded.pid)) {
  targets.push({ pid: recorded.pid, from: `启动记录 ${recorded.startedAt}` })
} else {
  for (const pid of listeners(PORT)) targets.push({ pid, from: 'netstat' })
}

if (targets.length === 0) {
  console.error(
    `[dev:stop] 端口 ${PORT} 确实被占用，但查不到占用者的进程号。\n` +
      `           请打开任务管理器，或执行 netstat -ano | findstr :${PORT} 查看 PID。`,
  )
  process.exit(1)
}

let failed = 0
for (const { pid, from } of targets) {
  const name = processName(pid)
  if (!isProjectProcess(name)) {
    console.warn(
      `[dev:stop] 端口 ${PORT} 被 ${name} (PID ${pid}) 占用，不是本项目的开发进程，` +
        '已跳过。请自行确认后再处理。',
    )
    failed++
    continue
  }
  if (killTree(pid)) {
    console.log(`[dev:stop] 已结束 ${name || 'node 进程'} (PID ${pid}，来源：${from})`)
  } else {
    console.error(`[dev:stop] 结束失败：${name || 'node 进程'} (PID ${pid})，可能需要管理员权限`)
    failed++
  }
}

// 状态文件里的进程已经被处理掉，别留着误导下一次判断
clearDevServer()
process.exit(failed ? 1 : 0)
