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

import { ARCH_INFO, ARCH_WHISPER } from './model-catalog.js'

const here = path.dirname(fileURLToPath(import.meta.url))

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
 * 引擎可执行文件的位置 —— **按架构选**。
 *
 * 两套引擎是两个独立的 exe（whisper 用 ggml，ONNX 用 onnxruntime），
 * 启动哪个由模型架构决定，见 models.js 的判定逻辑。
 *
 * 优先序：
 *   1. 环境变量（各架构一个，调试指定版本用）
 *   2. 打包态：resources/engine/
 *   3. 开发态：编译产物目录
 *
 * 注意 whisper 的 Vulkan 版不是「只能跑 GPU」——它同时包含 CPU 后端，
 * 用户选 cpu 或机器没显卡时会自动走 CPU。所以能拿到 Vulkan 版就用它。
 */
export function resolveEngineExe({ isPackaged, resourcesPath, arch = ARCH_WHISPER }) {
  const info = ARCH_INFO[arch] ?? ARCH_INFO[ARCH_WHISPER]

  const fromEnv = process.env[info.envVar]
  if (fromEnv && fs.existsSync(fromEnv)) {
    return { exe: fromEnv, source: 'env', arch: info.id }
  }

  if (isPackaged && resourcesPath) {
    const packaged = path.join(resourcesPath, 'engine', info.exe)
    if (fs.existsSync(packaged)) {
      return { exe: packaged, source: 'packaged', arch: info.id }
    }
  }

  for (const rel of info.devExe) {
    const full = path.join(repoRoot, ...rel.split('/'))
    if (fs.existsSync(full)) return { exe: full, source: 'dev', arch: info.id }
  }

  return { exe: '', source: 'missing', arch: info.id }
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

/**
 * 说话人分离模型的目录。
 *
 * 与识别模型彻底分开：这两个小模型（切分 + 声纹，共 33MB）随包分发，
 * 不从模型清单下载、也不归用户目录管 —— 它们不是「可切换的识别模型」，
 * 少一个分离就直接不可用，不该有第二条查找路径让它半残。
 *
 * 打包态在 `resources/diarization`（见 electron-builder.yml），开发态在仓库的
 * `resources/diarization`。
 */
export function diarizationModelDir({ isPackaged, resourcesPath }) {
  if (isPackaged && resourcesPath) return path.join(resourcesPath, 'diarization')
  return path.join(repoRoot, 'resources', 'diarization')
}

/** 分离所需的两个模型文件，缺任何一项都视为不可用 */
export const DIARIZATION_FILES = {
  segmentation: 'segmentation.onnx',
  embedding: 'speaker-embedding.onnx',
}
