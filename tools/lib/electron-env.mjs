/**
 * 构造交给 Electron 子进程的环境变量。
 *
 * 必须清掉两个变量，否则 Electron 会静默退化成纯 Node：
 *
 * 1. **`ELECTRON_RUN_AS_NODE`** —— 只要它被设为非空值，`electron.exe` 就不再是
 *    Electron，而是一个普通的 Node 解释器：不创建窗口，`import { app } from 'electron'`
 *    也拿不到东西（裸 `electron` 会解析到 npm 包里那个只导出一串路径的 index.js，
 *    报错信息是 "does not provide an export named 'BrowserWindow'"，跟真实原因
 *    完全不沾边，非常容易误判成 ESM 不支持具名导入）。
 *    某些开发环境与 CI 会在 shell 里带上这个变量，子进程默认会继承。
 *
 * 2. **`NODE_OPTIONS`** —— 里面通常是宿主的 `--require` 预载脚本，那是给 Node 用的，
 *    带进 Electron 会干扰它自己的模块加载。
 *
 * 注意：这两个变量只影响我们主动拉起的子进程。用户双击安装好的程序时不经过这里，
 * 所以这是开发/验证链路的坑，不是发布产物的坑。
 */

/** 从环境变量里剔除会污染 Electron 的项 */
export function cleanEnv(source = process.env) {
  const env = { ...source }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_OPTIONS
  return env
}

/**
 * 取 Electron 可执行文件路径，并顺手断言它真的会以 Electron 方式运行。
 * @param {NodeRequire} req 调用方的 require（用 createRequire 造）
 */
export function electronExecutable(req) {
  const exe = req('electron')
  if (process.env.ELECTRON_RUN_AS_NODE) {
    console.warn(
      '[warn] 检测到当前环境带有 ELECTRON_RUN_AS_NODE，已为子进程清除；' +
        '若直接手动运行 electron 请自行 unset。',
    )
  }
  return exe
}
