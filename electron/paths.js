/**
 * 路径解析。
 *
 * 开发态和打包态的目录布局完全不同，所有「东西在哪」的判断都收敛到这一个文件，
 * 免得散落到各处后打包时才逐个爆雷。
 *
 * 开发态                     打包态
 * <repo>/engine/build/...    <resources>/engine/xbaos-engine.exe
 * <repo>/models/             <resources>/models/  与  <userData>/models/
 * <repo>/dist/               <resources>/app.asar/dist/
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * 默认优先使用的模型名。
 *
 * 注意这只是「优先挑谁」，不代表这个文件一定存在 —— 2026-10-14 起模型
 * **不随安装包分发**，装完软件磁盘上一个模型都没有，要靠 `pickInstalledModel()`
 * 在用户自己的目录里挑。
 */
export const DEFAULT_MODEL = 'ggml-small.bin'

/** 目录字符串归一化：非字符串与纯空白一律当「没设置」 */
function normalizeDir(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** 仓库根目录（开发态） */
export const repoRoot = path.resolve(here, '..')

/** 渲染进程产物目录。打包后在 app.asar 内部，所以只能走只读路径。 */
export function resolveRendererDist() {
  return path.join(repoRoot, 'dist')
}

/**
 * 引擎可执行文件的位置。
 *
 * 优先序：
 *   1. 环境变量 XBAOS_ENGINE_EXE —— 调试指定版本用
 *   2. 打包态：resources/engine/
 *   3. 开发态：Vulkan 版优先，退回 CPU 版
 *
 * 注意 Vulkan 版不是「只能跑 GPU」——它同时包含 CPU 后端，
 * 用户选 cpu 或机器没显卡时会自动走 CPU。所以能拿到 Vulkan 版就用它。
 */
export function resolveEngineExe({ isPackaged, resourcesPath }) {
  const fromEnv = process.env.XBAOS_ENGINE_EXE
  if (fromEnv && fs.existsSync(fromEnv)) {
    return { exe: fromEnv, source: 'env' }
  }

  if (isPackaged && resourcesPath) {
    const packaged = path.join(resourcesPath, 'engine', 'xbaos-engine.exe')
    if (fs.existsSync(packaged)) {
      return { exe: packaged, source: 'packaged' }
    }
  }

  const candidates = [
    path.join(repoRoot, 'engine', 'build', 'vulkan', 'bin', 'xbaos-engine.exe'),
    path.join(repoRoot, 'engine', 'build', 'cpu', 'bin', 'xbaos-engine.exe'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { exe: candidate, source: 'dev' }
    }
  }

  return { exe: '', source: 'missing' }
}

/**
 * 模型查找目录，按优先级从高到低。
 *
 * 分「用户目录」和「安装目录」两层是为了同时撑住两种发行形态：
 *   - 当前形态（2026-10-14 起）：模型不随包，用户在模型管理页下载，
 *     落在 userData/models；安装目录那份是空的，留给打开模型文件夹
 *     手动丢进去的人
 *   - 若将来恢复随包：把 extraResources 那两行取消注释即可，查找逻辑不用动
 *
 * 两者共用同一套查找逻辑，不用按发行形态分叉代码。用户目录排在前面，
 * 这样用户自己放了别的模型时能生效。
 *
 * 只读目录和可写目录分开还有个好处：打包后 resources/ 在 Program Files
 * 这类位置时是只读的，不能往里写模型，加用户目录就绕开了这个限制。
 */
export function modelSearchDirs({
  isPackaged,
  resourcesPath,
  userDataPath,
  customModelsDir,
} = {}) {
  const dirs = []

  // 调试用：临时指定一份模型，不动任何目录结构
  const fromEnv = process.env.XBAOS_MODELS_DIR
  if (fromEnv) dirs.push({ dir: fromEnv, source: 'env' })

  // 用户指定的自定义目录优先。**一旦指定就不再扫默认用户目录** ——
  // 拍板结论：换目录就彻底换，旧目录里的模型要用户自己搬过去
  // （界面上会明确提醒「请尽快把模型迁移到新位置」）。
  const custom = normalizeDir(customModelsDir)
  if (custom) {
    dirs.push({ dir: custom, source: 'custom' })
  } else if (userDataPath) {
    dirs.push({ dir: path.join(userDataPath, 'models'), source: 'user' })
  }

  // 安装目录内的模型。正式包**不含**任何模型文件（electron-builder.yml 里
  // 的 extraResources 已注掉），这一层是留给用户手动放进去的；开发时若有人
  // 临时把模型拷进去，也能被认出来。
  if (isPackaged && resourcesPath) {
    dirs.push({ dir: path.join(resourcesPath, 'models'), source: 'bundled' })
  }

  // 开发态仓库内的模型。打包后 repoRoot 指向 app.asar 内部，
  // 那个路径下不可能有模型，列出来只会让人困惑，所以只在非打包态加。
  if (!isPackaged) dirs.push({ dir: path.join(repoRoot, 'models'), source: 'dev' })

  return dirs
}

/**
 * 找一个模型文件，返回命中的绝对路径。
 * @param {string} fileName
 * @returns {{path: string, dir: string, source: string} | null}
 */
export function findModel(fileName, ctx) {
  for (const { dir, source } of modelSearchDirs(ctx)) {
    const full = path.join(dir, fileName)
    if (fs.existsSync(full)) return { path: full, dir, source }
  }
  return null
}

/**
 * 列出所有能找到的模型文件。
 *
 * 同一个文件名只保留优先级最高的那一份 —— 否则「用户目录还有一份同样的模型」
 * 会在界面上显示成两条一模一样的记录。source 字段用来告诉用户这个模型是哪来的。
 *
 * @returns {Array<{name: string, path: string, dir: string, source: string, size: number}>}
 */
export function listAvailableModels(ctx) {
  const found = new Map()

  for (const { dir, source } of modelSearchDirs(ctx)) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue // 目录不存在或没权限，跳过
    }

    for (const name of entries) {
      if (!name.toLowerCase().endsWith('.bin')) continue
      if (found.has(name)) continue // 优先级更高的目录已经给过这个文件了

      const full = path.join(dir, name)
      try {
        const st = fs.statSync(full)
        if (!st.isFile()) continue
        found.set(name, { name, path: full, dir, source, size: st.size })
      } catch {
        /* 读不到就跳过，不要因为一个坏文件让整份列表失败 */
      }
    }
  }

  return [...found.values()]
}

/** 用户数据目录下的默认模型目录 */
export function userModelsDir(userDataPath) {
  return path.join(userDataPath, 'models')
}

/**
 * 模型的**写入**目录：下载落点、删除范围、模型管理页「打开文件夹」的目标。
 *
 * 用户设了自定义目录就用它，否则退回默认用户目录。注意读侧
 * （modelSearchDirs）在设了自定义目录时不再看默认用户目录，
 * 但写侧只认一个目录 —— 两边规则一致，不会出现「下到 A 却在 B 里找不到」。
 */
export function writableModelsDir(userDataPath, customModelsDir) {
  return normalizeDir(customModelsDir) || userModelsDir(userDataPath)
}

/** 用户数据目录下的日志文件（引擎 stderr 会镜像一份到这里，方便排查） */
export function logFilePath(userDataPath) {
  return path.join(userDataPath, 'logs', 'engine.log')
}
